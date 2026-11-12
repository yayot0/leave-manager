import { describe, expect, it } from "vitest";
import { diffInDays, parseISODate, toISODate, todayInTimeZone } from "./dates.js";

const MONTERREY = "America/Monterrey";

describe("parseISODate", () => {
  it("parses a valid YYYY-MM-DD string into a UTC-midnight Date", () => {
    const date = parseISODate("2026-11-11");
    expect(date).not.toBeNull();
    expect(date?.toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("accepts the first and last day of the year", () => {
    expect(parseISODate("2026-01-01")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseISODate("2026-12-31")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("accepts Feb 29 in a leap year (2028)", () => {
    expect(parseISODate("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("accepts Feb 29 in a leap century year (2000, divisible by 400)", () => {
    expect(parseISODate("2000-02-29")?.toISOString()).toBe("2000-02-29T00:00:00.000Z");
  });

  it("rejects Feb 29 in a non-leap year (2027) instead of rolling over to Mar 1", () => {
    expect(parseISODate("2027-02-29")).toBeNull();
  });

  it("rejects Feb 29 in a non-leap century year (2100)", () => {
    expect(parseISODate("2100-02-29")).toBeNull();
  });

  it("rejects non-existent days such as 2026-02-30 and 2026-04-31", () => {
    expect(parseISODate("2026-02-30")).toBeNull();
    expect(parseISODate("2026-04-31")).toBeNull();
  });

  it("rejects day 00 and month 00", () => {
    expect(parseISODate("2026-11-00")).toBeNull();
    expect(parseISODate("2026-00-10")).toBeNull();
  });

  it("rejects month 13", () => {
    expect(parseISODate("2026-13-01")).toBeNull();
  });

  it("rejects dates without zero padding (2026-1-5)", () => {
    expect(parseISODate("2026-1-5")).toBeNull();
    expect(parseISODate("2026-01-5")).toBeNull();
  });

  it.each([
    "",
    "garbage",
    "2026/11/11",
    "11-11-2026",
    "2026-11-11T00:00:00Z",
    " 2026-11-11",
    "2026-11-11 ",
    "20261111",
    "2026-11-1a",
  ])("rejects malformed input %j", (value) => {
    expect(parseISODate(value)).toBeNull();
  });
});

describe("toISODate", () => {
  it("formats a UTC-midnight Date as YYYY-MM-DD", () => {
    expect(toISODate(new Date(Date.UTC(2026, 10, 11)))).toBe("2026-11-11");
  });

  it("uses the UTC date, not the local one, for late-UTC instants", () => {
    expect(toISODate(new Date("2026-11-11T23:59:59.999Z"))).toBe("2026-11-11");
  });

  it("round-trips with parseISODate, including Feb 29 of a leap year", () => {
    for (const iso of ["2026-01-01", "2026-12-31", "2028-02-29"]) {
      const parsed = parseISODate(iso);
      expect(parsed).not.toBeNull();
      expect(toISODate(parsed as Date)).toBe(iso);
    }
  });
});

describe("todayInTimeZone", () => {
  it("returns the previous calendar day in Monterrey at 03:00 UTC (21:00 local)", () => {
    const now = new Date("2026-11-12T03:00:00Z");
    expect(toISODate(todayInTimeZone(MONTERREY, now))).toBe("2026-11-11");
    // Meanwhile it is already Nov 12 in UTC.
    expect(toISODate(todayInTimeZone("UTC", now))).toBe("2026-11-12");
  });

  it("returns the same calendar day in Monterrey at 06:00 UTC (00:00 local)", () => {
    const now = new Date("2026-11-12T06:00:00Z");
    expect(toISODate(todayInTimeZone(MONTERREY, now))).toBe("2026-11-12");
  });

  it("still returns the previous day in Monterrey one millisecond before local midnight", () => {
    const now = new Date("2026-11-12T05:59:59.999Z");
    expect(toISODate(todayInTimeZone(MONTERREY, now))).toBe("2026-11-11");
  });

  it("returns a UTC-midnight Date comparable with @db.Date values", () => {
    const today = todayInTimeZone(MONTERREY, new Date("2026-11-11T18:00:00Z"));
    expect(today.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(today.getTime()).toBe(parseISODate("2026-11-11")?.getTime());
  });

  it("resolves Feb 29 of a leap year in the company timezone", () => {
    const now = new Date("2028-03-01T04:00:00Z"); // 22:00 on Feb 29 in Monterrey
    expect(toISODate(todayInTimeZone(MONTERREY, now))).toBe("2028-02-29");
  });

  it("resolves New Year's Eve in Monterrey while UTC is already in the next year", () => {
    const now = new Date("2027-01-01T02:00:00Z");
    expect(toISODate(todayInTimeZone(MONTERREY, now))).toBe("2026-12-31");
    expect(toISODate(todayInTimeZone("UTC", now))).toBe("2027-01-01");
  });

  it("throws on an invalid timezone", () => {
    expect(() => todayInTimeZone("Not/AZone", new Date())).toThrow();
  });
});

describe("diffInDays", () => {
  it("returns 0 for the same date", () => {
    expect(diffInDays(new Date(Date.UTC(2026, 10, 11)), new Date(Date.UTC(2026, 10, 11)))).toBe(0);
  });

  it("counts Feb 29 in a leap year (2028-02-28 -> 2028-03-01 = 2)", () => {
    expect(diffInDays(parseISODate("2028-02-28") as Date, parseISODate("2028-03-01") as Date)).toBe(2);
  });

  it("returns 1 across a non-leap February end (2027-02-28 -> 2027-03-01)", () => {
    expect(diffInDays(parseISODate("2027-02-28") as Date, parseISODate("2027-03-01") as Date)).toBe(1);
  });

  it("returns a negative number when end is before start", () => {
    expect(diffInDays(parseISODate("2026-11-11") as Date, parseISODate("2026-11-10") as Date)).toBe(-1);
  });

  it("returns 365 for a full non-leap year and 366 for a leap year", () => {
    expect(diffInDays(parseISODate("2026-01-01") as Date, parseISODate("2027-01-01") as Date)).toBe(365);
    expect(diffInDays(parseISODate("2028-01-01") as Date, parseISODate("2029-01-01") as Date)).toBe(366);
  });
});
