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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function getBalance(userId: string) {
  return request(app).get("/api/me/balance").set("Cookie", await authCookie(userId));
}

describe("GET /api/me/balance", () => {
  it("returns 401 without an auth cookie", async () => {
    const res = await request(app).get("/api/me/balance");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it("returns 401 for an inactive user even with a valid token", async () => {
    const user = await createUser({ isActive: false });
    const res = await getBalance(user.id);
    expect(res.status).toBe(401);
  });

  it("returns the full balance for 3 years of service (16 days, anniversary period)", async () => {
    const user = await createUser({ hireDate: "2023-02-01" });
    const res = await getBalance(user.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      balance: {
        asOf: "2026-11-11",
        period: { start: "2026-02-01", end: "2027-01-31" },
        yearsOfService: 3,
        earned: 16,
        adjustments: 0,
        approved: 0,
        pending: 0,
        available: 16,
      },
    });
  });

  it("subtracts APPROVED and PENDING requests and adds adjustments within the period", async () => {
    const user = await createUser({ hireDate: "2023-02-01" });
    const vac = await createLeaveType({ code: "VAC" });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2026-03-02", end: "2026-03-04", businessDays: 3, status: "APPROVED",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2026-12-07", end: "2026-12-08", businessDays: 2, status: "PENDING",
    });
    await createAdjustment(user.id, 2, "2026-05-01");
    await createAdjustment(user.id, -1, "2026-06-01");

    const res = await getBalance(user.id);
    expect(res.body.balance).toMatchObject({
      earned: 16,
      approved: 3,
      pending: 2,
      adjustments: 1,
      available: 16 + 1 - 3 - 2,
    });
  });

  it("ignores requests and adjustments outside the current anniversary period (period boundaries)", async () => {
    const user = await createUser({ hireDate: "2023-02-01" });
    const vac = await createLeaveType({ code: "VAC" });
    // Previous period ends 2026-01-31.
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2026-01-30", end: "2026-01-30", businessDays: 1, status: "APPROVED",
    });
    // Next period starts 2027-02-01.
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2027-02-01", end: "2027-02-02", businessDays: 2, status: "PENDING",
    });
    await createAdjustment(user.id, 5, "2026-01-31");
    await createAdjustment(user.id, 5, "2027-02-01");
    // Exactly on the boundaries of the current period: counted.
    await createAdjustment(user.id, 1, "2026-02-01");
    await createAdjustment(user.id, 1, "2027-01-31");

    const res = await getBalance(user.id);
    expect(res.body.balance).toMatchObject({ approved: 0, pending: 0, adjustments: 2, available: 18 });
  });

  it("gives 0 earned days and a period starting on hireDate to someone with less than 1 year", async () => {
    const user = await createUser({ hireDate: "2026-03-15" });
    const res = await getBalance(user.id);
    expect(res.body.balance).toMatchObject({
      yearsOfService: 0,
      earned: 0,
      available: 0,
      period: { start: "2026-03-15", end: "2027-03-14" },
    });
  });

  it("starts a new period exactly on the anniversary date (hired 2025-11-11 => 1 year, 12 days)", async () => {
    const user = await createUser({ hireDate: "2025-11-11" });
    const res = await getBalance(user.id);
    expect(res.body.balance).toMatchObject({
      yearsOfService: 1,
      earned: 12,
      period: { start: "2026-11-11", end: "2027-11-10" },
    });
  });

  it("does not subtract requests whose leave type does not count against the vacation balance", async () => {
    const user = await createUser({ hireDate: "2023-02-01" });
    const sick = await createLeaveType({ code: "SICK", countsAgainstVacationBalance: false });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: sick.id, start: "2026-03-02", end: "2026-03-06", businessDays: 5, status: "APPROVED",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: sick.id, start: "2026-12-07", end: "2026-12-08", businessDays: 2, status: "PENDING",
    });

    const res = await getBalance(user.id);
    expect(res.body.balance).toMatchObject({ approved: 0, pending: 0, available: 16 });
  });

  it("does not subtract REJECTED or CANCELLED requests", async () => {
    const user = await createUser({ hireDate: "2023-02-01" });
    const vac = await createLeaveType({ code: "VAC" });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2026-03-02", end: "2026-03-06", businessDays: 5, status: "REJECTED",
    });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2026-03-02", end: "2026-03-06", businessDays: 5, status: "CANCELLED",
    });

    const res = await getBalance(user.id);
    expect(res.body.balance).toMatchObject({ approved: 0, pending: 0, available: 16 });
  });

  it("does not count other users' requests", async () => {
    const user = await createUser({ hireDate: "2023-02-01" });
    const other = await createUser({ hireDate: "2023-02-01" });
    const vac = await createLeaveType({ code: "VAC" });
    await createLeaveRequestRow({
      requesterId: other.id, leaveTypeId: vac.id, start: "2026-03-02", end: "2026-03-06", businessDays: 5, status: "APPROVED",
    });
    const res = await getBalance(user.id);
    expect(res.body.balance.available).toBe(16);
  });

  it("employee hired on Feb 29 (2024-02-29): at 2026-11-11 has 2 years, 14 days, period from the Feb 28 anniversary", async () => {
    const user = await createUser({ hireDate: "2024-02-29" });
    const res = await getBalance(user.id);
    expect(res.status).toBe(200);
    expect(res.body.balance).toMatchObject({
      yearsOfService: 2,
      earned: 14,
      available: 14,
      period: { start: "2026-02-28", end: "2027-02-27" },
    });
  });

  it("uses the company timezone for asOf (03:00 UTC on Nov 12 is still Nov 11 in Monterrey)", async () => {
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
    const user = await createUser({ hireDate: "2025-11-12" });
    const res = await getBalance(user.id);
    // In Monterrey the first anniversary (Nov 12) has not happened yet.
    expect(res.body.balance).toMatchObject({ asOf: "2026-11-11", yearsOfService: 0, earned: 0 });
  });
});
