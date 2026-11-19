import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { authCookie, createLeaveRequestRow, createLeaveType, createUser, prisma, resetDb } from "../../test/db.js";

const app = createApp();

/** "Today" is Wednesday 2026-11-11 in America/Monterrey; 2026-11-16..20 is Mon..Fri. */
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

const list = () => request(app).get("/api/hr/leave-types").set("Cookie", hrCookie);
const create = (body: unknown) =>
  request(app).post("/api/hr/leave-types").set("Cookie", hrCookie).send(body as object);
const patch = (id: string, body: unknown) =>
  request(app).patch(`/api/hr/leave-types/${id}`).set("Cookie", hrCookie).send(body as object);

const VALID = { code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true };

async function lastAudit() {
  return prisma.hrAuditLog.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
}

describe("GET /api/hr/leave-types", () => {
  it("includes inactive types (active first, then by name) with requestCount and maxBusinessDaysPerRequest", async () => {
    const user = await createUser();
    const vac = await createLeaveType({ code: "VAC", name: "Vacaciones", maxBusinessDaysPerRequest: 10 });
    await createLeaveType({ code: "SICK", name: "Incapacidad", countsAgainstVacationBalance: false });
    const old = await createLeaveType({ code: "OLD", name: "Antiguo", isActive: false });
    await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-16", businessDays: 1 });
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: vac.id, start: "2026-11-17", end: "2026-11-17", businessDays: 1, status: "CANCELLED",
    });
    await createLeaveRequestRow({ requesterId: user.id, leaveTypeId: old.id, start: "2026-11-18", end: "2026-11-18", businessDays: 1 });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body.leaveTypes.map((t: { code: string; isActive: boolean; requestCount: number }) => [t.code, t.isActive, t.requestCount])).toEqual([
      ["SICK", true, 0],
      ["VAC", true, 2],
      ["OLD", false, 1],
    ]);
    expect(res.body.leaveTypes[1]).toEqual({
      id: vac.id,
      code: "VAC",
      name: "Vacaciones",
      countsAgainstVacationBalance: true,
      maxBusinessDaysPerRequest: 10,
      isActive: true,
      requestCount: 2,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
});

describe("POST /api/hr/leave-types", () => {
  it("creates a type (201); maxBusinessDaysPerRequest defaults to null (no limit) and isActive to true", async () => {
    const res = await create(VALID);
    expect(res.status).toBe(201);
    expect(res.body.leaveType).toMatchObject({
      code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true,
      maxBusinessDaysPerRequest: null, isActive: true, requestCount: 0,
    });
  });

  it("trims code and name", async () => {
    const res = await create({ ...VALID, code: "  VAC_2 ", name: "  Vacaciones  " });
    expect(res.status).toBe(201);
    expect(res.body.leaveType).toMatchObject({ code: "VAC_2", name: "Vacaciones" });
  });

  it.each(["AB", "A1", "VAC_2026", "A".repeat(20)])("accepts code %s", async (code) => {
    expect((await create({ ...VALID, code })).status).toBe(201);
  });

  it.each([
    ["lowercase", "vac"],
    ["mixed case", "Vac"],
    ["1 character", "V"],
    ["21 characters", "A".repeat(21)],
    ["starting with a digit", "1VAC"],
    ["starting with underscore", "_VAC"],
    ["a dash", "VAC-1"],
    ["inner space", "VA C"],
    ["accented letter", "VACACIÓN"],
    ["empty", ""],
  ])("rejects a code with %s (400) and writes nothing", async (_label, code) => {
    const res = await create({ ...VALID, code });
    expect(res.status).toBe(400);
    expect(await prisma.leaveType.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it.each([
    ["missing code", { name: "X Y", countsAgainstVacationBalance: true }],
    ["missing name", { code: "XY", countsAgainstVacationBalance: true }],
    ["missing countsAgainstVacationBalance", { code: "XY", name: "X Y" }],
    ["countsAgainstVacationBalance as string", { ...VALID, countsAgainstVacationBalance: "true" }],
    ["isActive (not accepted on create, strict)", { ...VALID, isActive: false }],
    ["unknown field", { ...VALID, color: "red" }],
  ])("responds 400 for %s", async (_label, body) => {
    expect((await create(body)).status).toBe(400);
    expect(await prisma.leaveType.count()).toBe(0);
  });

  it.each([0, -1, 366, 1.5, "3"])("rejects maxBusinessDaysPerRequest = %j (400)", async (max) => {
    const res = await create({ ...VALID, maxBusinessDaysPerRequest: max });
    expect(res.status).toBe(400);
    expect(await prisma.leaveType.count()).toBe(0);
  });

  // A type that does NOT count against vacations: the Art. 78 LFT minimum does not apply.
  it.each([1, 11, 365, null])("accepts maxBusinessDaysPerRequest = %j on a type that does not count against vacations", async (max) => {
    const res = await create({ ...VALID, countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: max });
    expect(res.status).toBe(201);
    expect(res.body.leaveType.maxBusinessDaysPerRequest).toBe(max);
  });

  it("responds 409 DUPLICATE_CODE for an existing code", async () => {
    await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const res = await create({ ...VALID, name: "Otro nombre" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "DUPLICATE_CODE" });
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("responds 409 DUPLICATE_NAME for an existing name in another case", async () => {
    await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const res = await create({ ...VALID, code: "VAC2", name: " VACACIONES " });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_NAME");
    expect(await prisma.leaveType.count()).toBe(1);
  });

  it("a duplicate name of an INACTIVE type is still a duplicate", async () => {
    await createLeaveType({ code: "OLD", name: "Vacaciones", isActive: false });
    const res = await create({ ...VALID, code: "VAC2" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_NAME");
  });

  it("when both code and name are taken, reports DUPLICATE_CODE", async () => {
    await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const res = await create(VALID);
    expect(res.body.code).toBe("DUPLICATE_CODE");
  });
});

describe("PATCH /api/hr/leave-types/:id - validation", () => {
  it("responds 400 when the body includes code (code is not editable)", async () => {
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const res = await patch(type.id, { code: "VAX" });
    expect(res.status).toBe(400);
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).code).toBe("VAC");
  });

  it("responds 400 when code comes together with a valid change, and applies nothing", async () => {
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const res = await patch(type.id, { code: "VAX", name: "Vacaciones LFT" });
    expect(res.status).toBe(400);
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).name).toBe("Vacaciones");
  });

  it("responds 400 for an empty body", async () => {
    const type = await createLeaveType();
    expect((await patch(type.id, {})).status).toBe(400);
  });

  it.each([0, 366, -5, 2.5])("responds 400 for maxBusinessDaysPerRequest = %j", async (max) => {
    const type = await createLeaveType({ maxBusinessDaysPerRequest: 5 });
    const res = await patch(type.id, { maxBusinessDaysPerRequest: max });
    expect(res.status).toBe(400);
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).maxBusinessDaysPerRequest).toBe(5);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("maxBusinessDaysPerRequest: null removes the limit", async () => {
    const type = await createLeaveType({ maxBusinessDaysPerRequest: 5 });
    const res = await patch(type.id, { maxBusinessDaysPerRequest: null });
    expect(res.status).toBe(200);
    expect(res.body.leaveType.maxBusinessDaysPerRequest).toBeNull();
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).maxBusinessDaysPerRequest).toBeNull();
    const audit = await lastAudit();
    expect(audit.action).toBe("UPDATED");
    expect(audit.before).toMatchObject({ maxBusinessDaysPerRequest: 5 });
    expect(audit.after).toMatchObject({ maxBusinessDaysPerRequest: null });
  });

  it("responds 404 for an id that does not exist", async () => {
    expect((await patch("does-not-exist", { isActive: false })).status).toBe(404);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("responds 409 DUPLICATE_NAME when renaming to another type's name in another case", async () => {
    await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const sick = await createLeaveType({ code: "SICK", name: "Incapacidad" });
    const res = await patch(sick.id, { name: "vacaciones" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_NAME");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("allows changing only the case of its own name", async () => {
    const type = await createLeaveType({ code: "VAC", name: "vacaciones" });
    const res = await patch(type.id, { name: "Vacaciones" });
    expect(res.status).toBe(200);
    expect(res.body.leaveType.name).toBe("Vacaciones");
  });
});

describe("PATCH /api/hr/leave-types/:id - audit action", () => {
  it("isActive: false alone is DEACTIVATED", async () => {
    const type = await createLeaveType();
    const res = await patch(type.id, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.leaveType.isActive).toBe(false);
    expect((await lastAudit()).action).toBe("DEACTIVATED");
  });

  it("isActive: true alone on an inactive type is REACTIVATED", async () => {
    const type = await createLeaveType({ isActive: false });
    const res = await patch(type.id, { isActive: true });
    expect(res.status).toBe(200);
    expect((await lastAudit()).action).toBe("REACTIVATED");
  });

  it("name + isActive together is UPDATED (one single entry)", async () => {
    const type = await createLeaveType({ name: "Viejo" });
    const res = await patch(type.id, { name: "Nuevo", isActive: false });
    expect(res.status).toBe(200);
    expect(await prisma.hrAuditLog.count()).toBe(1);
    expect((await lastAudit()).action).toBe("UPDATED");
  });

  it("isActive equal to the current value plus a real change of another field is UPDATED", async () => {
    const type = await createLeaveType({ countsAgainstVacationBalance: true });
    await patch(type.id, { isActive: true, countsAgainstVacationBalance: false });
    expect((await lastAudit()).action).toBe("UPDATED");
  });

  it("a real change of name plus an unchanged isActive: false on an inactive type is UPDATED, not DEACTIVATED", async () => {
    const type = await createLeaveType({ name: "Viejo", isActive: false });
    await patch(type.id, { name: "Nuevo", isActive: false });
    expect((await lastAudit()).action).toBe("UPDATED");
  });

  it("a PATCH that changes nothing (same values) returns 200 and writes no audit entry", async () => {
    const type = await createLeaveType({ name: "Vacaciones", isActive: true, maxBusinessDaysPerRequest: null });
    const res = await patch(type.id, { name: "Vacaciones", isActive: true, maxBusinessDaysPerRequest: null });
    expect(res.status).toBe(200);
    expect(await prisma.hrAuditLog.count()).toBe(0);
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).updatedAt).toEqual(type.updatedAt);
  });

  it("deactivating an already inactive type writes nothing", async () => {
    const type = await createLeaveType({ isActive: false });
    expect((await patch(type.id, { isActive: false })).status).toBe(200);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });
});

describe("a deactivated leave type", () => {
  async function setup() {
    const manager = await createUser({ role: "MANAGER" });
    const employee = await createUser({ managerId: manager.id });
    const type = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    return { manager, employee, type };
  }

  it("disappears from the public GET /api/leave-types but stays in the HR list", async () => {
    const { employee, type } = await setup();
    await patch(type.id, { isActive: false });
    const pub = await request(app).get("/api/leave-types").set("Cookie", await authCookie(employee.id));
    expect(pub.body.leaveTypes).toEqual([]);
    const hr = await list();
    expect(hr.body.leaveTypes).toHaveLength(1);
  });

  it("cannot be used for a new request: POST 400 INVALID_LEAVE_TYPE", async () => {
    const { employee, type } = await setup();
    await patch(type.id, { isActive: false });
    const res = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", await authCookie(employee.id))
      .send({ leaveTypeId: type.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_LEAVE_TYPE");
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it("its existing PENDING requests can still be approved by the manager", async () => {
    const { manager, employee, type } = await setup();
    const created = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", await authCookie(employee.id))
      .send({ leaveTypeId: type.id, startDate: "2026-11-16", endDate: "2026-11-17" });
    expect(created.status).toBe(201);
    await patch(type.id, { isActive: false });

    const res = await request(app)
      .post(`/api/leave-requests/${created.body.leaveRequest.id}/approve`)
      .set("Cookie", await authCookie(manager.id));
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.status).toBe("APPROVED");
  });

  it("its existing PENDING requests can still be cancelled by the requester", async () => {
    const { employee, type } = await setup();
    const req = await createLeaveRequestRow({ requesterId: employee.id, leaveTypeId: type.id, start: "2026-11-16", end: "2026-11-16", businessDays: 1 });
    await patch(type.id, { isActive: false });
    const res = await request(app)
      .post(`/api/leave-requests/${req.id}/cancel`)
      .set("Cookie", await authCookie(employee.id));
    expect(res.status).toBe(200);
  });

  it("can be used again after being reactivated", async () => {
    const { employee, type } = await setup();
    await patch(type.id, { isActive: false });
    await patch(type.id, { isActive: true });
    const res = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", await authCookie(employee.id))
      .send({ leaveTypeId: type.id, startDate: "2026-11-16", endDate: "2026-11-16" });
    expect(res.status).toBe(201);
  });
});

describe("leave_types: database safety nets", () => {
  it.each([0, 367])("chk_leave_types_max_business_days_range rejects %i", async (max) => {
    await expect(createLeaveType({ maxBusinessDaysPerRequest: max })).rejects.toThrow();
  });

  it("chk_leave_types_max_business_days_range accepts 366 (the DB bound is wider than the API's 365)", async () => {
    await expect(createLeaveType({ maxBusinessDaysPerRequest: 366 })).resolves.toBeDefined();
  });

  it.each(["vac", "1AB", "AB-C"])("chk_leave_types_code_format rejects code %s", async (code) => {
    await expect(createLeaveType({ code, name: `Tipo ${code}x` })).rejects.toThrow();
  });

  it("uq_leave_types_name_lower rejects a name differing only in case", async () => {
    await createLeaveType({ code: "A1", name: "Vacaciones" });
    await expect(createLeaveType({ code: "A2", name: "VACACIONES" })).rejects.toThrow();
  });
});

describe("Art. 78 LFT: a type that counts against vacations cannot cap requests below 12 business days", () => {
  const counting = { code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true };

  describe("POST", () => {
    it.each([12, 13, 365, null])("accepts maxBusinessDaysPerRequest = %j on a counting type", async (max) => {
      const res = await create({ ...counting, maxBusinessDaysPerRequest: max });
      expect(res.status).toBe(201);
      expect(res.body.leaveType.maxBusinessDaysPerRequest).toBe(max);
    });

    it("accepts a counting type without maxBusinessDaysPerRequest (defaults to null = no limit)", async () => {
      const res = await create(counting);
      expect(res.status).toBe(201);
      expect(res.body.leaveType.maxBusinessDaysPerRequest).toBeNull();
    });

    it.each([1, 5, 11])("responds 400 LIMIT_BELOW_LFT_MINIMUM for maxBusinessDaysPerRequest = %i, and writes nothing", async (max) => {
      const res = await create({ ...counting, maxBusinessDaysPerRequest: max });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining("12"), code: "LIMIT_BELOW_LFT_MINIMUM" });
      expect(await prisma.leaveType.count()).toBe(0);
      expect(await prisma.hrAuditLog.count()).toBe(0);
    });

    it("an out-of-range maximum (0) is a plain Zod 400, not LIMIT_BELOW_LFT_MINIMUM", async () => {
      const res = await create({ ...counting, maxBusinessDaysPerRequest: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).not.toBe("LIMIT_BELOW_LFT_MINIMUM");
    });

    it("the LFT rule is checked before the duplicate checks would answer 409", async () => {
      await createLeaveType({ code: "VAC", name: "Vacaciones" });
      const res = await create({ ...counting, maxBusinessDaysPerRequest: 5 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("LIMIT_BELOW_LFT_MINIMUM");
    });
  });

  describe("PATCH evaluates the RESULTING type (current row + change)", () => {
    async function expectRejected(id: string, body: object, before: { countsAgainstVacationBalance: boolean; maxBusinessDaysPerRequest: number | null }) {
      const res = await patch(id, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String), code: "LIMIT_BELOW_LFT_MINIMUM" });
      expect(await prisma.leaveType.findUniqueOrThrow({ where: { id } })).toMatchObject(before);
      expect(await prisma.hrAuditLog.count()).toBe(0);
    }

    it("only countsAgainstVacationBalance: true on a type with max 5 -> 400, nothing written", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 5 });
      await expectRejected(type.id, { countsAgainstVacationBalance: true }, { countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 5 });
    });

    it("only countsAgainstVacationBalance: true on a type with max 11 -> 400", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 11 });
      await expectRejected(type.id, { countsAgainstVacationBalance: true }, { countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 11 });
    });

    it("only countsAgainstVacationBalance: true on a type with max 12 -> 200", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 12 });
      const res = await patch(type.id, { countsAgainstVacationBalance: true });
      expect(res.status).toBe(200);
      expect(res.body.leaveType).toMatchObject({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12 });
    });

    it("only countsAgainstVacationBalance: true on a type without limit -> 200", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: null });
      expect((await patch(type.id, { countsAgainstVacationBalance: true })).status).toBe(200);
    });

    it("only maxBusinessDaysPerRequest: 11 on a counting type -> 400", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: null });
      await expectRejected(type.id, { maxBusinessDaysPerRequest: 11 }, { countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: null });
    });

    it("only maxBusinessDaysPerRequest: 12 on a counting type -> 200 (exact limit)", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: null });
      const res = await patch(type.id, { maxBusinessDaysPerRequest: 12 });
      expect(res.status).toBe(200);
      expect(res.body.leaveType.maxBusinessDaysPerRequest).toBe(12);
    });

    it("lowering a counting type from 12 to 11 -> 400", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12 });
      await expectRejected(type.id, { maxBusinessDaysPerRequest: 11 }, { countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12 });
    });

    it("combined: countsAgainstVacationBalance: true + maxBusinessDaysPerRequest: 11 -> 400", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 5 });
      await expectRejected(
        type.id,
        { countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 11 },
        { countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 5 },
      );
    });

    it("combined: countsAgainstVacationBalance: true + maxBusinessDaysPerRequest: 12 on a type with max 5 -> 200", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 5 });
      const res = await patch(type.id, { countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12 });
      expect(res.status).toBe(200);
      expect(res.body.leaveType).toMatchObject({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12 });
      expect((await lastAudit()).action).toBe("UPDATED");
    });

    it("combined: countsAgainstVacationBalance: true + maxBusinessDaysPerRequest: null on a type with max 5 -> 200", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 5 });
      expect((await patch(type.id, { countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: null })).status).toBe(200);
    });

    it("combined the other way: countsAgainstVacationBalance: false + maxBusinessDaysPerRequest: 3 on a counting type -> 200", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 12 });
      const res = await patch(type.id, { countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 3 });
      expect(res.status).toBe(200);
      expect(res.body.leaveType).toMatchObject({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: 3 });
    });

    it("on a NON-counting type any maximum is fine (e.g. 1)", async () => {
      const type = await createLeaveType({ countsAgainstVacationBalance: false, maxBusinessDaysPerRequest: null });
      expect((await patch(type.id, { maxBusinessDaysPerRequest: 1 })).status).toBe(200);
    });

    it("a legacy counting type with max 5 (no DB CHECK) can still be deactivated or renamed, but not have its limit kept below 12", async () => {
      // There is no database CHECK for this rule, so such a row can exist (old data or a manual fix).
      // The rule only runs when "descuenta" or the limit changes.
      const type = await createLeaveType({ countsAgainstVacationBalance: true, maxBusinessDaysPerRequest: 5 });
      expect((await patch(type.id, { isActive: false })).status).toBe(200);
      expect((await patch(type.id, { name: "Vacaciones antiguas" })).status).toBe(200);
      const res = await patch(type.id, { maxBusinessDaysPerRequest: 6 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("LIMIT_BELOW_LFT_MINIMUM");
      expect((await patch(type.id, { maxBusinessDaysPerRequest: null })).status).toBe(200);
    });
  });
});

describe("PATCH /api/hr/leave-types/:id - optimistic concurrency (expectedUpdatedAt)", () => {
  async function loaded(id: string): Promise<string> {
    const res = await list();
    return res.body.leaveTypes.find((t: { id: string }) => t.id === id).updatedAt;
  }

  it("with the current updatedAt the change is applied and logged", async () => {
    const type = await createLeaveType({ name: "Viejo" });
    const expectedUpdatedAt = await loaded(type.id);
    vi.setSystemTime(new Date("2026-11-11T18:05:00Z"));
    const res = await patch(type.id, { name: "Nuevo", expectedUpdatedAt });
    expect(res.status).toBe(200);
    expect(res.body.leaveType.name).toBe("Nuevo");
    expect(res.body.leaveType.updatedAt).toBe("2026-11-11T18:05:00.000Z");
    expect(await prisma.hrAuditLog.count()).toBe(1);
  });

  it("the same instant written without milliseconds also matches", async () => {
    const type = await createLeaveType({ name: "Viejo" });
    expect(type.updatedAt.toISOString()).toBe("2026-11-11T18:00:00.000Z");
    const res = await patch(type.id, { name: "Nuevo", expectedUpdatedAt: "2026-11-11T18:00:00Z" });
    expect(res.status).toBe(200);
  });

  it("after someone else saved, the old updatedAt -> 409 STALE_DATA; nothing written, no audit row", async () => {
    const type = await createLeaveType({ name: "Viejo", maxBusinessDaysPerRequest: null });
    const staleUpdatedAt = await loaded(type.id);
    vi.setSystemTime(new Date("2026-11-11T18:05:00Z"));
    expect((await patch(type.id, { name: "Cambio de otra persona", expectedUpdatedAt: staleUpdatedAt })).status).toBe(200);
    const afterOther = await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } });

    vi.setSystemTime(new Date("2026-11-11T18:10:00Z"));
    const res = await patch(type.id, { name: "Mi cambio", maxBusinessDaysPerRequest: 20, expectedUpdatedAt: staleUpdatedAt });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "STALE_DATA" });
    expect(await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).toEqual(afterOther);
    expect(await prisma.hrAuditLog.count()).toBe(1); // only the other person's change
  });

  it("a stale updatedAt is 409 even when the values would change nothing (no audit row)", async () => {
    const type = await createLeaveType({ name: "Vacaciones" });
    const res = await patch(type.id, { name: "Vacaciones", expectedUpdatedAt: "2026-11-10T00:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_DATA");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("a matching updatedAt with values that change nothing -> 200, updatedAt untouched, no audit row", async () => {
    const type = await createLeaveType({ name: "Vacaciones" });
    const expectedUpdatedAt = type.updatedAt.toISOString();
    vi.setSystemTime(new Date("2026-11-11T18:05:00Z"));
    const res = await patch(type.id, { name: "Vacaciones", expectedUpdatedAt });
    expect(res.status).toBe(200);
    expect(res.body.leaveType.updatedAt).toBe(expectedUpdatedAt);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("an updatedAt 1 ms off is stale", async () => {
    const type = await createLeaveType({ name: "Viejo" });
    const res = await patch(type.id, { name: "Nuevo", expectedUpdatedAt: "2026-11-11T18:00:00.001Z" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_DATA");
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).name).toBe("Viejo");
  });

  it("STALE_DATA wins over other errors (e.g. the LFT rule): the client must reload first", async () => {
    const type = await createLeaveType({ countsAgainstVacationBalance: true });
    const res = await patch(type.id, { maxBusinessDaysPerRequest: 5, expectedUpdatedAt: "2026-11-10T00:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_DATA");
  });

  it("without expectedUpdatedAt it works as before (last write wins)", async () => {
    const type = await createLeaveType({ name: "Viejo" });
    vi.setSystemTime(new Date("2026-11-11T18:05:00Z"));
    await patch(type.id, { name: "Intermedio" });
    const res = await patch(type.id, { name: "Final" });
    expect(res.status).toBe(200);
    expect(res.body.leaveType.name).toBe("Final");
  });

  it("an unknown id with expectedUpdatedAt -> 404 (not 409)", async () => {
    expect((await patch("does-not-exist", { name: "Nuevo", expectedUpdatedAt: "2026-11-11T18:00:00.000Z" })).status).toBe(404);
  });

  it("{ expectedUpdatedAt } alone (no field to change) -> 400 and nothing written", async () => {
    const type = await createLeaveType({ name: "Viejo" });
    const res = await patch(type.id, { expectedUpdatedAt: type.updatedAt.toISOString() });
    expect(res.status).toBe(400);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it.each([
    ["not a date", "ayer"],
    ["date without time", "2026-11-11"],
    ["a number", 1731348000000],
    ["null", null],
  ])("expectedUpdatedAt as %s -> 400", async (_label, expectedUpdatedAt) => {
    const type = await createLeaveType({ name: "Viejo" });
    const res = await patch(type.id, { name: "Nuevo", expectedUpdatedAt });
    expect(res.status).toBe(400);
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).name).toBe("Viejo");
  });
});

describe("leave type names reject control characters anywhere", () => {
  const CONTROL_NAMES: [string, string][] = [
    ["inner newline", "Vaca\nciones"],
    ["inner carriage return", "Vaca\rciones"],
    ["inner tab", "Vaca\tciones"],
    ["NUL alone", "\u0000"],
    ["NUL inside", "Vaca\u0000ciones"],
    ["DEL (U+007F)", "Vaca\u007Fciones"],
    ["C1 control (U+0085)", "Vaca\u0085ciones"],
  ];

  it.each(CONTROL_NAMES)("POST responds 400 for a name with %s, and writes nothing", async (_label, name) => {
    const res = await create({ ...VALID, name });
    expect(res.status).toBe(400);
    expect(await prisma.leaveType.count()).toBe(0);
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it.each(CONTROL_NAMES)("PATCH responds 400 for a name with %s, and changes nothing", async (_label, name) => {
    const type = await createLeaveType({ name: "Vacaciones" });
    const res = await patch(type.id, { name });
    expect(res.status).toBe(400);
    expect((await prisma.leaveType.findUniqueOrThrow({ where: { id: type.id } })).name).toBe("Vacaciones");
    expect(await prisma.hrAuditLog.count()).toBe(0);
  });

  it("control characters only at the ends are trimmed, not rejected", async () => {
    const res = await create({ ...VALID, name: "\n\tVacaciones\t\n" });
    expect(res.status).toBe(201);
    expect(res.body.leaveType.name).toBe("Vacaciones");
  });
});
