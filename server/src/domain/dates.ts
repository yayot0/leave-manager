/**
 * Pure date helpers for date-only values ("YYYY-MM-DD"). A date-only value is
 * always represented as a Date at UTC midnight, the same shape Prisma returns
 * for @db.Date columns, so they can be compared directly with getTime().
 */

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses "YYYY-MM-DD" into a UTC-midnight Date. Returns null when the string
 * is malformed or is not a real calendar date (e.g. "2026-02-30").
 */
export function parseISODate(value: string): Date | null {
  const match = ISO_DATE_REGEX.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls over invalid dates (Feb 30 -> Mar 2); reject them.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Formats a date-only value as "YYYY-MM-DD" (UTC). */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar date it currently is in `timeZone`, as a UTC-midnight Date.
 *
 * Intl.DateTimeFormat converts the instant `now` to the wall-clock date seen
 * in that timezone (with its real offset and DST rules), independently of the
 * server's own timezone. We then rebuild it with Date.UTC so it can be
 * compared with @db.Date values. Example: 2026-11-12T03:00Z is still
 * 2026-11-11 in America/Monterrey (UTC-6), so this returns 2026-11-11.
 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: "year" | "month" | "day"): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Could not resolve ${type} for timezone ${timeZone}`);
    }
    return Number(part.value);
  };

  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

/** Whole days from `start` to `end` (both UTC-midnight dates). */
export function diffInDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
