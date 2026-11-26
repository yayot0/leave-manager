import request from "supertest";
import { verify } from "@node-rs/argon2";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AUTH_COOKIE_NAME } from "../auth/cookie.js";
import { hashPassword } from "../../security/password.js";
import {
  authCookie,
  createAdjustment,
  createLeaveRequestRow,
  createLeaveType,
  createUser,
  d,
  prisma,
  resetDb,
} from "../../test/db.js";
import { assertRoleChangeAllowed, deactivationBlocker, planDeactivation } from "./employee-validation.js";
import { DEACTIVATION_CANCEL_NOTE } from "./employees.service.js";

const app = createApp();

/**
 * Fixed "today": 2026-11-11 (Wednesday) in America/Monterrey (UTC-6, no DST).
 * - 2026-11-12 Thu = tomorrow; 2026-11-16 Mon .. 2026-11-20 Fri = 5 business days.
 * - Latest hire date accepted: 2027-11-11 (today + 1 year).
 * Only Date is faked; argon2, pg and supertest use real timers.
 */
const NOW = new Date("2026-11-11T18:00:00Z");
const TEMP_FORMAT = /^[a-km-np-z2-9]{5}(-[a-km-np-z2-9]{5}){3}$/;
const SECRET_KEYS = ["passwordHash", "password_hash", "passwordChangedAt", "temporaryPassword", "password"];
const AUDIT_KEYS = [
  "id",
  "email",
  "firstName",
  "lastName",
  "role",
  "departmentId",
  "managerId",
  "hireDate",
  "isActive",
  "mustChangePassword",
].sort();

let hr: { id: string };
let hrCookie: string;
let dept: { id: string; name: string };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  dept = await prisma.department.create({ data: { name: "Ventas" } });
  hr = await createUser({ role: "HR", firstName: "Helena", lastName: "Recursos" });
  hrCookie = await authCookie(hr.id);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------- helpers ----------

type Method = "get" | "post" | "patch";

function api(method: Method, path: string, cookie: string | null = hrCookie) {
  const req = request(app)[method](`/api/hr/employees${path}`);
  return cookie ? req.set("Cookie", cookie) : req;
}

const enc = encodeURIComponent;

function newEmployeeBody(overrides: Record<string, unknown> = {}) {
  return {
    email: "ana.lopez@acme.mx",
    firstName: "Ana",
    lastName: "Lopez",
    role: "EMPLOYEE",
    departmentId: dept.id,
    managerId: null,
    hireDate: "2026-11-16",
    ...overrides,
  };
}

/** Every key at any depth of a JSON value. */
function allKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, acc));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      acc.add(key);
      allKeys(inner, acc);
    }
  }
  return acc;
}

function expectNoSecrets(value: unknown) {
  const keys = allKeys(value);
  for (const secret of SECRET_KEYS) expect(keys.has(secret), `unexpected key ${secret}`).toBe(false);
}

/** The whole state the employee endpoints could touch, to prove a refused call wrote nothing. */
async function dbState() {
  return {
    users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
    requests: await prisma.leaveRequest.findMany({ orderBy: { id: "asc" } }),
    events: await prisma.requestEvent.findMany({ orderBy: { id: "asc" } }),
    audit: await prisma.hrAuditLog.findMany({ orderBy: { id: "asc" } }),
  };
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

async function vacationType() {
  return createLeaveType({ code: "VAC", name: "Vacaciones" });
}

// ---------- authorization ----------

describe("/api/hr/employees (RH-B2): every new route is HR-only", () => {
  async function seed() {
    const target = await createUser({ role: "EMPLOYEE", departmentId: dept.id });
    const inactive = await createUser({ role: "EMPLOYEE", isActive: false, departmentId: dept.id });
    return { target, inactive };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  const ROUTES: { name: string; call: (s: Seed, cookie: string | null) => request.Test }[] = [
    { name: "GET /employees", call: (_s, c) => api("get", "", c) },
    { name: "GET /employees/manager-options", call: (_s, c) => api("get", "/manager-options", c) },
    { name: "POST /employees", call: (_s, c) => api("post", "", c).send(newEmployeeBody()) },
    { name: "GET /employees/:id", call: (s, c) => api("get", `/${s.target.id}`, c) },
    { name: "PATCH /employees/:id", call: (s, c) => api("patch", `/${s.target.id}`, c).send({ firstName: "Otro" }) },
    {
      name: "GET /employees/:id/hire-date-impact",
      call: (s, c) => api("get", `/${s.target.id}/hire-date-impact?hireDate=2022-01-01`, c),
    },
    { name: "GET /employees/:id/deactivation-impact", call: (s, c) => api("get", `/${s.target.id}/deactivation-impact`, c) },
    { name: "POST /employees/:id/deactivate", call: (s, c) => api("post", `/${s.target.id}/deactivate`, c) },
    { name: "POST /employees/:id/reactivate", call: (s, c) => api("post", `/${s.inactive.id}/reactivate`, c) },
  ];

  describe.each(ROUTES)("$name", ({ call }) => {
    it("responds 401 without a session and writes nothing", async () => {
      const s = await seed();
      const before = await dbState();
      expect((await call(s, null)).status).toBe(401);
      expect(await dbState()).toEqual(before);
    });

    it.each(["EMPLOYEE", "MANAGER"] as const)("responds 403 to %s and writes nothing", async (role) => {
      const s = await seed();
      const user = await createUser({ role });
      const cookie = await authCookie(user.id);
      const before = await dbState();
      const res = await call(s, cookie);
      expect(res.status).toBe(403);
      expect(await dbState()).toEqual(before);
    });

    it("responds 401 to an HR user who is inactive", async () => {
      const s = await seed();
      const inactiveHr = await createUser({ role: "HR", isActive: false });
      const res = await call(s, await authCookie(inactiveHr.id));
      expect(res.status).toBe(401);
    });

    it("works for an active HR user (sanity check: the route exists)", async () => {
      const s = await seed();
      expect([200, 201]).toContain((await call(s, hrCookie)).status);
    });
  });
});

// ---------- create ----------

describe("POST /api/hr/employees: create with a one-time temporary password", () => {
  it("responds 201 with the temporary password (generator format), the employee and Cache-Control: no-store", async () => {
    const res = await api("post", "").send(newEmployeeBody());
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.temporaryPassword).toMatch(TEMP_FORMAT);
    expect(res.body.employee).toMatchObject({
      id: expect.any(String),
      email: "ana.lopez@acme.mx",
      firstName: "Ana",
      lastName: "Lopez",
      role: "EMPLOYEE",
      departmentId: dept.id,
      department: { id: dept.id, name: "Ventas" },
      managerId: null,
      manager: null,
      hireDate: "2026-11-16",
      isActive: true,
      mustChangePassword: true,
    });
    expectNoSecrets(res.body.employee);
  });

  it("stores only an argon2 hash of the temporary password and sets mustChangePassword = true explicitly (the column defaults to false)", async () => {
    const res = await api("post", "").send(newEmployeeBody());
    const { temporaryPassword } = res.body as { temporaryPassword: string };
    const row = await prisma.user.findUniqueOrThrow({ where: { id: res.body.employee.id } });
    expect(row.passwordHash).toMatch(/^\$argon2/);
    expect(row.passwordHash).not.toContain(temporaryPassword);
    expect(await verify(row.passwordHash, temporaryPassword)).toBe(true);
    expect(row.mustChangePassword).toBe(true);

    // Proof that the DEFAULT really is false: a row inserted without the column.
    const plain = await prisma.user.create({
      data: { email: "default@acme.mx", passwordHash: "x", firstName: "Def", lastName: "Ault", hireDate: d("2020-01-01") },
    });
    expect(plain.mustChangePassword).toBe(false);
  });

  it("the new employee can log in with the temporary password, but every normal route answers 403 PASSWORD_CHANGE_REQUIRED", async () => {
    const res = await api("post", "").send(newEmployeeBody({ hireDate: "2025-01-01" }));
    const loginRes = await login("ana.lopez@acme.mx", res.body.temporaryPassword);
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.mustChangePassword).toBe(true);
    const cookie = cookieFrom(loginRes);
    const blocked = await request(app).get("/api/me/balance").set("Cookie", cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
    const leave = await request(app).get("/api/leave-requests/mine").set("Cookie", cookie);
    expect(leave.status).toBe(403);
  });

  it("writes one CREATED audit row: before null, after with exactly the whitelisted keys and never the password", async () => {
    const res = await api("post", "").send(newEmployeeBody());
    const rows = await prisma.hrAuditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ actorId: hr.id, entityType: "EMPLOYEE", entityId: res.body.employee.id, action: "CREATED", before: null });
    expect(Object.keys(row.after as object).sort()).toEqual(AUDIT_KEYS);
    expect(row.after).toMatchObject({ email: "ana.lopez@acme.mx", hireDate: "2026-11-16", isActive: true, mustChangePassword: true });
    expect(JSON.stringify(row)).not.toContain(res.body.temporaryPassword);
    const hash = (await prisma.user.findUniqueOrThrow({ where: { id: res.body.employee.id } })).passwordHash;
    expect(JSON.stringify(row)).not.toContain(hash);
  });

  it("normalizes the email (trim + lowercase): '  Ana@X.COM ' is stored as 'ana@x.com'", async () => {
    const res = await api("post", "").send(newEmployeeBody({ email: "  Ana@X.COM " }));
    expect(res.status).toBe(201);
    expect(res.body.employee.email).toBe("ana@x.com");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: res.body.employee.id } })).email).toBe("ana@x.com");
  });

  it("trims first and last names", async () => {
    const res = await api("post", "").send(newEmployeeBody({ firstName: "  Ana  ", lastName: " Lopez " }));
    expect(res.status).toBe(201);
    expect(res.body.employee).toMatchObject({ firstName: "Ana", lastName: "Lopez" });
  });

  it("accepts a manager that is an active MANAGER or HR", async () => {
    const manager = await createUser({ role: "MANAGER" });
    const r1 = await api("post", "").send(newEmployeeBody({ managerId: manager.id }));
    expect(r1.status).toBe(201);
    expect(r1.body.employee.manager).toMatchObject({ id: manager.id });
    const r2 = await api("post", "").send(newEmployeeBody({ email: "otro@acme.mx", managerId: hr.id }));
    expect(r2.status).toBe(201);
  });

  it("DUPLICATE_EMAIL (409) also without distinguishing case, and writes nothing", async () => {
    await createUser({ email: "ana@x.com" });
    const before = await dbState();
    const res = await api("post", "").send(newEmployeeBody({ email: "ANA@x.com" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "DUPLICATE_EMAIL" });
    expect(await dbState()).toEqual(before);
  });

  it("DEPARTMENT_NOT_FOUND (409) for a department that does not exist", async () => {
    const res = await api("post", "").send(newEmployeeBody({ departmentId: "no-such-dept" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEPARTMENT_NOT_FOUND");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it.each([
    ["does not exist", async () => "no-such-user"],
    ["is inactive", async () => (await createUser({ role: "MANAGER", isActive: false })).id],
    ["has role EMPLOYEE", async () => (await createUser({ role: "EMPLOYEE" })).id],
  ])("MANAGER_NOT_ELIGIBLE (409) when the manager %s", async (_label, managerId) => {
    const id = await managerId();
    const res = await api("post", "").send(newEmployeeBody({ managerId: id }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGER_NOT_ELIGIBLE");
    expect(await prisma.hrAuditLog.count()).toBe(0);
    expect(await prisma.user.findUnique({ where: { email: "ana.lopez@acme.mx" } })).toBeNull();
  });

  it("hire date: today + 1 year (2027-11-11) is accepted; one day more is 400 HIRE_DATE_OUT_OF_RANGE", async () => {
    const ok = await api("post", "").send(newEmployeeBody({ hireDate: "2027-11-11" }));
    expect(ok.status).toBe(201);
    const tooFar = await api("post", "").send(newEmployeeBody({ email: "b@acme.mx", hireDate: "2027-11-12" }));
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.code).toBe("HIRE_DATE_OUT_OF_RANGE");
  });

  it("hire date: 1950-01-01 is accepted; 1949-12-31 is 400", async () => {
    expect((await api("post", "").send(newEmployeeBody({ hireDate: "1950-01-01" }))).status).toBe(201);
    expect((await api("post", "").send(newEmployeeBody({ email: "b@acme.mx", hireDate: "1949-12-31" }))).status).toBe(400);
  });

  it("hire date: 2024-02-29 (leap day) is valid; 2026-02-29 and 2026-13-01 are 400", async () => {
    expect((await api("post", "").send(newEmployeeBody({ hireDate: "2024-02-29" }))).status).toBe(201);
    expect((await api("post", "").send(newEmployeeBody({ email: "b@acme.mx", hireDate: "2026-02-29" }))).status).toBe(400);
    expect((await api("post", "").send(newEmployeeBody({ email: "c@acme.mx", hireDate: "2026-13-01" }))).status).toBe(400);
  });

  it.each([
    ["passwordHash", { passwordHash: "x" }],
    ["mustChangePassword", { mustChangePassword: false }],
    ["isActive", { isActive: false }],
    ["id", { id: "custom-id" }],
  ])("Zod .strict(): unknown field %s is a 400 and nothing is created", async (_name, extra) => {
    const res = await api("post", "").send(newEmployeeBody(extra));
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: "ana.lopez@acme.mx" } })).toBeNull();
  });

  it.each([
    ["missing email", { email: undefined }],
    ["invalid email", { email: "no-arroba" }],
    ["one-letter first name", { firstName: "A" }],
    ["control character in last name", { lastName: "Lo\npez" }],
    ["61-character first name", { firstName: "a".repeat(61) }],
    ["unknown role", { role: "ADMIN" }],
    ["missing managerId (must be explicit null)", { managerId: undefined }],
    ["missing departmentId", { departmentId: undefined }],
  ])("400 for %s", async (_label, overrides) => {
    const res = await api("post", "").send(newEmployeeBody(overrides));
    expect(res.status).toBe(400);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });
});

// ---------- reads ----------

describe("GET /api/hr/employees: list, filters and pagination", () => {
  async function people() {
    const other = await prisma.department.create({ data: { name: "Compras" } });
    const ana = await createUser({ firstName: "Ana", lastName: "Perez", email: "ana.perez@acme.mx", departmentId: dept.id });
    const beto = await createUser({ firstName: "Beto", lastName: "Alvarez", email: "beto@acme.mx", departmentId: dept.id, role: "MANAGER" });
    const carla = await createUser({ firstName: "Carla", lastName: "Perez", email: "carla@otra.com", departmentId: other.id });
    const ana2 = await createUser({ firstName: "Ana", lastName: "Perez", email: "ana.perez2@acme.mx", departmentId: dept.id });
    const inactive = await createUser({ firstName: "Dora", lastName: "Baja", email: "dora@acme.mx", departmentId: dept.id, isActive: false });
    return { other, ana, beto, carla, ana2, inactive };
  }

  const names = (res: request.Response) => (res.body.employees as { id: string }[]).map((e) => e.id);

  it("default: only active, ordered by last name, first name and then id (equal names never swap)", async () => {
    const p = await people();
    const res = await api("get", "");
    expect(res.status).toBe(200);
    const [firstAna, secondAna] = [p.ana.id, p.ana2.id].sort();
    // Alvarez, Perez Ana (x2 by id), Perez Carla, Recursos (HR)
    expect(names(res)).toEqual([p.beto.id, firstAna, secondAna, p.carla.id, hr.id]);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 5, totalPages: 1 });
  });

  it("status=inactive and status=all", async () => {
    const p = await people();
    expect(names(await api("get", "?status=inactive"))).toEqual([p.inactive.id]);
    const all = await api("get", "?status=all");
    expect(all.body.total).toBe(6);
    expect(names(all)).toContain(p.inactive.id);
  });

  it("pagination: total and totalPages; a page past the end is an empty list that still reports the total", async () => {
    await people();
    const p1 = await api("get", "?pageSize=2&page=1");
    expect(p1.body).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(p1.body.employees).toHaveLength(2);
    const p3 = await api("get", "?pageSize=2&page=3");
    expect(p3.body.employees).toHaveLength(1);
    const p4 = await api("get", "?pageSize=2&page=4");
    expect(p4.status).toBe(200);
    expect(p4.body).toMatchObject({ employees: [], total: 5, totalPages: 3, page: 4 });
    // The pages together are the whole list, without repeats.
    const all = [...names(p1), ...names(await api("get", "?pageSize=2&page=2")), ...names(p3)];
    expect(new Set(all).size).toBe(5);
  });

  it("an empty result has totalPages 1", async () => {
    const res = await api("get", "?q=nadie");
    expect(res.body).toMatchObject({ employees: [], total: 0, totalPages: 1 });
  });

  it("q: every word must match (first name, last name or email), case-insensitive", async () => {
    const p = await people();
    expect(names(await api("get", "?q=" + enc("ANA perez"))).sort()).toEqual([p.ana.id, p.ana2.id].sort());
    expect(names(await api("get", "?q=" + enc("carla PEREZ")))).toEqual([p.carla.id]);
    expect(names(await api("get", "?q=" + enc("ana alvarez")))).toEqual([]);
  });

  it("q matches the email too", async () => {
    const p = await people();
    expect(names(await api("get", "?q=otra.com"))).toEqual([p.carla.id]);
    expect(names(await api("get", "?q=ACME")).sort()).toEqual([p.ana.id, p.ana2.id, p.beto.id].sort());
  });

  // Prisma's `contains` does not escape LIKE wildcards: listEmployees does
  // (escapeLike). Without it q="%" matched every row and q="_" any value.
  it("q: % is a literal character, not an SQL wildcard", async () => {
    await people();
    expect((await api("get", "?q=" + enc("%"))).body.total).toBe(0);
  });

  it("q: _ is a literal character, not an SQL wildcard", async () => {
    await people();
    expect((await api("get", "?q=" + enc("_"))).body.total).toBe(0);
  });

  it("q: a wildcard in the middle is literal too ('a%z' does not match 'ana.perez@acme.mx')", async () => {
    await people();
    expect((await api("get", "?q=" + enc("a%z"))).body.total).toBe(0);
  });

  it("q: a backslash is literal and does not break the escaping", async () => {
    await people();
    expect((await api("get", "?q=" + enc("\\"))).body.total).toBe(0);
    expect((await api("get", "?q=" + enc("\\%"))).body.total).toBe(0);
  });

  it("q: a real underscore in an email is still found", async () => {
    const underscored = await createUser({ email: "luis_gomez@acme.mx" });
    expect(names(await api("get", "?q=" + enc("luis_g")))).toEqual([underscored.id]);
  });

  it("filters by departmentId and by role, combined with status", async () => {
    const p = await people();
    expect(names(await api("get", `?departmentId=${p.other.id}`))).toEqual([p.carla.id]);
    expect(names(await api("get", "?role=MANAGER"))).toEqual([p.beto.id]);
    expect(names(await api("get", "?role=HR"))).toEqual([hr.id]);
    expect(names(await api("get", `?departmentId=${dept.id}&status=inactive`))).toEqual([p.inactive.id]);
  });

  it.each([
    "?foo=1",
    "?pageSize=101",
    "?pageSize=0",
    "?page=0",
    "?page=1.5",
    "?status=deleted",
    "?role=ADMIN",
    "?q=" + "a".repeat(101),
  ])("400 for invalid query %s", async (query) => {
    expect((await api("get", query)).status).toBe(400);
  });

  it("pageSize=100 is accepted (the maximum)", async () => {
    expect((await api("get", "?pageSize=100")).status).toBe(200);
  });

  it("never exposes passwordHash, passwordChangedAt or a temporary password", async () => {
    await people();
    await api("post", "").send(newEmployeeBody());
    const res = await api("get", "?status=all");
    expectNoSecrets(res.body);
    expect(JSON.stringify(res.body)).not.toContain("not-a-real-hash");
  });
});

describe("GET /api/hr/employees/manager-options", () => {
  it("lists only active MANAGER and HR users, by last name", async () => {
    const m = await createUser({ role: "MANAGER", firstName: "Mario", lastName: "Alba", departmentId: dept.id });
    await createUser({ role: "MANAGER", isActive: false, lastName: "Inactivo" });
    await createUser({ role: "EMPLOYEE", lastName: "Empleado" });
    const res = await api("get", "/manager-options");
    expect(res.status).toBe(200);
    expect(res.body.managers.map((u: { id: string }) => u.id)).toEqual([m.id, hr.id]);
    expect(res.body.managers[0]).toEqual({
      id: m.id,
      firstName: "Mario",
      lastName: "Alba",
      role: "MANAGER",
      department: { id: dept.id, name: "Ventas" },
    });
  });
});

describe("GET /api/hr/employees/:id: detail", () => {
  it("returns the employee with manager, direct reports (active first), balance as of today and no secrets", async () => {
    const manager = await createUser({ role: "MANAGER", firstName: "Mario", lastName: "Jefe", departmentId: dept.id });
    const r1 = await createUser({ managerId: manager.id, lastName: "Zeta" });
    const r2 = await createUser({ managerId: manager.id, lastName: "Alfa", isActive: false });
    const res = await api("get", `/${manager.id}`);
    expect(res.status).toBe(200);
    const e = res.body.employee;
    expect(e).toMatchObject({ id: manager.id, hireDate: "2023-02-01", department: { name: "Ventas" } });
    expect(e.directReports.map((r: { id: string }) => r.id)).toEqual([r1.id, r2.id]);
    expect(e.balance).toMatchObject({
      asOf: "2026-11-11",
      period: { start: "2026-02-01", end: "2027-01-31" },
      yearsOfService: 3,
      earned: 16,
      available: 16,
    });
    expectNoSecrets(res.body);
  });

  it("works for someone registered before their first day (hire date in the future): 0 days earned", async () => {
    const future = await createUser({ hireDate: "2027-06-01" });
    const res = await api("get", `/${future.id}`);
    expect(res.status).toBe(200);
    expect(res.body.employee.balance).toMatchObject({ earned: 0, yearsOfService: 0 });
  });

  it("404 for an id that does not exist", async () => {
    const res = await api("get", "/no-such-id");
    expect(res.status).toBe(404);
  });

  it("permissions: for another active employee everything but reactivate", async () => {
    const emp = await createUser();
    const res = await api("get", `/${emp.id}`);
    expect(res.body.employee.permissions).toEqual({
      canEditRole: true,
      canEditHireDate: true,
      canEditManager: true,
      canDeactivate: true,
      canReactivate: false,
      canResetPassword: true,
    });
  });

  it("permissions: for an inactive employee only reactivate (and edits)", async () => {
    const emp = await createUser({ isActive: false });
    const res = await api("get", `/${emp.id}`);
    expect(res.body.employee.permissions).toMatchObject({ canDeactivate: false, canReactivate: true, canResetPassword: false });
  });

  it("permissions: HR on itself cannot change role, hire date, manager, deactivate or reset", async () => {
    const res = await api("get", `/${hr.id}`);
    expect(res.body.employee.permissions).toEqual({
      canEditRole: false,
      canEditHireDate: false,
      canEditManager: false,
      canDeactivate: false,
      canReactivate: false,
      canResetPassword: false,
    });
  });
});

// ---------- update ----------

describe("PATCH /api/hr/employees/:id: edit", () => {
  it("changes only the sent fields and writes one UPDATED row with the exact whitelist on both sides", async () => {
    const emp = await createUser({ firstName: "Ana", lastName: "Lopez", departmentId: dept.id });
    const res = await api("patch", `/${emp.id}`).send({ firstName: "Anabel", email: "  ANABEL@acme.mx" });
    expect(res.status).toBe(200);
    expect(res.body.employee).toMatchObject({ firstName: "Anabel", lastName: "Lopez", email: "anabel@acme.mx" });
    expectNoSecrets(res.body);

    const rows = await prisma.hrAuditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ actorId: hr.id, entityType: "EMPLOYEE", entityId: emp.id, action: "UPDATED" });
    expect(Object.keys(row.before as object).sort()).toEqual(AUDIT_KEYS);
    expect(Object.keys(row.after as object).sort()).toEqual(AUDIT_KEYS);
    expect(row.before).toMatchObject({ firstName: "Ana", email: emp.email, hireDate: "2023-02-01", departmentId: dept.id });
    expect(row.after).toMatchObject({ firstName: "Anabel", email: "anabel@acme.mx", lastName: "Lopez" });
  });

  it("a PATCH with the same values is a 200 that writes nothing and logs nothing", async () => {
    const emp = await createUser({ firstName: "Ana", role: "MANAGER", departmentId: dept.id });
    const before = await dbState();
    const res = await api("patch", `/${emp.id}`).send({
      firstName: "Ana",
      role: "MANAGER",
      departmentId: dept.id,
      hireDate: "2023-02-01",
      managerId: null,
      email: emp.email.toUpperCase(),
    });
    expect(res.status).toBe(200);
    expect(await dbState()).toEqual(before);
  });

  it("STALE_DATA (409) with an old expectedUpdatedAt: nothing written, nothing logged", async () => {
    const emp = await createUser();
    const loaded = emp.updatedAt.toISOString();
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect((await api("patch", `/${emp.id}`).send({ lastName: "Primero" })).status).toBe(200);
    const before = await dbState();
    const res = await api("patch", `/${emp.id}`).send({ firstName: "Segundo", expectedUpdatedAt: loaded });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_DATA");
    expect(await dbState()).toEqual(before);
  });

  it("the current expectedUpdatedAt is accepted", async () => {
    const emp = await createUser();
    const res = await api("patch", `/${emp.id}`).send({ firstName: "Nuevo", expectedUpdatedAt: emp.updatedAt.toISOString() });
    expect(res.status).toBe(200);
  });

  it.each([
    ["passwordHash", { passwordHash: "x" }],
    ["isActive", { isActive: false }],
    ["mustChangePassword", { mustChangePassword: false }],
  ])("Zod .strict(): %s in the PATCH is a 400 and changes nothing", async (_n, body) => {
    const emp = await createUser();
    const before = await dbState();
    expect((await api("patch", `/${emp.id}`).send(body)).status).toBe(400);
    expect(await dbState()).toEqual(before);
  });

  it("400 for an empty PATCH or one with only expectedUpdatedAt", async () => {
    const emp = await createUser();
    expect((await api("patch", `/${emp.id}`).send({})).status).toBe(400);
    expect((await api("patch", `/${emp.id}`).send({ expectedUpdatedAt: emp.updatedAt.toISOString() })).status).toBe(400);
  });

  it("404 for an id that does not exist", async () => {
    expect((await api("patch", "/no-such-id").send({ firstName: "Xx" })).status).toBe(404);
  });

  it("DUPLICATE_EMAIL (409) when the new email belongs to someone else, in any case", async () => {
    await createUser({ email: "tomado@acme.mx" });
    const emp = await createUser();
    const res = await api("patch", `/${emp.id}`).send({ email: "Tomado@ACME.mx" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_EMAIL");
  });

  it("DEPARTMENT_NOT_FOUND (409) for a department that does not exist", async () => {
    const emp = await createUser();
    const res = await api("patch", `/${emp.id}`).send({ departmentId: "nope" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEPARTMENT_NOT_FOUND");
  });

  it("managerId: null removes the manager", async () => {
    const m = await createUser({ role: "MANAGER" });
    const emp = await createUser({ managerId: m.id });
    const res = await api("patch", `/${emp.id}`).send({ managerId: null });
    expect(res.status).toBe(200);
    expect(res.body.employee.managerId).toBeNull();
  });

  it.each([
    ["does not exist", async () => "nope"],
    ["is inactive", async () => (await createUser({ role: "MANAGER", isActive: false })).id],
    ["is an EMPLOYEE", async () => (await createUser()).id],
  ])("MANAGER_NOT_ELIGIBLE (409) when the new manager %s", async (_l, managerId) => {
    const emp = await createUser();
    const res = await api("patch", `/${emp.id}`).send({ managerId: await managerId() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGER_NOT_ELIGIBLE");
  });

  it("MANAGER_IS_SELF (400)", async () => {
    const m = await createUser({ role: "MANAGER" });
    const res = await api("patch", `/${m.id}`).send({ managerId: m.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MANAGER_IS_SELF");
  });

  it("MANAGER_CYCLE (409) for a long chain: A -> B -> C, then manager(C) = A", async () => {
    const a = await createUser({ role: "MANAGER" });
    const b = await createUser({ role: "MANAGER" });
    const c = await createUser({ role: "MANAGER" });
    expect((await api("patch", `/${a.id}`).send({ managerId: b.id })).status).toBe(200);
    expect((await api("patch", `/${b.id}`).send({ managerId: c.id })).status).toBe(200);
    const res = await api("patch", `/${c.id}`).send({ managerId: a.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGER_CYCLE");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).managerId).toBeNull();
  });

  it("MANAGER_CYCLE (409) through an inactive user: A -> B (inactive) -> C, then manager(C) = A", async () => {
    const c = await createUser({ role: "MANAGER" });
    const b = await createUser({ role: "MANAGER", managerId: c.id, isActive: false });
    const a = await createUser({ role: "MANAGER", managerId: b.id });
    const res = await api("patch", `/${c.id}`).send({ managerId: a.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGER_CYCLE");
  });

  it("a non-cyclic reassignment inside the same tree is allowed (manager(A) = C when A -> B -> C)", async () => {
    const c = await createUser({ role: "MANAGER" });
    const b = await createUser({ role: "MANAGER", managerId: c.id });
    const a = await createUser({ role: "MANAGER", managerId: b.id });
    expect((await api("patch", `/${a.id}`).send({ managerId: c.id })).status).toBe(200);
  });

  it("HAS_ACTIVE_REPORTS (409) when demoting a MANAGER with active reports to EMPLOYEE", async () => {
    const m = await createUser({ role: "MANAGER" });
    await createUser({ managerId: m.id });
    const before = await dbState();
    const res = await api("patch", `/${m.id}`).send({ role: "EMPLOYEE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HAS_ACTIVE_REPORTS");
    expect(await dbState()).toEqual(before);
  });

  it("demoting to EMPLOYEE is allowed when every report is inactive, and MANAGER -> HR is allowed with active reports", async () => {
    const m = await createUser({ role: "MANAGER" });
    await createUser({ managerId: m.id, isActive: false });
    expect((await api("patch", `/${m.id}`).send({ role: "EMPLOYEE" })).status).toBe(200);
    const m2 = await createUser({ role: "MANAGER" });
    await createUser({ managerId: m2.id });
    expect((await api("patch", `/${m2.id}`).send({ role: "HR" })).status).toBe(200);
  });

  it("HIRE_DATE_AFTER_REQUESTS (409) with data.earliestRequestStart; the request's own start day is allowed", async () => {
    const vac = await vacationType();
    const emp = await createUser({ hireDate: "2023-02-01" });
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-12-07", end: "2026-12-08", businessDays: 2, status: "APPROVED" });
    // Rejected/cancelled requests earlier never block.
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-09", end: "2026-11-09", businessDays: 1, status: "CANCELLED" });

    const before = await dbState();
    const res = await api("patch", `/${emp.id}`).send({ hireDate: "2026-11-17" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: expect.any(String),
      code: "HIRE_DATE_AFTER_REQUESTS",
      data: { earliestRequestStart: "2026-11-16" },
    });
    expect(await dbState()).toEqual(before);

    expect((await api("patch", `/${emp.id}`).send({ hireDate: "2026-11-16" })).status).toBe(200);
  });

  it("HIRE_DATE_OUT_OF_RANGE (400) for more than a year ahead", async () => {
    const emp = await createUser();
    const res = await api("patch", `/${emp.id}`).send({ hireDate: "2027-11-12" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("HIRE_DATE_OUT_OF_RANGE");
  });

  it("errors without structured details carry no `data` key", async () => {
    const res = await api("patch", "/no-such-id").send({ firstName: "Xx" });
    expect(res.body).toEqual({ error: expect.any(String) });
  });
});

describe("PATCH /api/hr/employees/:id: segregation of duties (HR on itself)", () => {
  async function otherHr() {
    return createUser({ role: "HR" });
  }

  it("CANNOT_CHANGE_OWN_ROLE (403), nothing written", async () => {
    await otherHr();
    const before = await dbState();
    const res = await api("patch", `/${hr.id}`).send({ role: "MANAGER" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CANNOT_CHANGE_OWN_ROLE");
    expect(await dbState()).toEqual(before);
  });

  it("CANNOT_EDIT_OWN_HIRE_DATE (403), even combined with an allowed change (which is not applied either)", async () => {
    const before = await dbState();
    const res = await api("patch", `/${hr.id}`).send({ hireDate: "2010-01-01", firstName: "Otra" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CANNOT_EDIT_OWN_HIRE_DATE");
    expect(await dbState()).toEqual(before);
  });

  it("CANNOT_CHANGE_OWN_MANAGER (403), also to remove it", async () => {
    const boss = await otherHr();
    const res = await api("patch", `/${hr.id}`).send({ managerId: boss.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CANNOT_CHANGE_OWN_MANAGER");
    await prisma.user.update({ where: { id: hr.id }, data: { managerId: boss.id } });
    const cookie = await authCookie(hr.id);
    const remove = await api("patch", `/${hr.id}`, cookie).send({ managerId: null });
    expect(remove.status).toBe(403);
    expect(remove.body.code).toBe("CANNOT_CHANGE_OWN_MANAGER");
  });

  it("own name, email and department are allowed (200)", async () => {
    const res = await api("patch", `/${hr.id}`).send({ firstName: "Helen", email: "helen@acme.mx", departmentId: dept.id });
    expect(res.status).toBe(200);
    expect(res.body.employee).toMatchObject({ firstName: "Helen", email: "helen@acme.mx", departmentId: dept.id });
  });

  it("sending its own current role, hire date and manager is not a change: 200 without audit", async () => {
    const res = await api("patch", `/${hr.id}`).send({ role: "HR", hireDate: "2023-02-01", managerId: null });
    expect(res.status).toBe(200);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("another HR can change this HR's role and hire date", async () => {
    const other = await otherHr();
    const cookie = await authCookie(other.id);
    expect((await api("patch", `/${hr.id}`, cookie).send({ hireDate: "2020-01-01" })).status).toBe(200);
    expect((await api("patch", `/${hr.id}`, cookie).send({ role: "MANAGER" })).status).toBe(200);
  });
});

// ---------- hire-date impact ----------

describe("GET /api/hr/employees/:id/hire-date-impact", () => {
  it("moving the hire date one year back raises earned per LFT (3 years = 16 -> 4 years = 18)", async () => {
    const emp = await createUser({ hireDate: "2023-02-01" });
    const res = await api("get", `/${emp.id}/hire-date-impact?hireDate=2022-02-01`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      asOf: "2026-11-11",
      current: { period: { start: "2026-02-01", end: "2027-01-31" }, yearsOfService: 3, earned: 16, available: 16 },
      proposed: { period: { start: "2026-02-01", end: "2027-01-31" }, yearsOfService: 4, earned: 18, available: 18 },
      problem: null,
    });
  });

  it("exact anniversary today: hire date 2021-11-11 gives 5 years (20 days) and a period starting today", async () => {
    const vac = await vacationType();
    const emp = await createUser({ hireDate: "2023-02-01" });
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    const res = await api("get", `/${emp.id}/hire-date-impact?hireDate=2021-11-11`);
    expect(res.body.current).toMatchObject({ earned: 16, pending: 5, available: 11 });
    expect(res.body.proposed).toMatchObject({
      period: { start: "2026-11-11", end: "2027-11-10" },
      yearsOfService: 5,
      earned: 20,
      pending: 5,
      available: 15,
    });
  });

  it("anniversary tomorrow: hire date 2021-11-12 gives 4 years and the pending request falls in the next period", async () => {
    const vac = await vacationType();
    const emp = await createUser({ hireDate: "2023-02-01" });
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    const res = await api("get", `/${emp.id}/hire-date-impact?hireDate=2021-11-12`);
    expect(res.body.proposed).toMatchObject({
      period: { start: "2025-11-12", end: "2026-11-11" },
      yearsOfService: 4,
      earned: 18,
      pending: 0,
      available: 18,
    });
  });

  it("leap day hire date 2024-02-29: the anniversary is Feb 28 in non-leap years (Art. 18 LFT)", async () => {
    const emp = await createUser({ hireDate: "2023-02-01" });
    const res = await api("get", `/${emp.id}/hire-date-impact?hireDate=2024-02-29`);
    expect(res.body.proposed).toMatchObject({
      period: { start: "2026-02-28", end: "2027-02-27" },
      yearsOfService: 2,
      earned: 14,
    });
  });

  it("includes adjustments in both balances", async () => {
    const emp = await createUser({ hireDate: "2023-02-01" });
    await createAdjustment(emp.id, 3, "2026-06-01");
    const res = await api("get", `/${emp.id}/hire-date-impact?hireDate=2022-02-01`);
    expect(res.body.current).toMatchObject({ adjustments: 3, available: 19 });
    expect(res.body.proposed).toMatchObject({ adjustments: 3, available: 21 });
  });

  it("`problem` is the same the PATCH answers (HIRE_DATE_AFTER_REQUESTS with earliestRequestStart)", async () => {
    const vac = await vacationType();
    const emp = await createUser({ hireDate: "2023-02-01" });
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    const impact = await api("get", `/${emp.id}/hire-date-impact?hireDate=2026-11-18`);
    expect(impact.status).toBe(200);
    expect(impact.body.problem).toEqual({
      code: "HIRE_DATE_AFTER_REQUESTS",
      message: expect.any(String),
      earliestRequestStart: "2026-11-16",
    });
    const patch = await api("patch", `/${emp.id}`).send({ hireDate: "2026-11-18" });
    expect(patch.status).toBe(409);
    expect(patch.body).toEqual({
      error: impact.body.problem.message,
      code: impact.body.problem.code,
      data: { earliestRequestStart: impact.body.problem.earliestRequestStart },
    });
  });

  it("HIRE_DATE_OUT_OF_RANGE (400) like the PATCH; 400 for missing, malformed or extra query params", async () => {
    const emp = await createUser();
    const far = await api("get", `/${emp.id}/hire-date-impact?hireDate=2027-11-12`);
    expect(far.status).toBe(400);
    expect(far.body.code).toBe("HIRE_DATE_OUT_OF_RANGE");
    expect((await api("get", `/${emp.id}/hire-date-impact?hireDate=2027-11-11`)).status).toBe(200);
    expect((await api("get", `/${emp.id}/hire-date-impact`)).status).toBe(400);
    expect((await api("get", `/${emp.id}/hire-date-impact?hireDate=2026-02-29`)).status).toBe(400);
    expect((await api("get", `/${emp.id}/hire-date-impact?hireDate=1949-12-31`)).status).toBe(400);
    expect((await api("get", `/${emp.id}/hire-date-impact?hireDate=2022-01-01&x=1`)).status).toBe(400);
  });

  it("404 for an employee that does not exist; writes nothing", async () => {
    const before = await dbState();
    expect((await api("get", "/nope/hire-date-impact?hireDate=2022-01-01")).status).toBe(404);
    expect(await dbState()).toEqual(before);
  });
});

// ---------- deactivation ----------

describe("POST /api/hr/employees/:id/deactivate", () => {
  const DECIDED_AT = new Date("2026-11-01T15:00:00Z");

  async function employeeWithRequests() {
    const vac = await vacationType();
    const manager = await createUser({ role: "MANAGER", lastName: "Jefe" });
    const emp = await createUser({ managerId: manager.id, hireDate: "2023-02-01" });
    const row = (start: string, end: string, businessDays: number, status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED") =>
      createLeaveRequestRow({
        requesterId: emp.id,
        leaveTypeId: vac.id,
        start,
        end,
        businessDays,
        status,
        ...(status === "APPROVED" || status === "REJECTED" ? { deciderId: manager.id, decidedAt: DECIDED_AT } : {}),
      });
    return {
      vac,
      manager,
      emp,
      finished: await row("2026-11-02", "2026-11-06", 5, "APPROVED"),
      inProgress: await row("2026-11-10", "2026-11-11", 2, "APPROVED"),
      pendingTomorrow: await row("2026-11-12", "2026-11-13", 2, "PENDING"),
      pendingFuture: await row("2026-11-16", "2026-11-20", 5, "PENDING"),
      approvedFuture: await row("2026-11-23", "2026-11-27", 5, "APPROVED"),
      rejected: await row("2026-11-30", "2026-12-04", 5, "REJECTED"),
      cancelled: await row("2026-12-07", "2026-12-11", 5, "CANCELLED"),
    };
  }

  it("cancels PENDING and APPROVED that start after today, each with a CANCELLED event signed by HR; the rest stays as it was", async () => {
    const s = await employeeWithRequests();
    const res = await api("post", `/${s.emp.id}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cancelledRequests: 3, employee: { id: s.emp.id, isActive: false } });
    expectNoSecrets(res.body);

    const status = async (id: string) => prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
    for (const r of [s.pendingTomorrow, s.pendingFuture, s.approvedFuture]) {
      expect((await status(r.id)).status).toBe("CANCELLED");
      const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: r.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "CANCELLED", actorId: hr.id, note: DEACTIVATION_CANCEL_NOTE });
    }
    expect(DEACTIVATION_CANCEL_NOTE).toBe("Cancelada por la baja del empleado");

    // The approved one keeps who approved it and when (decider_id is never the canceller).
    const approved = await status(s.approvedFuture.id);
    expect(approved.deciderId).toBe(s.manager.id);
    expect(approved.decidedAt).toEqual(DECIDED_AT);
    const pending = await status(s.pendingFuture.id);
    expect(pending.deciderId).toBeNull();
    expect(pending.decidedAt).toBeNull();

    for (const r of [s.finished, s.inProgress, s.rejected, s.cancelled]) {
      expect(await status(r.id)).toEqual(r);
      expect(await prisma.requestEvent.count({ where: { leaveRequestId: r.id } })).toBe(0);
    }
  });

  it("writes one DEACTIVATED audit row (isActive true -> false) with the exact whitelist", async () => {
    const emp = await createUser();
    await api("post", `/${emp.id}/deactivate`);
    const rows = await prisma.hrAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "DEACTIVATED", entityType: "EMPLOYEE", entityId: emp.id, actorId: hr.id });
    expect(Object.keys(rows[0]!.before as object).sort()).toEqual(AUDIT_KEYS);
    expect(Object.keys(rows[0]!.after as object).sort()).toEqual(AUDIT_KEYS);
    expect((rows[0]!.before as { isActive: boolean }).isActive).toBe(true);
    expect((rows[0]!.after as { isActive: boolean }).isActive).toBe(false);
  });

  it("deactivation-impact predicts exactly what the POST does", async () => {
    const s = await employeeWithRequests();
    const impact = await api("get", `/${s.emp.id}/deactivation-impact`);
    expect(impact.status).toBe(200);
    expect(impact.body).toEqual({
      activeReports: [],
      overdueRequests: [],
      toCancel: { pending: 2, approved: 1 },
      startedApproved: 2,
      // inProgress ends today: no day of it is left after the deactivation.
      approvedRunningPastToday: 0,
      isLastActiveHr: false,
      blocker: null,
    });
    const res = await api("post", `/${s.emp.id}/deactivate`);
    expect(res.body.cancelledRequests).toBe(impact.body.toCancel.pending + impact.body.toCancel.approved);
  });

  it("deactivation-impact counts the APPROVED that started and still run after today (final settlement warning)", async () => {
    const vac = await vacationType();
    const manager = await createUser({ role: "MANAGER" });
    const emp = await createUser({ managerId: manager.id, hireDate: "2023-02-01" });
    // Today is 2026-11-11: started on the 9th, ends on the 13th.
    await createLeaveRequestRow({
      requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-09", end: "2026-11-13", businessDays: 5,
      status: "APPROVED", deciderId: manager.id, decidedAt: DECIDED_AT,
    });
    const impact = await api("get", `/${emp.id}/deactivation-impact`);
    expect(impact.status).toBe(200);
    expect(impact.body.approvedRunningPastToday).toBe(1);
    // It is not touched by the deactivation.
    const res = await api("post", `/${emp.id}/deactivate`);
    expect(res.status).toBe(200);
    const stillApproved = await prisma.leaveRequest.count({ where: { requesterId: emp.id, status: "APPROVED", endDate: d("2026-11-13") } });
    expect(stillApproved).toBe(1);
  });

  it("the deactivated employee's sessions answer 401 afterwards", async () => {
    const emp = await createUser();
    const cookie = await authCookie(emp.id);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookie)).status).toBe(200);
    await api("post", `/${emp.id}/deactivate`);
    expect((await request(app).get("/api/me/balance").set("Cookie", cookie)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("a PENDING that starts today is overdue: 409 HAS_OVERDUE_PENDING_REQUESTS with data.requests, and NOTHING changes", async () => {
    const s = await employeeWithRequests();
    const overdue = await createLeaveRequestRow({
      requesterId: s.emp.id, leaveTypeId: s.vac.id, start: "2026-10-26", end: "2026-10-27", businessDays: 2,
    });
    const before = await dbState();
    const res = await api("post", `/${s.emp.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: expect.any(String),
      code: "HAS_OVERDUE_PENDING_REQUESTS",
      data: {
        requests: [
          { id: overdue.id, startDate: "2026-10-26", endDate: "2026-10-27", businessDays: 2, status: "PENDING", leaveType: { name: "Vacaciones" } },
        ],
      },
    });
    expect(await dbState()).toEqual(before);

    const impact = await api("get", `/${s.emp.id}/deactivation-impact`);
    expect(impact.body.blocker).toBe("HAS_OVERDUE_PENDING_REQUESTS");
    expect(impact.body.overdueRequests).toEqual(res.body.data.requests);
  });

  it("boundary: startDate == today counts as started (overdue)", async () => {
    const vac = await vacationType();
    const emp = await createUser();
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-11", end: "2026-11-11", businessDays: 1 });
    const res = await api("post", `/${emp.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HAS_OVERDUE_PENDING_REQUESTS");
  });

  it("'today' is the date in APP_TIMEZONE: at 21:00 of Nov 11 in Monterrey (03:00Z Nov 12) a PENDING for Nov 12 is still cancellable", async () => {
    const vac = await vacationType();
    const emp = await createUser();
    const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-12", end: "2026-11-12", businessDays: 1 });
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
    // A session issued at the new "now" (the one from beforeEach may have expired).
    const res = await api("post", `/${emp.id}/deactivate`, await authCookie(hr.id));
    expect(res.status).toBe(200);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("CANCELLED");
  });

  it("'today' is the date in APP_TIMEZONE: at 00:00 of Nov 12 in Monterrey (06:00Z) that PENDING is overdue", async () => {
    const vac = await vacationType();
    const emp = await createUser();
    await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-12", end: "2026-11-12", businessDays: 1 });
    vi.setSystemTime(new Date("2026-11-12T06:00:00Z"));
    // A session issued at the new "now" (the one from beforeEach may have expired).
    const res = await api("post", `/${emp.id}/deactivate`, await authCookie(hr.id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HAS_OVERDUE_PENDING_REQUESTS");
  });

  it("HAS_ACTIVE_REPORTS (409) with active reports; impact lists them as the blocker; nothing changes", async () => {
    const m = await createUser({ role: "MANAGER" });
    const report = await createUser({ managerId: m.id, firstName: "Rita", lastName: "Reporte" });
    const impact = await api("get", `/${m.id}/deactivation-impact`);
    expect(impact.body).toMatchObject({
      activeReports: [{ id: report.id, firstName: "Rita", lastName: "Reporte" }],
      blocker: "HAS_ACTIVE_REPORTS",
    });
    const before = await dbState();
    const res = await api("post", `/${m.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HAS_ACTIVE_REPORTS");
    expect(await dbState()).toEqual(before);
  });

  it("only inactive reports do not block the deactivation", async () => {
    const m = await createUser({ role: "MANAGER" });
    await createUser({ managerId: m.id, isActive: false });
    expect((await api("post", `/${m.id}/deactivate`)).status).toBe(200);
  });

  it("CANNOT_DEACTIVATE_SELF (403); impact says so as the blocker", async () => {
    await createUser({ role: "HR" });
    const res = await api("post", `/${hr.id}/deactivate`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CANNOT_DEACTIVATE_SELF");
    expect((await api("get", `/${hr.id}/deactivation-impact`)).body.blocker).toBe("CANNOT_DEACTIVATE_SELF");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: hr.id } })).isActive).toBe(true);
  });

  it("EMPLOYEE_INACTIVE (409) when already inactive (POST and impact); 404 when it does not exist", async () => {
    const emp = await createUser({ isActive: false });
    const res = await api("post", `/${emp.id}/deactivate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMPLOYEE_INACTIVE");
    expect((await api("get", `/${emp.id}/deactivation-impact`)).body.code).toBe("EMPLOYEE_INACTIVE");
    expect((await api("post", "/nope/deactivate")).status).toBe(404);
    expect((await api("get", "/nope/deactivation-impact")).status).toBe(404);
  });

  it("STALE_DATA (409) with an old expectedUpdatedAt; body .strict()", async () => {
    const emp = await createUser();
    const loaded = emp.updatedAt.toISOString();
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await api("patch", `/${emp.id}`).send({ firstName: "Cambiado" });
    const res = await api("post", `/${emp.id}/deactivate`).send({ expectedUpdatedAt: loaded });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_DATA");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: emp.id } })).isActive).toBe(true);
    expect((await api("post", `/${emp.id}/deactivate`).send({ force: true })).status).toBe(400);
  });

  it("deactivating another HR works while one active HR remains; impact of the last HR on itself says isLastActiveHr", async () => {
    const h2 = await createUser({ role: "HR" });
    expect((await api("post", `/${h2.id}/deactivate`)).status).toBe(200);
    const impact = await api("get", `/${hr.id}/deactivation-impact`);
    expect(impact.body).toMatchObject({ isLastActiveHr: true, blocker: "CANNOT_DEACTIVATE_SELF" });
  });
});

describe("LAST_ACTIVE_HR: the rule itself (unreachable through the API while the actor is an active HR)", () => {
  it("assertRoleChangeAllowed refuses to demote the only active HR", async () => {
    await expect(assertRoleChangeAllowed(prisma, { id: hr.id, role: "HR", isActive: true }, "MANAGER")).rejects.toMatchObject({
      statusCode: 409,
      code: "LAST_ACTIVE_HR",
    });
    await createUser({ role: "HR", isActive: false });
    await expect(assertRoleChangeAllowed(prisma, { id: hr.id, role: "HR", isActive: true }, "EMPLOYEE")).rejects.toMatchObject({
      code: "LAST_ACTIVE_HR",
    });
    await createUser({ role: "HR" });
    await expect(assertRoleChangeAllowed(prisma, { id: hr.id, role: "HR", isActive: true }, "EMPLOYEE")).resolves.toBeUndefined();
  });

  it("planDeactivation + deactivationBlocker refuse to deactivate the only active HR", async () => {
    const plan = await planDeactivation(prisma, { id: hr.id, role: "HR" }, d("2026-11-11"));
    expect(plan.isLastActiveHr).toBe(true);
    expect(deactivationBlocker(plan)).toMatchObject({ code: "LAST_ACTIVE_HR" });
  });

  it("an HR actor that was deactivated cannot write anything (401 from the service, like requireAuth), so it cannot remove the last HR", async () => {
    const { updateEmployee, deactivateEmployee, createEmployee, reactivateEmployee } = await import("./employees.service.js");
    const h2 = await createUser({ role: "HR" });
    expect((await api("post", `/${h2.id}/deactivate`)).status).toBe(200);
    // h2 is now inactive but tries to act through the service (as if requireAuth had let it in just before).
    await expect(updateEmployee(h2.id, hr.id, { role: "EMPLOYEE" })).rejects.toMatchObject({ statusCode: 401 });
    await expect(deactivateEmployee(h2.id, hr.id, undefined)).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      createEmployee(h2.id, { email: "x@acme.mx", firstName: "Xx", lastName: "Yy", role: "HR", departmentId: dept.id, managerId: null, hireDate: d("2026-01-01") }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(reactivateEmployee(h2.id, h2.id, undefined)).rejects.toMatchObject({ statusCode: 401 });
    // The reset too: a deactivated HR never walks away with another account's password.
    const { resetEmployeePassword } = await import("./employees.service.js");
    const victim = await createUser({ role: "MANAGER" });
    await expect(resetEmployeePassword(h2.id, victim.id)).rejects.toMatchObject({ statusCode: 401 });
    expect(await prisma.user.count({ where: { role: "HR", isActive: true } })).toBe(1);
    expect(await prisma.hrAuditLog.count({ where: { actorId: h2.id } })).toBe(0);
  });

  it("an actor demoted from HR cannot write either (403)", async () => {
    const { updateEmployee } = await import("./employees.service.js");
    const h2 = await createUser({ role: "MANAGER" });
    const emp = await createUser();
    await expect(updateEmployee(h2.id, emp.id, { firstName: "Nope" })).rejects.toMatchObject({ statusCode: 403 });
    const { resetEmployeePassword } = await import("./employees.service.js");
    await expect(resetEmployeePassword(h2.id, emp.id)).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ---------- reactivation ----------

describe("POST /api/hr/employees/:id/reactivate", () => {
  const OLD = "la contraseña vieja del empleado";

  async function inactiveWithPassword(overrides: { managerId?: string | null } = {}) {
    const emp = await createUser({ email: "beto@acme.mx", managerId: overrides.managerId ?? null });
    const cookie = await authCookie(emp.id);
    await prisma.user.update({ where: { id: emp.id }, data: { passwordHash: await hashPassword(OLD), isActive: false } });
    return { emp: await prisma.user.findUniqueOrThrow({ where: { id: emp.id } }), oldCookie: cookie };
  }

  it("responds 200 with a new temporary password and Cache-Control: no-store; mustChangePassword and passwordChangedAt change", async () => {
    const { emp } = await inactiveWithPassword();
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const res = await api("post", `/${emp.id}/reactivate`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.temporaryPassword).toMatch(TEMP_FORMAT);
    expect(res.body.employee).toMatchObject({ id: emp.id, isActive: true, mustChangePassword: true });
    expectNoSecrets(res.body.employee);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });
    expect(after.isActive).toBe(true);
    expect(after.mustChangePassword).toBe(true);
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(emp.passwordChangedAt.getTime());
    expect(await verify(after.passwordHash, res.body.temporaryPassword)).toBe(true);
    expect(await verify(after.passwordHash, OLD)).toBe(false);
  });

  it("passwordChangedAt advances even with the clock frozen (nextPasswordChangedAt)", async () => {
    const { emp } = await inactiveWithPassword();
    await api("post", `/${emp.id}/reactivate`);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: emp.id } });
    expect(after.passwordChangedAt.getTime()).toBeGreaterThan(emp.passwordChangedAt.getTime());
  });

  it("the old password no longer works, the old session is 401, and the temporary one only opens the password change (403)", async () => {
    const { emp, oldCookie } = await inactiveWithPassword();
    const res = await api("post", `/${emp.id}/reactivate`);
    expect((await login("beto@acme.mx", OLD)).status).toBe(401);
    expect((await request(app).get("/api/me/balance").set("Cookie", oldCookie)).status).toBe(401);
    const fresh = await login("beto@acme.mx", res.body.temporaryPassword);
    expect(fresh.status).toBe(200);
    const blocked = await request(app).get("/api/me/balance").set("Cookie", cookieFrom(fresh));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("writes one REACTIVATED row with the whitelist and without the password anywhere", async () => {
    const { emp } = await inactiveWithPassword();
    const res = await api("post", `/${emp.id}/reactivate`);
    const rows = await prisma.hrAuditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ action: "REACTIVATED", entityType: "EMPLOYEE", entityId: emp.id, actorId: hr.id });
    expect(Object.keys(row.before as object).sort()).toEqual(AUDIT_KEYS);
    expect(Object.keys(row.after as object).sort()).toEqual(AUDIT_KEYS);
    expect(row.before).toMatchObject({ isActive: false, mustChangePassword: false });
    expect(row.after).toMatchObject({ isActive: true, mustChangePassword: true });
    const json = JSON.stringify(row);
    expect(json).not.toContain(res.body.temporaryPassword);
    expect(json).not.toContain("passwordChangedAt");
    expect(json).not.toContain("$argon2");
  });

  it("EMPLOYEE_ALREADY_ACTIVE (409) for an active employee; 404 for an unknown id", async () => {
    const emp = await createUser();
    const before = await dbState();
    const res = await api("post", `/${emp.id}/reactivate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMPLOYEE_ALREADY_ACTIVE");
    expect(await dbState()).toEqual(before);
    expect((await api("post", "/nope/reactivate")).status).toBe(404);
  });

  it("MANAGER_NOT_ELIGIBLE (409) when their manager is now inactive or an EMPLOYEE; the message says to change it first", async () => {
    const m = await createUser({ role: "MANAGER", isActive: false });
    const { emp } = await inactiveWithPassword({ managerId: m.id });
    const before = await dbState();
    const res = await api("post", `/${emp.id}/reactivate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGER_NOT_ELIGIBLE");
    expect(res.body.error).toContain("Cambia su jefe antes de reactivarlo");
    expect(await dbState()).toEqual(before);

    // The way out: edit the inactive employee's manager, then reactivate.
    expect((await api("patch", `/${emp.id}`).send({ managerId: null })).status).toBe(200);
    expect((await api("post", `/${emp.id}/reactivate`)).status).toBe(200);
  });

  it("a demoted manager (with only inactive reports) blocks reactivating those reports", async () => {
    const m = await createUser({ role: "MANAGER" });
    const { emp } = await inactiveWithPassword({ managerId: m.id });
    expect((await api("patch", `/${m.id}`).send({ role: "EMPLOYEE" })).status).toBe(200);
    const res = await api("post", `/${emp.id}/reactivate`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGER_NOT_ELIGIBLE");
  });

  it("STALE_DATA (409) with an old expectedUpdatedAt", async () => {
    const { emp } = await inactiveWithPassword();
    const res = await api("post", `/${emp.id}/reactivate`).send({ expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_DATA");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: emp.id } })).isActive).toBe(false);
  });

  it("GET of the reactivated employee never shows the temporary password", async () => {
    const { emp } = await inactiveWithPassword();
    const res = await api("post", `/${emp.id}/reactivate`);
    const detail = await api("get", `/${emp.id}`);
    expectNoSecrets(detail.body);
    expect(JSON.stringify(detail.body)).not.toContain(res.body.temporaryPassword);
    const list = await api("get", "?status=all");
    expect(JSON.stringify(list.body)).not.toContain(res.body.temporaryPassword);
  });
});

// ---------- database CHECKs (migration hr_employees) ----------

describe("migration hr_employees: CHECK constraints on users", () => {
  async function insertUser(data: Partial<Prisma.UserUncheckedCreateInput>) {
    return prisma.user.create({
      data: { email: `ok${Math.random().toString(36).slice(2)}@acme.mx`, passwordHash: "x", firstName: "Ok", lastName: "Ok", hireDate: d("2020-01-01"), ...data },
    });
  }

  it("chk_users_not_own_manager rejects manager_id = id", async () => {
    const u = await insertUser({});
    const err = await pgErrorOf(() => prisma.user.update({ where: { id: u.id }, data: { managerId: u.id } }));
    expect(err.code).toBe("23514");
    expect(err.message).toContain("chk_users_not_own_manager");
  });

  it.each([["Ana@acme.mx"], [" ana@acme.mx"], ["ana@acme.mx "], ["a@"]])("chk_users_email_normalized rejects %j", async (email) => {
    const err = await pgErrorOf(() => insertUser({ email }));
    expect(err.code).toBe("23514");
    expect(err.message).toContain("chk_users_email_normalized");
  });

  it.each([
    ["firstName", " Ana", "chk_users_first_name_trimmed"],
    ["firstName", "", "chk_users_first_name_trimmed"],
    ["lastName", "Lopez ", "chk_users_last_name_trimmed"],
    ["lastName", "x".repeat(101), "chk_users_last_name_trimmed"],
  ])("%s = %j is rejected by %s", async (field, value, constraint) => {
    const err = await pgErrorOf(() => insertUser({ [field]: value }));
    expect(err.code).toBe("23514");
    expect(err.message).toContain(constraint);
  });

  it("chk_users_hire_date_range: 1950-01-01 and 2100-12-31 pass; 1949-12-31 and 2101-01-01 are rejected", async () => {
    await insertUser({ hireDate: d("1950-01-01") });
    await insertUser({ hireDate: d("2100-12-31") });
    for (const date of ["1949-12-31", "2101-01-01"]) {
      const err = await pgErrorOf(() => insertUser({ hireDate: d(date) }));
      expect(err.message).toContain("chk_users_hire_date_range");
    }
  });
});

describe("migration hr_employees: chk_hr_audit_logs_no_secrets", () => {
  function insertAudit(before: Prisma.InputJsonValue, after: Prisma.InputJsonValue) {
    return prisma.hrAuditLog.create({
      data: { actorId: hr.id, entityType: "EMPLOYEE", entityId: "e1", action: "UPDATED", before, after },
    });
  }

  it("a clean snapshot is accepted (sanity check)", async () => {
    await insertAudit({ id: "e1", firstName: "Ana" }, { id: "e1", firstName: "Anabel" });
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it.each(["passwordHash", "password_hash", "password", "temporaryPassword"])("rejects the key %s in after and in before", async (key) => {
    const inAfter = await pgErrorOf(() => insertAudit({ id: "e1" }, { id: "e1", [key]: "secreto" }));
    expect(inAfter.code).toBe("23514");
    expect(inAfter.message).toContain("chk_hr_audit_logs_no_secrets");
    const inBefore = await pgErrorOf(() => insertAudit({ id: "e1", [key]: "secreto" }, { id: "e1" }));
    expect(inBefore.message).toContain("chk_hr_audit_logs_no_secrets");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });
});

// ---------- leave-request writes on inactive users ----------

describe("leave-request writes re-check isActive under the user lock", () => {
  it("decide (approve/reject) a request of an inactive requester -> 409 EMPLOYEE_INACTIVE, nothing changes", async () => {
    const vac = await vacationType();
    const manager = await createUser({ role: "MANAGER" });
    const emp = await createUser({ managerId: manager.id, isActive: false });
    const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    const cookie = await authCookie(manager.id);
    const before = await dbState();
    const approve = await request(app).post(`/api/leave-requests/${r.id}/approve`).set("Cookie", cookie).send({});
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe("EMPLOYEE_INACTIVE");
    const reject = await request(app).post(`/api/leave-requests/${r.id}/reject`).set("Cookie", cookie).send({ note: "No" });
    expect(reject.status).toBe(409);
    expect(reject.body.code).toBe("EMPLOYEE_INACTIVE");
    expect(await dbState()).toEqual(before);
  });

  it("HR deciding for an inactive requester without a manager also gets 409 EMPLOYEE_INACTIVE", async () => {
    const vac = await vacationType();
    const emp = await createUser({ isActive: false });
    const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    const res = await request(app).post(`/api/leave-requests/${r.id}/approve`).set("Cookie", hrCookie).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMPLOYEE_INACTIVE");
  });

  it("an actor deactivated after requireAuth gets 401 from applyLeaveRequestAction (approve and cancel)", async () => {
    const { applyLeaveRequestAction } = await import("../leave-requests/leave-request-decisions.service.js");
    const vac = await vacationType();
    // HR (the requester has no manager): visibility before the transaction
    // passes by role, so the fresh re-read inside it is what refuses.
    // (With a MANAGER actor the pre-check already answers 404: once the
    // manager is inactive, canView no longer lets them see the request.)
    const otherHr = await createUser({ role: "HR" });
    const emp = await createUser();
    const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    await prisma.user.update({ where: { id: otherHr.id }, data: { isActive: false } });
    await expect(applyLeaveRequestAction({ id: otherHr.id, role: "HR", isActive: true }, r.id, "APPROVE", undefined)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(applyLeaveRequestAction({ id: otherHr.id, role: "HR", isActive: true }, r.id, "REJECT", "No")).rejects.toMatchObject({
      statusCode: 401,
    });
    // The requester itself, deactivated: the actor check runs first, so 401.
    await prisma.user.update({ where: { id: emp.id }, data: { isActive: false } });
    await expect(applyLeaveRequestAction({ id: emp.id, role: "EMPLOYEE", isActive: true }, r.id, "CANCEL", undefined)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("PENDING");
    expect(await prisma.requestEvent.count()).toBe(0);
  });

  it("an active direct manager still decides normally after the re-read (sanity check)", async () => {
    const { applyLeaveRequestAction } = await import("../leave-requests/leave-request-decisions.service.js");
    const vac = await vacationType();
    const manager = await createUser({ role: "MANAGER" });
    const emp = await createUser({ managerId: manager.id });
    const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
    await expect(applyLeaveRequestAction({ id: manager.id, role: "MANAGER", isActive: true }, r.id, "APPROVE", undefined)).resolves.toBeDefined();
  });

  it("createLeaveRequest for a user deactivated after requireAuth -> 401 and no request is created", async () => {
    const { createLeaveRequest } = await import("../leave-requests/leave-requests.service.js");
    const vac = await vacationType();
    const emp = await createUser();
    await prisma.user.update({ where: { id: emp.id }, data: { isActive: false } });
    await expect(
      createLeaveRequest({ id: emp.id, hireDate: emp.hireDate }, { leaveTypeId: vac.id, startDate: d("2026-11-16"), endDate: d("2026-11-20"), reason: undefined }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it("START_BEFORE_HIRE_DATE: someone with a future hire date cannot request leave before it (POST 400, preview agrees)", async () => {
    const perm = await createLeaveType({ code: "PERM_GOCE", countsAgainstVacationBalance: false });
    // Today is 2026-11-11; hired on 2026-12-01 (registered ahead of the first day).
    const emp = await createUser({ hireDate: "2026-12-01" });
    const cookie = await authCookie(emp.id);
    const body = { leaveTypeId: perm.id, startDate: "2026-11-23", endDate: "2026-11-24" };

    const res = await request(app).post("/api/leave-requests").set("Cookie", cookie).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("START_BEFORE_HIRE_DATE");
    expect(await prisma.leaveRequest.count()).toBe(0);

    const preview = await request(app).get("/api/leave-requests/preview").query(body).set("Cookie", cookie);
    expect(preview.status).toBe(200);
    expect(preview.body.preview.canSubmit).toBe(false);
    expect(preview.body.preview.problems.map((p: { code: string }) => p.code)).toContain("START_BEFORE_HIRE_DATE");
    // A date problem: no balance of a period that does not contain the request.
    expect(preview.body.preview.balance).toBeNull();

    // On or after the hire date it is fine.
    const ok = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", cookie)
      .send({ leaveTypeId: perm.id, startDate: "2026-12-01", endDate: "2026-12-02" });
    expect(ok.status).toBe(201);
  });

  it("START_BEFORE_HIRE_DATE is re-checked under the lock with the fresh hireDate (HR moved it after requireAuth)", async () => {
    const { createLeaveRequest } = await import("../leave-requests/leave-requests.service.js");
    const perm = await createLeaveType({ code: "PERM_GOCE2", countsAgainstVacationBalance: false });
    const emp = await createUser({ hireDate: "2023-02-01" });
    const stale = { id: emp.id, hireDate: emp.hireDate };
    // HR moves the hire date into the future after the session was checked.
    await prisma.user.update({ where: { id: emp.id }, data: { hireDate: d("2026-12-01") } });
    await expect(
      createLeaveRequest(stale, { leaveTypeId: perm.id, startDate: d("2026-11-16"), endDate: d("2026-11-17"), reason: undefined }),
    ).rejects.toMatchObject({ statusCode: 400, code: "START_BEFORE_HIRE_DATE" });
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it("createLeaveRequest uses the hireDate read under the lock (HR changed it after requireAuth)", async () => {
    const { createLeaveRequest } = await import("../leave-requests/leave-requests.service.js");
    const vac = await vacationType();
    // Hired 2023-02-01 (16 days); HR moves the hire date to 2026-01-01 (0 days earned).
    const emp = await createUser({ hireDate: "2023-02-01" });
    const stale = { id: emp.id, hireDate: emp.hireDate };
    await prisma.user.update({ where: { id: emp.id }, data: { hireDate: d("2026-01-01") } });
    await expect(
      createLeaveRequest(stale, { leaveTypeId: vac.id, startDate: d("2026-11-16"), endDate: d("2026-11-20"), reason: undefined }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });
});
