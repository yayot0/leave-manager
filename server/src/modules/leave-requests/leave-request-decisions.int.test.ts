import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { LeaveRequestStatus } from "../../generated/prisma/enums.js";
import {
  authCookie,
  createAdjustment,
  createLeaveRequestRow,
  createLeaveType,
  createUser,
  prisma,
  resetDb,
} from "../../test/db.js";

const app = createApp();

/**
 * "Today" is 2026-11-11 (Wednesday) in America/Monterrey.
 * Future requests use 2026-11-16..2026-11-20 (Mon..Fri, 5 business days).
 */
const NOW = new Date("2026-11-11T18:00:00Z");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Small org chart similar to the seed:
 *   director (MANAGER, no manager)
 *   ├── hr1, hr2 (HR)
 *   ├── jefeA (MANAGER) ── a1, a2
 *   ├── jefeB (MANAGER) ── b1
 *   └── jefeInactivo (MANAGER, inactive) ── c1
 */
/** Re-signs every cookie with the current (fake) clock: sessions last 8 h. */
async function refreshCookies(org: Org) {
  for (const [name, user] of Object.entries(org.users) as [keyof Org["users"], { id: string }][]) {
    org.cookies[name] = await authCookie(user.id);
  }
}

async function createOrg() {
  const director = await createUser({ role: "MANAGER" });
  const hr1 = await createUser({ role: "HR", managerId: director.id });
  const hr2 = await createUser({ role: "HR", managerId: director.id });
  const jefeA = await createUser({ role: "MANAGER", managerId: director.id });
  const a1 = await createUser({ managerId: jefeA.id });
  const a2 = await createUser({ managerId: jefeA.id });
  const jefeB = await createUser({ role: "MANAGER", managerId: director.id });
  const b1 = await createUser({ managerId: jefeB.id });
  const jefeInactivo = await createUser({ role: "MANAGER", managerId: director.id, isActive: false });
  const c1 = await createUser({ managerId: jefeInactivo.id });
  const vacation = await createLeaveType({ code: "VAC", name: "Vacaciones" });
  const sick = await createLeaveType({ code: "SICK", name: "Incapacidad", countsAgainstVacationBalance: false });

  const users = { director, hr1, hr2, jefeA, a1, a2, jefeB, b1, jefeInactivo, c1 };
  const cookies = {} as Record<keyof typeof users, string>;
  for (const [name, user] of Object.entries(users) as [keyof typeof users, { id: string }][]) {
    cookies[name] = await authCookie(user.id);
  }
  return { ...users, users, cookies, vacation, sick };
}

type Org = Awaited<ReturnType<typeof createOrg>>;

async function requestRow(
  org: Org,
  requesterId: string,
  opts: {
    start?: string;
    end?: string;
    businessDays?: number;
    status?: LeaveRequestStatus;
    deciderId?: string;
    decidedAt?: Date;
    leaveTypeId?: string;
  } = {},
) {
  return createLeaveRequestRow({
    requesterId,
    leaveTypeId: opts.leaveTypeId ?? org.vacation.id,
    start: opts.start ?? "2026-11-16",
    end: opts.end ?? opts.start ?? "2026-11-20",
    businessDays: opts.businessDays ?? 5,
    status: opts.status,
    deciderId: opts.deciderId,
    decidedAt: opts.decidedAt,
  });
}

type Action = "approve" | "reject" | "cancel";

function act(cookie: string, id: string, action: Action, body?: unknown) {
  const req = request(app).post(`/api/leave-requests/${id}/${action}`).set("Cookie", cookie);
  if (body !== undefined) return req.send(body as object);
  // reject requires a note; give one by default so tests focus on permissions.
  if (action === "reject") return req.send({ note: "No hay cobertura" });
  return req;
}

function detail(cookie: string, id: string) {
  return request(app).get(`/api/leave-requests/${id}`).set("Cookie", cookie);
}

function pending(cookie: string) {
  return request(app).get("/api/leave-requests/pending-approvals").set("Cookie", cookie);
}

/** Request row + its events, to prove an operation changed nothing. */
async function snapshot(id: string) {
  const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
  const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: id } });
  return {
    status: row.status,
    deciderId: row.deciderId,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    updatedAt: row.updatedAt,
    eventCount: events.length,
  };
}

// ---------------------------------------------------------------------------

describe("permission matrix for approve", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("an employee cannot approve a teammate's request: 404 (they cannot even see it)", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.a2, lr.id, "approve");
    expect(res.status).toBe(404);
  });

  it("the manager of another team (jefeB) cannot approve a1's request: 404", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.jefeB, lr.id, "approve");
    expect(res.status).toBe(404);
  });

  it("the direct manager (jefeA) approves a1's request: 200", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.jefeA, lr.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.status).toBe("APPROVED");
  });

  it("jefeA cannot approve their own request: 403", async () => {
    const lr = await requestRow(org, org.jefeA.id);
    const res = await act(org.cookies.jefeA, lr.id, "approve");
    expect(res.status).toBe(403);
  });

  it("hr1 cannot approve their own request: 403", async () => {
    const lr = await requestRow(org, org.hr1.id);
    const res = await act(org.cookies.hr1, lr.id, "approve");
    expect(res.status).toBe(403);
  });

  it("the director approves jefeA's request", async () => {
    const lr = await requestRow(org, org.jefeA.id);
    expect((await act(org.cookies.director, lr.id, "approve")).status).toBe(200);
  });

  it("the director approves hr1's request", async () => {
    const lr = await requestRow(org, org.hr1.id);
    expect((await act(org.cookies.director, lr.id, "approve")).status).toBe(200);
  });

  it("another HR (hr2) cannot approve hr1's request, because hr1 has an active manager: 403", async () => {
    const lr = await requestRow(org, org.hr1.id);
    expect((await act(org.cookies.hr2, lr.id, "approve")).status).toBe(403);
  });

  it("HR approves the director's request (the director has no manager)", async () => {
    const lr = await requestRow(org, org.director.id);
    expect((await act(org.cookies.hr1, lr.id, "approve")).status).toBe(200);
  });

  it("the director cannot approve their own request even though nobody is above them: 403", async () => {
    const lr = await requestRow(org, org.director.id);
    expect((await act(org.cookies.director, lr.id, "approve")).status).toBe(403);
  });

  it("HR approves the request of an employee whose manager is inactive", async () => {
    const lr = await requestRow(org, org.c1.id);
    expect((await act(org.cookies.hr2, lr.id, "approve")).status).toBe(200);
  });

  it("the inactive manager cannot approve: their cookie is rejected with 401 by requireAuth", async () => {
    const lr = await requestRow(org, org.c1.id);
    const res = await act(org.cookies.jefeInactivo, lr.id, "approve");
    expect(res.status).toBe(401);
    expect((await snapshot(lr.id)).status).toBe("PENDING");
  });

  it("HR cannot approve a1 (who has an active manager): they can see it, so 403", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.hr1, lr.id, "approve");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/No te corresponde/);
  });

  it("the director (manager of jefeA) cannot approve a1's request (not the direct manager): 404", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.director, lr.id, "approve")).status).toBe(404);
  });

  it("the same matrix applies to reject", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.a2, lr.id, "reject")).status).toBe(404);
    expect((await act(org.cookies.jefeB, lr.id, "reject")).status).toBe(404);
    expect((await act(org.cookies.hr1, lr.id, "reject")).status).toBe(403);
    expect((await act(org.cookies.a1, lr.id, "reject")).status).toBe(403);
    expect((await act(org.cookies.jefeA, lr.id, "reject")).status).toBe(200);
  });

  it("without cookie every action returns 401", async () => {
    const lr = await requestRow(org, org.a1.id);
    for (const action of ["approve", "reject", "cancel"] as const) {
      const res = await request(app).post(`/api/leave-requests/${lr.id}/${action}`).send({ note: "x" });
      expect(res.status).toBe(401);
    }
    expect((await request(app).get(`/api/leave-requests/${lr.id}`)).status).toBe(401);
    expect((await request(app).get("/api/leave-requests/pending-approvals")).status).toBe(401);
  });
});

describe("GET /api/leave-requests/:id (visibility and payload)", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("the requester sees their request with permissions canCancel only", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await detail(org.cookies.a1, lr.id);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest).toMatchObject({
      id: lr.id,
      status: "PENDING",
      startDate: "2026-11-16",
      endDate: "2026-11-20",
      businessDays: 5,
      isOverdue: false,
      requester: { id: org.a1.id },
      permissions: { canApprove: false, canReject: false, canCancel: true },
      events: [],
    });
  });

  it("the direct manager sees canApprove/canReject but not canCancel", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await detail(org.cookies.jefeA, lr.id);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.permissions).toEqual({ canApprove: true, canReject: true, canCancel: false });
  });

  it("HR can see the detail of anybody, with permissions only where HR decides", async () => {
    const a1Req = await requestRow(org, org.a1.id);
    const dirReq = await requestRow(org, org.director.id);
    const c1Req = await requestRow(org, org.c1.id);
    const jefeBReq = await requestRow(org, org.jefeB.id);

    const a1Res = await detail(org.cookies.hr1, a1Req.id);
    expect(a1Res.status).toBe(200);
    expect(a1Res.body.leaveRequest.permissions).toEqual({ canApprove: false, canReject: false, canCancel: false });

    expect((await detail(org.cookies.hr1, dirReq.id)).body.leaveRequest.permissions.canApprove).toBe(true);
    expect((await detail(org.cookies.hr1, c1Req.id)).body.leaveRequest.permissions.canApprove).toBe(true);
    expect((await detail(org.cookies.hr1, jefeBReq.id)).status).toBe(200);
  });

  it("a teammate gets 404", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await detail(org.cookies.a2, lr.id);
    expect(res.status).toBe(404);
  });

  it("a manager of another team gets 404", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await detail(org.cookies.jefeB, lr.id)).status).toBe(404);
  });

  it("a hidden request and a non-existent id return the exact same 404 body", async () => {
    const lr = await requestRow(org, org.a1.id);
    const hidden = await detail(org.cookies.a2, lr.id);
    const missing = await detail(org.cookies.a2, "clxxxxxxxxxxxxxxxxxxxxxxx");
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it("acting on a non-existent id returns the same 404 as acting on a hidden one", async () => {
    const lr = await requestRow(org, org.a1.id);
    for (const action of ["approve", "reject", "cancel"] as const) {
      const hidden = await act(org.cookies.a2, lr.id, action);
      const missing = await act(org.cookies.a2, "clxxxxxxxxxxxxxxxxxxxxxxx", action);
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(hidden.body).toEqual(missing.body);
    }
  });

  it("an id longer than 64 chars is a validation error (400), never 500", async () => {
    const res = await detail(org.cookies.a1, "x".repeat(65));
    expect(res.status).toBe(400);
  });

  it("does not expose the raw deciderId nor the requester's manager/hire data", async () => {
    const lr = await requestRow(org, org.a1.id, { status: "APPROVED", deciderId: org.jefeA.id });
    const res = await detail(org.cookies.a1, lr.id);
    const body = res.body.leaveRequest;
    expect(body).not.toHaveProperty("deciderId");
    expect(body).not.toHaveProperty("requesterId");
    expect(Object.keys(body.requester).sort()).toEqual(["firstName", "id", "lastName"]);
    expect(body.decider).toEqual({ id: org.jefeA.id, firstName: org.jefeA.firstName, lastName: org.jefeA.lastName });
    expect(JSON.stringify(body)).not.toMatch(/managerId|hireDate|passwordHash|email/);
  });

  it("whoever decided a request can still see it after the requester changes team", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.jefeA, lr.id, "approve")).status).toBe(200);
    await prisma.user.update({ where: { id: org.a1.id }, data: { managerId: org.jefeB.id } });
    const res = await detail(org.cookies.jefeA, lr.id);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.permissions).toEqual({ canApprove: false, canReject: false, canCancel: false });
  });

  it("returns the events in order with action, note and actor (CREATED by API, then APPROVED)", async () => {
    const created = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", org.cookies.a1)
      .send({ leaveTypeId: org.vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(created.status).toBe(201);
    const id = created.body.leaveRequest.id as string;

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect((await act(org.cookies.jefeA, id, "approve", { note: "Disfrútalas" })).status).toBe(200);

    const res = await detail(org.cookies.a1, id);
    const events = res.body.leaveRequest.events as Array<{ action: string; note: string | null; actor: { id: string } }>;
    expect(events.map((e) => [e.action, e.note, e.actor.id])).toEqual([
      ["CREATED", null, org.a1.id],
      ["APPROVED", "Disfrútalas", org.jefeA.id],
    ]);
    expect(Object.keys(events[1].actor).sort()).toEqual(["firstName", "id", "lastName"]);
  });

  it("isOverdue is true in the detail for a PENDING request that starts today", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-11", end: "2026-11-11", businessDays: 1 });
    expect((await detail(org.cookies.jefeA, lr.id)).body.leaveRequest.isOverdue).toBe(true);
  });
});

describe("state transitions through the API", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  type Setup = { status: LeaveRequestStatus; start: string; label: string };
  const setups: Record<string, Setup> = {
    pending: { status: "PENDING", start: "2026-11-16", label: "PENDING" },
    approvedFuture: { status: "APPROVED", start: "2026-11-16", label: "APPROVED (starts tomorrow+)" },
    approvedToday: { status: "APPROVED", start: "2026-11-11", label: "APPROVED (starts today)" },
    approvedYesterday: { status: "APPROVED", start: "2026-11-10", label: "APPROVED (started yesterday)" },
    rejected: { status: "REJECTED", start: "2026-11-16", label: "REJECTED" },
    cancelled: { status: "CANCELLED", start: "2026-11-16", label: "CANCELLED" },
  };

  const matrix: Array<[keyof typeof setups, Action, number, LeaveRequestStatus]> = [
    ["pending", "approve", 200, "APPROVED"],
    ["pending", "reject", 200, "REJECTED"],
    ["pending", "cancel", 200, "CANCELLED"],
    ["approvedFuture", "approve", 409, "APPROVED"],
    ["approvedFuture", "reject", 409, "APPROVED"],
    ["approvedFuture", "cancel", 200, "CANCELLED"],
    ["approvedToday", "approve", 409, "APPROVED"],
    ["approvedToday", "reject", 409, "APPROVED"],
    ["approvedToday", "cancel", 409, "APPROVED"],
    ["approvedYesterday", "cancel", 409, "APPROVED"],
    ["rejected", "approve", 409, "REJECTED"],
    ["rejected", "reject", 409, "REJECTED"],
    ["rejected", "cancel", 409, "REJECTED"],
    ["cancelled", "approve", 409, "CANCELLED"],
    ["cancelled", "reject", 409, "CANCELLED"],
    ["cancelled", "cancel", 409, "CANCELLED"],
  ];

  it.each(matrix)("%s + %s => %i, final status %s", async (setupKey, action, expectedStatus, finalStatus) => {
    const s = setups[setupKey];
    const decided = s.status === "APPROVED" || s.status === "REJECTED";
    const lr = await requestRow(org, org.a1.id, {
      status: s.status,
      start: s.start,
      end: s.start,
      businessDays: 1,
      ...(decided ? { deciderId: org.jefeA.id } : {}),
    });
    const before = await snapshot(lr.id);
    const cookie = action === "cancel" ? org.cookies.a1 : org.cookies.jefeA;

    const res = await act(cookie, lr.id, action);

    expect(res.status).toBe(expectedStatus);
    const after = await snapshot(lr.id);
    expect(after.status).toBe(finalStatus);
    if (expectedStatus === 409) {
      expect(res.body).toEqual({ error: expect.any(String) });
      expect(after).toEqual(before);
    } else {
      expect(res.body.leaveRequest.status).toBe(finalStatus);
      expect(after.eventCount).toBe(before.eventCount + 1);
    }
  });

  it("approve records decider, decidedAt and decisionNote; the response is the full detail", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.jefeA, lr.id, "approve", { note: "  Ok  " });
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest).toMatchObject({
      status: "APPROVED",
      decisionNote: "Ok",
      decidedAt: NOW.toISOString(),
      decider: { id: org.jefeA.id },
      permissions: { canApprove: false, canReject: false, canCancel: false },
    });
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
    expect(row.deciderId).toBe(org.jefeA.id);
    expect(row.decidedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.decisionNote).toBe("Ok");
  });

  it("reject records decider, decidedAt and the required note", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.jefeA, lr.id, "reject", { note: "Cierre de mes" });
    expect(res.status).toBe(200);
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
    expect(row).toMatchObject({ status: "REJECTED", deciderId: org.jefeA.id, decisionNote: "Cierre de mes" });
    expect(row.decidedAt).not.toBeNull();
  });

  it("approving an overdue PENDING request (started yesterday) is still allowed", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-10", end: "2026-11-10", businessDays: 1 });
    expect((await act(org.cookies.jefeA, lr.id, "approve")).status).toBe(200);
  });
});

describe("status-code precedence: 404 > 403 > 409 > 422", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("a non-viewer gets 404 even when the state would give 409", async () => {
    const lr = await requestRow(org, org.a1.id, { status: "REJECTED", deciderId: org.jefeA.id });
    expect((await act(org.cookies.jefeB, lr.id, "approve")).status).toBe(404);
  });

  it("a viewer who may not decide gets 403 even when the state would give 409", async () => {
    const lr = await requestRow(org, org.a1.id, { status: "REJECTED", deciderId: org.jefeA.id });
    expect((await act(org.cookies.hr1, lr.id, "approve")).status).toBe(403);
    expect((await act(org.cookies.a1, lr.id, "approve")).status).toBe(403);
  });

  it("an invalid state gives 409 even when the balance would give 422", async () => {
    const lr = await requestRow(org, org.a1.id, { status: "REJECTED", deciderId: org.jefeA.id });
    await createAdjustment(org.a1.id, -20, "2026-06-01");
    expect((await act(org.cookies.jefeA, lr.id, "approve")).status).toBe(409);
  });

  it("a viewer who may not decide gets 403 even when the balance would give 422", async () => {
    const lr = await requestRow(org, org.a1.id);
    await createAdjustment(org.a1.id, -20, "2026-06-01");
    expect((await act(org.cookies.hr1, lr.id, "approve")).status).toBe(403);
  });

  it("cancelling someone else's visible request is 403 even if its state does not allow cancelling", async () => {
    const lr = await requestRow(org, org.a1.id, { status: "REJECTED", deciderId: org.jefeA.id });
    expect((await act(org.cookies.jefeA, lr.id, "cancel")).status).toBe(403);
  });
});

describe("body validation for decisions", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("reject without body => 400", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await request(app).post(`/api/leave-requests/${lr.id}/reject`).set("Cookie", org.cookies.jefeA);
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/obligatoria/)]));
  });

  it.each([
    ["missing note", {}],
    ["empty note", { note: "" }],
    ["blank note", { note: "    " }],
    ["note of 501 characters", { note: "x".repeat(501) }],
    ["non-string note", { note: 123 }],
    ["extra fields", { note: "ok", status: "APPROVED" }],
  ])("reject with %s => 400 and nothing changes", async (_label, body) => {
    const lr = await requestRow(org, org.a1.id);
    const before = await snapshot(lr.id);
    const res = await act(org.cookies.jefeA, lr.id, "reject", body);
    expect(res.status).toBe(400);
    expect(await snapshot(lr.id)).toEqual(before);
  });

  it("reject with a note of exactly 500 characters => 200", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.jefeA, lr.id, "reject", { note: "x".repeat(500) })).status).toBe(200);
  });

  it("approve without body => 200 and decisionNote null", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await request(app).post(`/api/leave-requests/${lr.id}/approve`).set("Cookie", org.cookies.jefeA);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.decisionNote).toBeNull();
  });

  it("approve with an empty JSON body or a blank note => 200, note stored as null", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.jefeA, lr.id, "approve", { note: "   " });
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.decisionNote).toBeNull();
    const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
    expect(events[0].note).toBeNull();
  });

  it("approve with a 501-character note or extra fields => 400", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.jefeA, lr.id, "approve", { note: "x".repeat(501) })).status).toBe(400);
    expect((await act(org.cookies.jefeA, lr.id, "approve", { foo: 1 })).status).toBe(400);
    expect((await snapshot(lr.id)).status).toBe("PENDING");
  });

  it("cancel without body => 200", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await request(app).post(`/api/leave-requests/${lr.id}/cancel`).set("Cookie", org.cookies.a1);
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.status).toBe("CANCELLED");
  });

  it("malformed JSON on approve => 400, not 500", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await request(app)
      .post(`/api/leave-requests/${lr.id}/approve`)
      .set("Cookie", org.cookies.jefeA)
      .set("Content-Type", "application/json")
      .send('{"note": ');
    expect(res.status).toBe(400);
  });
});

describe("cancel", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("the requester cancels a future APPROVED request; original decider_id and decided_at are kept", async () => {
    const decidedAt = new Date("2026-11-01T15:00:00Z");
    const lr = await requestRow(org, org.a1.id, { status: "APPROVED", deciderId: org.jefeA.id, decidedAt });

    const res = await act(org.cookies.a1, lr.id, "cancel", { note: "Cambio de planes" });

    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.status).toBe("CANCELLED");
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.deciderId).toBe(org.jefeA.id);
    expect(row.decidedAt?.toISOString()).toBe(decidedAt.toISOString());
    const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "CANCELLED", actorId: org.a1.id, note: "Cambio de planes" });
  });

  it("cannot cancel an APPROVED request that starts today: 409", async () => {
    const lr = await requestRow(org, org.a1.id, {
      status: "APPROVED", deciderId: org.jefeA.id, start: "2026-11-11", end: "2026-11-13", businessDays: 3,
    });
    const res = await act(org.cookies.a1, lr.id, "cancel");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya inició/);
  });

  it("cannot cancel an APPROVED request that started yesterday: 409", async () => {
    const lr = await requestRow(org, org.a1.id, {
      status: "APPROVED", deciderId: org.jefeA.id, start: "2026-11-10", end: "2026-11-13", businessDays: 4,
    });
    expect((await act(org.cookies.a1, lr.id, "cancel")).status).toBe(409);
  });

  it("timezone edge: at 2026-11-12T03:00Z (still Nov 11 in Monterrey) an APPROVED request starting Nov 12 can be cancelled", async () => {
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
    await refreshCookies(org);
    const lr = await requestRow(org, org.a1.id, {
      status: "APPROVED", deciderId: org.jefeA.id, start: "2026-11-12", end: "2026-11-12", businessDays: 1,
    });
    expect((await act(org.cookies.a1, lr.id, "cancel")).status).toBe(200);
  });

  it("timezone edge: at 2026-11-12T06:00Z (Nov 12 in Monterrey) the same request can no longer be cancelled", async () => {
    vi.setSystemTime(new Date("2026-11-12T06:00:00Z"));
    await refreshCookies(org);
    const lr = await requestRow(org, org.a1.id, {
      status: "APPROVED", deciderId: org.jefeA.id, start: "2026-11-12", end: "2026-11-12", businessDays: 1,
    });
    expect((await act(org.cookies.a1, lr.id, "cancel")).status).toBe(409);
  });

  it("the requester cancels a PENDING request; decider_id stays null", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.a1, lr.id, "cancel");
    expect(res.status).toBe(200);
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
    expect(row).toMatchObject({ status: "CANCELLED", deciderId: null, decidedAt: null, decisionNote: null });
  });

  it("an overdue PENDING request (started yesterday) can still be cancelled", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-10", end: "2026-11-10", businessDays: 1 });
    expect((await act(org.cookies.a1, lr.id, "cancel")).status).toBe(200);
  });

  it("someone who cannot see the request gets 404 when cancelling it", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.a2, lr.id, "cancel")).status).toBe(404);
    expect((await act(org.cookies.jefeB, lr.id, "cancel")).status).toBe(404);
  });

  it("the manager who sees it but is not the requester gets 403 (jefeA cancelling a1's request)", async () => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies.jefeA, lr.id, "cancel");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Solo quien hizo la solicitud/);
  });

  it("HR who sees it but is not the requester gets 403", async () => {
    const lr = await requestRow(org, org.director.id);
    expect((await act(org.cookies.hr1, lr.id, "cancel")).status).toBe(403);
  });

  it("cancelling frees the days in GET /api/me/balance (APPROVED and PENDING)", async () => {
    const approved = await requestRow(org, org.a1.id, { status: "APPROVED", deciderId: org.jefeA.id });
    const pendingLr = await requestRow(org, org.a1.id, { start: "2026-12-07", end: "2026-12-09", businessDays: 3 });
    const balance = async () =>
      (await request(app).get("/api/me/balance").set("Cookie", org.cookies.a1)).body.balance;

    expect(await balance()).toMatchObject({ earned: 16, approved: 5, pending: 3, available: 8 });

    expect((await act(org.cookies.a1, approved.id, "cancel")).status).toBe(200);
    expect(await balance()).toMatchObject({ approved: 0, pending: 3, available: 13 });

    expect((await act(org.cookies.a1, pendingLr.id, "cancel")).status).toBe(200);
    expect(await balance()).toMatchObject({ approved: 0, pending: 0, available: 16 });
  });

  it("after cancelling, the same dates can be requested again", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect((await act(org.cookies.a1, lr.id, "cancel")).status).toBe(200);
    const res = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", org.cookies.a1)
      .send({ leaveTypeId: org.vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    expect(res.status).toBe(201);
  });
});

describe("balance revalidation on approve", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("approving when a later negative adjustment leaves available < 0 => 422 and nothing changes", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-16", end: "2026-11-27", businessDays: 10 });
    await createAdjustment(org.a1.id, -7, "2026-06-01"); // 16 - 7 - 10 = -1
    const before = await snapshot(lr.id);

    const res = await act(org.cookies.jefeA, lr.id, "approve");

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Saldo insuficiente/);
    expect(res.body.error).toMatch(/-1/);
    expect(await snapshot(lr.id)).toEqual(before);
    expect(await prisma.requestEvent.count()).toBe(0);
  });

  it("approving when available is exactly 0 after the request => 200", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-16", end: "2026-11-27", businessDays: 10 });
    await createAdjustment(org.a1.id, -6, "2026-06-01"); // 16 - 6 - 10 = 0
    expect((await act(org.cookies.jefeA, lr.id, "approve")).status).toBe(200);
  });

  it("rejecting is still allowed when the balance is negative", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-16", end: "2026-11-27", businessDays: 10 });
    await createAdjustment(org.a1.id, -7, "2026-06-01");
    expect((await act(org.cookies.jefeA, lr.id, "reject")).status).toBe(200);
  });

  it("the requester can still cancel when the balance is negative", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2026-11-16", end: "2026-11-27", businessDays: 10 });
    await createAdjustment(org.a1.id, -7, "2026-06-01");
    expect((await act(org.cookies.a1, lr.id, "cancel")).status).toBe(200);
  });

  it("a leave type that does not count against the balance is approved even if the balance is negative", async () => {
    await requestRow(org, org.a1.id, { start: "2026-11-16", end: "2026-11-27", businessDays: 10 });
    await createAdjustment(org.a1.id, -7, "2026-06-01");
    const sickLr = await requestRow(org, org.a1.id, {
      leaveTypeId: org.sick.id, start: "2026-12-07", end: "2026-12-08", businessDays: 2,
    });
    expect((await act(org.cookies.jefeA, sickLr.id, "approve")).status).toBe(200);
  });

  it("uses the period of the request's startDate: a negative adjustment in the current period does not block a request in the next one", async () => {
    const lr = await requestRow(org, org.a1.id, { start: "2027-02-01", end: "2027-02-05", businessDays: 5 });
    await createAdjustment(org.a1.id, -16, "2026-06-01"); // current period at 0, unrelated
    await createLeaveRequestRow({
      requesterId: org.a1.id, leaveTypeId: org.vacation.id, start: "2026-11-16", end: "2026-11-16", businessDays: 1,
    }); // current period now -1
    expect((await act(org.cookies.jefeA, lr.id, "approve")).status).toBe(200);
  });
});

describe("audit trail", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it.each([
    ["approve", "APPROVED", "jefeA", "Aprobado"],
    ["reject", "REJECTED", "jefeA", "No hay cobertura"],
    ["cancel", "CANCELLED", "a1", "Ya no la necesito"],
  ] as const)("%s creates exactly one %s event with the right actor and note", async (action, eventAction, who, note) => {
    const lr = await requestRow(org, org.a1.id);
    const res = await act(org.cookies[who], lr.id, action, { note });
    expect(res.status).toBe(200);
    const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: eventAction, actorId: org.users[who].id, note });
    expect(await prisma.requestEvent.count()).toBe(1);
  });

  it("approve without note creates an event with note null", async () => {
    const lr = await requestRow(org, org.a1.id);
    await act(org.cookies.jefeA, lr.id, "approve");
    const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
    expect(events).toEqual([expect.objectContaining({ action: "APPROVED", note: null })]);
  });

  it("403, 404, 409 and 422 never create events nor change the request", async () => {
    const pendingLr = await requestRow(org, org.a1.id);
    const rejectedLr = await requestRow(org, org.a1.id, {
      status: "REJECTED", deciderId: org.jefeA.id, start: "2026-12-07", end: "2026-12-07", businessDays: 1,
    });
    const before = { p: await snapshot(pendingLr.id), r: await snapshot(rejectedLr.id) };

    expect((await act(org.cookies.hr1, pendingLr.id, "approve")).status).toBe(403);
    expect((await act(org.cookies.jefeA, pendingLr.id, "cancel")).status).toBe(403);
    expect((await act(org.cookies.a1, pendingLr.id, "approve")).status).toBe(403);
    expect((await act(org.cookies.a2, pendingLr.id, "reject")).status).toBe(404);
    expect((await act(org.cookies.jefeB, pendingLr.id, "cancel")).status).toBe(404);
    expect((await act(org.cookies.jefeA, rejectedLr.id, "approve")).status).toBe(409);
    expect((await act(org.cookies.a1, rejectedLr.id, "cancel")).status).toBe(409);
    await createAdjustment(org.a1.id, -20, "2026-06-01");
    expect((await act(org.cookies.jefeA, pendingLr.id, "approve")).status).toBe(422);

    expect(await snapshot(pendingLr.id)).toEqual(before.p);
    expect(await snapshot(rejectedLr.id)).toEqual(before.r);
    expect(await prisma.requestEvent.count()).toBe(0);
  });

  it("a full lifecycle (create, approve, cancel) leaves three events in order", async () => {
    const created = await request(app)
      .post("/api/leave-requests")
      .set("Cookie", org.cookies.a1)
      .send({ leaveTypeId: org.vacation.id, startDate: "2026-11-16", endDate: "2026-11-20" });
    const id = created.body.leaveRequest.id as string;
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await act(org.cookies.jefeA, id, "approve", { note: "Ok" });
    vi.setSystemTime(new Date(NOW.getTime() + 120_000));
    const res = await act(org.cookies.a1, id, "cancel", { note: "Me enfermé" });

    expect(res.status).toBe(200);
    expect(
      res.body.leaveRequest.events.map((e: { action: string; actor: { id: string }; note: string | null }) => [
        e.action, e.actor.id, e.note,
      ]),
    ).toEqual([
      ["CREATED", org.a1.id, null],
      ["APPROVED", org.jefeA.id, "Ok"],
      ["CANCELLED", org.a1.id, "Me enfermé"],
    ]);
    // Cancel kept the manager's decision fields.
    expect(res.body.leaveRequest).toMatchObject({ decider: { id: org.jefeA.id }, decisionNote: "Ok" });
  });
});

describe("GET /api/leave-requests/pending-approvals", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  const ids = (res: request.Response) => res.body.leaveRequests.map((r: { id: string }) => r.id);

  it("jefeA sees only PENDING requests of their own team, ordered by startDate asc", async () => {
    const a1Late = await requestRow(org, org.a1.id, { start: "2026-12-07", end: "2026-12-08", businessDays: 2 });
    const a2Early = await requestRow(org, org.a2.id, { start: "2026-11-16", end: "2026-11-16", businessDays: 1 });
    const a1Mid = await requestRow(org, org.a1.id, { start: "2026-11-23", end: "2026-11-23", businessDays: 1 });
    await requestRow(org, org.b1.id);
    await requestRow(org, org.jefeA.id); // own
    await requestRow(org, org.a1.id, { status: "APPROVED", deciderId: org.jefeA.id, start: "2026-11-30", end: "2026-11-30", businessDays: 1 });
    await requestRow(org, org.a2.id, { status: "REJECTED", deciderId: org.jefeA.id, start: "2026-11-30", end: "2026-11-30", businessDays: 1 });
    await requestRow(org, org.a2.id, { status: "CANCELLED", start: "2026-12-01", end: "2026-12-01", businessDays: 1 });

    const res = await pending(org.cookies.jefeA);

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([a2Early.id, a1Mid.id, a1Late.id]);
    expect(res.body.leaveRequests[0]).toMatchObject({
      startDate: "2026-11-16",
      endDate: "2026-11-16",
      businessDays: 1,
      isOverdue: false,
      requester: { id: org.a2.id },
      leaveType: { id: org.vacation.id, code: "VAC" },
    });
    expect(Object.keys(res.body.leaveRequests[0].requester).sort()).toEqual(["firstName", "id", "lastName"]);
  });

  it("HR sees the director's and the inactive-manager employee's requests, but not a1's nor their own", async () => {
    const dir = await requestRow(org, org.director.id, { start: "2026-11-23", end: "2026-11-23", businessDays: 1 });
    const c1 = await requestRow(org, org.c1.id, { start: "2026-11-16", end: "2026-11-16", businessDays: 1 });
    await requestRow(org, org.a1.id);
    await requestRow(org, org.hr1.id);

    const res = await pending(org.cookies.hr1);
    expect(ids(res)).toEqual([c1.id, dir.id]);

    // hr2 sees hr1's? No: hr1 has an active manager (the director).
    const res2 = await pending(org.cookies.hr2);
    expect(ids(res2)).toEqual([c1.id, dir.id]);
  });

  it("the director sees the requests of their direct reports (jefeA, hr1) but not a1's nor their own", async () => {
    const jefeAReq = await requestRow(org, org.jefeA.id);
    const hr1Req = await requestRow(org, org.hr1.id, { start: "2026-11-23", end: "2026-11-23", businessDays: 1 });
    await requestRow(org, org.a1.id);
    await requestRow(org, org.director.id);
    const res = await pending(org.cookies.director);
    expect(ids(res)).toEqual([jefeAReq.id, hr1Req.id]);
  });

  it("an employee sees an empty list, even with own PENDING requests", async () => {
    await requestRow(org, org.a1.id);
    const res = await pending(org.cookies.a1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leaveRequests: [] });
  });

  it("every item in pending-approvals is approvable by the viewer (consistency with canApprove)", async () => {
    await requestRow(org, org.director.id);
    await requestRow(org, org.c1.id);
    await requestRow(org, org.a1.id);
    await requestRow(org, org.hr2.id);
    for (const who of ["hr1", "director", "jefeA"] as const) {
      const res = await pending(org.cookies[who]);
      for (const item of res.body.leaveRequests as Array<{ id: string }>) {
        const d = await detail(org.cookies[who], item.id);
        expect(d.body.leaveRequest.permissions.canApprove, `${who} ${item.id}`).toBe(true);
      }
    }
  });

  it("isOverdue: starts yesterday => true, today => true, tomorrow => false", async () => {
    const y = await requestRow(org, org.a1.id, { start: "2026-11-10", end: "2026-11-10", businessDays: 1 });
    const t = await requestRow(org, org.a1.id, { start: "2026-11-11", end: "2026-11-11", businessDays: 1 });
    const tm = await requestRow(org, org.a1.id, { start: "2026-11-12", end: "2026-11-12", businessDays: 1 });

    const res = await pending(org.cookies.jefeA);
    const byId = Object.fromEntries(
      res.body.leaveRequests.map((r: { id: string; isOverdue: boolean }) => [r.id, r.isOverdue]),
    );
    expect(byId).toEqual({ [y.id]: true, [t.id]: true, [tm.id]: false });
    expect(ids(res)).toEqual([y.id, t.id, tm.id]);
  });

  it("isOverdue timezone edge: at 2026-11-12T03:00Z it is still Nov 11 in Monterrey, so a request starting Nov 12 is not overdue", async () => {
    vi.setSystemTime(new Date("2026-11-12T03:00:00Z"));
    await refreshCookies(org);
    const t = await requestRow(org, org.a1.id, { start: "2026-11-11", end: "2026-11-11", businessDays: 1 });
    const tm = await requestRow(org, org.a1.id, { start: "2026-11-12", end: "2026-11-12", businessDays: 1 });
    const res = await pending(org.cookies.jefeA);
    const byId = Object.fromEntries(
      res.body.leaveRequests.map((r: { id: string; isOverdue: boolean }) => [r.id, r.isOverdue]),
    );
    expect(byId).toEqual({ [t.id]: true, [tm.id]: false });

    vi.setSystemTime(new Date("2026-11-12T06:00:00Z"));
    const res2 = await pending(org.cookies.jefeA);
    expect(res2.body.leaveRequests.every((r: { isOverdue: boolean }) => r.isOverdue)).toBe(true);
  });

  it("a request disappears from pending-approvals once decided", async () => {
    const lr = await requestRow(org, org.a1.id);
    expect(ids(await pending(org.cookies.jefeA))).toEqual([lr.id]);
    await act(org.cookies.jefeA, lr.id, "approve");
    expect(ids(await pending(org.cookies.jefeA))).toEqual([]);
  });

  it("when a manager is deactivated, their team's requests move to HR's list", async () => {
    const lr = await requestRow(org, org.b1.id);
    expect(ids(await pending(org.cookies.hr1))).toEqual([]);
    await prisma.user.update({ where: { id: org.jefeB.id }, data: { isActive: false } });
    expect(ids(await pending(org.cookies.hr1))).toEqual([lr.id]);
    expect((await act(org.cookies.hr1, lr.id, "approve")).status).toBe(200);
  });
});

describe("concurrency (5 iterations each)", () => {
  it("approve (manager) and cancel (employee) at the same time on a request that starts today => one 200, one 409", async () => {
    // startDate = today, so whichever wins, the other is invalid:
    // APPROVED cannot be cancelled once started, CANCELLED cannot be approved.
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const org = await createOrg();
      const lr = await requestRow(org, org.a1.id, { start: "2026-11-11", end: "2026-11-11", businessDays: 1 });

      const [approve, cancel] = await Promise.all([
        act(org.cookies.jefeA, lr.id, "approve"),
        act(org.cookies.a1, lr.id, "cancel"),
      ]);

      expect([approve.status, cancel.status].sort(), `iteration ${i}`).toEqual([200, 409]);
      const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
      const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
      expect(events, `iteration ${i}`).toHaveLength(1);
      if (approve.status === 200) {
        expect(row).toMatchObject({ status: "APPROVED", deciderId: org.jefeA.id });
        expect(events[0]).toMatchObject({ action: "APPROVED", actorId: org.jefeA.id });
      } else {
        expect(row).toMatchObject({ status: "CANCELLED", deciderId: null, decidedAt: null });
        expect(events[0]).toMatchObject({ action: "CANCELLED", actorId: org.a1.id });
      }
    }
  });

  it("approve and cancel at the same time on a FUTURE request: both can legitimately succeed in sequence, final state stays coherent", async () => {
    // With a future startDate, APPROVED -> CANCELLED is valid, so if approve
    // wins, cancel also succeeds afterwards. Either way the result is coherent.
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const org = await createOrg();
      const lr = await requestRow(org, org.a1.id);

      const [approve, cancel] = await Promise.all([
        act(org.cookies.jefeA, lr.id, "approve"),
        act(org.cookies.a1, lr.id, "cancel"),
      ]);

      expect(cancel.status, `iteration ${i}`).toBe(200);
      const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
      const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
      expect(row.status).toBe("CANCELLED");
      if (approve.status === 200) {
        expect(events.map((e) => e.action).sort()).toEqual(["APPROVED", "CANCELLED"]);
        expect(row.deciderId).toBe(org.jefeA.id);
      } else {
        expect(approve.status).toBe(409);
        expect(events.map((e) => e.action)).toEqual(["CANCELLED"]);
        expect(row.deciderId).toBeNull();
      }
    }
  });

  it("double concurrent approval by the same manager => one 200, one 409, a single APPROVED event", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const org = await createOrg();
      const lr = await requestRow(org, org.a1.id);

      const results = await Promise.all([
        act(org.cookies.jefeA, lr.id, "approve", { note: "uno" }),
        act(org.cookies.jefeA, lr.id, "approve", { note: "dos" }),
      ]);

      expect(results.map((r) => r.status).sort(), `iteration ${i}`).toEqual([200, 409]);
      const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
      expect(events, `iteration ${i}`).toHaveLength(1);
      expect(events[0].action).toBe("APPROVED");
      const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
      expect(row.decisionNote).toBe(events[0].note);
    }
  });

  it("approve and reject at the same time => one 200, one 409, final status matches the winner", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const org = await createOrg();
      const lr = await requestRow(org, org.a1.id);

      const [approve, reject] = await Promise.all([
        act(org.cookies.jefeA, lr.id, "approve"),
        act(org.cookies.jefeA, lr.id, "reject", { note: "No" }),
      ]);

      expect([approve.status, reject.status].sort(), `iteration ${i}`).toEqual([200, 409]);
      const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: lr.id } });
      const events = await prisma.requestEvent.findMany({ where: { leaveRequestId: lr.id } });
      expect(events).toHaveLength(1);
      expect(row.status).toBe(approve.status === 200 ? "APPROVED" : "REJECTED");
      expect(events[0].action).toBe(row.status);
    }
  });

  it("approving while the employee creates a new request: the balance stays consistent (no deadlock)", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const org = await createOrg();
      const lr = await requestRow(org, org.a1.id, { start: "2026-11-16", end: "2026-11-27", businessDays: 10 });

      const [approve, create] = await Promise.all([
        act(org.cookies.jefeA, lr.id, "approve"),
        request(app)
          .post("/api/leave-requests")
          .set("Cookie", org.cookies.a1)
          .send({ leaveTypeId: org.vacation.id, startDate: "2026-12-07", endDate: "2026-12-14" }), // 6 days
      ]);

      expect(approve.status, `iteration ${i}`).toBe(200);
      expect(create.status, `iteration ${i}`).toBe(201);
      const balance = (await request(app).get("/api/me/balance").set("Cookie", org.cookies.a1)).body.balance;
      expect(balance).toMatchObject({ approved: 10, pending: 6, available: 0 });
    }
  });
});

describe("HR who is also a direct manager", () => {
  let org: Org;
  beforeEach(async () => {
    org = await createOrg();
  });

  it("hr1 sees their direct report in pending-approvals and approves; hr2 sees the detail but gets 403 and no pending item", async () => {
    const e = await createUser({ managerId: org.hr1.id });
    const lr = await requestRow(org, e.id);

    const hr1List = await pending(org.cookies.hr1);
    expect(hr1List.body.leaveRequests.map((r: { id: string }) => r.id)).toContain(lr.id);

    const hr2List = await pending(org.cookies.hr2);
    expect(hr2List.body.leaveRequests.map((r: { id: string }) => r.id)).not.toContain(lr.id);

    const hr2Detail = await detail(org.cookies.hr2, lr.id);
    expect(hr2Detail.status).toBe(200);
    expect(hr2Detail.body.leaveRequest.permissions.canApprove).toBe(false);

    const hr2Approve = await act(org.cookies.hr2, lr.id, "approve");
    expect(hr2Approve.status).toBe(403);
    expect((await snapshot(lr.id)).eventCount).toBe(0);

    const hr1Approve = await act(org.cookies.hr1, lr.id, "approve");
    expect(hr1Approve.status).toBe(200);
    expect(hr1Approve.body.leaveRequest).toMatchObject({ status: "APPROVED", decider: { id: org.hr1.id } });
  });
});

describe("manager reassignment while the request is PENDING", () => {
  it("after moving a1 from jefeA to jefeB: jefeA gets 404, jefeB sees it, lists update, jefeB approves", async () => {
    const org = await createOrg();
    const lr = await requestRow(org, org.a1.id);
    const ids = async (cookie: string) =>
      (await pending(cookie)).body.leaveRequests.map((r: { id: string }) => r.id);

    expect(await ids(org.cookies.jefeA)).toEqual([lr.id]);
    expect(await ids(org.cookies.jefeB)).toEqual([]);

    await prisma.user.update({ where: { id: org.a1.id }, data: { managerId: org.jefeB.id } });

    expect(await ids(org.cookies.jefeA)).toEqual([]);
    expect(await ids(org.cookies.jefeB)).toEqual([lr.id]);

    expect((await detail(org.cookies.jefeA, lr.id)).status).toBe(404);
    expect((await act(org.cookies.jefeA, lr.id, "approve")).status).toBe(404);
    expect((await snapshot(lr.id)).status).toBe("PENDING");

    const jefeBDetail = await detail(org.cookies.jefeB, lr.id);
    expect(jefeBDetail.status).toBe(200);
    expect(jefeBDetail.body.leaveRequest.permissions.canApprove).toBe(true);

    const res = await act(org.cookies.jefeB, lr.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.leaveRequest.decider.id).toBe(org.jefeB.id);
  });
});

describe("pending-approvals <=> permissions.canApprove (both directions)", () => {
  it("for every active actor, pending-approvals ids equal the PENDING ids whose detail gives 200 with canApprove", async () => {
    const org = await createOrg();
    const hrReport = await createUser({ managerId: org.hr1.id });
    const hrReportCookie = await authCookie(hrReport.id);

    const requesters = [
      org.director, org.hr1, org.hr2, org.jefeA, org.a1, org.a2, org.jefeB, org.b1, org.c1, hrReport,
    ];
    const allPending: string[] = [];
    for (const [i, r] of requesters.entries()) {
      const lr = await requestRow(org, r.id);
      allPending.push(lr.id);
      // A second, later PENDING for some requesters (non-overlapping).
      if (i % 2 === 0) {
        allPending.push((await requestRow(org, r.id, { start: "2026-12-07", end: "2026-12-07", businessDays: 1 })).id);
      }
    }
    // Non-PENDING noise that must never appear.
    await requestRow(org, org.a1.id, { status: "APPROVED", deciderId: org.jefeA.id, start: "2026-12-14", end: "2026-12-14", businessDays: 1 });
    await requestRow(org, org.director.id, { status: "REJECTED", deciderId: org.hr1.id, start: "2026-12-14", end: "2026-12-14", businessDays: 1 });
    await requestRow(org, org.c1.id, { status: "CANCELLED", start: "2026-12-14", end: "2026-12-14", businessDays: 1 });

    const actors: Array<[string, string]> = [
      ...(Object.entries(org.cookies) as [string, string][]).filter(([name]) => name !== "jefeInactivo"),
      ["hrReport", hrReportCookie],
    ];

    for (const [name, cookie] of actors) {
      const listRes = await pending(cookie);
      expect(listRes.status).toBe(200);
      const listed = new Set<string>(listRes.body.leaveRequests.map((r: { id: string }) => r.id));

      const approvable = new Set<string>();
      for (const id of allPending) {
        const res = await detail(cookie, id);
        expect([200, 404], `${name} ${id}`).toContain(res.status);
        if (res.status === 200 && res.body.leaveRequest.permissions.canApprove === true) {
          approvable.add(id);
        }
      }

      expect([...listed].sort(), `actor ${name}`).toEqual([...approvable].sort());
    }
  });
});

describe("visibility is checked before the transaction", () => {
  it("an outsider (jefeB) gets the same 404 body as for a non-existent id on approve/reject/cancel, nothing changes", async () => {
    const org = await createOrg();
    const lr = await requestRow(org, org.a1.id);
    const before = await snapshot(lr.id);

    for (const action of ["approve", "reject", "cancel"] as const) {
      const hidden = await act(org.cookies.jefeB, lr.id, action);
      const missing = await act(org.cookies.jefeB, "cl0000000000000000000000", action);
      expect(hidden.status, action).toBe(404);
      expect(missing.status, action).toBe(404);
      expect(hidden.body).toEqual(missing.body);
      expect(hidden.body).toEqual({ error: "Solicitud no encontrada" });
    }

    expect(await snapshot(lr.id)).toEqual(before);
    expect(await prisma.requestEvent.count()).toBe(0);
  });

  it("an id with only spaces or longer than 64 chars is rejected with a 400 in Spanish, not 404/500", async () => {
    const org = await createOrg();
    const long = await act(org.cookies.jefeA, "x".repeat(65), "approve");
    expect(long.status).toBe(400);
    expect(long.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/[Ii]d/)]));
    const blank = await act(org.cookies.jefeA, "%20%20", "approve");
    expect(blank.status).toBe(400);
  });
});
