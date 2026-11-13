import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { LeaveRequestStatus } from "../generated/prisma/enums.js";
import { createLeaveType, createUser, d, prisma, resetDb } from "../test/db.js";

/**
 * chk_leave_requests_decision_matches_status, tested by inserting rows
 * directly with Prisma (bypassing the app and the test helper that fills in
 * a decider automatically).
 */
const CONSTRAINT = "chk_leave_requests_decision_matches_status";

beforeEach(resetDb);

afterAll(async () => {
  await prisma.$disconnect();
});

async function fixtures() {
  const requester = await createUser();
  const decider = await createUser({ role: "MANAGER" });
  const type = await createLeaveType();
  return { requester, decider, type };
}

async function insert(
  f: Awaited<ReturnType<typeof fixtures>>,
  status: LeaveRequestStatus,
  decision: { deciderId?: string; decidedAt?: Date },
) {
  return prisma.leaveRequest.create({
    data: {
      requesterId: f.requester.id,
      leaveTypeId: f.type.id,
      startDate: d("2026-11-16"),
      endDate: d("2026-11-20"),
      businessDays: 5,
      status,
      deciderId: decision.deciderId ?? null,
      decidedAt: decision.decidedAt ?? null,
    },
  });
}

async function expectCheckViolation(promise: Promise<unknown>) {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error, "expected the insert to be rejected").toBeDefined();
  expect(JSON.stringify(error) + String(error)).toContain(CONSTRAINT);
  expect(await prisma.leaveRequest.count()).toBe(0);
}

const AT = new Date("2026-11-10T15:00:00Z");

describe(`${CONSTRAINT}`, () => {
  describe("APPROVED / REJECTED require decider_id AND decided_at", () => {
    it.each(["APPROVED", "REJECTED"] as const)("%s without decider nor decided_at fails", async (status) => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, status, {}));
    });

    it.each(["APPROVED", "REJECTED"] as const)("%s with decider but no decided_at fails", async (status) => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, status, { deciderId: f.decider.id }));
    });

    it.each(["APPROVED", "REJECTED"] as const)("%s with decided_at but no decider fails", async (status) => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, status, { decidedAt: AT }));
    });

    it.each(["APPROVED", "REJECTED"] as const)("%s with both passes", async (status) => {
      const f = await fixtures();
      const row = await insert(f, status, { deciderId: f.decider.id, decidedAt: AT });
      expect(row.status).toBe(status);
    });
  });

  describe("PENDING requires neither", () => {
    it("PENDING with decider and decided_at fails", async () => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, "PENDING", { deciderId: f.decider.id, decidedAt: AT }));
    });

    it("PENDING with only a decider fails", async () => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, "PENDING", { deciderId: f.decider.id }));
    });

    it("PENDING with only decided_at fails", async () => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, "PENDING", { decidedAt: AT }));
    });

    it("PENDING with neither passes", async () => {
      const f = await fixtures();
      expect((await insert(f, "PENDING", {})).status).toBe("PENDING");
    });
  });

  describe("CANCELLED: both or neither, never only one", () => {
    it("CANCELLED with only a decider fails", async () => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, "CANCELLED", { deciderId: f.decider.id }));
    });

    it("CANCELLED with only decided_at fails", async () => {
      const f = await fixtures();
      await expectCheckViolation(insert(f, "CANCELLED", { decidedAt: AT }));
    });

    it("CANCELLED with both passes (approved, then cancelled by the employee)", async () => {
      const f = await fixtures();
      expect((await insert(f, "CANCELLED", { deciderId: f.decider.id, decidedAt: AT })).status).toBe("CANCELLED");
    });

    it("CANCELLED with neither passes (cancelled while pending)", async () => {
      const f = await fixtures();
      expect((await insert(f, "CANCELLED", {})).status).toBe("CANCELLED");
    });
  });

  describe("UPDATEs are checked too", () => {
    it("moving a PENDING row to APPROVED without setting the decider fails", async () => {
      const f = await fixtures();
      const row = await insert(f, "PENDING", {});
      let error: unknown;
      try {
        await prisma.leaveRequest.update({ where: { id: row.id }, data: { status: "APPROVED" } });
      } catch (err) {
        error = err;
      }
      expect(JSON.stringify(error) + String(error)).toContain(CONSTRAINT);
      expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING");
    });

    it("clearing decided_at on an APPROVED row fails", async () => {
      const f = await fixtures();
      const row = await insert(f, "APPROVED", { deciderId: f.decider.id, decidedAt: AT });
      await expect(
        prisma.leaveRequest.update({ where: { id: row.id }, data: { decidedAt: null } }),
      ).rejects.toThrow();
    });
  });
});

describe("chk_leave_requests_decider_not_requester", () => {
  const SELF_CONSTRAINT = "chk_leave_requests_decider_not_requester";

  async function errorOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      return JSON.stringify(err) + String(err);
    }
    throw new Error("expected the operation to be rejected");
  }

  it("an APPROVED row whose decider is the requester fails on INSERT", async () => {
    const f = await fixtures();
    const message = await errorOf(insert(f, "APPROVED", { deciderId: f.requester.id, decidedAt: AT }));
    expect(message).toContain(SELF_CONSTRAINT);
    expect(await prisma.leaveRequest.count()).toBe(0);
  });

  it("a REJECTED row whose decider is the requester fails too", async () => {
    const f = await fixtures();
    const message = await errorOf(insert(f, "REJECTED", { deciderId: f.requester.id, decidedAt: AT }));
    expect(message).toContain(SELF_CONSTRAINT);
  });

  it("an UPDATE that sets the requester as decider fails and leaves the row unchanged", async () => {
    const f = await fixtures();
    const row = await insert(f, "PENDING", {});
    const message = await errorOf(
      prisma.leaveRequest.update({
        where: { id: row.id },
        data: { status: "APPROVED", deciderId: f.requester.id, decidedAt: AT },
      }),
    );
    expect(message).toContain(SELF_CONSTRAINT);
    const after = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "PENDING", deciderId: null, decidedAt: null });
  });

  it("an UPDATE that only swaps the decider of an APPROVED row to the requester fails", async () => {
    const f = await fixtures();
    const row = await insert(f, "APPROVED", { deciderId: f.decider.id, decidedAt: AT });
    const message = await errorOf(
      prisma.leaveRequest.update({ where: { id: row.id }, data: { deciderId: f.requester.id } }),
    );
    expect(message).toContain(SELF_CONSTRAINT);
  });
});
