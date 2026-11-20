import request from "supertest";
import { verify } from "@node-rs/argon2";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { AUTH_COOKIE_NAME } from "./cookie.js";
import { hashPassword } from "../../security/password.js";
import { authCookie, createUser, prisma, resetDb } from "../../test/db.js";
import type { Role } from "../../generated/prisma/enums.js";

const app = createApp();

/**
 * Real timers on purpose: nothing here depends on "today", and
 * passwordChangedAt / JWT iat should behave as in production.
 * Note: the login limiter (5 failures per IP, module memory) is shared by
 * every test of this file; failed logins here stay well under 5.
 */

const CURRENT = "corriente estable del rio bravo";
const NEW = "nueva frase segura para el sistema 2026";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A user with a real argon2 hash of `password`. */
async function userWithPassword(
  opts: { role?: Role; password?: string; mustChangePassword?: boolean; firstName?: string } = {},
) {
  const user = await createUser({ role: opts.role });
  return prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(opts.password ?? CURRENT),
      mustChangePassword: opts.mustChangePassword ?? false,
      ...(opts.firstName ? { firstName: opts.firstName } : {}),
    },
  });
}

function changePassword(cookie: string | undefined, body: object) {
  const req = request(app).post("/api/auth/change-password");
  if (cookie) req.set("Cookie", cookie);
  return req.send(body);
}

/** The auth cookie ("name=value") set by a response. */
function cookieFrom(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  expect(cookie, "response should set the auth cookie").toBeDefined();
  return cookie!.split(";")[0]!;
}

function login(email: string, password: string) {
  return request(app).post("/api/auth/login").send({ email, password });
}

describe("POST /api/auth/change-password: rejected requests change nothing", () => {
  it("responds 401 without a session cookie", async () => {
    const res = await changePassword(undefined, { currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(401);
  });

  it("responds 401 with a forged cookie", async () => {
    const res = await changePassword(`${AUTH_COOKIE_NAME}=garbage`, { currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(401);
  });

  it("wrong current password → 400 INVALID_CURRENT_PASSWORD, hash untouched, session still valid", async () => {
    const user = await userWithPassword();
    const cookie = await authCookie(user.id);

    const res = await changePassword(cookie, { currentPassword: "otra contraseña equivocada", newPassword: NEW });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: "INVALID_CURRENT_PASSWORD" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(user.passwordHash);
    expect(after.passwordChangedAt).toEqual(user.passwordChangedAt);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookie)).status).toBe(200);
  });

  it.each([
    ["too short (14)", "frase de 14 ch", "PASSWORD_TOO_SHORT"],
    ["too long (129)", "x".repeat(64) + "y".repeat(65), "PASSWORD_TOO_LONG"],
    ["common (in the list)", "abcddesignbuild", "PASSWORD_TOO_COMMON"],
    ["trivial pattern", "123456789012345", "PASSWORD_TOO_COMMON"],
    ["the service name", "leave manager es genial hoy", "PASSWORD_CONTAINS_PERSONAL_INFO"],
  ])("weak new password: %s → 400 %s", async (_label, newPassword, code) => {
    const user = await userWithPassword();
    const res = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(user.passwordHash);
  });

  it("new password with the user's own first name as a word → PASSWORD_CONTAINS_PERSONAL_INFO", async () => {
    const user = await userWithPassword({ firstName: "Ana" });
    const res = await changePassword(await authCookie(user.id), {
      currentPassword: CURRENT,
      newPassword: "ana come tacos al pastor",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_CONTAINS_PERSONAL_INFO");
  });

  it("the policy uses the user's real data: 'banana' is fine for Ana", async () => {
    const user = await userWithPassword({ firstName: "Ana" });
    const res = await changePassword(await authCookie(user.id), {
      currentPassword: CURRENT,
      newPassword: "mi banana favorita del mercado",
    });
    expect(res.status).toBe(200);
  });

  it("new password equal to the current one → 400 PASSWORD_UNCHANGED", async () => {
    const user = await userWithPassword();
    const res = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: CURRENT });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: "PASSWORD_UNCHANGED" });
  });

  it("PASSWORD_UNCHANGED also when they differ only in Unicode normalization (NFC vs NFD)", async () => {
    const nfc = "mañana iremos al cerro de la silla";
    const user = await userWithPassword({ password: nfc });
    const res = await changePassword(await authCookie(user.id), {
      currentPassword: nfc,
      newPassword: nfc.normalize("NFD"),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_UNCHANGED");
  });

  it("the policy runs before the current password: weak new + wrong current → policy code", async () => {
    const user = await userWithPassword();
    const res = await changePassword(await authCookie(user.id), { currentPassword: "equivocada", newPassword: "corta" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_TOO_SHORT");
  });

  it.each([
    ["an extra field (strict)", { currentPassword: CURRENT, newPassword: NEW, userId: "someone-else" }],
    ["missing newPassword", { currentPassword: CURRENT }],
    ["missing currentPassword", { newPassword: NEW }],
    ["empty currentPassword", { currentPassword: "", newPassword: NEW }],
    ["a non-string password", { currentPassword: CURRENT, newPassword: 123456789012345 }],
    ["a body over 1024 characters", { currentPassword: CURRENT, newPassword: "a".repeat(1025) }],
  ])("malformed body: %s → 400 from Zod", async (_label, body) => {
    const user = await userWithPassword();
    const res = await changePassword(await authCookie(user.id), body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Datos de entrada inválidos", details: expect.any(Array) });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(user.passwordHash);
  });

  it("an empty body → 400", async () => {
    const user = await userWithPassword();
    const res = await request(app).post("/api/auth/change-password").set("Cookie", await authCookie(user.id));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/change-password: success", () => {
  it("responds 200 with the public user (no hash) and a new session cookie", async () => {
    const user = await userWithPassword();
    const res = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, mustChangePassword: false });
    expect(res.body.user).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain(NEW);
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).join(";");
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it("stores an argon2 hash of the new password (never the plain text) and advances passwordChangedAt", async () => {
    const user = await userWithPassword();
    await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).not.toBe(NEW);
    expect(after.passwordHash).toMatch(/^\$argon2/);
    expect(await verify(after.passwordHash, NEW)).toBe(true);
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(user.passwordChangedAt.getTime());
  });

  it("the new cookie works; a token issued BEFORE the change (another session) gets 401", async () => {
    const user = await userWithPassword();
    const otherSession = await authCookie(user.id);
    const thisSession = await authCookie(user.id);

    const res = await changePassword(thisSession, { currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(200);
    const newCookie = cookieFrom(res);

    expect((await request(app).get("/api/me/balance").set("Cookie", newCookie)).status).toBe(200);
    expect((await request(app).get("/api/me/balance").set("Cookie", otherSession)).status).toBe(401);
    // The cookie this same request used is also an old token now.
    expect((await request(app).get("/api/auth/me").set("Cookie", thisSession)).status).toBe(401);
  });

  it("login works with the new password and not with the old one", async () => {
    const user = await userWithPassword();
    await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });

    expect((await login(user.email, CURRENT)).status).toBe(401);
    const ok = await login(user.email, NEW);
    expect(ok.status).toBe(200);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookieFrom(ok))).status).toBe(200);
  });

  it("a temporary password is replaced: must_change_password becomes false", async () => {
    const user = await userWithPassword({ mustChangePassword: true });
    const res = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });

    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.mustChangePassword).toBe(false);
  });

  it("two changes in a row each invalidate the previous token", async () => {
    const user = await userWithPassword();
    const first = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });
    const cookie1 = cookieFrom(first);
    const second = await changePassword(cookie1, {
      currentPassword: NEW,
      newPassword: "tercera frase distinta de las otras",
    });
    expect(second.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie1)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookieFrom(second))).status).toBe(200);
  });
});

describe("POST /api/auth/change-password: rate limit per user (5 wrong current passwords / 15 min)", () => {
  it("after 5 wrong current passwords the 6th gets 429 TOO_MANY_ATTEMPTS, even with the right one", async () => {
    const user = await userWithPassword();
    const cookie = await authCookie(user.id);

    for (let i = 0; i < 5; i++) {
      const res = await changePassword(cookie, { currentPassword: `equivocada numero ${i}`, newPassword: NEW });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CURRENT_PASSWORD");
    }

    const blocked = await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: expect.any(String), code: "TOO_MANY_ATTEMPTS" });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(user.passwordHash);
  });

  it("policy errors do NOT use up attempts: 6 weak new passwords, then a valid change works", async () => {
    const user = await userWithPassword();
    const cookie = await authCookie(user.id);

    for (let i = 0; i < 6; i++) {
      // Wrong current too: the policy answers first, so it says nothing about it.
      const res = await changePassword(cookie, { currentPassword: "equivocada", newPassword: "debil" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("PASSWORD_TOO_SHORT");
    }

    const ok = await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW });
    expect(ok.status).toBe(200);
  });

  it("PASSWORD_UNCHANGED and Zod errors do not use up attempts either", async () => {
    const user = await userWithPassword();
    const cookie = await authCookie(user.id);

    for (let i = 0; i < 3; i++) {
      expect((await changePassword(cookie, { currentPassword: CURRENT, newPassword: CURRENT })).status).toBe(400);
      expect((await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW, extra: 1 })).status).toBe(400);
    }

    expect((await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW })).status).toBe(200);
  });

  it("4 wrong attempts still let the 5th (correct) one through", async () => {
    const user = await userWithPassword();
    const cookie = await authCookie(user.id);
    for (let i = 0; i < 4; i++) {
      expect((await changePassword(cookie, { currentPassword: "equivocada", newPassword: NEW })).status).toBe(400);
    }
    expect((await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW })).status).toBe(200);
  });

  it("is per user: a blocked user does not block another one", async () => {
    const blockedUser = await userWithPassword();
    const other = await userWithPassword();
    const blockedCookie = await authCookie(blockedUser.id);

    for (let i = 0; i < 6; i++) {
      await changePassword(blockedCookie, { currentPassword: "equivocada", newPassword: NEW });
    }
    expect((await changePassword(blockedCookie, { currentPassword: CURRENT, newPassword: NEW })).status).toBe(429);

    const res = await changePassword(await authCookie(other.id), { currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(200);
  });

  it("the limit follows the user, not the session: a new session of a blocked user is still blocked", async () => {
    const user = await userWithPassword();
    const first = await authCookie(user.id);
    for (let i = 0; i < 5; i++) {
      await changePassword(first, { currentPassword: "equivocada", newPassword: NEW });
    }
    const second = await authCookie(user.id);
    expect((await changePassword(second, { currentPassword: CURRENT, newPassword: NEW })).status).toBe(429);
  });
});

describe("temporary password (must_change_password = true): only /auth/me, change-password and logout", () => {
  interface Blocked {
    name: string;
    role: Role;
    call: (targetId: string) => request.Test;
  }

  const BLOCKED: Blocked[] = [
    { name: "GET /api/me/balance", role: "EMPLOYEE", call: () => request(app).get("/api/me/balance") },
    { name: "GET /api/leave-types", role: "EMPLOYEE", call: () => request(app).get("/api/leave-types") },
    { name: "GET /api/leave-requests/mine", role: "EMPLOYEE", call: () => request(app).get("/api/leave-requests/mine") },
    {
      name: "POST /api/leave-requests",
      role: "EMPLOYEE",
      call: () => request(app).post("/api/leave-requests").send({ leaveTypeId: "x", startDate: "2027-01-04", endDate: "2027-01-04" }),
    },
    {
      name: "GET /api/leave-requests/pending-approvals",
      role: "MANAGER",
      call: () => request(app).get("/api/leave-requests/pending-approvals"),
    },
    { name: "GET /api/hr/departments (HR)", role: "HR", call: () => request(app).get("/api/hr/departments") },
    {
      name: "POST /api/hr/employees/:id/reset-password (HR)",
      role: "HR",
      call: (targetId) => request(app).post(`/api/hr/employees/${targetId}/reset-password`),
    },
  ];

  it.each(BLOCKED)("$name → 403 PASSWORD_CHANGE_REQUIRED and writes nothing", async ({ role, call }) => {
    const user = await userWithPassword({ role, mustChangePassword: true });
    const target = await userWithPassword();

    const res = await call(target.id).set("Cookie", await authCookie(user.id));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), code: "PASSWORD_CHANGE_REQUIRED" });
    expect(await prisma.leaveRequest.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
    const targetAfter = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(targetAfter.passwordHash).toBe(target.passwordHash);
  });

  it.each(BLOCKED)("$name works again after changing the password", async ({ role, call }) => {
    const user = await userWithPassword({ role, mustChangePassword: true });
    const target = await userWithPassword();

    const changed = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });
    expect(changed.status).toBe(200);

    const res = await call(target.id).set("Cookie", cookieFrom(changed));
    expect([401, 403]).not.toContain(res.status);
    expect(res.body.code).not.toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("GET /api/auth/me responds 200 with mustChangePassword: true (and no hash)", async () => {
    const user = await userWithPassword({ mustChangePassword: true });
    const res = await request(app).get("/api/auth/me").set("Cookie", await authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, mustChangePassword: true });
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("POST /api/auth/change-password is allowed", async () => {
    const user = await userWithPassword({ mustChangePassword: true });
    const res = await changePassword(await authCookie(user.id), { currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(200);
  });

  it("POST /api/auth/logout works (it does not require a session) and clears the cookie", async () => {
    const user = await userWithPassword({ mustChangePassword: true });
    const res = await request(app).post("/api/auth/logout").set("Cookie", await authCookie(user.id));
    expect(res.status).toBe(200);
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).join(";");
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=;`);
  });

  it("POST /api/auth/logout also works without any cookie", async () => {
    expect((await request(app).post("/api/auth/logout")).status).toBe(200);
  });

  it("login with a temporary password succeeds and the session says mustChangePassword: true", async () => {
    const user = await userWithPassword({ mustChangePassword: true });
    const res = await login(user.email, CURRENT);
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    const cookie = cookieFrom(res);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookie)).status).toBe(403);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(200);
  });

  it("a token signed with a passwordChangedAt that does not match (e.g. tampered value) gets 401", async () => {
    const user = await userWithPassword();
    const { signAuthToken } = await import("../../security/jwt.js");
    const token = await signAuthToken(user.id, new Date(user.passwordChangedAt.getTime() - 1));
    const res = await request(app).get("/api/auth/me").set("Cookie", `${AUTH_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/change-password: general limit (20 requests / 15 min, any answer)", () => {
  it("the 21st request gets 429 even when none was a wrong current password", async () => {
    // Same password as new: PASSWORD_UNCHANGED, which costs an argon2 check
    // but does not count in the failed-attempts limiter.
    const user = await userWithPassword();
    const cookie = await authCookie(user.id);
    for (let i = 0; i < 20; i++) {
      const res = await changePassword(cookie, { currentPassword: CURRENT, newPassword: CURRENT });
      expect(res.body.code).toBe("PASSWORD_UNCHANGED");
    }
    const res = await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_ATTEMPTS");
  });
});

describe("/api/auth responses: no cache and a whitelisted user", () => {
  it("login, /me and change-password send Cache-Control: no-store and never passwordHash or passwordChangedAt", async () => {
    const user = await userWithPassword();

    const loginRes = await login(user.email, CURRENT);
    expect(loginRes.status).toBe(200);
    const cookie = cookieFrom(loginRes);
    const meRes = await request(app).get("/api/auth/me").set("Cookie", cookie);
    const changeRes = await changePassword(cookie, { currentPassword: CURRENT, newPassword: NEW });

    for (const res of [loginRes, meRes, changeRes]) {
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(res.body.user).sort()).toEqual(
        [
          "createdAt",
          "departmentId",
          "email",
          "firstName",
          "hireDate",
          "id",
          "isActive",
          "lastName",
          "managerId",
          "mustChangePassword",
          "role",
          "updatedAt",
        ].sort(),
      );
    }
  });
});
