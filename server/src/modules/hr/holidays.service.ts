import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { lockHoliday } from "../../db/locks.js";
import { isUniqueViolation } from "../../db/pg-errors.js";
import { todayInTimeZone, toISODate } from "../../domain/dates.js";
import { ConflictError, NotFoundError } from "../../errors/AppError.js";
import type { DbClient } from "../balance/balance.service.js";
import { recordHrAudit, type AuditSnapshot } from "./audit.js";
import { withCode } from "./errors.js";
import type { CreateHolidayInput } from "./hr.schemas.js";

const NOT_FOUND = "Festivo no encontrado";
const DUPLICATE_DATE = "Ya hay un festivo en esa fecha";

const holidaySelect = {
  id: true,
  date: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HolidaySelect;

// Derived from the select, so it can never drift from the model.
type HolidayRow = Prisma.HolidayGetPayload<{ select: typeof holidaySelect }>;

function serialize(row: HolidayRow) {
  return { ...row, date: toISODate(row.date) };
}

function snapshot(row: HolidayRow): AuditSnapshot {
  return { id: row.id, date: toISODate(row.date), name: row.name };
}

const duplicateDate = () => withCode(new ConflictError(DUPLICATE_DATE), "DUPLICATE_DATE");

/** Holidays of a calendar year, by date. */
export async function listHolidays(year: number) {
  const rows = await prisma.holiday.findMany({
    where: { date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } },
    orderBy: { date: "asc" },
    select: holidaySelect,
  });
  return rows.map(serialize);
}

/**
 * Active requests (PENDING or APPROVED) whose business days would differ if
 * this date became (or stopped being) a holiday. They are NOT recalculated:
 * businessDays is fixed when a request is created. HR uses the breakdown to
 * decide whether to correct balances with an adjustment:
 * - `countingBalance` / `notCountingBalance`: by the request's own copy of
 *   countsAgainstVacationBalance (never the type's current value). Only the
 *   first ones can need an adjustment.
 * - `past` / `upcoming`: already over (endDate before today in APP_TIMEZONE)
 *   or still running / in the future. Past ones still count in the balance
 *   of their period, so they may need an adjustment too.
 * `affectedRequests` is the total (= countingBalance + notCountingBalance =
 * past + upcoming).
 *
 * A Saturday or Sunday never counted as a business day, so a holiday there
 * changes nothing: all zeros without looking at any request. Dates are UTC
 * midnight (@db.Date), hence getUTCDay().
 */
export interface HolidayImpact {
  affectedRequests: number;
  breakdown: { countingBalance: number; notCountingBalance: number; past: number; upcoming: number };
}

const NO_IMPACT: HolidayImpact = {
  affectedRequests: 0,
  breakdown: { countingBalance: 0, notCountingBalance: 0, past: 0, upcoming: 0 },
};

export async function getHolidayImpact(db: DbClient, date: Date): Promise<HolidayImpact> {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return NO_IMPACT;
  }
  // Sequential on purpose: inside a transaction `db` is a single connection.
  const crossing = await db.leaveRequest.findMany({
    where: {
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: date },
      endDate: { gte: date },
    },
    select: { endDate: true, countsAgainstVacationBalance: true },
  });
  const today = todayInTimeZone(env.APP_TIMEZONE);
  const counting = crossing.filter((request) => request.countsAgainstVacationBalance).length;
  const past = crossing.filter((request) => request.endDate.getTime() < today.getTime()).length;
  return {
    affectedRequests: crossing.length,
    breakdown: {
      countingBalance: counting,
      notCountingBalance: crossing.length - counting,
      past,
      upcoming: crossing.length - past,
    },
  };
}

export async function createHoliday(actorId: string, input: CreateHolidayInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      if (await tx.holiday.findUnique({ where: { date: input.date }, select: { id: true } })) {
        throw duplicateDate();
      }
      const created = await tx.holiday.create({ data: input, select: holidaySelect });
      await recordHrAudit(tx, {
        actorId,
        entityType: "HOLIDAY",
        entityId: created.id,
        action: "CREATED",
        before: null,
        after: snapshot(created),
      });
      return { holiday: serialize(created), ...(await getHolidayImpact(tx, created.date)) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateDate();
    throw err;
  }
}

export async function deleteHoliday(actorId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    await lockHoliday(tx, id);
    const current = await tx.holiday.findUnique({ where: { id }, select: holidaySelect });
    if (!current) {
      throw new NotFoundError(NOT_FOUND);
    }
    await tx.holiday.delete({ where: { id } });
    await recordHrAudit(tx, {
      actorId,
      entityType: "HOLIDAY",
      entityId: id,
      action: "DELETED",
      before: snapshot(current),
      after: null,
    });
    return getHolidayImpact(tx, current.date);
  });
}
