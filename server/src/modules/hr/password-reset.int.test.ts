import { inspect } from "node:util";
import request from "supertest";
import { verify } from "@node-rs/argon2";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createApp } from "../../app.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AUTH_COOKIE_NAME } from "../auth/cookie.js";
import { hashPassword } from "../../security/password.js";
import { authCookie, createUser, prisma, resetDb } from "../../test/db.js";
import type { Role } from "../../generated/prisma/enums.js";

const app = createApp();

/**
 * Real timers: passwordChangedAt and the session tokens should behave as in
 * production. The login limiter (5 failures per IP, module memory) is shared
 * by the whole file; failed logins here stay under 5.
 */

const TEMP_FORMAT = /^[a-km-np-z2-9]{5}(-[a-km-np-z2-9]{5}){3}$/;
const ORIGINAL = "contraseña original del empleado";

let hr: { id: string };
let hrCookie: string;

beforeEach(async () => {
  await resetDb();
  hr = await createUser({ role: "HR" });
  hrCookie = await authCookie(hr.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function employee(opts: { role?: Role; isActive?: boolean } = {}) {
  const user = await createUser({ role: opts.role, isActive: opts.isActive });
  return prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(ORIGINAL) } });
}

/** `cookie: null` sends no cookie at all (a default parameter would swallow `undefined`). */
function reset(employeeId: string, cookie: string | null = hrCookie) {
  const req = request(app).post(`/api/hr/employees/${encodeURIComponent(employeeId)}/reset-password`);
  return cookie ? req.set("Cookie", cookie) : req;
}

function login(email: string, password: string) {
  return request(app).post("/api/auth/login").send({ email, password });
}

function cookieFrom(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  expect(cookie, "response should set the auth cookie").toBeDefined();
  return cookie!.split(";")[0]!;
}

/** The pg error behind a Prisma error (SQLSTATE and message), as in audit-log.int.test.ts. */
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

describe("POST /api/hr/employees/:id/reset-password: success", () => {
  it("responds 200 with a temporary password in the generator's format, the user and Cache-Control: no-store", async () => {
    const emp = await employee();
    const res = await reset(emp.id);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      temporaryPassword: expect.stringMatching(TEMP_FORMAT),
      user: { id: emp.id, email: emp.email, firstName: emp.firstName, lastName: emp.lastName },
    });
  });

  it("marks the password temporary and advances passwordChangedAt", async () => {
    const emp = await employee();
    await reset(emp.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });
    expect(after.mustChangePassword).toBe(true);
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(emp.passwordChangedAt.getTime());
  });

  it("stores only an argon2 hash of the temporary password, never the plain text", async () => {
    const emp = await employee();
    const { temporaryPassword } = (await reset(emp.id)).body as { temporaryPassword: string };

    const after = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });
    expect(after.passwordHash).not.toBe(temporaryPassword);
    expect(after.passwordHash).not.toContain(temporaryPassword);
    expect(after.passwordHash).toMatch(/^\$argon2/);
    expect(await verify(after.passwordHash, temporaryPassword)).toBe(true);
    expect(await verify(after.passwordHash, ORIGINAL)).toBe(false);
  });

  it("the employee logs in with it, and the session says mustChangePassword: true", async () => {
    const emp = await employee();
    const { temporaryPassword } = (await reset(emp.id)).body as { temporaryPassword: string };

    const res = await login(emp.email, temporaryPassword);
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);

    const cookie = cookieFrom(res);
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    const blocked = await request(app).get("/api/me/balance").set("Cookie", cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("the employee then replaces it with change-password and gets full access", async () => {
    const emp = await employee();
    const { temporaryPassword } = (await reset(emp.id)).body as { temporaryPassword: string };
    const session = cookieFrom(await login(emp.email, temporaryPassword));

    const same = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", session)
      .send({ currentPassword: temporaryPassword, newPassword: temporaryPassword });
    expect(same.body.code).toBe("PASSWORD_UNCHANGED");

    const changed = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", session)
      .send({ currentPassword: temporaryPassword, newPassword: "mi propia frase larga y secreta" });
    expect(changed.status).toBe(200);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookieFrom(changed))).status).toBe(200);
  });

  it("ends every session the employee had before the reset (401)", async () => {
    const emp = await employee();
    const before1 = await authCookie(emp.id);
    const before2 = await authCookie(emp.id);
    expect((await request(app).get("/api/auth/me").set("Cookie", before1)).status).toBe(200);

    await reset(emp.id);

    expect((await request(app).get("/api/auth/me").set("Cookie", before1)).status).toBe(401);
    expect((await request(app).get("/api/me/balance").set("Cookie", before2)).status).toBe(401);
  });

  it("the old password no longer works for login", async () => {
    const emp = await employee();
    await reset(emp.id);
    expect((await login(emp.email, ORIGINAL)).status).toBe(401);
  });

  it("a second reset gives ANOTHER password and the first one stops working", async () => {
    const emp = await employee();
    const first = (await reset(emp.id)).body.temporaryPassword as string;
    const second = (await reset(emp.id)).body.temporaryPassword as string;

    expect(second).toMatch(TEMP_FORMAT);
    expect(second).not.toBe(first);
    expect((await login(emp.email, first)).status).toBe(401);
    expect((await login(emp.email, second)).status).toBe(200);
    expect(await prisma.hrAuditLog.count({ where: { action: "PASSWORD_RESET" } })).toBe(2);
  });

  it("does not end the HR user's own session", async () => {
    const emp = await employee();
    await reset(emp.id);
    expect((await request(app).get("/api/hr/departments").set("Cookie", hrCookie)).status).toBe(200);
  });

  it("works for MANAGER and HR targets too (another HR user)", async () => {
    const manager = await employee({ role: "MANAGER" });
    const otherHr = await employee({ role: "HR" });
    expect((await reset(manager.id)).status).toBe(200);
    expect((await reset(otherHr.id)).status).toBe(200);
  });

  it("no GET returns the temporary password afterwards (e.g. the employee's /api/auth/me)", async () => {
    const emp = await employee();
    const { temporaryPassword } = (await reset(emp.id)).body as { temporaryPassword: string };
    const session = cookieFrom(await login(emp.email, temporaryPassword));

    const responses = [
      await request(app).get("/api/auth/me").set("Cookie", session),
      await request(app).get("/api/hr/employees/count").set("Cookie", hrCookie),
      await request(app).get("/api/auth/me").set("Cookie", hrCookie),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(temporaryPassword);
      expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    }
  });
});

describe("reset-password: audit log", () => {
  it("writes exactly one EMPLOYEE / PASSWORD_RESET row with before/after = {mustChangePassword, passwordChangedAt}", async () => {
    const emp = await employee();
    await reset(emp.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });

    const rows = await prisma.hrAuditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ actorId: hr.id, entityType: "EMPLOYEE", entityId: emp.id, action: "PASSWORD_RESET" });
    expect(row.before).toEqual({
      mustChangePassword: false,
      passwordChangedAt: emp.passwordChangedAt.toISOString(),
    });
    expect(row.after).toEqual({
      mustChangePassword: true,
      passwordChangedAt: after.passwordChangedAt.toISOString(),
    });
  });

  it("the temporary password (and the hash) appear in NO field of the audit row", async () => {
    const emp = await employee();
    const { temporaryPassword } = (await reset(emp.id)).body as { temporaryPassword: string };
    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });

    const [row] = await prisma.$queryRaw<{ whole: string }[]>`SELECT row_to_json(l)::text AS whole FROM hr_audit_logs l`;
    expect(row).toBeDefined();
    const prismaRow = await prisma.hrAuditLog.findFirstOrThrow();
    for (const text of [row!.whole, JSON.stringify(prismaRow.before), JSON.stringify(prismaRow.after), JSON.stringify(prismaRow)]) {
      expect(text).not.toContain(temporaryPassword);
      expect(text).not.toContain(passwordHash);
      // Not even without its dashes.
      expect(text).not.toContain(temporaryPassword.replaceAll("-", ""));
    }
  });

  it("the database CHECK rejects a PASSWORD_RESET row with an extra field (passwordHash) in after", async () => {
    const emp = await employee();
    const snapshot = { mustChangePassword: false, passwordChangedAt: new Date().toISOString() };
    const err = await pgErrorOf(() =>
      prisma.hrAuditLog.create({
        data: {
          actorId: hr.id,
          entityType: "EMPLOYEE",
          entityId: emp.id,
          action: "PASSWORD_RESET",
          before: snapshot,
          after: { ...snapshot, mustChangePassword: true, passwordHash: "$argon2id$leaked" },
        },
      }),
    );
    expect(err.code).toBe("23514");
    expect(err.message).toContain("chk_hr_audit_logs_password_reset_shape");
  });

  it.each([
    ["an extra field in before", { extra: "x" }, {}, "EMPLOYEE"],
    ["after.mustChangePassword false", {}, { mustChangePassword: false }, "EMPLOYEE"],
    ["after without passwordChangedAt", {}, { passwordChangedAt: undefined }, "EMPLOYEE"],
    ["an entity other than EMPLOYEE", {}, {}, "DEPARTMENT"],
  ] as const)("the CHECK also rejects %s", async (_label, beforeExtra, afterExtra, entityType) => {
    const at = new Date().toISOString();
    const err = await pgErrorOf(() =>
      prisma.hrAuditLog.create({
        data: {
          actorId: hr.id,
          entityType,
          entityId: "some-id",
          action: "PASSWORD_RESET",
          before: { mustChangePassword: false, passwordChangedAt: at, ...beforeExtra },
          after: JSON.parse(JSON.stringify({ mustChangePassword: true, passwordChangedAt: at, ...afterExtra })),
        },
      }),
    );
    expect(err.code).toBe("23514");
    expect(err.message).toContain("chk_hr_audit_logs_password_reset_shape");
  });

  it("the CHECK rejects a PASSWORD_RESET row without before (snapshots_match_action)", async () => {
    const err = await pgErrorOf(() =>
      prisma.hrAuditLog.create({
        data: {
          actorId: hr.id,
          entityType: "EMPLOYEE",
          entityId: "some-id",
          action: "PASSWORD_RESET",
          before: Prisma.DbNull,
          after: { mustChangePassword: true, passwordChangedAt: new Date().toISOString() },
        },
      }),
    );
    expect(err.code).toBe("23514");
  });

  it("sanity: a well-formed PASSWORD_RESET row is accepted by the database", async () => {
    const at = new Date().toISOString();
    await prisma.hrAuditLog.create({
      data: {
        actorId: hr.id,
        entityType: "EMPLOYEE",
        entityId: "some-id",
        action: "PASSWORD_RESET",
        before: { mustChangePassword: false, passwordChangedAt: at },
        after: { mustChangePassword: true, passwordChangedAt: at },
      },
    });
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });
});

describe("reset-password: refused requests change nothing", () => {
  async function stateOf(userId: string) {
    return {
      user: await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, mustChangePassword: true, passwordChangedAt: true },
      }),
      audit: await prisma.hrAuditLog.count(),
    };
  }

  it("HR resetting its own password → 403 CANNOT_RESET_OWN_PASSWORD", async () => {
    const before = await stateOf(hr.id);
    const res = await reset(hr.id);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), code: "CANNOT_RESET_OWN_PASSWORD" });
    expect(await stateOf(hr.id)).toEqual(before);
    // Its session survives.
    expect((await request(app).get("/api/auth/me").set("Cookie", hrCookie)).status).toBe(200);
  });

  it("unknown id → 404 and no audit row", async () => {
    const res = await reset("does-not-exist");
    expect(res.status).toBe(404);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("inactive employee → 409 EMPLOYEE_INACTIVE, nothing written", async () => {
    const emp = await employee({ isActive: false });
    const before = await stateOf(emp.id);
    const res = await reset(emp.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "EMPLOYEE_INACTIVE" });
    expect(await stateOf(emp.id)).toEqual(before);
  });

  it("an id over 64 characters → 400 (Zod)", async () => {
    expect((await reset("x".repeat(65))).status).toBe(400);
  });

  it.each(["EMPLOYEE", "MANAGER"] as const)("%s → 403, nothing written", async (role) => {
    const actor = await createUser({ role });
    const emp = await employee();
    // A MANAGER cannot reset even its own direct report.
    await prisma.user.update({ where: { id: emp.id }, data: { managerId: actor.id } });
    const before = await stateOf(emp.id);
    const res = await reset(emp.id, await authCookie(actor.id));
    expect(res.status).toBe(403);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(await stateOf(emp.id)).toEqual(before);
  });

  it("without a session → 401, nothing written", async () => {
    const emp = await employee();
    const before = await stateOf(emp.id);
    const res = await reset(emp.id, null);
    expect(res.status).toBe(401);
    expect(await stateOf(emp.id)).toEqual(before);
  });

  it("an HR session issued before HR changed its own password → 401", async () => {
    const emp = await employee();
    await prisma.user.update({ where: { id: hr.id }, data: { passwordChangedAt: new Date(Date.now() + 1000) } });
    const res = await reset(emp.id);
    expect(res.status).toBe(401);
  });
});

describe("no secrets in the console", () => {
  let spies: MockInstance[] = [];

  beforeEach(() => {
    spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  function everythingLogged(): string {
    return spies.flatMap((spy) => spy.mock.calls.map((args) => args.map((a) => inspect(a, { depth: 10 })).join(" "))).join("\n");
  }

  it("a reset and the following change-password (errors and success) never log a password", async () => {
    const emp = await employee();
    const { temporaryPassword } = (await reset(emp.id)).body as { temporaryPassword: string };
    const session = cookieFrom(await login(emp.email, temporaryPassword));
    const NEW = "frase nueva que nunca debe salir en logs";
    const WRONG = "contraseña equivocada que tampoco sale";

    const send = (body: object) => request(app).post("/api/auth/change-password").set("Cookie", session).send(body);
    expect((await send({ currentPassword: WRONG, newPassword: NEW })).status).toBe(400);
    expect((await send({ currentPassword: temporaryPassword, newPassword: "corta" })).status).toBe(400);
    expect((await send({ currentPassword: temporaryPassword, newPassword: NEW, extra: NEW })).status).toBe(400);
    expect((await send({ currentPassword: temporaryPassword, newPassword: NEW })).status).toBe(200);

    const logged = everythingLogged();
    for (const secret of [temporaryPassword, NEW, WRONG, ORIGINAL]) {
      expect(logged).not.toContain(secret);
    }
    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });
    expect(logged).not.toContain(passwordHash);
  });
});

describe("reset-password: clears the employee's change-password lockout", () => {
  it("after 5 wrong attempts (429), a reset lets the employee replace the new temporary password", async () => {
    const emp = await employee();
    const tempRes = await reset(emp.id);
    const firstTemp = tempRes.body.temporaryPassword as string;
    const empCookie = cookieFrom(await login(emp.email, firstTemp));

    const wrong = { currentPassword: "temporal copiada con un error", newPassword: "mi propia frase larga y segura" };
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/api/auth/change-password").set("Cookie", empCookie).send(wrong);
      expect(res.body.code).toBe("INVALID_CURRENT_PASSWORD");
    }
    const locked = await request(app).post("/api/auth/change-password").set("Cookie", empCookie).send(wrong);
    expect(locked.status).toBe(429);

    // HR gives a new temporary password: the old sessions die and the counter is cleared.
    const second = await reset(emp.id);
    const newCookie = cookieFrom(await login(emp.email, second.body.temporaryPassword as string));
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", newCookie)
      .send({ currentPassword: second.body.temporaryPassword, newPassword: "mi propia frase larga y segura" });

    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);
  });
});
