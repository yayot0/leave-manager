import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import {
  authCookie,
  createAdjustment,
  createLeaveRequestRow,
  createLeaveType,
  createUser,
  prisma,
  resetDb,
} from "../../test/db.js";

const app = createApp();

/**
 * "Today" is Wednesday 2026-11-11 in America/Monterrey.
 * Employee hired 2023-02-01: 3rd anniversary on 2026-02-01 -> 16 days in the
 * period 2026-02-01..2027-01-31.
 * Free weeks: 2026-11-16..20 (5 days), 2026-11-23..27 (5), 2026-11-30..12-04 (5).
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

async function setup() {
  const hr = await createUser({ role: "HR" });
  const manager = await createUser({ role: "MANAGER" });
  const employee = await createUser({ hireDate: "2023-02-01", managerId: manager.id });
  const vacation = await createLeaveType({ code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true });
  const personal = await createLeaveType({ code: "PER", name: "Día personal", countsAgainstVacationBalance: false });
  return {
    hr, manager, employee, vacation, personal,
    hrCookie: await authCookie(hr.id),
    managerCookie: await authCookie(manager.id),
    cookie: await authCookie(employee.id),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function post(ctx: Ctx, leaveTypeId: string, startDate: string, endDate: string) {
  return request(app).post("/api/leave-requests").set("Cookie", ctx.cookie).send({ leaveTypeId, startDate, endDate });
}

async function balance(ctx: Ctx) {
  const res = await request(app).get("/api/me/balance").set("Cookie", ctx.cookie);
  expect(res.status).toBe(200);
  return res.body.balance as { available: number; pending: number; approved: number };
}

/** HR editing the type (directly in the DB until the HR endpoints exist). */
async function setCounts(_ctx: Ctx, typeId: string, value: boolean) {
  await prisma.leaveType.update({ where: { id: typeId }, data: { countsAgainstVacationBalance: value } });
  return { status: 200 };
}

const approve = (ctx: Ctx, id: string) =>
  request(app).post(`/api/leave-requests/${id}/approve`).set("Cookie", ctx.managerCookie);

const detail = (cookie: string, id: string) => request(app).get(`/api/leave-requests/${id}`).set("Cookie", cookie);

describe("creating a request stores a copy of countsAgainstVacationBalance", () => {
  it("copies true from a type that counts and false from one that does not (row and response)", async () => {
    const ctx = await setup();
    const a = await post(ctx, ctx.vacation.id, "2026-11-16", "2026-11-16");
    const b = await post(ctx, ctx.personal.id, "2026-11-17", "2026-11-17");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.leaveRequest.countsAgainstVacationBalance).toBe(true);
    expect(b.body.leaveRequest.countsAgainstVacationBalance).toBe(false);
    const rows = await prisma.leaveRequest.findMany({ orderBy: { startDate: "asc" } });
    expect(rows.map((r) => r.countsAgainstVacationBalance)).toEqual([true, false]);
  });

  it("the column has no DEFAULT: an insert that omits it fails (the app must always set it)", async () => {
    const ctx = await setup();
    await expect(
      prisma.$executeRaw`
        INSERT INTO leave_requests (id, requester_id, leave_type_id, start_date, end_date, business_days, status, updated_at)
        VALUES ('raw1', ${ctx.employee.id}, ${ctx.vacation.id}, '2026-11-16', '2026-11-16', 1, 'PENDING', now())`,
    ).rejects.toThrow();
  });
});

describe("editing a leave type never changes past balances", () => {
  it("type that counted -> HR makes it NOT count: /api/me/balance is unchanged for the existing request", async () => {
    const ctx = await setup();
    expect((await post(ctx, ctx.vacation.id, "2026-11-16", "2026-11-20")).status).toBe(201);
    const before = await balance(ctx);
    expect(before).toMatchObject({ pending: 5, available: 11 });

    expect((await setCounts(ctx, ctx.vacation.id, false)).status).toBe(200);

    expect(await balance(ctx)).toEqual(before);
  });

  it("...and a NEW request of that type uses the new value (does not count)", async () => {
    const ctx = await setup();
    await post(ctx, ctx.vacation.id, "2026-11-16", "2026-11-20");
    await setCounts(ctx, ctx.vacation.id, false);

    const res = await post(ctx, ctx.vacation.id, "2026-11-23", "2026-11-27");
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.countsAgainstVacationBalance).toBe(false);
    expect(await balance(ctx)).toMatchObject({ pending: 5, available: 11 });
  });

  it("...the manager still sees requesterBalance for the old request, and null for the new one", async () => {
    const ctx = await setup();
    const old = await post(ctx, ctx.vacation.id, "2026-11-16", "2026-11-20");
    await setCounts(ctx, ctx.vacation.id, false);
    const fresh = await post(ctx, ctx.vacation.id, "2026-11-23", "2026-11-27");

    const oldDetail = await detail(ctx.managerCookie, old.body.leaveRequest.id);
    expect(oldDetail.body.leaveRequest.requesterBalance).toMatchObject({
      availableWithoutRequest: 16,
      availableAfterApproval: 11,
      blocksApproval: false,
    });
    const freshDetail = await detail(ctx.managerCookie, fresh.body.leaveRequest.id);
    expect(freshDetail.body.leaveRequest.requesterBalance).toBeNull();
  });

  it("...approving the old request still checks the balance (422 INSUFFICIENT_BALANCE), the new one does not (200)", async () => {
    const ctx = await setup();
    const old = await post(ctx, ctx.vacation.id, "2026-11-16", "2026-11-20");
    await setCounts(ctx, ctx.vacation.id, false);
    const fresh = await post(ctx, ctx.vacation.id, "2026-11-23", "2026-11-27");
    // HR adjustment leaves the period negative: 16 - 5 - 20 = -9.
    await createAdjustment(ctx.employee.id, -20, "2026-11-01");

    const resOld = await approve(ctx, old.body.leaveRequest.id);
    expect(resOld.status).toBe(422);
    expect(resOld.body.code).toBe("INSUFFICIENT_BALANCE");
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: old.body.leaveRequest.id } })).status).toBe("PENDING");

    const resFresh = await approve(ctx, fresh.body.leaveRequest.id);
    expect(resFresh.status).toBe(200);
    expect(resFresh.body.leaveRequest.status).toBe("APPROVED");
  });

  it("inverse: type that did NOT count -> HR makes it count: the old request still does not count", async () => {
    const ctx = await setup();
    const old = await post(ctx, ctx.personal.id, "2026-11-16", "2026-11-20");
    expect(old.status).toBe(201);
    const before = await balance(ctx);
    expect(before).toMatchObject({ pending: 0, available: 16 });

    expect((await setCounts(ctx, ctx.personal.id, true)).status).toBe(200);
    expect(await balance(ctx)).toEqual(before);

    const oldDetail = await detail(ctx.managerCookie, old.body.leaveRequest.id);
    expect(oldDetail.body.leaveRequest.requesterBalance).toBeNull();
  });

  it("inverse: the old request is approved even with a negative period; a new one counts and is checked", async () => {
    const ctx = await setup();
    const old = await post(ctx, ctx.personal.id, "2026-11-16", "2026-11-20");
    await setCounts(ctx, ctx.personal.id, true);

    const fresh = await post(ctx, ctx.personal.id, "2026-11-23", "2026-11-27");
    expect(fresh.status).toBe(201);
    expect(fresh.body.leaveRequest.countsAgainstVacationBalance).toBe(true);
    expect(await balance(ctx)).toMatchObject({ pending: 5, available: 11 });

    // Now more than the remaining 11 days is refused for this type.
    const tooMuch = await post(ctx, ctx.personal.id, "2026-11-30", "2026-12-18");
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code).toBe("INSUFFICIENT_BALANCE");

    await createAdjustment(ctx.employee.id, -20, "2026-11-01");
    expect((await approve(ctx, old.body.leaveRequest.id)).status).toBe(200);
    expect((await approve(ctx, fresh.body.leaveRequest.id)).status).toBe(422);
  });

  it("the preview uses the type's CURRENT value for a new request", async () => {
    const ctx = await setup();
    await setCounts(ctx, ctx.vacation.id, false);
    const res = await request(app)
      .get("/api/leave-requests/preview")
      .query({ leaveTypeId: ctx.vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" })
      .set("Cookie", ctx.cookie);
    expect(res.status).toBe(200);
    expect(res.body.preview.balance).toBeNull();
    expect(res.body.preview.leaveType.countsAgainstVacationBalance).toBe(false);
  });

  it("an APPROVED request keeps counting after its type stops counting", async () => {
    const ctx = await setup();
    await createLeaveRequestRow({
      requesterId: ctx.employee.id, leaveTypeId: ctx.vacation.id, start: "2026-11-16", end: "2026-11-20",
      businessDays: 5, status: "APPROVED", deciderId: ctx.manager.id,
    });
    await setCounts(ctx, ctx.vacation.id, false);
    expect(await balance(ctx)).toMatchObject({ approved: 5, available: 11 });
  });
});

describe("API responses expose the request's own copy", () => {
  async function editedSetup() {
    const ctx = await setup();
    const created = await post(ctx, ctx.vacation.id, "2026-11-16", "2026-11-20");
    await setCounts(ctx, ctx.vacation.id, false);
    return { ctx, id: created.body.leaveRequest.id as string };
  }

  it("GET /mine: countsAgainstVacationBalance is the request's (true) while leaveType's is now false", async () => {
    const { ctx } = await editedSetup();
    const res = await request(app).get("/api/leave-requests/mine").set("Cookie", ctx.cookie);
    expect(res.body.leaveRequests[0].countsAgainstVacationBalance).toBe(true);
    expect(res.body.leaveRequests[0].leaveType.countsAgainstVacationBalance).toBe(false);
  });

  it("GET /:id: same for the detail (requester and manager)", async () => {
    const { ctx, id } = await editedSetup();
    for (const cookie of [ctx.cookie, ctx.managerCookie, ctx.hrCookie]) {
      const res = await detail(cookie, id);
      expect(res.status).toBe(200);
      expect(res.body.leaveRequest.countsAgainstVacationBalance).toBe(true);
      expect(res.body.leaveRequest.leaveType.countsAgainstVacationBalance).toBe(false);
    }
  });

  it("GET /pending-approvals: same for the manager's list", async () => {
    const { ctx } = await editedSetup();
    const res = await request(app).get("/api/leave-requests/pending-approvals").set("Cookie", ctx.managerCookie);
    expect(res.body.leaveRequests).toHaveLength(1);
    expect(res.body.leaveRequests[0].countsAgainstVacationBalance).toBe(true);
    expect(res.body.leaveRequests[0].leaveType.countsAgainstVacationBalance).toBe(false);
  });

  it("approve response exposes the copy too", async () => {
    const { ctx, id } = await editedSetup();
    const res = await approve(ctx, id);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.countsAgainstVacationBalance).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const MIGRATION_SQL = readFileSync(
  new URL("../../../prisma/migrations/20261118182322_snapshot_counts_against_balance/migration.sql", import.meta.url),
  "utf8",
);

/** The single UPDATE between the "-- backfill" and "-- end backfill" markers, without comment lines. */
function extractBackfill(sql: string): string {
  const lines = sql.split("\n");
  const start = lines.findIndex((l) => /^--\s*backfill\b/.test(l));
  const end = lines.findIndex((l) => /^--\s*end backfill\b/.test(l));
  if (start < 0 || end < 0 || end <= start) throw new Error("backfill markers not found in migration.sql");
  return lines
    .slice(start + 1, end)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();
}

class Rollback extends Error {}

describe("migration snapshot_counts_against_balance: backfill statement", () => {
  it("the markers enclose exactly one UPDATE statement", () => {
    const sql = extractBackfill(MIGRATION_SQL);
    expect(sql).toMatch(/^UPDATE\s+"leave_requests"/);
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql.endsWith(";")).toBe(true);
  });

  it("sets every request's copy to its leave type's current value (run inside a rolled-back transaction)", async () => {
    const user = await createUser();
    const other = await createUser();
    const vac = await createLeaveType({ code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true });
    const sick = await createLeaveType({ code: "SICK", name: "Incapacidad", countsAgainstVacationBalance: false });
    const per = await createLeaveType({ code: "PER", name: "Personal", countsAgainstVacationBalance: false });
    const rows = [
      await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-16", businessDays: 1 }),
      await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: vac.id, start: "2026-11-17", end: "2026-11-17", businessDays: 1, status: "APPROVED" }),
      await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: sick.id, start: "2026-11-18", end: "2026-11-18", businessDays: 1 }),
      await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: sick.id, start: "2026-11-18", end: "2026-11-18", businessDays: 1, status: "CANCELLED" }),
      await createLeaveRequestRow({ requesterId: other.id, leaveTypeId: per.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 }),
      await createLeaveRequestRow({ requesterId: other.id, leaveTypeId: vac.id, start: "2026-11-23", end: "2026-11-23", businessDays: 1, status: "REJECTED" }),
    ];
    const original = new Map(rows.map((r) => [r.id, r.countsAgainstVacationBalance]));
    const backfill = extractBackfill(MIGRATION_SQL);

    let inside: { id: string; copy: boolean | null; type_value: boolean }[] = [];
    let updatedCount = -1;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "leave_requests" ALTER COLUMN "counts_against_vacation_balance" DROP NOT NULL`);
        // Break the copy on purpose: NULL on some rows, inverted on others, of every type.
        await tx.$executeRaw`UPDATE leave_requests SET counts_against_vacation_balance = NULL WHERE id IN (${rows[0]!.id}, ${rows[2]!.id}, ${rows[4]!.id})`;
        await tx.$executeRaw`UPDATE leave_requests SET counts_against_vacation_balance = NOT counts_against_vacation_balance WHERE id IN (${rows[1]!.id}, ${rows[3]!.id}, ${rows[5]!.id})`;
        const broken = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
          WHERE lr.counts_against_vacation_balance IS DISTINCT FROM lt.counts_against_vacation_balance`;
        expect(Number(broken[0]!.n)).toBe(6);

        updatedCount = await tx.$executeRawUnsafe(backfill);

        inside = await tx.$queryRaw`
          SELECT lr.id, lr.counts_against_vacation_balance AS copy, lt.counts_against_vacation_balance AS type_value
          FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id`;
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(updatedCount).toBe(6);
    expect(inside).toHaveLength(6);
    for (const row of inside) {
      expect(row.copy).not.toBeNull();
      expect(row.copy).toBe(row.type_value);
    }
    const byId = new Map(inside.map((r) => [r.id, r.copy]));
    expect(byId.get(rows[0]!.id)).toBe(true);
    expect(byId.get(rows[2]!.id)).toBe(false);
    expect(byId.get(rows[4]!.id)).toBe(false);
    expect(byId.get(rows[5]!.id)).toBe(true);

    // The rollback restored both the data and the NOT NULL constraint.
    const after = await prisma.leaveRequest.findMany();
    for (const r of after) expect(r.countsAgainstVacationBalance).toBe(original.get(r.id));
    const [col] = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'leave_requests' AND column_name = 'counts_against_vacation_balance'`;
    expect(col!.is_nullable).toBe("NO");
  });

  it("the backfill takes the type's CURRENT value, not the one the request was created with", async () => {
    const user = await createUser();
    const vac = await createLeaveType({ code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true });
    const row = await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-16", businessDays: 1 });
    const backfill = extractBackfill(MIGRATION_SQL);

    let copy: boolean | undefined;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.leaveType.update({ where: { id: vac.id }, data: { countsAgainstVacationBalance: false } });
        await tx.$executeRawUnsafe(backfill);
        copy = (await tx.leaveRequest.findUniqueOrThrow({ where: { id: row.id } })).countsAgainstVacationBalance;
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(copy).toBe(false);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: row.id } })).countsAgainstVacationBalance).toBe(true);
  });
});
