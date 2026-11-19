import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { authCookie, createHoliday, createLeaveType, createUser, prisma, resetDb } from "../../test/db.js";

const app = createApp();

/**
 * "Today" is Wednesday 2026-11-11 in America/Monterrey.
 * 2026-11-16 Mon .. 20 Fri; 21 Sat; 22 Sun; 23 Mon.
 * Employee hired 2023-02-01: 16 vacation days in 2026-02-01..2027-01-31.
 */
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

async function setup(opts: { max?: number | null; counts?: boolean } = {}) {
  const manager = await createUser({ role: "MANAGER" });
  const hr = await createUser({ role: "HR" });
  const employee = await createUser({ hireDate: "2023-02-01", managerId: manager.id });
  const type = await createLeaveType({
    code: "PER",
    name: "Día personal",
    countsAgainstVacationBalance: opts.counts ?? false,
    maxBusinessDaysPerRequest: opts.max === undefined ? 1 : opts.max,
  });
  return {
    type,
    cookie: await authCookie(employee.id),
    managerCookie: await authCookie(manager.id),
    hrCookie: await authCookie(hr.id),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const post = (ctx: Ctx, startDate: string, endDate: string, leaveTypeId = ctx.type.id) =>
  request(app).post("/api/leave-requests").set("Cookie", ctx.cookie).send({ leaveTypeId, startDate, endDate });

const preview = (ctx: Ctx, startDate: string, endDate: string, leaveTypeId = ctx.type.id) =>
  request(app).get("/api/leave-requests/preview").query({ leaveTypeId, startDate, endDate }).set("Cookie", ctx.cookie);

const codes = (res: request.Response) => res.body.preview.problems.map((p: { code: string }) => p.code);

describe("EXCEEDS_TYPE_LIMIT: maxBusinessDaysPerRequest of the leave type", () => {
  it("2 business days on a type with max 1: POST 400 EXCEEDS_TYPE_LIMIT and nothing is written", async () => {
    const ctx = await setup({ max: 1 });
    const res = await post(ctx, "2026-11-16", "2026-11-17");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.stringContaining("máximo 1 día hábil"), code: "EXCEEDS_TYPE_LIMIT" });
    expect(res.body.error).toContain("Día personal");
    expect(res.body.error).toContain("tiene 2");
    expect(await prisma.leaveRequest.count()).toBe(0);
    expect(await prisma.requestEvent.count()).toBe(0);
  });

  it("the preview answers 200 with that same problem and canSubmit false", async () => {
    const ctx = await setup({ max: 1 });
    const res = await preview(ctx, "2026-11-16", "2026-11-17");
    expect(res.status).toBe(200);
    expect(res.body.preview.businessDays).toBe(2);
    expect(codes(res)).toEqual(["EXCEEDS_TYPE_LIMIT"]);
    expect(res.body.preview.canSubmit).toBe(false);
    const post400 = await post(ctx, "2026-11-16", "2026-11-17");
    expect(res.body.preview.problems[0].message).toBe(post400.body.error);
  });

  it("uses plural in the message for a limit greater than 1", async () => {
    const ctx = await setup({ max: 3 });
    const res = await post(ctx, "2026-11-16", "2026-11-19");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("máximo 3 días hábiles");
  });

  it.each([
    [1, "2026-11-16", "2026-11-16"],
    [5, "2026-11-16", "2026-11-20"],
  ])("exactly the max (%i) is accepted (201) and the preview has no problems", async (max, start, end) => {
    const ctx = await setup({ max });
    const pre = await preview(ctx, start, end);
    expect(pre.body.preview.canSubmit).toBe(true);
    const res = await post(ctx, start, end);
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(max);
  });

  it("one day over the max (5 -> 6 business days) is refused", async () => {
    const ctx = await setup({ max: 5 });
    const res = await post(ctx, "2026-11-16", "2026-11-23");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EXCEEDS_TYPE_LIMIT");
  });

  it("weekends do not count toward the limit: Fri..Sun is 1 business day (OK with max 1)", async () => {
    const ctx = await setup({ max: 1 });
    const res = await post(ctx, "2026-11-20", "2026-11-22");
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(1);
  });

  it("but Fri..Mon is 2 business days: refused with max 1", async () => {
    const ctx = await setup({ max: 1 });
    const res = await post(ctx, "2026-11-20", "2026-11-23");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EXCEEDS_TYPE_LIMIT");
  });

  it("holidays do not count toward the limit: Mon..Tue with Tue holiday is 1 business day (OK with max 1)", async () => {
    const ctx = await setup({ max: 1 });
    await createHoliday("2026-11-17", "Festivo");
    const pre = await preview(ctx, "2026-11-16", "2026-11-17");
    expect(pre.body.preview.businessDays).toBe(1);
    expect(pre.body.preview.canSubmit).toBe(true);
    expect((await post(ctx, "2026-11-16", "2026-11-17")).status).toBe(201);
  });

  it("a range of only weekend days reports NO_BUSINESS_DAYS, not EXCEEDS_TYPE_LIMIT", async () => {
    const ctx = await setup({ max: 1 });
    const res = await preview(ctx, "2026-11-21", "2026-11-22");
    expect(codes(res)).toEqual(["NO_BUSINESS_DAYS"]);
  });

  it("a type without max (null) has no limit: 16 business days are accepted", async () => {
    const ctx = await setup({ max: null });
    const res = await post(ctx, "2026-11-16", "2026-12-07");
    expect(res.status).toBe(201);
    expect(res.body.leaveRequest.businessDays).toBe(16);
  });

  it("an inactive type with a max reports only INVALID_LEAVE_TYPE (no EXCEEDS_TYPE_LIMIT)", async () => {
    const ctx = await setup({ max: 1 });
    await prisma.leaveType.update({ where: { id: ctx.type.id }, data: { isActive: false } });
    const res = await preview(ctx, "2026-11-16", "2026-11-20");
    expect(codes(res)).toEqual(["INVALID_LEAVE_TYPE"]);
    expect((await post(ctx, "2026-11-16", "2026-11-20")).body.code).toBe("INVALID_LEAVE_TYPE");
  });

  it("is phase 1: with both EXCEEDS_TYPE_LIMIT and INSUFFICIENT_BALANCE the POST reports EXCEEDS_TYPE_LIMIT (400), the preview both", async () => {
    // Counts against a 16-day balance; 17 business days exceed both the max and the balance.
    const ctx = await setup({ max: 10, counts: true });
    const pre = await preview(ctx, "2026-11-16", "2026-12-08");
    expect(pre.body.preview.businessDays).toBe(17);
    expect(codes(pre)).toEqual(["EXCEEDS_TYPE_LIMIT", "INSUFFICIENT_BALANCE"]);
    const res = await post(ctx, "2026-11-16", "2026-12-08");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EXCEEDS_TYPE_LIMIT");
  });

  it("with a past start date the preview reports START_IN_PAST and EXCEEDS_TYPE_LIMIT together", async () => {
    const ctx = await setup({ max: 1 });
    const res = await preview(ctx, "2026-11-09", "2026-11-10");
    expect(codes(res)).toEqual(["START_IN_PAST", "EXCEEDS_TYPE_LIMIT"]);
  });

  it("raising the limit lets the same request through", async () => {
    const ctx = await setup({ max: 1 });
    expect((await post(ctx, "2026-11-16", "2026-11-17")).status).toBe(400);
    await prisma.leaveType.update({ where: { id: ctx.type.id }, data: { maxBusinessDaysPerRequest: 2 } });
    expect((await post(ctx, "2026-11-16", "2026-11-17")).status).toBe(201);
  });

  it("removing the limit (null) lets a long request through", async () => {
    const ctx = await setup({ max: 1 });
    await prisma.leaveType.update({ where: { id: ctx.type.id }, data: { maxBusinessDaysPerRequest: null } });
    expect((await post(ctx, "2026-11-16", "2026-11-20")).status).toBe(201);
  });

  it("lowering the max does not affect existing PENDING requests: they can still be approved", async () => {
    const ctx = await setup({ max: 5 });
    const created = await post(ctx, "2026-11-16", "2026-11-20");
    expect(created.status).toBe(201);

    await prisma.leaveType.update({ where: { id: ctx.type.id }, data: { maxBusinessDaysPerRequest: 1 } });

    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: created.body.leaveRequest.id } });
    expect(row).toMatchObject({ status: "PENDING", businessDays: 5 });

    const res = await request(app)
      .post(`/api/leave-requests/${created.body.leaveRequest.id}/approve`)
      .set("Cookie", ctx.managerCookie);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.status).toBe("APPROVED");

    // A new one with the same length is now refused.
    expect((await post(ctx, "2026-11-23", "2026-11-27")).body.code).toBe("EXCEEDS_TYPE_LIMIT");
  });

  it("the public catalog exposes maxBusinessDaysPerRequest so the form can show it", async () => {
    const ctx = await setup({ max: 3 });
    const res = await request(app).get("/api/leave-types").set("Cookie", ctx.cookie);
    expect(res.body.leaveTypes[0]).toMatchObject({ id: ctx.type.id, maxBusinessDaysPerRequest: 3 });
  });
});
