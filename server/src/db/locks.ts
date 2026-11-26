import type { Prisma } from "../generated/prisma/client.js";

/**
 * Row locks used to serialize operations that read and then change a user's
 * vacation balance or a request's status. They only work inside an
 * interactive transaction, and only against other code that takes them too.
 *
 * Lock order is ALWAYS: requester's user row first, then the request row.
 * Keeping one global order means two transactions can never each hold the
 * lock the other is waiting for, so they cannot deadlock.
 */

/**
 * Locks the user's row until the transaction ends. NO KEY UPDATE serializes
 * every balance-changing operation for this user but, unlike FOR UPDATE,
 * does not block the FOR KEY SHARE locks Postgres takes when other tables
 * (request_events, balance_adjustments) insert rows that reference users.
 */
export async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
}

/**
 * Like lockUser, but also reads the row in the same statement, so the caller
 * sees the user as it is once the lock is held. `requireAuth` checked
 * isActive BEFORE the transaction: if HR deactivated the user in between
 * (deactivation takes this same lock), the caller must refuse to write,
 * or a request could end up PENDING for an inactive employee. Every write
 * on a user's requests uses this instead of lockUser. null = no such user.
 */
export async function lockUserForWrite(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ isActive: boolean; hireDate: Date } | null> {
  const rows = await tx.$queryRaw<{ is_active: boolean; hire_date: Date }[]>`
    SELECT is_active, hire_date FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
  const row = rows[0];
  return row ? { isActive: row.is_active, hireDate: row.hire_date } : null;
}

/**
 * Arbitrary constant key of the employee-directory advisory lock. Advisory
 * keys are global to the database: never reuse this number for anything else.
 */
const EMPLOYEE_DIRECTORY_LOCK_KEY = 4_120_250_001;

/**
 * Serializes EVERY change to the employee directory (create, edit,
 * deactivate, reactivate) until the transaction ends. Needed because their
 * rules span several rows, which row locks cannot protect (write skew):
 * - T1 sets manager(A) = B while T2 sets manager(B) = A: each walks the
 *   chain, sees no cycle (the other has not committed) and both commit;
 * - two HR users deactivate each other: each still sees two active HR;
 * - demoting B to EMPLOYEE while someone gets B as their new manager;
 * - deactivating a manager while someone is assigned to them.
 * Under READ COMMITTED every statement takes a fresh snapshot, so whatever
 * is read AFTER this lock includes the previous change's commit.
 *
 * Lock order: this lock first, then lockUser, then lockLeaveRequest. Leave
 * request operations never take it, so no wait cycle (deadlock) can form.
 * Directory changes are rare, so serializing them costs nothing.
 */
export async function lockEmployeeDirectory(tx: Prisma.TransactionClient): Promise<void> {
  // $executeRaw: the function returns `void`, a column type $queryRaw would
  // have to deserialize.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EMPLOYEE_DIRECTORY_LOCK_KEY}::bigint)`;
}

/**
 * HR catalog rows: locked before reading the "before" snapshot of the audit
 * log, so a concurrent change cannot slip between that read and the write
 * (and the log never records a "before" that was already stale). Separate
 * functions, never a table name taken as a parameter.
 *
 * Departments and leave types use NO KEY UPDATE, like lockUser: users and
 * leave_requests reference them, and inserting such a row takes FOR KEY
 * SHARE on the referenced row, which NO KEY UPDATE does not block (so
 * creating a request never waits for HR editing its type). A DELETE still
 * takes its own stronger lock.
 */
export async function lockDepartment(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM departments WHERE id = ${id} FOR NO KEY UPDATE`;
}

export async function lockLeaveType(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM leave_types WHERE id = ${id} FOR NO KEY UPDATE`;
}

export async function lockHoliday(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM holidays WHERE id = ${id} FOR UPDATE`;
}

/** Locks a leave request's row until the transaction ends. */
export async function lockLeaveRequest(
  tx: Prisma.TransactionClient,
  leaveRequestId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM leave_requests WHERE id = ${leaveRequestId} FOR UPDATE`;
}
