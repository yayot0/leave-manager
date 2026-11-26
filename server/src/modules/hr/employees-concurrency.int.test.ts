import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { authCookie, createLeaveRequestRow, createLeaveType, createUser, prisma, resetDb } from "../../test/db.js";
import { DEACTIVATION_CANCEL_NOTE } from "./employees.service.js";

const app = createApp();

/**
 * Races between writes on the employee directory (and with leave-request
 * writes). Each scenario runs several ROUNDS with fresh rows, so a test does
 * not pass by luck of scheduling. Fixed "today": 2026-11-11 (Wednesday) in
 * America/Monterrey; only Date is faked.
 */
const NOW = new Date("2026-11-11T18:00:00Z");
const ROUNDS = 8;

let hr1: { id: string };
let hr2: { id: string };
let cookie1: string;
let cookie2: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  hr1 = await createUser({ role: "HR" });
  hr2 = await createUser({ role: "HR" });
  cookie1 = await authCookie(hr1.id);
  cookie2 = await authCookie(hr2.id);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const patch = (cookie: string, id: string, body: object) =>
  request(app).patch(`/api/hr/employees/${id}`).set("Cookie", cookie).send(body);
const deactivate = (cookie: string, id: string) =>
  request(app).post(`/api/hr/employees/${id}/deactivate`).set("Cookie", cookie).send({});

/** Walks manager_id from every user; fails if any chain comes back to a user already seen. */
async function expectNoManagerCycle() {
  const users = await prisma.user.findMany({ select: { id: true, managerId: true } });
  const managerOf = new Map(users.map((u) => [u.id, u.managerId]));
  for (const start of users) {
    const seen = new Set<string>();
    let cursor: string | null = start.id;
    while (cursor) {
      expect(seen.has(cursor), `manager cycle through ${cursor}`).toBe(false);
      seen.add(cursor);
      cursor = managerOf.get(cursor) ?? null;
    }
  }
}

describe("manager cycles under concurrency (lockEmployeeDirectory)", () => {
  it.each([
    ["two different HR users", () => [cookie1, cookie2] as const],
    ["the same HR user twice", () => [cookie1, cookie1] as const],
  ])(
    "PATCH manager(A)=B and manager(B)=A in parallel (%s): exactly one 200, the other 409 MANAGER_CYCLE, never a cycle",
    async (_label, cookies) => {
      const [c1, c2] = cookies();
      for (let round = 0; round < ROUNDS; round++) {
        const a = await createUser({ role: "MANAGER" });
        const b = await createUser({ role: "MANAGER" });
        const [ra, rb] = await Promise.all([patch(c1, a.id, { managerId: b.id }), patch(c2, b.id, { managerId: a.id })]);

        expect([ra.status, rb.status].sort(), `round ${round}`).toEqual([200, 409]);
        const loser = ra.status === 409 ? ra : rb;
        expect(loser.body.code).toBe("MANAGER_CYCLE");

        const [fa, fb] = await Promise.all([
          prisma.user.findUniqueOrThrow({ where: { id: a.id } }),
          prisma.user.findUniqueOrThrow({ where: { id: b.id } }),
        ]);
        expect(fa.managerId === b.id && fb.managerId === a.id).toBe(false);
        expect([fa.managerId, fb.managerId].filter(Boolean)).toHaveLength(1);
        // Exactly one UPDATED row per round: the loser logged nothing.
        expect(await prisma.hrAuditLog.count({ where: { entityId: { in: [a.id, b.id] } } })).toBe(1);
      }
      await expectNoManagerCycle();
    },
  );

  it("three-way ring in parallel (A->B, B->C, C->A): at most two succeed and no cycle remains", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await createUser({ role: "MANAGER" });
      const b = await createUser({ role: "MANAGER" });
      const c = await createUser({ role: "MANAGER" });
      const results = await Promise.all([
        patch(cookie1, a.id, { managerId: b.id }),
        patch(cookie2, b.id, { managerId: c.id }),
        patch(cookie1, c.id, { managerId: a.id }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, `round ${round}`).toEqual([200, 200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe("MANAGER_CYCLE");
    }
    await expectNoManagerCycle();
  });
});

describe("there is always at least one active HR user", () => {
  it("two HR users deactivate each other in parallel: exactly one is applied, the other gets 403 (actor no longer active) or 409 LAST_ACTIVE_HR", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [r1, r2] = await Promise.all([deactivate(cookie1, hr2.id), deactivate(cookie2, hr1.id)]);
      const statuses = [r1.status, r2.status];
      expect(statuses.filter((s) => s === 200), `round ${round}`).toHaveLength(1);
      const loser = r1.status === 200 ? r2 : r1;
      expect(
        loser.status === 403 || loser.status === 401 || (loser.status === 409 && loser.body.code === "LAST_ACTIVE_HR"),
        `loser answered ${loser.status} ${JSON.stringify(loser.body)}`,
      ).toBe(true);
      expect(await prisma.user.count({ where: { role: "HR", isActive: true } })).toBe(1);
      expect(await prisma.hrAuditLog.count({ where: { action: "DEACTIVATED" } })).toBe(round + 1);
      // Next round: both active again (the session cookies stay valid: no password change).
      await prisma.user.updateMany({ where: { id: { in: [hr1.id, hr2.id] } }, data: { isActive: true } });
    }
  });

  it("two HR users demote each other (PATCH role) in parallel: exactly one is applied and one HR remains", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const target = round % 2 === 0 ? "EMPLOYEE" : "MANAGER";
      const [r1, r2] = await Promise.all([patch(cookie1, hr2.id, { role: target }), patch(cookie2, hr1.id, { role: target })]);
      expect([r1.status, r2.status].filter((s) => s === 200), `round ${round}`).toHaveLength(1);
      const loser = r1.status === 200 ? r2 : r1;
      expect(loser.status === 403 || loser.status === 401 || (loser.status === 409 && loser.body.code === "LAST_ACTIVE_HR")).toBe(true);
      expect(await prisma.user.count({ where: { role: "HR", isActive: true } })).toBe(1);
      await prisma.user.updateMany({ where: { id: { in: [hr1.id, hr2.id] } }, data: { role: "HR" } });
    }
  });

  it("deactivate H2 and demote H1 in parallel (mixed): one HR always remains", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await Promise.all([deactivate(cookie1, hr2.id), patch(cookie2, hr1.id, { role: "EMPLOYEE" })]);
      expect(await prisma.user.count({ where: { role: "HR", isActive: true } })).toBe(1);
      await prisma.user.updateMany({ where: { id: { in: [hr1.id, hr2.id] } }, data: { role: "HR", isActive: true } });
    }
  });

  it("sequential: with two HR, H1 deactivates H2 (200); afterwards H2's session is 401", async () => {
    expect((await deactivate(cookie1, hr2.id)).status).toBe(200);
    expect((await request(app).get("/api/hr/employees").set("Cookie", cookie2)).status).toBe(401);
    expect(await prisma.user.count({ where: { role: "HR", isActive: true } })).toBe(1);
  });
});

describe("deactivation vs. leave-request writes (lockUserForWrite)", () => {
  async function employeeSetup() {
    const manager = await createUser({ role: "MANAGER" });
    const emp = await createUser({ hireDate: "2023-02-01", managerId: manager.id });
    return { manager, emp, empCookie: await authCookie(emp.id), managerCookie: await authCookie(manager.id) };
  }

  it("POST /api/leave-requests vs. deactivate in parallel: never a PENDING request of an inactive employee", async () => {
    const vac = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS * 2; round++) {
      const { emp, empCookie } = await employeeSetup();
      const create = request(app)
        .post("/api/leave-requests")
        .set("Cookie", empCookie)
        .send({ leaveTypeId: vac.id, startDate: "2026-11-16", endDate: "2026-11-20" });
      const [created, deactivated] = await Promise.all([create, deactivate(cookie1, emp.id)]);

      expect(deactivated.status, `round ${round}: ${JSON.stringify(deactivated.body)}`).toBe(200);
      expect([201, 401], `round ${round}: ${JSON.stringify(created.body)}`).toContain(created.status);
      outcomes.add(String(created.status));

      const requests = await prisma.leaveRequest.findMany({ where: { requesterId: emp.id } });
      expect(requests.filter((r) => r.status === "PENDING")).toHaveLength(0);
      if (created.status === 201) {
        // Created first, then cancelled by the deactivation, signed by HR.
        expect(requests).toHaveLength(1);
        expect(requests[0]!.status).toBe("CANCELLED");
        expect(deactivated.body.cancelledRequests).toBe(1);
        const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: requests[0]!.id, action: "CANCELLED" } });
        expect(events).toEqual([expect.objectContaining({ actorId: hr1.id, note: DEACTIVATION_CANCEL_NOTE })]);
      } else {
        expect(requests).toHaveLength(0);
        expect(deactivated.body.cancelledRequests).toBe(0);
      }
    }
    // Informative only: which orders were observed (scheduling decides).
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it("manager approves vs. HR deactivates in parallel: the future request always ends CANCELLED", async () => {
    const vac = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    for (let round = 0; round < ROUNDS; round++) {
      const { emp, manager, managerCookie } = await employeeSetup();
      const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
      const [approved, deactivated] = await Promise.all([
        request(app).post(`/api/leave-requests/${r.id}/approve`).set("Cookie", managerCookie).send({}),
        deactivate(cookie1, emp.id),
      ]);
      expect(deactivated.status).toBe(200);
      if (approved.status !== 200) {
        expect(approved.status, `round ${round}: ${JSON.stringify(approved.body)}`).toBe(409);
        expect(approved.body.code).toBe("EMPLOYEE_INACTIVE");
      }
      const final = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id } });
      expect(final.status).toBe("CANCELLED");
      // An approval that won keeps its decider; one that lost left none.
      expect(final.deciderId).toBe(approved.status === 200 ? manager.id : null);
    }
  });

  it("the employee cancels vs. HR deactivates in parallel: one CANCELLED event, never two", async () => {
    const vac = await createLeaveType({ code: "VAC", name: "Vacaciones" });
    for (let round = 0; round < ROUNDS; round++) {
      const { emp, empCookie } = await employeeSetup();
      const r = await createLeaveRequestRow({ requesterId: emp.id, leaveTypeId: vac.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 });
      const [cancelled, deactivated] = await Promise.all([
        request(app).post(`/api/leave-requests/${r.id}/cancel`).set("Cookie", empCookie).send({}),
        deactivate(cookie1, emp.id),
      ]);
      expect(deactivated.status).toBe(200);
      expect([200, 401]).toContain(cancelled.status);
      expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("CANCELLED");
      const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: r.id } });
      expect(events).toHaveLength(1);
      expect(events[0]!.actorId).toBe(cancelled.status === 200 ? emp.id : hr1.id);
      expect(deactivated.body.cancelledRequests).toBe(cancelled.status === 200 ? 0 : 1);
    }
  });
});

describe("other cross-row races on the directory", () => {
  it("create an employee under manager M vs. deactivate M in parallel: never an active employee under an inactive manager", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    for (let round = 0; round < ROUNDS; round++) {
      const m = await createUser({ role: "MANAGER" });
      const [created, deactivated] = await Promise.all([
        request(app)
          .post("/api/hr/employees")
          .set("Cookie", cookie1)
          .send({
            email: `nuevo${round}@acme.mx`,
            firstName: "Nuevo",
            lastName: "Empleado",
            role: "EMPLOYEE",
            departmentId: dept.id,
            managerId: m.id,
            hireDate: "2026-11-16",
          }),
        deactivate(cookie2, m.id),
      ]);
      const ok = [created.status, deactivated.status];
      if (created.status === 201) {
        expect(deactivated.status, `round ${round}`).toBe(409);
        expect(deactivated.body.code).toBe("HAS_ACTIVE_REPORTS");
      } else {
        expect(ok, `round ${round}`).toEqual([409, 200]);
        expect(created.body.code).toBe("MANAGER_NOT_ELIGIBLE");
      }
      const orphans = await prisma.user.count({ where: { isActive: true, manager: { isActive: false } } });
      expect(orphans).toBe(0);
    }
  });

  it("demote B to EMPLOYEE vs. assign X's manager = B in parallel: never an active report under an EMPLOYEE", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const b = await createUser({ role: "MANAGER" });
      const x = await createUser();
      const [demoted, assigned] = await Promise.all([
        patch(cookie1, b.id, { role: "EMPLOYEE" }),
        patch(cookie2, x.id, { managerId: b.id }),
      ]);
      expect([demoted.status, assigned.status].sort(), `round ${round}`).toEqual([200, 409]);
      if (demoted.status === 409) expect(demoted.body.code).toBe("HAS_ACTIVE_REPORTS");
      else expect(assigned.body.code).toBe("MANAGER_NOT_ELIGIBLE");
      expect(await prisma.user.count({ where: { isActive: true, manager: { role: "EMPLOYEE" } } })).toBe(0);
    }
  });

  it("two creates with the same email (different case) in parallel: one 201, one 409 DUPLICATE_EMAIL", async () => {
    const dept = await prisma.department.create({ data: { name: "Ventas" } });
    for (let round = 0; round < ROUNDS; round++) {
      const body = (email: string) => ({
        email,
        firstName: "Doble",
        lastName: "Alta",
        role: "EMPLOYEE",
        departmentId: dept.id,
        managerId: null,
        hireDate: "2026-11-16",
      });
      const [r1, r2] = await Promise.all([
        request(app).post("/api/hr/employees").set("Cookie", cookie1).send(body(`dup${round}@acme.mx`)),
        request(app).post("/api/hr/employees").set("Cookie", cookie2).send(body(`DUP${round}@Acme.MX`)),
      ]);
      expect([r1.status, r2.status].sort(), `round ${round}`).toEqual([201, 409]);
      expect((r1.status === 409 ? r1 : r2).body.code).toBe("DUPLICATE_EMAIL");
      expect(await prisma.user.count({ where: { email: `dup${round}@acme.mx` } })).toBe(1);
    }
  });

  it("two PATCHes of different fields with the same expectedUpdatedAt in parallel: one 200, the other 409 STALE_DATA", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const emp = await createUser();
      const loaded = emp.updatedAt.toISOString();
      // Every write gets a later updatedAt than the one loaded (frozen clock otherwise).
      vi.setSystemTime(new Date(NOW.getTime() + (round + 1) * 1000));
      const [r1, r2] = await Promise.all([
        patch(cookie1, emp.id, { firstName: "Uno", expectedUpdatedAt: loaded }),
        patch(cookie2, emp.id, { lastName: "Dos", expectedUpdatedAt: loaded }),
      ]);
      expect([r1.status, r2.status].sort(), `round ${round}`).toEqual([200, 409]);
      expect((r1.status === 409 ? r1 : r2).body.code).toBe("STALE_DATA");
      expect(await prisma.hrAuditLog.count({ where: { entityId: emp.id } })).toBe(1);
    }
  });
});
