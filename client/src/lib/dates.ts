/**
 * Formatting of the API's dates. There are two kinds and they are NOT
 * interchangeable:
 *
 * - Date-only values ("2026-03-01", or "2021-03-15T00:00:00.000Z" for
 *   `hireDate`): a calendar day with no time and no timezone. Never pass them
 *   to `new Date(value)` and format in local time: "2026-03-01" is parsed as
 *   UTC midnight, which in Monterrey (UTC-6) is still Feb 28 at 18:00, so the
 *   page would show the day before. Instead we rebuild the day at UTC midnight
 *   and format it with `timeZone: "UTC"`, so the browser's zone never matters.
 *
 * - Instants (`createdAt` of an event, "2026-11-12T03:00:00.000Z"): a real
 *   moment in time, shown in the user's own timezone.
 */

const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/;

/**
 * Parses a date-only value into a Date at UTC midnight. Returns null when it
 * is malformed or not a real calendar day ("2026-02-30").
 */
export function parseDateOnly(value: string): Date | null {
  const match = DATE_ONLY_REGEX.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

/**
 * The calendar day after a date-only value: "2027-03-14" → "2027-03-15".
 * (The period ends the day before the anniversary, so this gives the
 * anniversary.) Returns the input unchanged if it is not a valid date.
 */
export function nextDateOnly(value: string): string {
  const date = parseDateOnly(value);
  if (!date) {
    return value;
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const LOCALE = "es-MX";

// timeZone "UTC" is what keeps date-only values on their own day.
const longDate = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
// Instants: no timeZone, so the browser's own.
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });

function formatWith(formatter: Intl.DateTimeFormat, value: string): string {
  const date = parseDateOnly(value);
  // Shows the raw value rather than "Invalid Date" if the API ever sends junk.
  return date ? formatter.format(date) : value;
}

/** "2026-03-01" → "1 de marzo de 2026". */
export function formatDate(value: string): string {
  return formatWith(longDate, value);
}

/** "2026-03-01" → "1 mar 2026". */
export function formatShortDate(value: string): string {
  return formatWith(shortDate, value);
}

/** A date range; a single day when both ends are equal. */
export function formatDateRange(start: string, end: string, format: (value: string) => string = formatDate): string {
  return start === end ? format(start) : `${format(start)} al ${format(end)}`;
}

/** An instant, in the browser's timezone: "11 nov 2026, 21:00". */
export function formatDateTime(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    return instant;
  }
  return dateTime.format(date);
}

/**
 * Today's calendar date in the browser's timezone, as "YYYY-MM-DD". Only for
 * UX (the `min` of a date input); the API decides with the company timezone.
 */
export function todayISO(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
