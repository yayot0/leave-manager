import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "../errors/AppError.js";
import { isOverlapConstraintViolation, OVERLAP_CONSTRAINT } from "./pg-errors.js";
import {
  createLeaveRequestRow,
  createLeaveType,
  createUser,
  prisma,
  resetDb,
} from "../test/db.js";

beforeEach(resetDb);

afterAll(async () => {
  await prisma.$disconnect();
});

/** Runs `fn`, expects it to throw, and returns what was thrown. */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected the operation to throw, but it succeeded");
}

describe("isOverlapConstraintViolation (safety net for the EXCLUDE constraint)", () => {
  it("returns true for the error raised when inserting two overlapping PENDING requests of the same user", async () => {
    const user = await createUser();
    const type = await createLeaveType();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: type.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5,
    });

    const err = await captureError(() =>
      createLeaveRequestRow({
        requesterId: user.id, leaveTypeId: type.id, start: "2026-11-20", end: "2026-11-24", businessDays: 3,
      }),
    );

    expect(isOverlapConstraintViolation(err)).toBe(true);
    expect(await prisma.leaveRequest.count()).toBe(1);
  });

  it("returns true for an overlap between an APPROVED and a PENDING request", async () => {
    const user = await createUser();
    const type = await createLeaveType();
    await createLeaveRequestRow({
      requesterId: user.id, leaveTypeId: type.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5, status: "APPROVED",
    });
    const err = await captureError(() =>
      createLeaveRequestRow({
        requesterId: user.id, leaveTypeId: type.id, start: "2026-11-18", end: "2026-11-18", businessDays: 1,
      }),
    );
    expect(isOverlapConstraintViolation(err)).toBe(true);
  });

  it("the database does not reject overlaps with REJECTED/CANCELLED requests nor across users (sanity check of the constraint)", async () => {
    const user = await createUser();
    const other = await createUser();
    const type = await createLeaveType();
    const base = { leaveTypeId: type.id, start: "2026-11-16", end: "2026-11-20", businessDays: 5 };
    await createLeaveRequestRow({ ...base, requesterId: user.id, status: "REJECTED" });
    await createLeaveRequestRow({ ...base, requesterId: user.id, status: "CANCELLED" });
    await createLeaveRequestRow({ ...base, requesterId: user.id });
    await createLeaveRequestRow({ ...base, requesterId: other.id });
    expect(await prisma.leaveRequest.count()).toBe(4);
  });

  it("returns false for a unique-constraint violation (duplicate leave_type code)", async () => {
    await createLeaveType({ code: "DUP", name: "Uno" });
    const err = await captureError(() => createLeaveType({ code: "DUP", name: "Dos" }));
    expect(err).toBeInstanceOf(Error);
    expect(isOverlapConstraintViolation(err)).toBe(false);
  });

  it("returns false for a CHECK violation (chk_leave_requests_business_days_positive)", async () => {
    const user = await createUser();
    const type = await createLeaveType();
    const err = await captureError(() =>
      createLeaveRequestRow({
        requesterId: user.id, leaveTypeId: type.id, start: "2026-11-16", end: "2026-11-16", businessDays: 0,
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(isOverlapConstraintViolation(err)).toBe(false);
  });

  it("returns false for a CHECK violation on dates (end before start)", async () => {
    const user = await createUser();
    const type = await createLeaveType();
    const err = await captureError(() =>
      createLeaveRequestRow({
        requesterId: user.id, leaveTypeId: type.id, start: "2026-11-20", end: "2026-11-16", businessDays: 1,
      }),
    );
    expect(isOverlapConstraintViolation(err)).toBe(false);
  });

  it("returns false for a foreign-key violation (non-existent requester)", async () => {
    const type = await createLeaveType();
    const err = await captureError(() =>
      createLeaveRequestRow({
        requesterId: "no-such-user", leaveTypeId: type.id, start: "2026-11-16", end: "2026-11-16", businessDays: 1,
      }),
    );
    expect(isOverlapConstraintViolation(err)).toBe(false);
  });

  it("returns false for a plain Error, even if its message mentions the constraint name", () => {
    expect(isOverlapConstraintViolation(new Error("boom"))).toBe(false);
    expect(isOverlapConstraintViolation(new Error(`23P01 ${OVERLAP_CONSTRAINT}`))).toBe(false);
  });

  it("returns false for null, undefined and non-error values", () => {
    expect(isOverlapConstraintViolation(null)).toBe(false);
    expect(isOverlapConstraintViolation(undefined)).toBe(false);
    expect(isOverlapConstraintViolation("23P01")).toBe(false);
    expect(isOverlapConstraintViolation({ code: "23P01", message: OVERLAP_CONSTRAINT })).toBe(false);
  });

  it("returns false for a ConflictError", () => {
    expect(isOverlapConstraintViolation(new ConflictError())).toBe(false);
  });
});
