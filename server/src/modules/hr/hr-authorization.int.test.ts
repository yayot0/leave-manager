import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { AUTH_COOKIE_NAME } from "../auth/cookie.js";
import { authCookie, createHoliday, createLeaveType, createUser, prisma, resetDb } from "../../test/db.js";

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

/** Existing catalog rows, so PATCH/DELETE target real ids (a 403 must not depend on a 404). */
async function seedCatalogs() {
  const department = await prisma.department.create({ data: { name: "Ventas" } });
  const leaveType = await createLeaveType({ code: "VAC", name: "Vacaciones" });
  const holiday = await createHoliday("2026-12-25", "Navidad");
  // Target of the password reset (no department, so DELETE /departments/:id still works).
  const employee = await createUser({ role: "EMPLOYEE" });
  return { department, leaveType, holiday, employee };
}

type Seed = Awaited<ReturnType<typeof seedCatalogs>>;

interface Endpoint {
  name: string;
  call: (seed: Seed) => request.Test;
}

/** Every endpoint under /api/hr, each with a VALID body/query (so only the role can stop it). */
const ENDPOINTS: Endpoint[] = [
  { name: "GET /employees/count", call: () => request(app).get("/api/hr/employees/count") },
  {
    name: "POST /employees/:id/reset-password",
    call: (s) => request(app).post(`/api/hr/employees/${s.employee.id}/reset-password`),
  },
  { name: "GET /departments", call: () => request(app).get("/api/hr/departments") },
  { name: "POST /departments", call: () => request(app).post("/api/hr/departments").send({ name: "Compras" }) },
  {
    name: "PATCH /departments/:id",
    call: (s) => request(app).patch(`/api/hr/departments/${s.department.id}`).send({ name: "Otro nombre" }),
  },
  { name: "DELETE /departments/:id", call: (s) => request(app).delete(`/api/hr/departments/${s.department.id}`) },
  { name: "GET /leave-types", call: () => request(app).get("/api/hr/leave-types") },
  {
    name: "POST /leave-types",
    call: () =>
      request(app)
        .post("/api/hr/leave-types")
        .send({ code: "NEW", name: "Nuevo tipo", countsAgainstVacationBalance: false }),
  },
  {
    name: "PATCH /leave-types/:id",
    call: (s) => request(app).patch(`/api/hr/leave-types/${s.leaveType.id}`).send({ isActive: false }),
  },
  { name: "GET /holidays", call: () => request(app).get("/api/hr/holidays?year=2026") },
  { name: "GET /holidays/impact", call: () => request(app).get("/api/hr/holidays/impact?date=2026-11-18") },
  {
    name: "POST /holidays",
    call: () => request(app).post("/api/hr/holidays").send({ date: "2026-12-24", name: "Nochebuena" }),
  },
  { name: "DELETE /holidays/:id", call: (s) => request(app).delete(`/api/hr/holidays/${s.holiday.id}`) },
];

/** Whole state of the catalogs + audit log, to prove a refused call wrote nothing. */
async function catalogState() {
  return {
    departments: await prisma.department.findMany({ orderBy: { id: "asc" } }),
    leaveTypes: await prisma.leaveType.findMany({ orderBy: { id: "asc" } }),
    holidays: await prisma.holiday.findMany({ orderBy: { id: "asc" } }),
    // The password reset writes here: a refused call must not touch any account.
    passwords: await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { id: true, passwordHash: true, mustChangePassword: true, passwordChangedAt: true },
    }),
    auditLogs: await prisma.hrAuditLog.count(),
  };
}

describe("/api/hr authorization: the whole router is HR-only", () => {
  describe.each(ENDPOINTS)("$name", ({ call }) => {
    it("responds 401 without a session cookie and writes nothing", async () => {
      const seed = await seedCatalogs();
      const before = await catalogState();
      const res = await call(seed);
      expect(res.status).toBe(401);
      expect(await catalogState()).toEqual(before);
    });

    it("responds 401 with a forged cookie and writes nothing", async () => {
      const seed = await seedCatalogs();
      const before = await catalogState();
      const res = await call(seed).set("Cookie", `${AUTH_COOKIE_NAME}=garbage`);
      expect(res.status).toBe(401);
      expect(await catalogState()).toEqual(before);
    });

    it.each(["EMPLOYEE", "MANAGER"] as const)(
      "responds 403 to %s and writes nothing (neither the catalog nor hr_audit_logs)",
      async (role) => {
        const seed = await seedCatalogs();
        const user = await createUser({ role });
        const before = await catalogState();
        const res = await call(seed).set("Cookie", await authCookie(user.id));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: expect.any(String) });
        expect(await catalogState()).toEqual(before);
        expect(before.auditLogs).toBe(0);
      },
    );

    it("responds 401 to an HR user who was deactivated (session no longer valid)", async () => {
      const seed = await seedCatalogs();
      const hr = await createUser({ role: "HR", isActive: false });
      const before = await catalogState();
      const res = await call(seed).set("Cookie", await authCookie(hr.id));
      expect(res.status).toBe(401);
      expect(await catalogState()).toEqual(before);
    });

    it("is allowed for an active HR user (sanity check: the endpoint really exists)", async () => {
      const seed = await seedCatalogs();
      const hr = await createUser({ role: "HR" });
      const res = await call(seed).set("Cookie", await authCookie(hr.id));
      expect([200, 201, 204]).toContain(res.status);
    });
  });
});
