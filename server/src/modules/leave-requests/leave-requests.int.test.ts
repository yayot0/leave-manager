import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { AUTH_COOKIE_NAME } from "../auth/cookie.js";
import {
  authCookie,
  createAdjustment,
  createHoliday,
  createLeaveRequestRow,
  createLeaveType,
  createUser,
  prisma,
  resetDb,
} from "../../test/db.js";

const app = createApp();

/**
 * Calendar reference (2026-11-11 is a Wednesday, the fixed "today"):
 * - 2026-11-14/15 Sat/Sun; 2026-11-16 Mon .. 2026-11-20 Fri.
 * - 2026-11-23 Mon .. 2026-12-04 Fri = 10 business days.
 * - 2026-12-07 Mon .. 2026-12-18 Fri = 10 business days.
 * - 2027-02-01 is a Monday (first day of the next anniversary period).
 * No holidays exist unless a test creates them.
 */
const NOW = new Date("2026-11-11T18:00:00Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** User hired 2023-02-01: 3 years => 16 days, period 2026-02-01..2027-01-31. */
async function setup(opts: { hireDate?: string } = {}) {
  const user = await createUser({ hireDate: opts.hireDate ?? "2023-02-01" });
  const vacation = await createLeaveType({ code: "VAC", name: "Vacaciones" });
  const cookie = await authCookie(user.id);
  return { user, vacation, cookie };
}

function post(cookie: string | null, body: unknown) {
  const req = request(app).post("/api/leave-requests");
  if (cookie) req.set("Cookie", cookie);
  return req.send(body as object);
}

async function countRows() {
  const [requests, events] = await Promise.all([
    prisma.leaveRequest.count(),
    prisma.requestEvent.count(),
  ]);
  return { requests, events };
}

describe("POST /api/leave-requests - happy path", () => {
  it("creates a PENDING request (201) with YYYY-MM-DD dates and business days excluding a holiday", async () => {
    const { user, vacation, cookie } = await setup();
    await createHoliday("2026-11-16", "Revolución");

    const res = await post(cookie, {
      leaveTypeId: vacation.id,
      startDate: "2026-11-16",
      endDate: "2026-11-22", // Mon..Sun, Monday is a holiday
      reason: "  Viaje familiar  ",
    });

    expect(res.status).toBe(201);
    expect(res.body.leaveRequest).toMatchObject({
      id: expect.any(String),
      startDate: "2026-11-16",
      endDate: "2026-11-22",
      businessDays: 4,
      status: "PENDING",
      reason: "Viaje familiar",
      decidedAt: null,
      decisionNote: null,
      leaveType: { id: vacation.id, code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true },
    });

    const row = await prisma.leaveRequest.findUniqueOrThrow({
      where: { id: res.body.leaveRequest.id },
      include: { events: true },
    });
    expect(row.requesterId).toBe(user.id);
    expect(row.deciderId).toBeNull();
    expect(row.businessDays).toBe(4);
    expect(row.events).toHaveLength(1);
    expect(row.events[0]).toMatchObject({ action: "CREATED", actorId: user.id });
    expect(await prisma.requestEvent.count()).toBe(1);
  });

  it("stores an empty/blank reason as null", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, {
      leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16", reason: "   ",
    });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.reason).toBeNull();
  });

  it("accepts a request without reason", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.reason).toBeNull();
  });
});

describe("POST /api/leave-requests - start date vs today", () => {
  it("allows startDate equal to today", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-11", endDate: "2026-11-11" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(1);
  });

  it("rejects startDate yesterday with 400 and creates nothing", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/anterior a hoy/);
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it("uses the company timezone: at 03:00 UTC on Nov 12 it is still Nov 11 in Monterrey, so startDate 2026-11-11 is allowed", async () => {
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-11", endDate: "2026-11-11" });
    expect(res.status).toBe(201);
  });

  it("uses the company timezone: at 06:00 UTC on Nov 12 (midnight in Monterrey) startDate 2026-11-11 is in the past", async () => {
    vi.setSystemTime(new Date("2026-11-12T06:00:00Z"));
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-11", endDate: "2026-11-12" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/leave-requests - business days", () => {
  it("rejects a weekend-only range (2026-11-14..15) with 400 and a business-days message", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-14", endDate: "2026-11-15" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/días hábiles/);
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it("rejects a range that is only a holiday with 400", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-16");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/días hábiles/);
  });

  it("rejects a range made only of a holiday plus a weekend with 400", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-20"); // Friday
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-20", endDate: "2026-11-22" });
    expect(res.status).toBe(400);
  });

  it("ignores holidays that fall outside the requested range", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-13");
    await createHoliday("2026-11-23");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(5);
  });
});

describe("POST /api/leave-requests - body validation (400)", () => {
  it("rejects endDate before startDate", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-20", endDate: "2026-11-19" });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/fecha de fin/)]),
    );
  });

  it.each([
    ["non-existent day", "2026-02-30"],
    ["Feb 29 in a non-leap year", "2027-02-29"],
    ["month 13", "2026-13-01"],
    ["missing zero padding", "2026-12-1"],
    ["datetime instead of date", "2026-12-01T00:00:00Z"],
    ["garbage", "mañana"],
  ])("rejects an invalid date (%s)", async (_label, value) => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: value });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.any(Array));
  });

  it("rejects a non-string date", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: 20261116, endDate: "2026-11-16" });
    expect(res.status).toBe(400);
  });

  it("rejects extra fields (strict schema), e.g. trying to set status", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, {
      leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16", status: "APPROVED",
    });
    expect(res.status).toBe(400);
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("rejects an %s leaveTypeId", async (_label, value) => {
    const { cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: value, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/leaveTypeId/)]));
  });

  it("rejects a missing body", async () => {
    const { cookie } = await setup();
    const res = await post(cookie, {});
    expect(res.status).toBe(400);
  });

  it("rejects a reason longer than 500 characters", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, {
      leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16", reason: "x".repeat(501),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a reason of exactly 500 characters", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, {
      leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16", reason: "x".repeat(500),
    });
    expect(res.status).toBe(201);
  });

  it("rejects a range of 366 days or more between start and end", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await post(cookie, { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2027-11-17" });
    expect(res.status).toBe(400);
  });

  it("accepts a range with a 365-day difference (limit) for a type that does not use balance", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await post(cookie, { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2027-11-16" });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/leave-requests - latest requestable start date (current or next period)", () => {
  it("allows startDate on 2028-01-31, the last day of the next period (hire 2023-02-01)", async () => {
    const { vacation, cookie } = await setup();
    // 2028-01-31 is a Monday; counts in the 2027-02-01..2028-01-31 period (18 days).
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2028-01-31", endDate: "2028-01-31" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.startDate).toBe("2028-01-31");
  });

  it("also allows it for a type that does not use balance", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await post(cookie, { leaveTypeId: sick.id, startDate: "2028-01-31", endDate: "2028-02-04" });
    expect(res.status).toBe(201);
  });

  it("rejects startDate 2028-02-01 (one day too far) with 400 mentioning 2028-01-31, and creates nothing", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2028-02-01", endDate: "2028-02-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/periodo actual o en el siguiente/);
    expect(res.body.error).toMatch(/2028-01-31/);
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it("rejects a far-future startDate (9999-01-04) with 400", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "9999-01-04", endDate: "9999-01-04" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2028-01-31/);
  });

  it("checks the future limit before the leave type (non-existent type + far date => future-limit message)", async () => {
    const { cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: "does-not-exist", startDate: "2028-02-01", endDate: "2028-02-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2028-01-31/);
  });

  it("a range that starts within the limit but ends after it is allowed (only startDate is limited)", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await post(cookie, { leaveTypeId: sick.id, startDate: "2028-01-31", endDate: "2028-02-08" });
    expect(res.status).toBe(201);
  });

  it("for an employee with less than 1 year (hire 2026-05-04) the limit is 2028-05-03", async () => {
    const { cookie } = await setup({ hireDate: "2026-05-04" });
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const ok = await post(cookie, { leaveTypeId: sick.id, startDate: "2028-05-03", endDate: "2028-05-03" });
    expect(ok.status).toBe(201);
    const tooFar = await post(cookie, { leaveTypeId: sick.id, startDate: "2028-05-04", endDate: "2028-05-04" });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error).toMatch(/2028-05-03/);
  });

  it("for an employee hired on Feb 29 (2024-02-29) the limit is 2028-02-28", async () => {
    const { cookie } = await setup({ hireDate: "2024-02-29" });
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const ok = await post(cookie, { leaveTypeId: sick.id, startDate: "2028-02-28", endDate: "2028-02-28" });
    expect(ok.status).toBe(201);
    const tooFar = await post(cookie, { leaveTypeId: sick.id, startDate: "2028-02-29", endDate: "2028-02-29" });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error).toMatch(/2028-02-28/);
  });
});

describe("POST /api/leave-requests - malformed input", () => {
  it("malformed JSON with a valid cookie => 400 with a clear message, not 500", async () => {
    const { cookie } = await setup();
    const res = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send('{"leaveTypeId": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El cuerpo de la petición no es JSON válido" });
  });

  it("rejects a leaveTypeId of 65 characters with 400", async () => {
    const { cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: "a".repeat(65), startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/leaveTypeId/)]));
  });

  it("a leaveTypeId of exactly 64 characters passes validation (then fails as non-existent type)", async () => {
    const { cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: "a".repeat(64), startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tipo de permiso/);
  });
});

describe("POST /api/leave-requests - leave type", () => {
  it("rejects an inactive leave type with 400", async () => {
    const { cookie } = await setup();
    const inactive = await createLeaveType({ code: "OLD", isActive: false });
    const res = await post(cookie, { leaveTypeId: inactive.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tipo de permiso/);
  });

  it("rejects a non-existent leave type with 400", async () => {
    const { cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: "does-not-exist", startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tipo de permiso/);
  });
});

describe("POST /api/leave-requests - balance", () => {
  it("rejects with 422 when requesting more days than available (17 > 16) and creates nothing", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-08" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Saldo insuficiente/);
    expect(res.body.error).toMatch(/17/);
    expect(res.body.error).toMatch(/2026-02-01 a 2027-01-31/);
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it("allows requesting exactly the available balance (16 days)", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(16);
  });

  it("a positive adjustment allows requesting more than the base entitlement", async () => {
    const { user, vacation, cookie } = await setup();
    await createAdjustment(user.id, 1, "2026-06-01");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-08" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(17);
  });

  it("a negative adjustment reduces what can be requested", async () => {
    const { user, vacation, cookie } = await setup();
    await createAdjustment(user.id, -1, "2026-06-01");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" });
    expect(res.status).toBe(422);
  });

  it("existing PENDING requests already subtract from the balance", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-13", businessDays: 10, status: "PENDING",
    });
    // 16 - 10 = 6 available; asking 7.
    const tooMany = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-24" });
    expect(tooMany.status).toBe(422);
    const exact = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-23" });
    expect(exact.status).toBe(201);
    expect(exact.body.leaveRequest.businessDays).toBe(6);
  });

  it("REJECTED and CANCELLED requests do not subtract from the balance", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-13", businessDays: 10, status: "REJECTED",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-04-06", end: "2026-04-17", businessDays: 10, status: "CANCELLED",
    });
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" });
    expect(res.status).toBe(201);
  });

  it("a request starting on 2027-02-01 uses the next period (18 days) even if the current one is exhausted", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-23", businessDays: 16, status: "APPROVED",
    });
    // 2027-02-01 Mon .. 2027-02-24 Wed = 18 business days.
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2027-02-01", endDate: "2027-02-24" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(18);
  });

  it("the next period also has a limit: 19 days starting 2027-02-01 => 422 mentioning that period", async () => {
    const { vacation, cookie } = await setup();
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2027-02-01", endDate: "2027-02-25" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/2027-02-01 a 2028-01-31/);
  });

  it("a request starting on 2027-01-29 (last business day of the period) counts against the current, exhausted period", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-23", businessDays: 16, status: "APPROVED",
    });
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2027-01-29", endDate: "2027-02-02" });
    expect(res.status).toBe(422);
  });

  it("a type that does not count against the balance is allowed even with 0 available days", async () => {
    // Hired 2026-03-15: less than 1 year => 0 days earned.
    const { cookie } = await setup({ hireDate: "2026-03-15" });
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await post(cookie, { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.leaveType.countsAgainstVacationBalance).toBe(false);
  });

  it("an employee with less than 1 year cannot request vacation days (422)", async () => {
    const { vacation, cookie } = await setup({ hireDate: "2026-03-15" });
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(422);
  });

  it("an employee hired 2025-11-12 can use their 12 days for a request starting on their first anniversary", async () => {
    const { vacation, cookie } = await setup({ hireDate: "2025-11-12" });
    // 2026-11-12 Thu .. 2026-11-27 Fri = 12 business days.
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-12", endDate: "2026-11-27" });
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(12);
  });
});

describe("POST /api/leave-requests - overlaps", () => {
  async function withExisting(status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED") {
    const ctx = await setup();
    await createLeaveRequestRow({
      requesterId: ctx.user.id, leaveTypeId: ctx.vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5, status,
    });
    return ctx;
  }

  it("rejects overlap with a PENDING request with 409", async () => {
    const { vacation, cookie } = await withExisting("PENDING");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-18", endDate: "2026-11-24" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2026-11-16 a 2026-11-20/);
    expect(await countRows()).toEqual({ requests: 1, events: 0 });
  });

  it("rejects overlap with an APPROVED request with 409", async () => {
    const { vacation, cookie } = await withExisting("APPROVED");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(409);
  });

  it("allows overlap with a REJECTED request", async () => {
    const { vacation, cookie } = await withExisting("REJECTED");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(201);
  });

  it("allows overlap with a CANCELLED request", async () => {
    const { vacation, cookie } = await withExisting("CANCELLED");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(201);
  });

  it("rejects a single-day overlap on the end boundary (new start = existing end) with 409", async () => {
    const { vacation, cookie } = await withExisting("PENDING");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-20", endDate: "2026-11-24" });
    expect(res.status).toBe(409);
  });

  it("rejects a single-day overlap on the start boundary (new end = existing start) with 409", async () => {
    const { vacation, cookie } = await withExisting("PENDING");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-12", endDate: "2026-11-16" });
    expect(res.status).toBe(409);
  });

  it("rejects a new request fully containing an existing one with 409", async () => {
    const { vacation, cookie } = await withExisting("PENDING");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-12", endDate: "2026-11-24" });
    expect(res.status).toBe(409);
  });

  it("rejects overlap even when the overlapping days are only a weekend", async () => {
    const ctx = await setup();
    await createLeaveRequestRow({
      requesterId: ctx.user.id, leaveTypeId: ctx.vacation.id, start: "2026-11-16", end: "2026-11-22", businessDays: 5,
    });
    const res = await post(ctx.cookie, { leaveTypeId: ctx.vacation.id, startDate: "2026-11-22", endDate: "2026-11-23" });
    expect(res.status).toBe(409);
  });

  it("allows an adjacent request starting the day after the existing one ends", async () => {
    const { vacation, cookie } = await withExisting("PENDING");
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-21", endDate: "2026-11-24" });
    expect(res.status).toBe(201);
  });

  it("rejects overlap regardless of leave type (a non-balance type also collides)", async () => {
    const { cookie } = await withExisting("PENDING");
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await post(cookie, { leaveTypeId: sick.id, startDate: "2026-11-18", endDate: "2026-11-18" });
    expect(res.status).toBe(409);
  });

  it("allows the same dates as another user's request", async () => {
    const { vacation, cookie } = await setup();
    const other = await createUser();
    await createLeaveRequestRow({
      requesterId: other.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5, status: "APPROVED",
    });
    const res = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(201);
  });
});

describe("authentication", () => {
  it("POST without cookie => 401", async () => {
    const res = await post(null, { leaveTypeId: "x", startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it("GET /mine without cookie => 401", async () => {
    const res = await request(app).get("/api/leave-requests/mine");
    expect(res.status).toBe(401);
  });

  it("invalid cookie => 401 on POST and GET /mine", async () => {
    const { vacation } = await setup();
    const bad = `${AUTH_COOKIE_NAME}=not.a.jwt`;
    const postRes = await post(bad, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    const getRes = await request(app).get("/api/leave-requests/mine").set("Cookie", bad);
    expect(postRes.status).toBe(401);
    expect(getRes.status).toBe(401);
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it("valid token of an inactive user => 401", async () => {
    const user = await createUser({ isActive: false });
    const vacation = await createLeaveType({ code: "VAC" });
    const res = await post(await authCookie(user.id), {
      leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16",
    });
    expect(res.status).toBe(401);
  });

  it("validation does not run before authentication (invalid body without cookie => 401, not 400)", async () => {
    const res = await post(null, { foo: "bar" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/leave-requests/mine", () => {
  it("returns only the current user's requests ordered by startDate desc", async () => {
    const { user, vacation, cookie } = await setup();
    const other = await createUser();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-03", businessDays: 2, status: "APPROVED",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-12-07", end: "2026-12-08", businessDays: 2,
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-06-01", end: "2026-06-01", businessDays: 1, status: "REJECTED",
    });
    await createLeaveRequestRow({
      requesterId: other.id, leaveTypeId: vacation.id, start: "2026-12-14", end: "2026-12-14", businessDays: 1,
    });

    const res = await request(app).get("/api/leave-requests/mine").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.leaveRequests.map((r: { startDate: string }) => r.startDate)).toEqual([
      "2026-12-07",
      "2026-06-01",
      "2026-03-02",
    ]);
    expect(res.body.leaveRequests[0]).toMatchObject({
      endDate: "2026-12-08",
      status: "PENDING",
      leaveType: { id: vacation.id, code: "VAC" },
    });
  });

  it("breaks startDate ties by createdAt desc", async () => {
    const { user, vacation, cookie } = await setup();
    const older = await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-12-07", end: "2026-12-07", businessDays: 1,
      status: "CANCELLED", createdAt: new Date("2026-10-01T00:00:00Z"),
    });
    const newer = await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-12-07", end: "2026-12-07", businessDays: 1,
      status: "PENDING", createdAt: new Date("2026-11-01T00:00:00Z"),
    });
    const res = await request(app).get("/api/leave-requests/mine").set("Cookie", cookie);
    expect(res.body.leaveRequests.map((r: { id: string }) => r.id)).toEqual([newer.id, older.id]);
  });

  it("returns an empty list when the user has no requests", async () => {
    const { cookie } = await setup();
    const res = await request(app).get("/api/leave-requests/mine").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leaveRequests: [] });
  });

  it("includes a request created through the API with its serialized dates", async () => {
    const { vacation, cookie } = await setup();
    const created = await post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-17" });
    const res = await request(app).get("/api/leave-requests/mine").set("Cookie", cookie);
    expect(res.body.leaveRequests).toEqual([created.body.leaveRequest]);
  });
});

describe("concurrency", () => {
  it("two simultaneous 10-day requests (non-overlapping) with a 16-day balance => exactly one 201 and one 422", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { vacation, cookie } = await setup();

      const [a, b] = await Promise.all([
        post(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-23", endDate: "2026-12-04" }),
        post(cookie, { leaveTypeId: vacation.id, startDate: "2026-12-07", endDate: "2026-12-18" }),
      ]);

      expect([a.status, b.status].sort(), `iteration ${i}`).toEqual([201, 422]);
      const ok = a.status === 201 ? a : b;
      expect(ok.body.leaveRequest.businessDays).toBe(10);
      expect(await countRows(), `iteration ${i}`).toEqual({ requests: 1, events: 1 });
    }
  });

  it("two simultaneous requests with identical dates => exactly one 201 and one 409", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { vacation, cookie } = await setup();
      const body = { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" };

      const [a, b] = await Promise.all([post(cookie, body), post(cookie, body)]);

      expect([a.status, b.status].sort(), `iteration ${i}`).toEqual([201, 409]);
      expect(await countRows(), `iteration ${i}`).toEqual({ requests: 1, events: 1 });
    }
  });

  it("simultaneous requests from different users do not block each other", async () => {
    const vacation = await createLeaveType({ code: "VAC" });
    const u1 = await createUser();
    const u2 = await createUser();
    const body = { leaveTypeId: vacation.id, startDate: "2026-11-23", endDate: "2026-12-04" };
    const [a, b] = await Promise.all([
      post(await authCookie(u1.id), body),
      post(await authCookie(u2.id), body),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await countRows()).toEqual({ requests: 2, events: 2 });
  });
});
