/**
 * Pure vacation-balance calculations: no Prisma, no Express, everything is
 * received as a parameter. Dates are always treated as UTC midnight (what
 * Postgres @db.Date columns and Prisma give us), and every calculation uses
 * getUTC-prefixed accessors and Date.UTC, so the result never shifts by a day
 * depending on the server's local timezone.
 */

export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface AdjustmentInput {
  days: number;
  effectiveDate: Date;
}

export interface LeaveRequestInput {
  startDate: Date;
  businessDays: number;
  status: LeaveRequestStatus;
  countsAgainstVacationBalance: boolean;
}

export interface VacationPeriod {
  start: Date;
  end: Date;
}

export interface VacationBalance {
  period: VacationPeriod;
  yearsOfService: number;
  earned: number;
  adjustments: number;
  approved: number;
  pending: number;
  available: number;
}

function toUTCDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUTCDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Anniversary of hireDate that falls in `year`. Someone hired on Feb 29 has
 * no literal anniversary in a non-leap year; per Art. 18 LFT (the
 * interpretation most favorable to the worker), their year is considered
 * completed on Feb 28 instead of overflowing into March 1.
 */
function anniversaryInYear(hireDate: Date, year: number): Date {
  const month = hireDate.getUTCMonth();
  const day = hireDate.getUTCDate();
  if (month === 1 && day === 29 && !isLeapYear(year)) {
    return new Date(Date.UTC(year, 1, 28));
  }
  return new Date(Date.UTC(year, month, day));
}

/** The nth anniversary of hireDate (n = 0 is hireDate itself). */
function nthAnniversary(hireDate: Date, n: number): Date {
  return anniversaryInYear(hireDate, hireDate.getUTCFullYear() + n);
}

export function countBusinessDays(start: Date, end: Date, holidays: Date[]): number {
  const startDate = toUTCDateOnly(start);
  const endDate = toUTCDateOnly(end);
  const holidaySet = new Set(holidays.map((h) => isoOf(toUTCDateOnly(h))));

  let count = 0;
  let cursor = startDate;
  while (cursor.getTime() <= endDate.getTime()) {
    const weekday = cursor.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(isoOf(cursor))) {
      count++;
    }
    cursor = addUTCDays(cursor, 1);
  }
  return count;
}

export function getYearsOfService(hireDate: Date, asOf: Date): number {
  const hire = toUTCDateOnly(hireDate);
  const now = toUTCDateOnly(asOf);

  let years = now.getUTCFullYear() - hire.getUTCFullYear();
  const anniversaryThisYear = anniversaryInYear(hire, now.getUTCFullYear());
  if (now.getTime() < anniversaryThisYear.getTime()) {
    years -= 1;
  }
  return Math.max(years, 0);
}

export function getVacationEntitlement(yearsOfService: number): number {
  if (yearsOfService < 1) {
    return 0;
  }
  if (yearsOfService <= 5) {
    return 12 + 2 * (yearsOfService - 1);
  }
  return 20 + 2 * Math.ceil((yearsOfService - 5) / 5);
}

export function getCurrentVacationPeriod(hireDate: Date, asOf: Date): VacationPeriod {
  const hire = toUTCDateOnly(hireDate);
  const now = toUTCDateOnly(asOf);
  const years = getYearsOfService(hire, now);

  const start = nthAnniversary(hire, years);
  const end = addUTCDays(nthAnniversary(hire, years + 1), -1);
  return { start, end };
}

export function calculateVacationBalance(params: {
  hireDate: Date;
  asOf: Date;
  adjustments: AdjustmentInput[];
  leaveRequests: LeaveRequestInput[];
}): VacationBalance {
  const hireDate = toUTCDateOnly(params.hireDate);
  const asOf = toUTCDateOnly(params.asOf);
  const yearsOfService = getYearsOfService(hireDate, asOf);
  const earned = getVacationEntitlement(yearsOfService);
  const period = getCurrentVacationPeriod(hireDate, asOf);

  const inPeriod = (date: Date): boolean => {
    const value = toUTCDateOnly(date).getTime();
    return value >= period.start.getTime() && value <= period.end.getTime();
  };

  const adjustments = params.adjustments
    .filter((adjustment) => inPeriod(adjustment.effectiveDate))
    .reduce((sum, adjustment) => sum + adjustment.days, 0);

  const relevantRequests = params.leaveRequests.filter(
    (request) => request.countsAgainstVacationBalance && inPeriod(request.startDate),
  );
  const approved = relevantRequests
    .filter((request) => request.status === "APPROVED")
    .reduce((sum, request) => sum + request.businessDays, 0);
  const pending = relevantRequests
    .filter((request) => request.status === "PENDING")
    .reduce((sum, request) => sum + request.businessDays, 0);

  const available = earned + adjustments - approved - pending;

  return { period, yearsOfService, earned, adjustments, approved, pending, available };
}
