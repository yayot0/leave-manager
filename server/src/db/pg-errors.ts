import { Prisma } from "../generated/prisma/client.js";

/**
 * True when an interactive transaction could not start in time or ran past
 * its timeout (Prisma P2028), typically because it waited too long for a row
 * lock under heavy contention. It is transient: the client may retry.
 */
export function isTransactionTimeout(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028";
}

/** Postgres SQLSTATE for exclusion_violation (EXCLUDE constraints). */
const EXCLUSION_VIOLATION = "23P01";

export const OVERLAP_CONSTRAINT = "excl_leave_requests_no_overlapping_active_ranges";

/**
 * True when `err` comes from the no-overlap EXCLUDE constraint on
 * leave_requests. Prisma has no dedicated code for exclusion violations; with
 * @prisma/adapter-pg it surfaces as a PrismaClientKnownRequestError whose
 * meta.driverAdapterError.cause carries the original pg SQLSTATE and message
 * (verified empirically with Prisma 7.10).
 */
export function isOverlapConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  const cause = (err.meta?.driverAdapterError as { cause?: unknown } | undefined)?.cause as
    | { code?: unknown; originalCode?: unknown; message?: unknown }
    | undefined;
  if (!cause) {
    return false;
  }
  const code = cause.originalCode ?? cause.code;
  return (
    code === EXCLUSION_VIOLATION &&
    typeof cause.message === "string" &&
    cause.message.includes(OVERLAP_CONSTRAINT)
  );
}
