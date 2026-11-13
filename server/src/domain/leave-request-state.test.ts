import { describe, expect, it } from "vitest";
import { hasStarted, transition, type LeaveRequestAction } from "./leave-request-state.js";
import type { LeaveRequestStatus } from "./vacation.js";

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const TODAY = utc("2026-11-11");
const YESTERDAY = utc("2026-11-10");
const TOMORROW = utc("2026-11-12");
const future = { startDate: TOMORROW, today: TODAY };

describe("hasStarted (startDate <= today)", () => {
  it("is true when the request started yesterday", () => {
    expect(hasStarted(YESTERDAY, TODAY)).toBe(true);
  });

  it("is true when the request starts today", () => {
    expect(hasStarted(TODAY, TODAY)).toBe(true);
  });

  it("is false when the request starts tomorrow", () => {
    expect(hasStarted(TOMORROW, TODAY)).toBe(false);
  });

  it("works across a leap day (2028-02-29 vs 2028-02-28)", () => {
    expect(hasStarted(utc("2028-02-29"), utc("2028-02-28"))).toBe(false);
    expect(hasStarted(utc("2028-02-29"), utc("2028-02-29"))).toBe(true);
  });
});

describe("transition: every status x action combination", () => {
  const cases: Array<[LeaveRequestStatus, LeaveRequestAction, LeaveRequestStatus | null]> = [
    ["PENDING", "APPROVE", "APPROVED"],
    ["PENDING", "REJECT", "REJECTED"],
    ["PENDING", "CANCEL", "CANCELLED"],
    ["APPROVED", "APPROVE", null],
    ["APPROVED", "REJECT", null],
    ["APPROVED", "CANCEL", "CANCELLED"], // future start date
    ["REJECTED", "APPROVE", null],
    ["REJECTED", "REJECT", null],
    ["REJECTED", "CANCEL", null],
    ["CANCELLED", "APPROVE", null],
    ["CANCELLED", "REJECT", null],
    ["CANCELLED", "CANCEL", null],
  ];

  it.each(cases)("%s + %s (startDate in the future) => %s", (status, action, expected) => {
    const result = transition(status, action, future);
    if (expected === null) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toEqual(expect.any(String));
    } else {
      expect(result).toEqual({ ok: true, next: expected });
    }
  });

  it.each(["APPROVE", "REJECT", "CANCEL"] as const)(
    "PENDING + %s is allowed even if the request already started (overdue)",
    (action) => {
      expect(transition("PENDING", action, { startDate: YESTERDAY, today: TODAY }).ok).toBe(true);
      expect(transition("PENDING", action, { startDate: TODAY, today: TODAY }).ok).toBe(true);
    },
  );

  it("final states REJECTED and CANCELLED reject every action regardless of dates", () => {
    for (const status of ["REJECTED", "CANCELLED"] as const) {
      for (const action of ["APPROVE", "REJECT", "CANCEL"] as const) {
        for (const startDate of [YESTERDAY, TODAY, TOMORROW]) {
          expect(transition(status, action, { startDate, today: TODAY }).ok).toBe(false);
        }
      }
    }
  });

  it("returns distinct, meaningful reasons for each final/blocked state", () => {
    const approved = transition("APPROVED", "APPROVE", future);
    const rejected = transition("REJECTED", "APPROVE", future);
    const cancelled = transition("CANCELLED", "APPROVE", future);
    expect(approved).toEqual({ ok: false, reason: expect.stringMatching(/aprobada/) });
    expect(rejected).toEqual({ ok: false, reason: expect.stringMatching(/rechazada/) });
    expect(cancelled).toEqual({ ok: false, reason: expect.stringMatching(/cancelada/) });
  });
});

describe("transition: APPROVED + CANCEL depends on whether the leave started", () => {
  it("allowed when startDate is tomorrow", () => {
    expect(transition("APPROVED", "CANCEL", { startDate: TOMORROW, today: TODAY })).toEqual({
      ok: true,
      next: "CANCELLED",
    });
  });

  it("NOT allowed when startDate is today", () => {
    const result = transition("APPROVED", "CANCEL", { startDate: TODAY, today: TODAY });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/ya inició/) });
  });

  it("NOT allowed when startDate was yesterday", () => {
    const result = transition("APPROVED", "CANCEL", { startDate: YESTERDAY, today: TODAY });
    expect(result.ok).toBe(false);
  });
});
