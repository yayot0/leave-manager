import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { calculateVacationBalance, type VacationBalance } from "../../domain/vacation.js";

/** Either the global client or the `tx` handle of an interactive transaction. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Vacation balance of `user` for the anniversary period that contains `asOf`.
 * Loads the raw data and delegates all the math (and period filtering) to the
 * pure domain function.
 */
export async function getVacationBalance(
  db: DbClient,
  user: { id: string; hireDate: Date },
  asOf: Date,
): Promise<VacationBalance> {
  // Sequential on purpose: inside a transaction `db` is a single connection,
  // so running these with Promise.all gains nothing and pg deprecates
  // issuing a query while another one is still running on the same client.
  const adjustments = await db.balanceAdjustment.findMany({
    where: { userId: user.id },
    select: { days: true, effectiveDate: true },
  });
  const leaveRequests = await db.leaveRequest.findMany({
    where: { requesterId: user.id, status: { in: ["PENDING", "APPROVED"] } },
    select: {
      startDate: true,
      businessDays: true,
      status: true,
      leaveType: { select: { countsAgainstVacationBalance: true } },
    },
  });

  return calculateVacationBalance({
    hireDate: user.hireDate,
    asOf,
    adjustments,
    leaveRequests: leaveRequests.map((request) => ({
      startDate: request.startDate,
      businessDays: request.businessDays,
      status: request.status,
      countsAgainstVacationBalance: request.leaveType.countsAgainstVacationBalance,
    })),
  });
}
