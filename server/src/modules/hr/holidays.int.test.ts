import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { LeaveRequestStatus } from "../../generated/prisma/enums.js";
import {
  authCookie,
  createHoliday,
  createLeaveRequestRow,
  createLeaveType,
  createUser,
  prisma,
  resetDb,
} from "../../test/db.js";

const app = createApp();

/**
 * Calendar reference ("today" is Wednesday 2026-11-11 in America/Monterrey):
 * - 2026-11-16 Mon .. 2026-11-20 Fri; 2026-11-21 Sat; 2026-11-22 Sun; 2026-11-23 Mon.
 * - 2026 is not a leap year; 2028 is.
 */
let hrCookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
  await resetDb();
  const hr = await createUser({ role: "HR" });
  hrCookie = await authCookie(hr.id);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const NO_IMPACT = {
  affectedRequests: 0,
  breakdown: { countingBalance: 0, notCountingBalance: 0, past: 0, upcoming: 0 },
};

const list = (query: string) => request(app).get(`/api/hr/holidays${query}`).set("Cookie", hrCookie);
const impact = (query: string) => request(app).get(`/api/hr/holidays/impact${query}`).set("Cookie", hrCookie);
const create = (body: unknown) =>
  request(app).post("/api/hr/holidays").set("Cookie", hrCookie).send(body as object);
const remove = (id: string) => request(app).delete(`/api/hr/holidays/${id}`).set("Cookie", hrCookie);

/**
 * One request per user (the EXCLUDE constraint forbids overlapping active
 * requests of the SAME user, and this test needs many overlapping ones).
 */
async function requestOf(start: string, end: string, status: LeaveRequestStatus = "PENDING", businessDays = 1) {
  const user = await createUser();
  const type = await createLeaveType();
  return createLeaveRequestRow({ requesterId: user.id, leaveTypeId: type.id, start, end, businessDays, status });
}

describe("GET /api/hr/holidays?year=", () => {
  it("lists only the holidays of that calendar year, by date, with dates as YYYY-MM-DD (Jan 1 and Dec 31 included)", async () => {
    await createHoliday("2026-12-31", "Fin de año");
    await createHoliday("2026-01-01", "Año nuevo");
    await createHoliday("2026-09-16", "Independencia");
    await createHoliday("2025-12-31", "Año anterior");
    await createHoliday("2027-01-01", "Año siguiente");

    const res = await list("?year=2026");

    expect(res.status).toBe(200);
    expect(res.body.holidays.map((h: { date: string; name: string }) => [h.date, h.name])).toEqual([
      ["2026-01-01", "Año nuevo"],
      ["2026-09-16", "Independencia"],
      ["2026-12-31", "Fin de año"],
    ]);
    expect(res.body.holidays[0]).toEqual({
      id: expect.any(String),
      date: "2026-01-01",
      name: "Año nuevo",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("returns an empty list for a year without holidays", async () => {
    await createHoliday("2026-12-25");
    const res = await list("?year=2027");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ holidays: [] });
  });

  it.each(["2000", "2100"])("accepts the boundary year %s", async (year) => {
    expect((await list(`?year=${year}`)).status).toBe(200);
  });

  it.each([
    ["no year", ""],
    ["empty year", "?year="],
    ["year 1999", "?year=1999"],
    ["year 2101", "?year=2101"],
    ["non-numeric year", "?year=abc"],
    ["decimal year", "?year=2026.5"],
    ["unknown extra parameter (strict)", "?year=2026&month=1"],
  ])("responds 400 for %s", async (_label, query) => {
    expect((await list(query)).status).toBe(400);
  });
});

describe("POST /api/hr/holidays", () => {
  it("creates a holiday (201) and returns it with affectedRequests", async () => {
    const res = await create({ date: "2026-12-25", name: "Navidad" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      holiday: { id: expect.any(String), date: "2026-12-25", name: "Navidad", createdAt: expect.any(String), updatedAt: expect.any(String) },
      affectedRequests: 0,
      breakdown: { countingBalance: 0, notCountingBalance: 0, past: 0, upcoming: 0 },
    });
    const row = await prisma.holiday.findFirstOrThrow();
    expect(row.date.toISOString()).toBe("2026-12-25T00:00:00.000Z");
  });

  it("accepts Feb 29 of a leap year (2028)", async () => {
    const res = await create({ date: "2028-02-29", name: "Bisiesto" });
    expect(res.status).toBe(201);
    expect(res.body.holiday.date).toBe("2028-02-29");
  });

  it("responds 409 DUPLICATE_DATE for a date that already has a holiday, and writes nothing", async () => {
    await create({ date: "2026-12-25", name: "Navidad" });
    const res = await create({ date: "2026-12-25", name: "Otra cosa" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "DUPLICATE_DATE" });
    expect(await prisma.holiday.count()).toBe(1);
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("two holidays may share a name on different dates", async () => {
    expect((await create({ date: "2026-12-24", name: "Descanso" })).status).toBe(201);
    expect((await create({ date: "2026-12-31", name: "Descanso" })).status).toBe(201);
  });

  it.each([
    ["Feb 29 of a non-leap year", { date: "2027-02-29", name: "Festivo" }],
    ["Feb 30", { date: "2026-02-30", name: "Festivo" }],
    ["month 13", { date: "2026-13-01", name: "Festivo" }],
    ["non-ISO format", { date: "25/12/2026", name: "Festivo" }],
    ["date with time", { date: "2026-12-25T00:00:00Z", name: "Festivo" }],
    ["missing date", { name: "Festivo" }],
    ["missing name", { date: "2026-12-25" }],
    ["1-character name", { date: "2026-12-25", name: "N" }],
    ["unknown field", { date: "2026-12-25", name: "Navidad", recurring: true }],
  ])("responds 400 for %s and writes nothing", async (_label, body) => {
    expect((await create(body)).status).toBe(400);
    expect(await prisma.holiday.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });
});

describe("DELETE /api/hr/holidays/:id", () => {
  it("deletes the holiday (200 with affectedRequests)", async () => {
    const holiday = await createHoliday("2026-12-25");
    const res = await remove(holiday.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(NO_IMPACT);
    expect(await prisma.holiday.count()).toBe(0);
  });

  it("responds 404 for an id that does not exist, and for one already deleted", async () => {
    expect((await remove("does-not-exist")).status).toBe(404);
    const holiday = await createHoliday("2026-12-25");
    expect((await remove(holiday.id)).status).toBe(200);
    expect((await remove(holiday.id)).status).toBe(404);
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("the date can be used again after deleting it", async () => {
    const holiday = await createHoliday("2026-12-25");
    await remove(holiday.id);
    expect((await create({ date: "2026-12-25", name: "Navidad" })).status).toBe(201);
  });
});

describe("holiday impact: affectedRequests", () => {
  /** Wednesday 2026-11-18. */
  const DATE = "2026-11-18";

  async function scenario() {
    await requestOf("2026-11-16", "2026-11-20", "PENDING"); // crosses -> counts
    await requestOf("2026-11-18", "2026-11-18", "APPROVED"); // exactly that day -> counts
    await requestOf("2026-11-18", "2026-11-20", "PENDING"); // starts on it -> counts
    await requestOf("2026-11-16", "2026-11-18", "APPROVED"); // ends on it -> counts
    await requestOf("2026-11-16", "2026-11-20", "REJECTED"); // crosses but rejected
    await requestOf("2026-11-16", "2026-11-20", "CANCELLED"); // crosses but cancelled
    await requestOf("2026-11-16", "2026-11-17", "PENDING"); // ends the day before
    await requestOf("2026-11-19", "2026-11-20", "APPROVED"); // starts the day after
  }

  it("GET /impact counts PENDING/APPROVED requests whose range crosses the date (boundaries included), not REJECTED/CANCELLED nor the ones next to it", async () => {
    await scenario();
    const res = await impact(`?date=${DATE}`);
    expect(res.status).toBe(200);
    // scenario() uses counting types and dates on/after today: all count and are upcoming.
    expect(res.body).toEqual({
      affectedRequests: 4,
      breakdown: { countingBalance: 4, notCountingBalance: 0, past: 0, upcoming: 4 },
    });
  });

  it("POST returns the same count as GET /impact", async () => {
    await scenario();
    const res = await create({ date: DATE, name: "Festivo nuevo" });
    expect(res.status).toBe(201);
    expect(res.body.affectedRequests).toBe(4);
  });

  it("DELETE returns the count for the deleted holiday's date", async () => {
    await scenario();
    const holiday = await createHoliday(DATE);
    const res = await remove(holiday.id);
    expect(res.status).toBe(200);
    // scenario() uses counting types and dates on/after today: all count and are upcoming.
    expect(res.body).toEqual({
      affectedRequests: 4,
      breakdown: { countingBalance: 4, notCountingBalance: 0, past: 0, upcoming: 4 },
    });
  });

  it("counts requests of every user and of past dates too (past APPROVED crossing the date)", async () => {
    await requestOf("2026-11-02", "2026-11-04", "APPROVED");
    expect((await impact("?date=2026-11-03")).body.affectedRequests).toBe(1);
  });

  it("is 0 when no request crosses the date", async () => {
    await requestOf("2026-11-16", "2026-11-17");
    expect((await impact("?date=2026-12-25")).body).toEqual(NO_IMPACT);
  });

  describe("on a weekend date it is always 0, even with active requests crossing it", () => {
    beforeEach(async () => {
      // Mon 16 .. Mon 23: crosses Sat 21 and Sun 22.
      await requestOf("2026-11-16", "2026-11-23", "PENDING", 6);
      await requestOf("2026-11-20", "2026-11-23", "APPROVED", 2);
      await requestOf("2026-11-21", "2026-11-22", "APPROVED", 1);
    });

    it.each(["2026-11-21", "2026-11-22"])("GET /impact?date=%s -> 0", async (date) => {
      const res = await impact(`?date=${date}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(NO_IMPACT);
    });

    it.each(["2026-11-21", "2026-11-22"])("POST holiday on %s -> affectedRequests 0", async (date) => {
      const res = await create({ date, name: "En fin de semana" });
      expect(res.status).toBe(201);
      expect(res.body.affectedRequests).toBe(0);
      expect(res.body.breakdown).toEqual(NO_IMPACT.breakdown);
    });

    it.each(["2026-11-21", "2026-11-22"])("DELETE holiday on %s -> affectedRequests 0", async (date) => {
      const holiday = await createHoliday(date);
      const res = await remove(holiday.id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(NO_IMPACT);
    });

    it("control: the Friday and Monday around that weekend do count", async () => {
      expect((await impact("?date=2026-11-20")).body.affectedRequests).toBe(2);
      expect((await impact("?date=2026-11-23")).body.affectedRequests).toBe(2);
    });
  });

  it.each([
    ["no date", ""],
    ["invalid date", "?date=2026-02-30"],
    ["non-ISO date", "?date=18/11/2026"],
    ["unknown extra parameter (strict)", "?date=2026-11-18&year=2026"],
  ])("GET /impact responds 400 for %s", async (_label, query) => {
    expect((await impact(query)).status).toBe(400);
  });

  it("GET /impact writes nothing", async () => {
    await scenario();
    await impact(`?date=${DATE}`);
    expect(await prisma.holiday.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });
});

describe("holiday impact: breakdown (countingBalance/notCountingBalance by the request's copy; past/upcoming by endDate vs today)", () => {
  /** One user and one type per request, so the EXCLUDE constraint never gets in the way. */
  async function requestWith(opts: {
    start: string;
    end: string;
    counts: boolean;
    status?: LeaveRequestStatus;
    /** The type's CURRENT value; defaults to the request's copy. */
    typeCounts?: boolean;
  }) {
    const user = await createUser();
    const type = await createLeaveType({ countsAgainstVacationBalance: opts.typeCounts ?? opts.counts });
    return createLeaveRequestRow({
      requesterId: user.id,
      leaveTypeId: type.id,
      start: opts.start,
      end: opts.end,
      businessDays: 1,
      status: opts.status ?? "APPROVED",
      countsAgainstVacationBalance: opts.counts,
    });
  }

  /**
   * Past weekday Mon 2026-11-09 ("today" is Wed 2026-11-11). Requests crossing
   * it can be already over (endDate < today) or still running (endDate >= today).
   */
  async function pastDateMix() {
    await requestWith({ start: "2026-11-09", end: "2026-11-10", counts: true }); // past (ended yesterday), counts
    await requestWith({ start: "2026-11-09", end: "2026-11-09", counts: false }); // past, does not count
    await requestWith({ start: "2026-11-02", end: "2026-11-10", counts: false, status: "PENDING" }); // past (late PENDING), does not count
    await requestWith({ start: "2026-11-05", end: "2026-11-11", counts: true, status: "PENDING" }); // ends TODAY -> upcoming, counts
    await requestWith({ start: "2026-11-09", end: "2026-11-13", counts: false }); // running -> upcoming, does not count
    await requestWith({ start: "2026-11-06", end: "2026-11-20", counts: true }); // running -> upcoming, counts
    // Not active: never part of the breakdown.
    await requestWith({ start: "2026-11-09", end: "2026-11-10", counts: true, status: "REJECTED" });
    await requestWith({ start: "2026-11-09", end: "2026-11-13", counts: true, status: "CANCELLED" });
  }

  const PAST_DATE_EXPECTED = {
    affectedRequests: 6,
    breakdown: { countingBalance: 3, notCountingBalance: 3, past: 3, upcoming: 3 },
  };

  it("GET /impact on a past date gives the exact breakdown of a mix (ended, ending today, running)", async () => {
    await pastDateMix();
    const res = await impact("?date=2026-11-09");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PAST_DATE_EXPECTED);
  });

  it("POST returns the same breakdown as GET /impact, besides the holiday", async () => {
    await pastDateMix();
    const res = await create({ date: "2026-11-09", name: "Festivo retroactivo" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ holiday: expect.objectContaining({ date: "2026-11-09" }), ...PAST_DATE_EXPECTED });
  });

  it("DELETE returns the same breakdown for the deleted holiday's date", async () => {
    await pastDateMix();
    const holiday = await createHoliday("2026-11-09");
    const res = await remove(holiday.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PAST_DATE_EXPECTED);
  });

  it("totals always add up: affectedRequests = counting + notCounting = past + upcoming", async () => {
    await pastDateMix();
    const { affectedRequests, breakdown } = (await impact("?date=2026-11-09")).body;
    expect(breakdown.countingBalance + breakdown.notCountingBalance).toBe(affectedRequests);
    expect(breakdown.past + breakdown.upcoming).toBe(affectedRequests);
  });

  it("on a future date every crossing request is upcoming (future and running ones)", async () => {
    await requestWith({ start: "2026-11-18", end: "2026-11-18", counts: true, status: "PENDING" }); // future, counts
    await requestWith({ start: "2026-11-16", end: "2026-11-20", counts: false }); // future, does not count
    await requestWith({ start: "2026-11-10", end: "2026-11-18", counts: true }); // already running, ends on the date
    const res = await impact("?date=2026-11-18");
    expect(res.body).toEqual({
      affectedRequests: 3,
      breakdown: { countingBalance: 2, notCountingBalance: 1, past: 0, upcoming: 3 },
    });
  });

  it("uses the request's copy of countsAgainstVacationBalance, never the type's current value", async () => {
    // Type now counts, but the request was created when it did not (and vice versa).
    await requestWith({ start: "2026-11-18", end: "2026-11-18", counts: false, typeCounts: true });
    await requestWith({ start: "2026-11-18", end: "2026-11-18", counts: true, typeCounts: false });
    await requestWith({ start: "2026-11-18", end: "2026-11-18", counts: true, typeCounts: false });
    expect((await impact("?date=2026-11-18")).body.breakdown).toMatchObject({ countingBalance: 2, notCountingBalance: 1 });
  });

  it("changing the type after the request was created does not move it between countingBalance and notCountingBalance", async () => {
    const user = await createUser();
    const type = await createLeaveType({ countsAgainstVacationBalance: true });
    await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: type.id, start: "2026-11-18", end: "2026-11-18", businessDays: 1 });
    await prisma.leaveType.update({ where: { id: type.id }, data: { countsAgainstVacationBalance: false } });
    expect((await impact("?date=2026-11-18")).body.breakdown).toMatchObject({ countingBalance: 1, notCountingBalance: 0 });
  });

  it("'today' is the APP_TIMEZONE date: at 21:00 in Monterrey (03:00 UTC next day) a request ending that day is still upcoming", async () => {
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z")); // 2026-11-11 21:00 in America/Monterrey
    // The session from beforeEach may have expired after moving the clock.
    hrCookie = await authCookie((await createUser({ role: "HR" })).id);
    await requestWith({ start: "2026-11-10", end: "2026-11-11", counts: true });
    await requestWith({ start: "2026-11-10", end: "2026-11-10", counts: true });
    expect((await impact("?date=2026-11-10")).body.breakdown).toMatchObject({ past: 1, upcoming: 1 });
  });

  it("the next day in Monterrey (06:00 UTC = 00:00 local) that same request becomes past", async () => {
    vi.setSystemTime(new Date("2026-11-12T06:00:00Z")); // 2026-11-12 00:00 in America/Monterrey
    // The session from beforeEach may have expired after moving the clock.
    hrCookie = await authCookie((await createUser({ role: "HR" })).id);
    await requestWith({ start: "2026-11-10", end: "2026-11-11", counts: true });
    expect((await impact("?date=2026-11-10")).body.breakdown).toMatchObject({ past: 1, upcoming: 0 });
  });

  describe("a weekend date is all zeros even with a mix of active requests crossing it", () => {
    beforeEach(async () => {
      // Sat 2026-11-07 and Sun 2026-11-08 (past) / Sat 2026-11-21 (future).
      await requestWith({ start: "2026-11-06", end: "2026-11-09", counts: true }); // crosses the past weekend, ended (09 < 11) -> past
      await requestWith({ start: "2026-11-06", end: "2026-11-23", counts: false, status: "PENDING" }); // running
      await requestWith({ start: "2026-11-20", end: "2026-11-23", counts: true }); // future
    });

    it.each(["2026-11-07", "2026-11-08", "2026-11-21", "2026-11-22"])("GET /impact?date=%s -> all zeros", async (date) => {
      expect((await impact(`?date=${date}`)).body).toEqual(NO_IMPACT);
    });

    it("POST and DELETE on a weekend date -> all zeros", async () => {
      const added = await create({ date: "2026-11-07", name: "Sábado" });
      expect(added.status).toBe(201);
      expect(added.body).toEqual({ holiday: expect.objectContaining({ date: "2026-11-07" }), ...NO_IMPACT });
      expect((await remove(added.body.holiday.id)).body).toEqual(NO_IMPACT);
    });

    it("control: the Monday after (2026-11-09, past) and Friday before (2026-11-06) do count", async () => {
      expect((await impact("?date=2026-11-09")).body).toEqual({
        affectedRequests: 2,
        breakdown: { countingBalance: 1, notCountingBalance: 1, past: 1, upcoming: 1 },
      });
      expect((await impact("?date=2026-11-06")).body.affectedRequests).toBe(2);
    });
  });
});

describe("POST /api/hr/holidays: year range 2000-2100 and names without control characters", () => {
  it.each(["2000-01-01", "2100-12-31"])("accepts the boundary date %s", async (date) => {
    const res = await create({ date, name: "Límite" });
    expect(res.status).toBe(201);
    expect(res.body.holiday.date).toBe(date);
  });

  it.each(["1999-12-31", "2101-01-01", "1900-01-01", "0001-01-01", "9999-12-31"])(
    "responds 400 for %s (outside 2000-2100) and writes nothing",
    async (date) => {
      expect((await create({ date, name: "Fuera de rango" })).status).toBe(400);
      expect(await prisma.holiday.count()).toBe(0);
      expect(await prisma.hrAuditLog.count()).toBe(0);
    },
  );

  it("GET /impact is not limited to 2000-2100 (only the POST is): 1999-12-31 answers 200", async () => {
    // Documents the current behavior: the impact query only validates the date format.
    expect((await impact("?date=1999-12-31")).status).toBe(200);
  });

  it.each([
    ["inner newline", "Navi\ndad"],
    ["inner carriage return", "Navi\rdad"],
    ["inner tab", "Navi\tdad"],
    ["NUL alone", "\u0000"],
    ["NUL inside", "Navi\u0000dad"],
    ["DEL (U+007F)", "Navi\u007Fdad"],
    ["C1 control (U+0085)", "Navi\u0085dad"],
    ["escape (U+001B)", "Navi\u001Bdad"],
  ])("responds 400 for a name with %s, and writes nothing", async (_label, name) => {
    const res = await create({ date: "2026-12-25", name });
    expect(res.status).toBe(400);
    expect(await prisma.holiday.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("a tab or newline only at the ends is trimmed, not rejected", async () => {
    const res = await create({ date: "2026-12-25", name: "\tNavidad\n" });
    expect(res.status).toBe(201);
    expect(res.body.holiday.name).toBe("Navidad");
  });

  it("accented letters and ñ are fine (only control characters are rejected)", async () => {
    const res = await create({ date: "2026-12-12", name: "Día de la Virgen, año ñ" });
    expect(res.status).toBe(201);
  });
});

describe("adding or removing a holiday never recalculates existing requests", () => {
  it("businessDays of existing requests (and the employee's balance) stay the same after POST and DELETE", async () => {
    const employee = await createUser({ hireDate: "2023-02-01" });
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const cookie = await authCookie(employee.id);
    const created = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", cookie)
      .send({ leaveTypeId: type.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(created.status).toBe(201);
    expect(created.body.leaveRequest.businessDays).toBe(5);
    const balanceBefore = (await request(app).get("/api/me/balance").set("Cookie", cookie)).body;

    const added = await create({ date: "2026-11-18", name: "Festivo nuevo" });
    expect(added.body.affectedRequests).toBe(1);
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: created.body.leaveRequest.id } });
    expect(row.businessDays).toBe(5);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookie)).body).toEqual(balanceBefore);

    const removed = await remove(added.body.holiday.id);
    expect(removed.body.affectedRequests).toBe(1);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: row.id } })).businessDays).toBe(5);
  });

  it("a request created over an existing holiday keeps its lower businessDays after the holiday is deleted", async () => {
    const employee = await createUser({ hireDate: "2023-02-01" });
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const holiday = await createHoliday("2026-11-18");
    const created = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", await authCookie(employee.id))
      .send({ leaveTypeId: type.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(created.body.leaveRequest.businessDays).toBe(4);

    expect((await remove(holiday.id)).body.affectedRequests).toBe(1);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: created.body.leaveRequest.id } })).businessDays).toBe(4);
  });

  it("a new request after adding a holiday does use it", async () => {
    const employee = await createUser({ hireDate: "2023-02-01" });
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    await create({ date: "2026-11-18", name: "Festivo nuevo" });
    const res = await request(app)
      .get("/api/leave-requests/preview")
      .query({ leaveTypeId: type.id, startDate: "2026-11-16", endDate: "2026-11-20" })
      .set("Cookie", await authCookie(employee.id));
    expect(res.body.preview.businessDays).toBe(4);
  });
});

describe("holidays: database safety nets", () => {
  it.each([" Navidad", "Navidad ", ""])("chk_holidays_name_trimmed rejects %j", async (name) => {
    await expect(createHoliday("2026-12-25", name)).rejects.toThrow();
  });

  it("the unique date index rejects a second holiday on the same date", async () => {
    await createHoliday("2026-12-25", "Navidad");
    await expect(createHoliday("2026-12-25", "Otra")).rejects.toThrow();
  });
});
