import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateRange,
  formatDateTime,
  formatShortDate,
  formatWeekday,
  nextDateOnly,
  parseDateOnly,
  todayISO,
} from "./dates";

describe("test environment", () => {
  it("runs in Monterrey, where the naive approach shows the day before", () => {
    // Control test: proves the timezone is really set, so the tests below
    // would catch the bug. new Date("2026-03-01") is UTC midnight, which in
    // Monterrey is still Feb 28.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Monterrey");
    expect(new Date("2026-03-01").toLocaleDateString("es-MX", { day: "numeric", month: "long" })).toBe(
      "28 de febrero",
    );
  });
});

describe("parseDateOnly", () => {
  it("builds the date at UTC midnight", () => {
    expect(parseDateOnly("2026-03-01")?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("accepts the full ISO form the API uses for hireDate", () => {
    expect(parseDateOnly("2021-03-15T00:00:00.000Z")?.toISOString()).toBe("2021-03-15T00:00:00.000Z");
  });

  it.each(["", "2026-3-1", "01/03/2026", "2026-02-30", "2026-13-01", "2026-03-01T06:00:00.000Z"])(
    "rejects %j",
    (value) => {
      expect(parseDateOnly(value)).toBeNull();
    },
  );
});

describe("formatDate (date-only values)", () => {
  it("shows the same calendar day in Monterrey", () => {
    expect(formatDate("2026-03-01")).toBe("1 de marzo de 2026");
  });

  it("does not move New Year's Day to the previous year", () => {
    expect(formatDate("2027-01-01")).toBe("1 de enero de 2027");
  });

  it("formats Feb 29 of a leap year", () => {
    expect(formatDate("2028-02-29")).toBe("29 de febrero de 2028");
  });

  it("formats hireDate in its full ISO form on the right day", () => {
    expect(formatDate("2021-03-15T00:00:00.000Z")).toBe("15 de marzo de 2021");
  });

  it("shows the raw value instead of 'Invalid Date'", () => {
    expect(formatDate("no-es-fecha")).toBe("no-es-fecha");
  });
});

describe("formatShortDate and formatDateRange", () => {
  it("uses the abbreviated month", () => {
    expect(formatShortDate("2026-12-01")).toMatch(/^1 dic\.? 2026$/);
  });

  it("joins two different days and collapses a single day", () => {
    expect(formatDateRange("2026-12-01", "2026-12-03")).toBe("1 de diciembre de 2026 al 3 de diciembre de 2026");
    expect(formatDateRange("2026-12-01", "2026-12-01")).toBe("1 de diciembre de 2026");
  });
});

describe("formatWeekday", () => {
  it("gives the weekday of the date itself, not the day before in Monterrey", () => {
    // 2026-03-01 is a Sunday; new Date("2026-03-01") + local getDay() would say Saturday (UTC-6).
    expect(formatWeekday("2026-03-01")).toBe("domingo");
    expect(formatWeekday("2026-11-16")).toBe("lunes");
  });
});

describe("formatDateTime (instants)", () => {
  it("shows an instant in the local timezone", () => {
    // 03:00 UTC on Nov 12 is still 21:00 on Nov 11 in Monterrey.
    const formatted = formatDateTime("2026-11-12T03:00:00.000Z");
    expect(formatted).toMatch(/11 nov\.? 2026/);
    expect(formatted).toMatch(/21:00|9:00\s?p\.?\s?m\.?/);
  });
});

describe("todayISO", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 2026-11-12 03:00 UTC is still Nov 11 in Monterrey.
    expect(todayISO(new Date("2026-11-12T03:00:00.000Z"))).toBe("2026-11-11");
  });
});

describe("nextDateOnly", () => {
  it("moves one calendar day, across months, years and Feb 29", () => {
    expect(nextDateOnly("2027-03-14")).toBe("2027-03-15");
    expect(nextDateOnly("2026-12-31")).toBe("2027-01-01");
    expect(nextDateOnly("2028-02-28")).toBe("2028-02-29");
    expect(nextDateOnly("2027-02-28")).toBe("2027-03-01");
  });

  it("returns invalid input unchanged", () => {
    expect(nextDateOnly("nope")).toBe("nope");
  });
});
