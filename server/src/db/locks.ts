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

/** Locks a leave request's row until the transaction ends. */
export async function lockLeaveRequest(
  tx: Prisma.TransactionClient,
  leaveRequestId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM leave_requests WHERE id = ${leaveRequestId} FOR UPDATE`;
}
