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
  const cause = driverCause(err);
  return (
    cause !== undefined &&
    (cause.originalCode ?? cause.code) === EXCLUSION_VIOLATION &&
    typeof cause.message === "string" &&
    cause.message.includes(OVERLAP_CONSTRAINT)
  );
}

/** Postgres SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * True when `err` is a unique violation: Prisma's P2002 for the indexes it
 * manages, or the raw SQLSTATE 23505 for the ones added by hand (e.g.
 * uq_departments_name_lower), which Prisma may not map to P2002. With
 * `constraint`, only a violation of that one.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  const cause = driverCause(err);
  const isUnique = err.code === "P2002" || (cause !== undefined && (cause.originalCode ?? cause.code) === UNIQUE_VIOLATION);
  if (!isUnique || constraint === undefined) {
    return isUnique;
  }
  // Only that constraint (e.g. "users_email_key"): its name travels in the
  // pg message and/or Prisma's meta, as in isForeignKeyViolation.
  const where = `${typeof cause?.message === "string" ? cause.message : ""} ${JSON.stringify(err.meta ?? {})}`;
  return where.includes(constraint);
}

/** Postgres SQLSTATE for foreign_key_violation (e.g. ON DELETE RESTRICT). */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * True when `err` is a violation of the foreign key `constraint` (e.g.
 * "users_department_id_fkey"): Prisma's P2003 or the raw SQLSTATE 23503,
 * and only that constraint, so another FK failing in the same transaction is
 * never mistaken for it.
 */
export function isForeignKeyViolation(err: unknown, constraint: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  const cause = driverCause(err);
  const isFk = err.code === "P2003" || (cause !== undefined && (cause.originalCode ?? cause.code) === FOREIGN_KEY_VIOLATION);
  if (!isFk) {
    return false;
  }
  // The constraint name travels in the pg message and/or Prisma's meta.
  const where = `${typeof cause?.message === "string" ? cause.message : ""} ${JSON.stringify(err.meta ?? {})}`;
  return where.includes(constraint);
}

interface DriverCause {
  code?: unknown;
  originalCode?: unknown;
  message?: unknown;
}

/**
 * The original pg error behind a Prisma error. With @prisma/adapter-pg it
 * lives in meta.driverAdapterError.cause (verified empirically with Prisma
 * 7.10).
 */
function driverCause(err: unknown): DriverCause | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }
  return (err.meta?.driverAdapterError as { cause?: unknown } | undefined)?.cause as DriverCause | undefined;
}
