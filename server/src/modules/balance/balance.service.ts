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
  const [adjustments, leaveRequests] = await Promise.all([
    db.balanceAdjustment.findMany({
      where: { userId: user.id },
      select: { days: true, effectiveDate: true },
    }),
    db.leaveRequest.findMany({
      where: { requesterId: user.id, status: { in: ["PENDING", "APPROVED"] } },
      select: {
        startDate: true,
        businessDays: true,
        status: true,
        leaveType: { select: { countsAgainstVacationBalance: true } },
      },
    }),
  ]);

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
