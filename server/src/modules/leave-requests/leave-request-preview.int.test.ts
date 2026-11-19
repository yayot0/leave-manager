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
 * - 2026-11-07/08 Sat/Sun (past); 2026-11-14/15 Sat/Sun.
 * - 2026-11-16 Mon .. 2026-11-20 Fri.
 * - 2026-11-16 Mon .. 2026-12-07 Mon = 16 business days.
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

type Query = Record<string, string>;

function preview(cookie: string | null, query: Query | string) {
  const req =
    typeof query === "string"
      ? request(app).get(`/api/leave-requests/preview?${query}`)
      : request(app).get("/api/leave-requests/preview").query(query);
  if (cookie) req.set("Cookie", cookie);
  return req;
}

function post(cookie: string, body: object) {
  return request(app).post("/api/leave-requests").set("Cookie", cookie).send(body);
}

async function countRows() {
  const [requests, events] = await Promise.all([
    prisma.leaveRequest.count(),
    prisma.requestEvent.count(),
  ]);
  return { requests, events };
}

function codes(res: request.Response): string[] {
  return res.body.preview.problems.map((p: { code: string }) => p.code);
}

describe("GET /api/leave-requests/preview - authentication", () => {
  it("responds 401 without a cookie", async () => {
    const res = await preview(null, { leaveTypeId: "x", startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it("responds 401 with an invalid cookie", async () => {
    const res = await preview(`${AUTH_COOKIE_NAME}=not.a.jwt`, {
      leaveTypeId: "x", startDate: "2026-11-16", endDate: "2026-11-16",
    });
    expect(res.status).toBe(401);
  });

  it("authentication runs before validation (malformed query without cookie => 401, not 400)", async () => {
    const res = await preview(null, { foo: "bar" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/leave-requests/preview - malformed query (400 with details, like the POST)", () => {
  it.each([
    ["leaveTypeId", { startDate: "2026-11-16", endDate: "2026-11-16" }],
    ["startDate", { leaveTypeId: "VAC_ID", endDate: "2026-11-16" }],
    ["endDate", { leaveTypeId: "VAC_ID", startDate: "2026-11-16" }],
  ])("rejects a missing %s", async (_field, query) => {
    const { vacation, cookie } = await setup();
    const q: Query = { ...query };
    if (q.leaveTypeId) q.leaveTypeId = vacation.id;
    const res = await preview(cookie, q);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.body.details).toEqual(expect.any(Array));
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("rejects an empty query string", async () => {
    const { cookie } = await setup();
    const res = await preview(cookie, {});
    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["non-existent day", "2026-02-30"],
    ["Feb 29 in a non-leap year", "2027-02-29"],
    ["month 13", "2026-13-01"],
    ["missing zero padding", "2026-12-1"],
    ["datetime instead of date", "2026-12-01T00:00:00Z"],
    ["garbage", "mañana"],
    ["empty", ""],
  ])("rejects an invalid date (%s)", async (_label, value) => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: value });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/YYYY-MM-DD/)]),
    );
  });

  it("rejects a malformed startDate too (2026-02-30)", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-02-30", endDate: "2026-03-02" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/YYYY-MM-DD/)]));
  });

  it("accepts Feb 29 of a leap year as a valid date (2028-02-29 is only a business-rule problem, not a 400)", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2028-02-29", endDate: "2028-02-29" });
    expect(res.status).toBe(200);
    expect(codes(res)).toEqual(["START_TOO_FAR"]);
  });

  it("rejects endDate before startDate with the same message as the POST", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-20", endDate: "2026-11-19" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining(["La fecha de fin no puede ser anterior a la fecha de inicio"]),
    );
  });

  it("accepts endDate equal to startDate (single day)", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(200);
    expect(res.body.preview.businessDays).toBe(1);
  });

  it("rejects a range of 366 days or more (2026-11-16..2027-11-17)", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2027-11-17" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/366/)]));
  });

  it("accepts a range with a 365-day difference (limit)", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2027-11-16" });
    expect(res.status).toBe(200);
    expect(res.body.preview.canSubmit).toBe(true);
  });

  it("rejects an extra parameter (strict schema), including `reason` which only the POST accepts", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, {
      leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16", reason: "viaje",
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.any(Array));
  });

  it("rejects a repeated parameter (?startDate=a&startDate=b) instead of picking one", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(
      cookie,
      `leaveTypeId=${encodeURIComponent(vacation.id)}&startDate=2026-11-16&startDate=2026-11-17&endDate=2026-11-20`,
    );
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.any(Array));
  });

  it("rejects a repeated leaveTypeId", async () => {
    const { vacation, cookie } = await setup();
    const id = encodeURIComponent(vacation.id);
    const res = await preview(cookie, `leaveTypeId=${id}&leaveTypeId=${id}&startDate=2026-11-16&endDate=2026-11-16`);
    expect(res.status).toBe(400);
  });

  it("rejects bracket syntax (startDate[]=...) as a non-string", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(
      cookie,
      `leaveTypeId=${encodeURIComponent(vacation.id)}&startDate[]=2026-11-16&endDate=2026-11-16`,
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["65 characters", "a".repeat(65)],
  ])("rejects an %s leaveTypeId", async (_label, value) => {
    const { cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: value, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/leaveTypeId/)]));
  });

  it("malformed input writes nothing", async () => {
    const { vacation, cookie } = await setup();
    await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-02-30", endDate: "2026-11-16" });
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });
});

describe("GET /api/leave-requests/preview - happy path", () => {
  it("returns businessDays excluding weekends and holidays, the leave type, the balance of the startDate period and canSubmit true", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-16", "Revolución");

    // Mon 16 .. Sun 29: 10 weekdays, minus the Monday holiday => 9.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-29" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      preview: {
        businessDays: 9,
        leaveType: {
          id: vacation.id,
          code: "VAC",
          name: "Vacaciones",
          countsAgainstVacationBalance: true,
          maxBusinessDaysPerRequest: null,
        },
        balance: {
          period: { start: "2026-02-01", end: "2027-01-31" },
          available: 16,
          availableAfter: 7,
        },
        problems: [],
        canSubmit: true,
      },
    });
  });

  it("does not expose isActive of the leave type", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.body.preview.leaveType).not.toHaveProperty("isActive");
  });

  it("available reflects existing PENDING/APPROVED requests and adjustments (availableAfter = available - businessDays)", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-06", businessDays: 5, status: "APPROVED",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-12-14", end: "2026-12-15", businessDays: 2, status: "PENDING",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-04-06", end: "2026-04-10", businessDays: 5, status: "REJECTED",
    });
    await createAdjustment(user.id, 1, "2026-06-01");

    // 16 - 5 - 2 + 1 = 10; asking 3 (Mon 16 .. Wed 18).
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-18" });
    expect(res.body.preview.balance).toMatchObject({ available: 10, availableAfter: 7 });
    expect(res.body.preview.canSubmit).toBe(true);
  });

  it("requesting exactly the available balance leaves availableAfter = 0 and canSubmit true", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" });
    expect(res.body.preview).toMatchObject({
      businessDays: 16,
      balance: { available: 16, availableAfter: 0 },
      problems: [],
      canSubmit: true,
    });
  });

  it("startDate equal to today is allowed (no START_IN_PAST)", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-11", endDate: "2026-11-11" });
    expect(res.body.preview.canSubmit).toBe(true);
  });

  it("uses the company timezone: at 03:00 UTC on Nov 12 it is still Nov 11 in Monterrey", async () => {
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-11", endDate: "2026-11-11" });
    expect(res.body.preview.canSubmit).toBe(true);
  });

  it("uses the company timezone: at 06:00 UTC on Nov 12 (midnight in Monterrey) Nov 11 is in the past", async () => {
    vi.setSystemTime(new Date("2026-11-12T06:00:00Z"));
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-11", endDate: "2026-11-11" });
    expect(codes(res)).toEqual(["START_IN_PAST"]);
  });

  it("ignores holidays outside the requested range", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-13");
    await createHoliday("2026-11-23");
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.body.preview.businessDays).toBe(5);
  });

  it("a holiday on a weekend is not subtracted twice", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-15"); // Sunday
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-13", endDate: "2026-11-16" });
    expect(res.body.preview.businessDays).toBe(2);
  });
});

describe("GET /api/leave-requests/preview - balance by period", () => {
  it("a request starting on 2027-02-01 uses the next period's balance (18 days) even if the current one is exhausted", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-23", businessDays: 16, status: "APPROVED",
    });
    // 2027-02-01 Mon .. 2027-02-05 Fri = 5 business days.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2027-02-01", endDate: "2027-02-05" });
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({
      businessDays: 5,
      balance: { period: { start: "2027-02-01", end: "2028-01-31" }, available: 18, availableAfter: 13 },
      problems: [],
      canSubmit: true,
    });
  });

  it("a request starting on the last day of the current period (2027-01-29) and crossing into the next counts entirely against the current one", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-03-02", end: "2026-03-16", businessDays: 11, status: "APPROVED",
    });
    // Fri 29 Jan .. Tue 2 Feb = 3 business days, all from 2026-02-01..2027-01-31.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2027-01-29", endDate: "2027-02-02" });
    expect(res.body.preview).toMatchObject({
      businessDays: 3,
      balance: { period: { start: "2026-02-01", end: "2027-01-31" }, available: 5, availableAfter: 2 },
      canSubmit: true,
    });
  });

  it("an employee hired on Feb 29 (2024-02-29) has their next period start on 2027-02-28", async () => {
    const { vacation, cookie } = await setup({ hireDate: "2024-02-29" });
    // Current period 2026-02-28..2027-02-27 (2 years => 14 days).
    const current = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2027-02-26", endDate: "2027-02-26" });
    expect(current.body.preview.balance).toMatchObject({
      period: { start: "2026-02-28", end: "2027-02-27" },
      available: 14,
    });
    // 2027-03-01 is a Monday, in the period 2027-02-28..2028-02-28 (3 years => 16 days).
    const next = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2027-03-01", endDate: "2027-03-01" });
    expect(next.body.preview.balance).toMatchObject({
      period: { start: "2027-02-28", end: "2028-02-28" },
      available: 16,
    });
  });
});

describe("GET /api/leave-requests/preview - each problem code and its message", () => {
  it("START_IN_PAST: startDate yesterday", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" });
    expect(res.status).toBe(200);
    expect(res.body.preview.problems).toEqual([
      { code: "START_IN_PAST", message: "La fecha de inicio no puede ser anterior a hoy" },
    ]);
    expect(res.body.preview.canSubmit).toBe(false);
  });

  it("START_TOO_FAR: startDate 2028-02-01, one day after the end of the next period, mentioning 2028-01-31", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2028-02-01", endDate: "2028-02-01" });
    expect(res.body.preview.problems).toEqual([
      {
        code: "START_TOO_FAR",
        message: "La fecha de inicio debe caer en tu periodo actual o en el siguiente (a más tardar 2028-01-31)",
      },
    ]);
    expect(res.body.preview.canSubmit).toBe(false);
  });

  it("START_TOO_FAR is not reported for 2028-01-31 (last allowed day)", async () => {
    const { cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2028-01-31", endDate: "2028-01-31" });
    expect(res.body.preview.canSubmit).toBe(true);
  });

  it("START_TOO_FAR for an employee with less than 1 year (hire 2026-05-04): limit 2028-05-03", async () => {
    const { cookie } = await setup({ hireDate: "2026-05-04" });
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const ok = await preview(cookie, { leaveTypeId: sick.id, startDate: "2028-05-03", endDate: "2028-05-03" });
    expect(ok.body.preview.canSubmit).toBe(true);
    const tooFar = await preview(cookie, { leaveTypeId: sick.id, startDate: "2028-05-04", endDate: "2028-05-04" });
    expect(codes(tooFar)).toEqual(["START_TOO_FAR"]);
    expect(tooFar.body.preview.problems[0].message).toMatch(/2028-05-03/);
  });

  it("INVALID_LEAVE_TYPE: non-existent type => leaveType null and balance null", async () => {
    const { cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: "does-not-exist", startDate: "2026-11-16", endDate: "2026-11-17" });
    expect(res.status).toBe(200);
    expect(res.body.preview).toEqual({
      businessDays: 2,
      leaveType: null,
      balance: null,
      problems: [{ code: "INVALID_LEAVE_TYPE", message: "Tipo de permiso no válido o inactivo" }],
      canSubmit: false,
    });
  });

  it("INVALID_LEAVE_TYPE: inactive type => leaveType null and balance null", async () => {
    const { cookie } = await setup();
    const inactive = await createLeaveType({ code: "OLD", isActive: false });
    const res = await preview(cookie, { leaveTypeId: inactive.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.body.preview).toMatchObject({
      leaveType: null,
      balance: null,
      problems: [{ code: "INVALID_LEAVE_TYPE", message: "Tipo de permiso no válido o inactivo" }],
      canSubmit: false,
    });
  });

  it("INVALID_LEAVE_TYPE skips user-state checks: an overlapping request is not reported", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
    });
    const res = await preview(cookie, { leaveTypeId: "does-not-exist", startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(codes(res)).toEqual(["INVALID_LEAVE_TYPE"]);
  });

  it("NO_BUSINESS_DAYS: weekend-only range (2026-11-14..15)", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-14", endDate: "2026-11-15" });
    expect(res.body.preview.businessDays).toBe(0);
    expect(res.body.preview.problems).toEqual([
      {
        code: "NO_BUSINESS_DAYS",
        message: "El rango no incluye días hábiles (solo fines de semana o festivos)",
      },
    ]);
    expect(res.body.preview.canSubmit).toBe(false);
  });

  it("NO_BUSINESS_DAYS: a single holiday", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-16");
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.body.preview.businessDays).toBe(0);
    expect(codes(res)).toEqual(["NO_BUSINESS_DAYS"]);
  });

  it("NO_BUSINESS_DAYS: a Friday holiday plus the weekend", async () => {
    const { vacation, cookie } = await setup();
    await createHoliday("2026-11-20");
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-20", endDate: "2026-11-22" });
    expect(codes(res)).toEqual(["NO_BUSINESS_DAYS"]);
  });

  it.each(["PENDING", "APPROVED"] as const)("OVERLAP with a %s request, mentioning its dates", async (status) => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5, status,
    });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-20", endDate: "2026-11-24" });
    expect(res.body.preview.problems).toEqual([
      {
        code: "OVERLAP",
        message:
          "Ya tienes una solicitud pendiente o aprobada que se encima con esas fechas (2026-11-16 a 2026-11-20)",
      },
    ]);
    expect(res.body.preview.canSubmit).toBe(false);
  });

  it.each(["REJECTED", "CANCELLED"] as const)("no OVERLAP with a %s request", async (status) => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5, status,
    });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.body.preview.problems).toEqual([]);
    expect(res.body.preview.canSubmit).toBe(true);
  });

  it("no OVERLAP with an adjacent request (starts the day after the existing one ends)", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
    });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-21", endDate: "2026-11-24" });
    expect(codes(res)).toEqual([]);
  });

  it("no OVERLAP with another user's request on the same dates", async () => {
    const { vacation, cookie } = await setup();
    const other = await createUser();
    await createLeaveRequestRow({
      requesterId: other.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5, status: "APPROVED",
    });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(codes(res)).toEqual([]);
  });

  it("OVERLAP also applies to a type that does not count against the balance", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
    });
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2026-11-18", endDate: "2026-11-18" });
    expect(codes(res)).toEqual(["OVERLAP"]);
    expect(res.body.preview.balance).toBeNull();
  });

  it("INSUFFICIENT_BALANCE: 17 days with 16 available => availableAfter -1, canSubmit false", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-08" });
    expect(res.body.preview).toMatchObject({
      businessDays: 17,
      balance: { period: { start: "2026-02-01", end: "2027-01-31" }, available: 16, availableAfter: -1 },
      problems: [
        {
          code: "INSUFFICIENT_BALANCE",
          message:
            "Saldo insuficiente: solicitas 17 días hábiles y tienes 16 disponibles en el periodo 2026-02-01 a 2027-01-31",
        },
      ],
      canSubmit: false,
    });
  });

  it("INSUFFICIENT_BALANCE with an already-negative period shows the real available but says 0 in the message", async () => {
    const { user, vacation, cookie } = await setup();
    await createAdjustment(user.id, -20, "2026-06-01");
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.body.preview.balance).toMatchObject({ available: -4, availableAfter: -5 });
    expect(res.body.preview.problems).toEqual([
      expect.objectContaining({
        code: "INSUFFICIENT_BALANCE",
        message: expect.stringMatching(/tienes 0 disponibles/),
      }),
    ]);
  });

  it("a weekend-only range in a period already negative by an HR adjustment reports only NO_BUSINESS_DAYS (no 'solicitas 0 días'), and the POST answers 400 with that message", async () => {
    const { user, vacation, cookie } = await setup();
    await createAdjustment(user.id, -20, "2026-06-01"); // 16 - 20 = -4
    const query = { leaveTypeId: vacation.id, startDate: "2026-11-14", endDate: "2026-11-15" };

    const res = await preview(cookie, query);
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({
      businessDays: 0,
      balance: { period: { start: "2026-02-01", end: "2027-01-31" }, available: -4, availableAfter: -4 },
      problems: [
        {
          code: "NO_BUSINESS_DAYS",
          message: "El rango no incluye días hábiles (solo fines de semana o festivos)",
        },
      ],
      canSubmit: false,
    });
    expect(res.body.preview.problems).toHaveLength(1);

    const created = await post(cookie, query);
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("El rango no incluye días hábiles (solo fines de semana o festivos)");
    expect(await countRows()).toEqual({ requests: 0, events: 0 });
  });

  it("INSUFFICIENT_BALANCE for an employee with less than 1 year (0 days earned)", async () => {
    const { vacation, cookie } = await setup({ hireDate: "2026-03-15" });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.body.preview.balance).toMatchObject({
      period: { start: "2026-03-15", end: "2027-03-14" },
      available: 0,
      availableAfter: -1,
    });
    expect(codes(res)).toEqual(["INSUFFICIENT_BALANCE"]);
  });

  it("an employee hired 2025-11-12 can already use their 12 days starting on their first anniversary", async () => {
    const { vacation, cookie } = await setup({ hireDate: "2025-11-12" });
    // 2026-11-12 Thu .. 2026-11-27 Fri = 12 business days.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-12", endDate: "2026-11-27" });
    expect(res.body.preview).toMatchObject({
      businessDays: 12,
      balance: { period: { start: "2026-11-12", end: "2027-11-11" }, available: 12, availableAfter: 0 },
      canSubmit: true,
    });
  });
});

describe("GET /api/leave-requests/preview - leave type that does not count against the balance", () => {
  it("returns balance null and no INSUFFICIENT_BALANCE even with 0 available days", async () => {
    // Hired 2026-03-15: less than 1 year => 0 days earned.
    const { cookie } = await setup({ hireDate: "2026-03-15" });
    const sick = await createLeaveType({ code: "SICK", name: "Incapacidad", countsAgainstVacationBalance: false });
    const res = await preview(cookie, { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.body.preview).toEqual({
      businessDays: 5,
      leaveType: {
        id: sick.id,
        code: "SICK",
        name: "Incapacidad",
        countsAgainstVacationBalance: false,
        maxBusinessDaysPerRequest: null,
      },
      balance: null,
      problems: [],
      canSubmit: true,
    });
  });
});

describe("GET /api/leave-requests/preview - several problems at once", () => {
  it("reports START_IN_PAST, INVALID_LEAVE_TYPE and NO_BUSINESS_DAYS together, in that order", async () => {
    const { cookie } = await setup();
    // 2026-11-07/08 is a past weekend.
    const res = await preview(cookie, { leaveTypeId: "does-not-exist", startDate: "2026-11-07", endDate: "2026-11-08" });
    expect(codes(res)).toEqual(["START_IN_PAST", "INVALID_LEAVE_TYPE", "NO_BUSINESS_DAYS"]);
    expect(res.body.preview.canSubmit).toBe(false);
  });

  it("reports OVERLAP and INSUFFICIENT_BALANCE together", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
    });
    // 16 - 5 = 11 available; asking 16 that overlap the existing one.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" });
    expect(codes(res)).toEqual(["OVERLAP", "INSUFFICIENT_BALANCE"]);
    expect(res.body.preview.balance).toMatchObject({ available: 11, availableAfter: -5 });
  });

  it("reports START_TOO_FAR together with NO_BUSINESS_DAYS (far-away weekend)", async () => {
    const { vacation, cookie } = await setup();
    // 2028-02-05/06 is a Saturday/Sunday.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2028-02-05", endDate: "2028-02-06" });
    expect(codes(res)).toEqual(expect.arrayContaining(["START_TOO_FAR", "NO_BUSINESS_DAYS"]));
    expect(codes(res)[0]).toBe("START_TOO_FAR");
  });

  it("reports START_IN_PAST together with OVERLAP (phase 1 and phase 2)", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-09", end: "2026-11-13", businessDays: 5, status: "APPROVED",
    });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" });
    expect(codes(res)).toEqual(["START_IN_PAST", "OVERLAP"]);
  });
});

describe("GET /api/leave-requests/preview - date problems skip the balance check", () => {
  it("START_TOO_FAR with a range that would exceed any balance => balance null and no INSUFFICIENT_BALANCE", async () => {
    const { vacation, cookie } = await setup();
    // 2028-02-01 Tue .. 2028-03-31 Fri = 21 (leap February) + 23 = 44 business days,
    // far above the 20 of that period.
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2028-02-01", endDate: "2028-03-31" });
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({
      businessDays: 44,
      leaveType: { id: vacation.id },
      balance: null,
      canSubmit: false,
    });
    expect(codes(res)).toEqual(["START_TOO_FAR"]);
  });

  it("START_IN_PAST with insufficient balance => balance null and only START_IN_PAST", async () => {
    const { user, vacation, cookie } = await setup();
    await createAdjustment(user.id, -20, "2026-06-01"); // period at -4
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" });
    expect(res.body.preview.balance).toBeNull();
    expect(codes(res)).toEqual(["START_IN_PAST"]);
  });

  it("START_IN_PAST with an overlapping request => balance null but OVERLAP is still reported", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-09", end: "2026-11-13", businessDays: 5, status: "PENDING",
    });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" });
    expect(res.body.preview.balance).toBeNull();
    expect(res.body.preview.problems).toEqual([
      { code: "START_IN_PAST", message: "La fecha de inicio no puede ser anterior a hoy" },
      {
        code: "OVERLAP",
        message:
          "Ya tienes una solicitud pendiente o aprobada que se encima con esas fechas (2026-11-09 a 2026-11-13)",
      },
    ]);
  });

  it("START_TOO_FAR with an overlapping request => balance null but OVERLAP is still reported", async () => {
    const { user, cookie } = await setup();
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    // Allowed start (last day of the next period) whose range runs past the limit.
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: sick.id, start: "2028-01-31", end: "2028-02-04", businessDays: 5,
    });
    const vacation = await prisma.leaveType.findFirstOrThrow({ where: { code: "VAC" } });
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2028-02-02", endDate: "2028-02-03" });
    expect(res.body.preview.balance).toBeNull();
    expect(codes(res)).toEqual(["START_TOO_FAR", "OVERLAP"]);
  });

  it("without date problems the balance is still computed (NO_BUSINESS_DAYS does not skip it)", async () => {
    const { vacation, cookie } = await setup();
    const res = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-14", endDate: "2026-11-15" });
    expect(res.body.preview.balance).toMatchObject({ available: 16, availableAfter: 16 });
    expect(codes(res)).toEqual(["NO_BUSINESS_DAYS"]);
  });
});

describe("GET /api/leave-requests/preview - writes nothing", () => {
  it("does not change leave_requests nor request_events, for a valid and for an invalid preview", async () => {
    const { user, vacation, cookie } = await setup();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
    });
    const before = await countRows();

    const ok = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-23", endDate: "2026-11-27" });
    const overlap = await preview(cookie, { leaveTypeId: vacation.id, startDate: "2026-11-18", endDate: "2026-11-24" });
    expect(ok.body.preview.canSubmit).toBe(true);
    expect(overlap.body.preview.canSubmit).toBe(false);

    expect(await countRows()).toEqual(before);
    expect(before).toEqual({ requests: 1, events: 0 });
  });

  it("repeating a valid preview does not reserve balance (available stays the same)", async () => {
    const { vacation, cookie } = await setup();
    const query = { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" };
    const first = await preview(cookie, query);
    const second = await preview(cookie, query);
    expect(first.body.preview.balance.available).toBe(16);
    expect(second.body.preview.balance.available).toBe(16);
  });
});

describe("preview and POST agree", () => {
  type Scenario = {
    label: string;
    arrange: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<{ leaveTypeId: string; startDate: string; endDate: string }>;
  };

  const STATUS_BY_CODE: Record<string, number> = {
    START_IN_PAST: 400,
    START_TOO_FAR: 400,
    INVALID_LEAVE_TYPE: 400,
    NO_BUSINESS_DAYS: 400,
    OVERLAP: 409,
    INSUFFICIENT_BALANCE: 422,
  };

  const scenarios: Scenario[] = [
    {
      label: "happy path",
      arrange: async ({ vacation }) => ({ leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" }),
    },
    {
      label: "exact balance (16 days)",
      arrange: async ({ vacation }) => ({ leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" }),
    },
    {
      label: "overlap with a PENDING request",
      arrange: async ({ user, vacation }) => {
        await createLeaveRequestRow({
          requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
        });
        return { leaveTypeId: vacation.id, startDate: "2026-11-18", endDate: "2026-11-24" };
      },
    },
    {
      label: "insufficient balance",
      arrange: async ({ vacation }) => ({ leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-08" }),
    },
    {
      label: "start in the past",
      arrange: async ({ vacation }) => ({ leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" }),
    },
    {
      label: "start too far + non-existent type (first problem wins)",
      arrange: async () => ({ leaveTypeId: "does-not-exist", startDate: "2028-02-01", endDate: "2028-02-01" }),
    },
    {
      label: "start too far with a range above any balance (START_TOO_FAR, not 422)",
      arrange: async ({ vacation }) => ({ leaveTypeId: vacation.id, startDate: "2028-02-01", endDate: "2028-03-31" }),
    },
    {
      label: "start in the past + overlap + negative balance (START_IN_PAST first => 400)",
      arrange: async ({ user, vacation }) => {
        await createAdjustment(user.id, -20, "2026-06-01");
        await createLeaveRequestRow({
          requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-09", end: "2026-11-13", businessDays: 5,
        });
        return { leaveTypeId: vacation.id, startDate: "2026-11-10", endDate: "2026-11-12" };
      },
    },
    {
      label: "inactive type",
      arrange: async () => {
        const inactive = await createLeaveType({ code: "OLD", isActive: false });
        return { leaveTypeId: inactive.id, startDate: "2026-11-16", endDate: "2026-11-16" };
      },
    },
    {
      label: "weekend only",
      arrange: async ({ vacation }) => ({ leaveTypeId: vacation.id, startDate: "2026-11-14", endDate: "2026-11-15" }),
    },
    {
      label: "overlap + insufficient balance (OVERLAP first => 409)",
      arrange: async ({ user, vacation }) => {
        await createLeaveRequestRow({
          requesterId: user.id, leaveTypeId: vacation.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
        });
        return { leaveTypeId: vacation.id, startDate: "2026-11-16", endDate: "2026-12-07" };
      },
    },
    {
      label: "type that does not count against the balance",
      arrange: async () => {
        const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
        return { leaveTypeId: sick.id, startDate: "2026-11-16", endDate: "2026-11-20" };
      },
    },
  ];

  it.each(scenarios)("$label", async ({ arrange }) => {
    const ctx = await setup();
    const input = await arrange(ctx);

    const pre = await preview(ctx.cookie, input);
    expect(pre.status).toBe(200);
    const { canSubmit, problems, businessDays } = pre.body.preview;

    const res = await post(ctx.cookie, input);

    if (canSubmit) {
      expect(problems).toEqual([]);
      expect(res.status).toBe(201);
      expect(res.body.leaveRequest.businessDays).toBe(businessDays);
    } else {
      const [first] = problems;
      expect(res.status).toBe(STATUS_BY_CODE[first.code]);
      expect(res.body).toEqual({ error: first.message, code: first.code });
    }
  });
});
