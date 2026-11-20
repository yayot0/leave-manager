import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../db/pg-errors.js";
import { authCookie, createUser, prisma, resetDb } from "../../test/db.js";

const app = createApp();

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

const list = () => request(app).get("/api/hr/departments").set("Cookie", hrCookie);
const create = (body: unknown) =>
  request(app).post("/api/hr/departments").set("Cookie", hrCookie).send(body as object);
const rename = (id: string, body: unknown) =>
  request(app).patch(`/api/hr/departments/${id}`).set("Cookie", hrCookie).send(body as object);
const remove = (id: string) => request(app).delete(`/api/hr/departments/${id}`).set("Cookie", hrCookie);

async function assignTo(departmentId: string, opts: { isActive?: boolean } = {}) {
  const user = await createUser({ isActive: opts.isActive });
  await prisma.user.update({ where: { id: user.id }, data: { departmentId } });
  return user;
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected the operation to throw, but it succeeded");
}

describe("GET /api/hr/departments", () => {
  it("returns an empty list when there are no departments", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ departments: [] });
  });

  it("lists departments by name with employeeCount counting active AND inactive employees", async () => {
    const ventas = await prisma.department.create({ data: { name: "Ventas" } });
    const compras = await prisma.department.create({ data: { name: "Compras" } });
    await prisma.department.create({ data: { name: "Almacén" } });
    await assignTo(ventas.id);
    await assignTo(ventas.id);
    await assignTo(ventas.id, { isActive: false });
    await assignTo(compras.id, { isActive: false });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.departments.map((x: { name: string; employeeCount: number }) => [x.name, x.employeeCount])).toEqual([
      ["Almacén", 0],
      ["Compras", 1],
      ["Ventas", 3],
    ]);
    expect(res.body.departments[0]).toEqual({
      id: expect.any(String),
      name: "Almacén",
      employeeCount: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
});

describe("POST /api/hr/departments", () => {
  it("creates a department (201) with employeeCount 0", async () => {
    const res = await create({ name: "Ventas" });
    expect(res.status).toBe(201);
    expect(res.body.department).toMatchObject({ id: expect.any(String), name: "Ventas", employeeCount: 0 });
    expect(await prisma.department.count()).toBe(1);
  });

  it("trims surrounding spaces before saving", async () => {
    const res = await create({ name: "   Recursos Humanos  " });
    expect(res.status).toBe(201);
    expect(res.body.department.name).toBe("Recursos Humanos");
  });

  it.each([
    ["lowercase", "ventas"],
    ["uppercase", "VENTAS"],
    ["surrounding spaces", "  Ventas  "],
    ["mixed case and spaces", " vEnTaS "],
  ])("responds 409 DUPLICATE_NAME for an existing name with different %s", async (_label, name) => {
    await create({ name: "Ventas" });
    const res = await create({ name });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "DUPLICATE_NAME" });
    expect(await prisma.department.count()).toBe(1);
  });

  it.each([
    ["missing name", {}],
    ["null name", { name: null }],
    ["numeric name", { name: 123 }],
    ["1 character", { name: "A" }],
    ["only spaces (empty after trim)", { name: "     " }],
    ["61 characters", { name: "A".repeat(61) }],
    ["unknown field (strict)", { name: "Ventas", extra: true }],
  ])("responds 400 for %s and writes nothing", async (_label, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(await prisma.department.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("accepts exactly 2 and exactly 60 characters (length limits are inclusive)", async () => {
    expect((await create({ name: "TI" })).status).toBe(201);
    expect((await create({ name: "B".repeat(60) })).status).toBe(201);
  });
});

describe("PATCH /api/hr/departments/:id", () => {
  it("renames a department and keeps its employeeCount", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await assignTo(dept.id);
    const res = await rename(dept.id, { name: "Ventas Norte" });
    expect(res.status).toBe(200);
    expect(res.body.department).toMatchObject({ id: dept.id, name: "Ventas Norte", employeeCount: 1 });
    expect((await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name).toBe("Ventas Norte");
  });

  it("responds 409 DUPLICATE_NAME when renaming to another department's name in a different case", async () => {
    await prisma.department.create({ data: { name: "Ventas" } });
    const compras = await prisma.department.create({ data: { name: "Compras" } });
    const res = await rename(compras.id, { name: " ventas " });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_NAME");
    expect((await prisma.department.findUniqueOrThrow({ where: { id: compras.id } })).name).toBe("Compras");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("allows changing only the case of its own name (not a duplicate of itself)", async () => {
    const dept = await prisma.department.create({ data: { name: "ventas" } });
    const res = await rename(dept.id, { name: "Ventas" });
    expect(res.status).toBe(200);
    expect(res.body.department.name).toBe("Ventas");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it.each([
    ["the exact same name", "Ventas"],
    ["the same name with surrounding spaces", "  Ventas "],
  ])("renaming to %s returns 200 and writes neither the row nor the audit log", async (_label, name) => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    const res = await rename(dept.id, { name });
    expect(res.status).toBe(200);
    expect(res.body.department.name).toBe("Ventas");
    expect(await prisma.hrAuditLog.count()).toBe(0);
    const after = await prisma.department.findUniqueOrThrow({ where: { id: dept.id } });
    expect(after.updatedAt).toEqual(dept.updatedAt);
  });

  it("responds 404 for an id that does not exist", async () => {
    const res = await rename("does-not-exist", { name: "Ventas" });
    expect(res.status).toBe(404);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("responds 400 for an invalid body even when the id does not exist", async () => {
    const res = await rename("does-not-exist", { name: "" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/hr/departments/:id", () => {
  it("deletes an empty department (204, no body)", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    const res = await remove(dept.id);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(await prisma.department.count()).toBe(0);
  });

  it("responds 409 DEPARTMENT_HAS_EMPLOYEES when its only employee is INACTIVE", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await assignTo(dept.id, { isActive: false });
    const res = await remove(dept.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "DEPARTMENT_HAS_EMPLOYEES" });
    expect(await prisma.department.count()).toBe(1);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("responds 409 DEPARTMENT_HAS_EMPLOYEES with an active employee", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await assignTo(dept.id);
    const res = await remove(dept.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEPARTMENT_HAS_EMPLOYEES");
  });

  it("can be deleted after its last employee is moved out", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    const user = await assignTo(dept.id);
    expect((await remove(dept.id)).status).toBe(409);
    await prisma.user.update({ where: { id: user.id }, data: { departmentId: null } });
    expect((await remove(dept.id)).status).toBe(204);
  });

  it("responds 404 for an id that does not exist (and for an already deleted one)", async () => {
    expect((await remove("does-not-exist")).status).toBe(404);
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    expect((await remove(dept.id)).status).toBe(204);
    expect((await remove(dept.id)).status).toBe(404);
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("a deleted name can be reused", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await remove(dept.id);
    expect((await create({ name: "ventas" })).status).toBe(201);
  });
});

describe("departments: database safety nets behind the API", () => {
  it("FK RESTRICT: deleting a department with an assigned user directly in the database fails", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    const user = await assignTo(dept.id);
    const err = await captureError(() => prisma.department.delete({ where: { id: dept.id } }));
    expect(isForeignKeyViolation(err, "users_department_id_fkey")).toBe(true);
    expect(await prisma.department.count()).toBe(1);
    // ON DELETE SET NULL is gone: the employee keeps the department.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).departmentId).toBe(dept.id);
  });

  it("uq_departments_name_lower: inserting a name that differs only in case fails", async () => {
    await prisma.department.create({ data: { name: "Ventas" } });
    const err = await captureError(() => prisma.department.create({ data: { name: "VENTAS" } }));
    expect(isUniqueViolation(err)).toBe(true);
  });

  it.each([" Ventas", "Ventas ", ""])("chk_departments_name_trimmed rejects %j", async (name) => {
    await expect(prisma.department.create({ data: { name } })).rejects.toThrow();
  });
});

describe("department names reject control characters anywhere", () => {
  const CONTROL_NAMES: [string, string][] = [
    ["inner newline", "Ven\ntas"],
    ["inner carriage return", "Ven\rtas"],
    ["inner tab", "Ven\ttas"],
    ["NUL alone", "\u0000"],
    ["NUL inside", "Ven\u0000tas"],
    ["DEL (U+007F)", "Ven\u007Ftas"],
    ["C1 control (U+0085)", "Ven\u0085tas"],
  ];

  it.each(CONTROL_NAMES)("POST responds 400 for a name with %s, and writes nothing", async (_label, name) => {
    const res = await create({ name });
    expect(res.status).toBe(400);
    expect(await prisma.department.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it.each(CONTROL_NAMES)("PATCH responds 400 for a name with %s, and changes nothing", async (_label, name) => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    const res = await rename(dept.id, { name });
    expect(res.status).toBe(400);
    expect((await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name).toBe("Ventas");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("control characters only at the ends are trimmed, not rejected", async () => {
    const res = await create({ name: "\n\tVentas \t" });
    expect(res.status).toBe(201);
    expect(res.body.department.name).toBe("Ventas");
  });
});

describe("isForeignKeyViolation(err, constraint) only matches the named constraint", () => {
  async function managerFkError(): Promise<unknown> {
    // users_manager_id_fkey: a manager id that does not exist.
    return captureError(() =>
      prisma.user.create({
        data: {
          email: `fk-${Date.now()}@test.local`,
          passwordHash: "x",
          firstName: "Fk",
          lastName: "Test",
          role: "EMPLOYEE",
          hireDate: new Date(Date.UTC(2023, 1, 1)),
          managerId: "does-not-exist",
        },
      }),
    );
  }

  it("true for the constraint that actually failed (users_manager_id_fkey)", async () => {
    expect(isForeignKeyViolation(await managerFkError(), "users_manager_id_fkey")).toBe(true);
  });

  it("false for a different FK constraint name (users_department_id_fkey) on that same error", async () => {
    expect(isForeignKeyViolation(await managerFkError(), "users_department_id_fkey")).toBe(false);
  });

  it("false for the department FK error when asked about another constraint", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    await assignTo(dept.id);
    const err = await captureError(() => prisma.department.delete({ where: { id: dept.id } }));
    expect(isForeignKeyViolation(err, "users_department_id_fkey")).toBe(true);
    expect(isForeignKeyViolation(err, "users_manager_id_fkey")).toBe(false);
    expect(isForeignKeyViolation(err, "leave_requests_leave_type_id_fkey")).toBe(false);
  });

  it("false for a unique violation, a plain Error and non-errors", async () => {
    await prisma.department.create({ data: { name: "Ventas" } });
    const unique = await captureError(() => prisma.department.create({ data: { name: "VENTAS" } }));
    expect(isForeignKeyViolation(unique, "users_department_id_fkey")).toBe(false);
    expect(isForeignKeyViolation(new Error("users_department_id_fkey"), "users_department_id_fkey")).toBe(false);
    expect(isForeignKeyViolation(null, "users_department_id_fkey")).toBe(false);
    expect(isForeignKeyViolation("users_department_id_fkey", "users_department_id_fkey")).toBe(false);
  });
});
