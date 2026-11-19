import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import { createUser, prisma, resetDb } from "../../test/db.js";
import { recordHrAudit } from "./audit.js";

// Database-level guarantees of hr_audit_logs (append-only triggers, CHECKs).
// Entries are written with recordHrAudit directly: the HR endpoints that
// write them in real use, and their tests, come with the HR catalogs.

let hr: { id: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T18:00:00Z"));
  await resetDb();
  hr = await createUser({ role: "HR" });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

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

/** Creates a department and its CREATED entry in one transaction, as the HR endpoint will. */
async function insertAuditRow(name: string) {
  await prisma.$transaction(async (tx) => {
    const department = await tx.department.create({ data: { name } });
    await recordHrAudit(tx, {
      actorId: hr.id,
      entityType: "DEPARTMENT",
      entityId: department.id,
      action: "CREATED",
      before: null,
      after: { id: department.id, name },
    });
  });
}

async function seedAuditRow() {
  await insertAuditRow("Ventas");
  const rows = await prisma.hrAuditLog.findMany();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

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
    await insertAuditRow("Compras");
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
