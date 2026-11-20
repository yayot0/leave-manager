import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { Prisma } from "../../generated/prisma/client.js";
import { authCookie, createHoliday, createLeaveType, createUser, prisma, resetDb } from "../../test/db.js";

const app = createApp();

let hr: { id: string };
let hrCookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
  await resetDb();
  hr = await createUser({ role: "HR" });
  hrCookie = await authCookie(hr.id);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const send = (method: "post" | "patch" | "delete", path: string, body?: object) => {
  const req = request(app)[method](`/api/hr${path}`).set("Cookie", hrCookie);
  return body ? req.send(body) : req;
};

async function onlyAuditRow() {
  const rows = await prisma.hrAuditLog.findMany();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** The pg error behind a Prisma error (SQLSTATE and message), as @prisma/adapter-pg exposes it. */
async function pgErrorOf(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) throw err;
    const cause = (err.meta?.driverAdapterError as { cause?: { originalCode?: string; code?: string; message?: string } } | undefined)?.cause;
    return { code: String(cause?.originalCode ?? cause?.code), message: String(cause?.message) };
  }
  throw new Error("Expected the operation to fail, but it succeeded");
}

async function seedAuditRow() {
  const res = await send("post", "/departments", { name: "Ventas" });
  expect(res.status).toBe(201);
  return onlyAuditRow();
}

describe("each HR change writes exactly one audit row with whitelisted snapshots", () => {
  it("department CREATED: before null, after {id, name}", async () => {
    const res = await send("post", "/departments", { name: "Ventas" });
    const row = await onlyAuditRow();
    expect(row).toMatchObject({
      actorId: hr.id,
      entityType: "DEPARTMENT",
      entityId: res.body.department.id,
      action: "CREATED",
      before: null,
      after: { id: res.body.department.id, name: "Ventas" },
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("department UPDATED (rename): before and after with only {id, name}", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await send("patch", `/departments/${dept.id}`, { name: "Comercial" });
    const row = await onlyAuditRow();
    expect(row).toMatchObject({ actorId: hr.id, entityType: "DEPARTMENT", entityId: dept.id, action: "UPDATED" });
    expect(row.before).toEqual({ id: dept.id, name: "Ventas" });
    expect(row.after).toEqual({ id: dept.id, name: "Comercial" });
  });

  it("department DELETED: before {id, name}, after null", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await send("delete", `/departments/${dept.id}`);
    const row = await onlyAuditRow();
    expect(row).toMatchObject({ entityType: "DEPARTMENT", entityId: dept.id, action: "DELETED", after: null });
    expect(row.before).toEqual({ id: dept.id, name: "Ventas" });
  });

  it("leave type CREATED: after has exactly the whitelisted fields (no timestamps, no requestCount)", async () => {
    const res = await send("post", "/leave-types", {
      // 12 = the Art. 78 LFT minimum for a type that counts against vacations.
      code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12,
    });
    const row = await onlyAuditRow();
    expect(row).toMatchObject({ actorId: hr.id, entityType: "LEAVE_TYPE", entityId: res.body.leaveType.id, action: "CREATED", before: null });
    expect(row.after).toEqual({
      id: res.body.leaveType.id,
      code: "VAC",
      name: "Vacaciones",
      countsAgainstVacationBalance: true,
      maxBusinessDaysPerRequest: 12,
      isActive: true,
    });
  });

  it("leave type UPDATED: before/after show the full whitelisted picture on both sides", async () => {
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    await send("patch", `/leave-types/${type.id}`, { countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 3 });
    const row = await onlyAuditRow();
    expect(row.action).toBe("UPDATED");
    expect(row.before).toEqual({
      id: type.id, code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: null, isActive: true,
    });
    expect(row.after).toEqual({
      id: type.id, code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 3, isActive: true,
    });
  });

  it("leave type DEACTIVATED and then REACTIVATED: two rows, in order, with isActive flipping", async () => {
    const type = await createLeaveType();
    await send("patch", `/leave-types/${type.id}`, { isActive: false });
    vi.setSystemTime(new Date("2026-11-11T18:00:01Z"));
    await send("patch", `/leave-types/${type.id}`, { isActive: true });
    const rows = await prisma.hrAuditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["DEACTIVATED", "REACTIVATED"]);
    expect(rows[0]!.before).toMatchObject({ isActive: true });
    expect(rows[0]!.after).toMatchObject({ isActive: false });
    expect(rows[1]!.before).toMatchObject({ isActive: false });
    expect(rows[1]!.after).toMatchObject({ isActive: true });
  });

  it("holiday CREATED: after {id, date (YYYY-MM-DD), name}", async () => {
    const res = await send("post", "/holidays", { date: "2026-12-25", name: "Navidad" });
    const row = await onlyAuditRow();
    expect(row).toMatchObject({ actorId: hr.id, entityType: "HOLIDAY", entityId: res.body.holiday.id, action: "CREATED", before: null });
    expect(row.after).toEqual({ id: res.body.holiday.id, date: "2026-12-25", name: "Navidad" });
  });

  it("holiday DELETED: before {id, date (YYYY-MM-DD), name}, after null", async () => {
    const holiday = await createHoliday("2028-02-29", "Bisiesto");
    await send("delete", `/holidays/${holiday.id}`);
    const row = await onlyAuditRow();
    expect(row).toMatchObject({ entityType: "HOLIDAY", entityId: holiday.id, action: "DELETED", after: null });
    expect(row.before).toEqual({ id: holiday.id, date: "2028-02-29", name: "Bisiesto" });
  });

  it("a deleted department's audit trail survives (entity_id has no FK)", async () => {
    const created = await send("post", "/departments", { name: "Ventas" });
    await send("delete", `/departments/${created.body.department.id}`);
    const rows = await prisma.hrAuditLog.findMany({ where: { entityId: created.body.department.id } });
    expect(rows.map((r) => r.action).sort()).toEqual(["CREATED", "DELETED"]);
  });

  it("GETs never write to the audit log", async () => {
    await createHoliday("2026-12-25");
    await request(app).get("/api/hr/departments").set("Cookie", hrCookie);
    await request(app).get("/api/hr/leave-types").set("Cookie", hrCookie);
    await request(app).get("/api/hr/holidays?year=2026").set("Cookie", hrCookie);
    await request(app).get("/api/hr/holidays/impact?date=2026-12-25").set("Cookie", hrCookie);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });
});

describe("a failed change leaves no audit row (same transaction)", () => {
  it.each([
    ["department 409 DUPLICATE_NAME", async () => {
      await prisma.department.create({ data: { name: "Ventas" } });
      return send("post", "/departments", { name: "ventas" });
    }, 409],
    ["department rename 409", async () => {
      await prisma.department.create({ data: { name: "Ventas" } });
      const other = await prisma.department.create({ data: { name: "Compras" } });
      return send("patch", `/departments/${other.id}`, { name: "VENTAS" });
    }, 409],
    ["department delete 409 DEPARTMENT_HAS_EMPLOYEES", async () => {
      const dept = await prisma.department.create({ data: { name: "Ventas" } });
      const user = await createUser();
      await prisma.user.update({ where: { id: user.id }, data: { departmentId: dept.id } });
      return send("delete", `/departments/${dept.id}`);
    }, 409],
    ["department 400", async () => send("post", "/departments", { name: "" }), 400],
    ["department 404", async () => send("delete", "/departments/nope"), 404],
    ["leave type 409 DUPLICATE_CODE", async () => {
      await createLeaveType({ code: "VAC", name: "Vacaciones" });
      return send("post", "/leave-types", { code: "VAC", name: "Otro", countsAgainstVacationBalance: true });
    }, 409],
    ["leave type 409 DUPLICATE_NAME on PATCH", async () => {
      await createLeaveType({ code: "VAC", name: "Vacaciones" });
      const other = await createLeaveType({ code: "SICK", name: "Incapacidad" });
      return send("patch", `/leave-types/${other.id}`, { name: "Vacaciones", isActive: false });
    }, 409],
    ["leave type 400 (code on PATCH)", async () => {
      const type = await createLeaveType();
      return send("patch", `/leave-types/${type.id}`, { code: "NEW" });
    }, 400],
    ["holiday 409 DUPLICATE_DATE", async () => {
      await createHoliday("2026-12-25");
      return send("post", "/holidays", { date: "2026-12-25", name: "Navidad" });
    }, 409],
    ["holiday 400", async () => send("post", "/holidays", { date: "2027-02-29", name: "Navidad" }), 400],
    ["holiday 404", async () => send("delete", "/holidays/nope"), 404],
  ])("%s", async (_label, run, status) => {
    const res = await run();
    expect(res.status).toBe(status);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("the PATCH that failed with 409 did not apply the other field either (all or nothing)", async () => {
    await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const other = await createLeaveType({ code: "SICK", name: "Incapacidad" });
    await send("patch", `/leave-types/${other.id}`, { name: "Vacaciones", isActive: false });
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: other.id } })).isActive).toBe(true);
  });
});

describe("hr_audit_logs is append-only at the database level", () => {
  it("UPDATE through Prisma fails with SQLSTATE 42501 and an 'append-only' message; the row is unchanged", async () => {
    const row = await seedAuditRow();
    const err = await pgErrorOf(() => prisma.hrAuditLog.update({ where: { id: row.id }, data: { entityId: "forged" } }));
    expect(err.code).toBe("42501");
    expect(err.message).toContain("append-only");
    expect(err.message).toContain("UPDATE");
    expect(await prisma.hrAuditLog.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it("raw UPDATE fails with 42501 too", async () => {
    await seedAuditRow();
    const err = await pgErrorOf(() => prisma.$executeRaw`UPDATE hr_audit_logs SET action = 'DELETED'`);
    expect(err.code).toBe("42501");
    expect(err.message).toContain("append-only");
  });

  it("DELETE through Prisma fails with 42501 'append-only'", async () => {
    const row = await seedAuditRow();
    const err = await pgErrorOf(() => prisma.hrAuditLog.delete({ where: { id: row.id } }));
    expect(err.code).toBe("42501");
    expect(err.message).toContain("append-only");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("raw DELETE of every row fails with 42501 and keeps them all", async () => {
    await seedAuditRow();
    await send("post", "/departments", { name: "Compras" });
    const err = await pgErrorOf(() => prisma.$executeRaw`DELETE FROM hr_audit_logs`);
    expect(err.code).toBe("42501");
    expect(err.message).toContain("DELETE");
    expect(await prisma.hrAuditLog.count()).toBe(2);
  });

  it("TRUNCATE without app.allow_audit_truncate fails with 42501 'append-only'", async () => {
    await seedAuditRow();
    const err = await pgErrorOf(() => prisma.$executeRawUnsafe(`TRUNCATE "hr_audit_logs"`));
    expect(err.code).toBe("42501");
    expect(err.message).toContain("append-only");
    expect(err.message).toContain("TRUNCATE");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("TRUNCATE users CASCADE also fails (it would reach hr_audit_logs) and truncates nothing", async () => {
    await seedAuditRow();
    const users = await prisma.user.count();
    const err = await pgErrorOf(() => prisma.$executeRawUnsafe(`TRUNCATE "users" CASCADE`));
    expect(err.code).toBe("42501");
    expect(err.message).toContain("append-only");
    expect(await prisma.user.count()).toBe(users);
    expect(await prisma.department.count()).toBe(1);
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("TRUNCATE with app.allow_audit_truncate set to something other than 'on' still fails", async () => {
    await seedAuditRow();
    const err = await pgErrorOf(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.allow_audit_truncate', 'true', true)`;
        await tx.$executeRawUnsafe(`TRUNCATE "hr_audit_logs"`);
      }),
    );
    expect(err.code).toBe("42501");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("TRUNCATE works inside a transaction that sets app.allow_audit_truncate = 'on' locally", async () => {
    await seedAuditRow();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.allow_audit_truncate', 'on', true)`;
      await tx.$executeRawUnsafe(`TRUNCATE "hr_audit_logs"`);
    });
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("the local setting does not outlive its transaction: a later TRUNCATE fails again", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.allow_audit_truncate', 'on', true)`;
    });
    await seedAuditRow();
    const err = await pgErrorOf(() => prisma.$executeRawUnsafe(`TRUNCATE "hr_audit_logs"`));
    expect(err.code).toBe("42501");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("the setting does NOT allow UPDATE or DELETE (it only opens TRUNCATE)", async () => {
    await seedAuditRow();
    const err = await pgErrorOf(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.allow_audit_truncate', 'on', true)`;
        await tx.$executeRaw`DELETE FROM hr_audit_logs`;
      }),
    );
    expect(err.code).toBe("42501");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("an HR user with audit rows cannot be deleted (actor FK RESTRICT)", async () => {
    await seedAuditRow();
    await expect(prisma.user.delete({ where: { id: hr.id } })).rejects.toThrow();
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });
});

describe("hr_audit_logs CHECK constraints (snapshots match the action)", () => {
  const base = () => ({ actorId: hr.id, entityType: "DEPARTMENT" as const, entityId: "x" });

  it.each([
    ["CREATED with a before", { action: "CREATED" as const, before: { id: "x" }, after: { id: "x" } }],
    ["CREATED without an after", { action: "CREATED" as const, before: Prisma.DbNull, after: Prisma.DbNull }],
    ["DELETED with an after", { action: "DELETED" as const, before: { id: "x" }, after: { id: "x" } }],
    ["UPDATED without a before", { action: "UPDATED" as const, before: Prisma.DbNull, after: { id: "x" } }],
    ["DEACTIVATED without an after", { action: "DEACTIVATED" as const, before: { id: "x" }, after: Prisma.DbNull }],
    ["a JSON null (not SQL NULL) as after", { action: "CREATED" as const, before: Prisma.DbNull, after: Prisma.JsonNull }],
    ["a bare string as after", { action: "CREATED" as const, before: Prisma.DbNull, after: "x" }],
    ["an array as before", { action: "DELETED" as const, before: ["x"], after: Prisma.DbNull }],
  ])("rejects %s", async (_label, data) => {
    await expect(prisma.hrAuditLog.create({ data: { ...base(), ...data } })).rejects.toThrow();
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("accepts a valid REACTIVATED row (both snapshots are objects)", async () => {
    await prisma.hrAuditLog.create({ data: { ...base(), action: "REACTIVATED", before: { a: 1 }, after: { a: 2 } } });
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });
});
