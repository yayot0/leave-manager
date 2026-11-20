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
