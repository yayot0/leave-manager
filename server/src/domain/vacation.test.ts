import { describe, expect, it } from "vitest";
import {
  calculateVacationBalance,
  countBusinessDays,
  getCurrentVacationPeriod,
  getVacationEntitlement,
  getYearsOfService,
  type LeaveRequestInput,
} from "./vacation.js";

/** Always build UTC-midnight dates, never locale-dependent constructors. */
function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe("getVacationEntitlement", () => {
  it("returns 0 days for someone with less than 1 year of service (year 0)", () => {
    expect(getVacationEntitlement(0)).toBe(0);
  });

  it("returns 12 days for exactly 1 year of service", () => {
    expect(getVacationEntitlement(1)).toBe(12);
  });

  it("returns 14 days for 2 years of service", () => {
    expect(getVacationEntitlement(2)).toBe(14);
  });

  it("returns 16 days for 3 years of service", () => {
    expect(getVacationEntitlement(3)).toBe(16);
  });

  it("returns 18 days for 4 years of service", () => {
    expect(getVacationEntitlement(4)).toBe(18);
  });

  it("returns 20 days for 5 years of service (top of the yearly-increment band)", () => {
    expect(getVacationEntitlement(5)).toBe(20);
  });

  it("returns 22 days for 6 years of service (first year of the 6-10 band)", () => {
    expect(getVacationEntitlement(6)).toBe(22);
  });

  it("returns 22 days for 10 years of service (last year of the 6-10 band)", () => {
    expect(getVacationEntitlement(10)).toBe(22);
  });

  it("returns 24 days for 11 years of service (first year of the 11-15 band)", () => {
    expect(getVacationEntitlement(11)).toBe(24);
  });

  it("returns 24 days for 15 years of service (last year of the 11-15 band)", () => {
    expect(getVacationEntitlement(15)).toBe(24);
  });

  it("returns 26 days for 16 years of service (first year of the 16-20 band)", () => {
    expect(getVacationEntitlement(16)).toBe(26);
  });
});

describe("getYearsOfService", () => {
  it("returns the new, incremented year on the exact anniversary day", () => {
    const hireDate = utc("2020-05-10");
    const asOf = utc("2026-05-10");
    expect(getYearsOfService(hireDate, asOf)).toBe(6);
  });

  it("has not yet incremented the year one day before the anniversary", () => {
    const hireDate = utc("2020-05-10");
    const asOf = utc("2026-05-09");
    expect(getYearsOfService(hireDate, asOf)).toBe(5);
  });

  it("returns 0 for someone hired less than a year ago", () => {
    const hireDate = utc("2026-01-01");
    const asOf = utc("2026-10-23");
    expect(getYearsOfService(hireDate, asOf)).toBe(0);
  });

  it("never returns a negative number even if asOf is before hireDate", () => {
    const hireDate = utc("2026-10-23");
    const asOf = utc("2025-01-01");
    expect(getYearsOfService(hireDate, asOf)).toBe(0);
  });

  describe("February 29 hire date in a non-leap evaluation year", () => {
    // Hired on a leap-year Feb 29; evaluated in 2029, which is NOT a leap
    // year (2029 / 4 is not an integer). Per Art. 18 LFT the anniversary is
    // treated as Feb 28 in that case (most favorable interpretation).
    const hireDate = utc("2016-02-29");

    it("has not completed the year yet on Feb 27 (one day before the Feb 28 anniversary)", () => {
      expect(getYearsOfService(hireDate, utc("2029-02-27"))).toBe(12);
    });

    it("has already completed the year on Feb 28 itself (the treated-as anniversary)", () => {
      expect(getYearsOfService(hireDate, utc("2029-02-28"))).toBe(13);
    });

    it("has already completed the year on March 1 (anniversary already passed)", () => {
      expect(getYearsOfService(hireDate, utc("2029-03-01"))).toBe(13);
    });
  });
});

describe("getCurrentVacationPeriod", () => {
  it("runs from one anniversary to the day before the next one", () => {
    const hireDate = utc("2020-11-01");
    const asOf = utc("2026-10-23");
    const period = getCurrentVacationPeriod(hireDate, asOf);
    expect(period.start.toISOString()).toBe(utc("2025-11-01").toISOString());
    expect(period.end.toISOString()).toBe(utc("2026-10-31").toISOString());
  });

  it("for someone with less than 1 year of service, runs from hireDate to the day before their first anniversary", () => {
    const hireDate = utc("2026-05-04");
    const asOf = utc("2026-10-23");
    const period = getCurrentVacationPeriod(hireDate, asOf);
    expect(period.start.toISOString()).toBe(utc("2026-05-04").toISOString());
    expect(period.end.toISOString()).toBe(utc("2027-05-03").toISOString());
  });

  it("moves the period forward exactly on the anniversary day", () => {
    const hireDate = utc("2020-11-01");
    const asOf = utc("2026-11-01");
    const period = getCurrentVacationPeriod(hireDate, asOf);
    expect(period.start.toISOString()).toBe(utc("2026-11-01").toISOString());
    expect(period.end.toISOString()).toBe(utc("2027-10-31").toISOString());
  });
});

describe("countBusinessDays", () => {
  it("excludes Saturdays and Sundays", () => {
    // Mon 2026-10-05 to Sun 2026-10-11: 5 weekdays, 2 weekend days excluded.
    const start = utc("2026-10-05");
    const end = utc("2026-10-11");
    expect(countBusinessDays(start, end, [])).toBe(5);
  });

  it("excludes holidays that fall on a weekday in the middle of the range", () => {
    // Mon 2026-09-14 to Fri 2026-09-18, with Wed 2026-09-16 as a holiday
    // (Día de la Independencia) => 4 business days.
    const start = utc("2026-09-14");
    const end = utc("2026-09-18");
    const holidays = [utc("2026-09-16")];
    expect(countBusinessDays(start, end, holidays)).toBe(4);
  });

  it("is inclusive of both the start and end date", () => {
    const start = utc("2026-10-05");
    const end = utc("2026-10-05");
    expect(countBusinessDays(start, end, [])).toBe(1);
  });

  it("returns 0 for a single-day range that falls on a weekend", () => {
    // 2026-10-10 is a Saturday.
    const start = utc("2026-10-10");
    const end = utc("2026-10-10");
    expect(countBusinessDays(start, end, [])).toBe(0);
  });

  it("returns 0 for a single-day range that is itself a holiday", () => {
    const start = utc("2026-01-01");
    const end = utc("2026-01-01");
    expect(countBusinessDays(start, end, [utc("2026-01-01")])).toBe(0);
  });

  it("ignores holidays that fall outside of the requested range", () => {
    const start = utc("2026-10-05");
    const end = utc("2026-10-09");
    const holidays = [utc("2026-12-25")];
    expect(countBusinessDays(start, end, holidays)).toBe(5);
  });
});

describe("calculateVacationBalance", () => {
  const baseParams = {
    hireDate: utc("2020-02-01"),
    asOf: utc("2026-10-23"),
  };

  it("ignores adjustments whose effectiveDate falls outside the current period", () => {
    // Current period: 2026-02-01 -> 2027-01-31.
    const result = calculateVacationBalance({
      ...baseParams,
      adjustments: [{ days: 5, effectiveDate: utc("2025-06-01") }],
      leaveRequests: [],
    });
    expect(result.adjustments).toBe(0);
    expect(result.available).toBe(result.earned);
  });

  it("counts an adjustment whose effectiveDate falls inside the current period", () => {
    const result = calculateVacationBalance({
      ...baseParams,
      adjustments: [{ days: 3, effectiveDate: utc("2026-05-01") }],
      leaveRequests: [],
    });
    expect(result.adjustments).toBe(3);
    expect(result.available).toBe(result.earned + 3);
  });

  it("ignores leave requests with countsAgainstVacationBalance = false even if otherwise eligible", () => {
    const leaveRequests: LeaveRequestInput[] = [
      {
        startDate: utc("2026-06-01"),
        businessDays: 5,
        status: "APPROVED",
        countsAgainstVacationBalance: false,
      },
    ];
    const result = calculateVacationBalance({ ...baseParams, adjustments: [], leaveRequests });
    expect(result.approved).toBe(0);
    expect(result.available).toBe(result.earned);
  });

  it("ignores leave requests whose startDate falls outside the current period", () => {
    const leaveRequests: LeaveRequestInput[] = [
      {
        startDate: utc("2025-01-15"), // previous period
        businessDays: 5,
        status: "APPROVED",
        countsAgainstVacationBalance: true,
      },
    ];
    const result = calculateVacationBalance({ ...baseParams, adjustments: [], leaveRequests });
    expect(result.approved).toBe(0);
    expect(result.available).toBe(result.earned);
  });

  it("counts APPROVED requests towards `approved` and PENDING requests towards `pending`", () => {
    const leaveRequests: LeaveRequestInput[] = [
      {
        startDate: utc("2026-07-06"),
        businessDays: 5,
        status: "APPROVED",
        countsAgainstVacationBalance: true,
      },
      {
        startDate: utc("2026-12-21"),
        businessDays: 4,
        status: "PENDING",
        countsAgainstVacationBalance: true,
      },
    ];
    const result = calculateVacationBalance({ ...baseParams, adjustments: [], leaveRequests });
    expect(result.approved).toBe(5);
    expect(result.pending).toBe(4);
    expect(result.available).toBe(result.earned - 5 - 4);
  });

  it("ignores REJECTED and CANCELLED requests even though they pass every other filter", () => {
    const leaveRequests: LeaveRequestInput[] = [
      {
        startDate: utc("2026-07-06"),
        businessDays: 5,
        status: "REJECTED",
        countsAgainstVacationBalance: true,
      },
      {
        startDate: utc("2026-08-10"),
        businessDays: 5,
        status: "CANCELLED",
        countsAgainstVacationBalance: true,
      },
    ];
    const result = calculateVacationBalance({ ...baseParams, adjustments: [], leaveRequests });
    expect(result.approved).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.available).toBe(result.earned);
  });

  it("computes available = earned + adjustments - approved - pending", () => {
    const result = calculateVacationBalance({
      ...baseParams,
      adjustments: [{ days: 3, effectiveDate: utc("2026-02-01") }],
      leaveRequests: [
        {
          startDate: utc("2026-07-06"),
          businessDays: 5,
          status: "APPROVED",
          countsAgainstVacationBalance: true,
        },
        {
          startDate: utc("2026-12-21"),
          businessDays: 5,
          status: "PENDING",
          countsAgainstVacationBalance: true,
        },
      ],
    });
    expect(result.earned).toBe(22);
    expect(result.adjustments).toBe(3);
    expect(result.approved).toBe(5);
    expect(result.pending).toBe(5);
    expect(result.available).toBe(22 + 3 - 5 - 5);
  });

  it("gives 0 available days for someone with less than 1 year of service", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2026-05-04"),
      asOf: utc("2026-10-23"),
      adjustments: [],
      leaveRequests: [],
    });
    expect(result.yearsOfService).toBe(0);
    expect(result.earned).toBe(0);
    expect(result.available).toBe(0);
    expect(result.period.start.toISOString()).toBe(utc("2026-05-04").toISOString());
    expect(result.period.end.toISOString()).toBe(utc("2027-05-03").toISOString());
  });
});

/**
 * Integration tests against the real Grupo Norte demo seed
 * (server/prisma/seed.ts). All cases use asOf = 2026-10-23, the "today" the
 * seed's own comments assume. Hire dates, adjustments and leave requests
 * were read directly from the seed file, not assumed.
 */
describe("calculateVacationBalance — Grupo Norte demo seed (asOf = 2026-10-23)", () => {
  const asOf = utc("2026-10-23");

  it("director (Eduardo Villanueva, hired 2014-03-03): 12 years, earned 24, no adjustments/requests", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2014-03-03"),
      asOf,
      adjustments: [],
      leaveRequests: [],
    });
    expect(result.yearsOfService).toBe(12);
    expect(result.earned).toBe(24);
    expect(result.adjustments).toBe(0);
    expect(result.approved).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.available).toBe(24);
  });

  it("rh@demo.com (Alejandra Reyes, hired 2020-11-01): 5 years, earned 20, no adjustments/requests", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2020-11-01"),
      asOf,
      adjustments: [],
      leaveRequests: [],
    });
    expect(result.yearsOfService).toBe(5);
    expect(result.earned).toBe(20);
    expect(result.available).toBe(20);
  });

  it("jefe@demo.com (Ricardo Montemayor, hired 2018-06-15): 8 years, earned 22, no adjustments/requests", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2018-06-15"),
      asOf,
      adjustments: [],
      leaveRequests: [],
    });
    expect(result.yearsOfService).toBe(8);
    expect(result.earned).toBe(22);
    expect(result.available).toBe(22);
  });

  it("humberto.saldana@gruponorte.mx (Finanzas manager, hired 2019-09-10): 7 years, earned 22; an APPROVED VAC request from the PREVIOUS period (startDate 2026-06-01, before the current period starting 2026-09-10) does not count", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2019-09-10"),
      asOf,
      adjustments: [],
      leaveRequests: [
        {
          startDate: utc("2026-06-01"),
          businessDays: 5,
          status: "APPROVED",
          countsAgainstVacationBalance: true,
        },
      ],
    });
    expect(result.yearsOfService).toBe(7);
    expect(result.earned).toBe(22);
    expect(result.period.start.toISOString()).toBe(utc("2026-09-10").toISOString());
    expect(result.approved).toBe(0);
    expect(result.available).toBe(22);
  });

  it("empleado@demo.com (Fernando Garza, hired 2023-02-01): 3 years, earned 16; +3 CARRYOVER, 5 days APPROVED and 5 days PENDING all within the current period => available 9", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2023-02-01"),
      asOf,
      adjustments: [{ days: 3, effectiveDate: utc("2026-02-01") }],
      leaveRequests: [
        {
          startDate: utc("2026-07-06"),
          businessDays: 5,
          status: "APPROVED",
          countsAgainstVacationBalance: true,
        },
        {
          startDate: utc("2026-12-21"),
          businessDays: 5,
          status: "PENDING",
          countsAgainstVacationBalance: true,
        },
      ],
    });
    expect(result.yearsOfService).toBe(3);
    expect(result.earned).toBe(16);
    expect(result.adjustments).toBe(3);
    expect(result.approved).toBe(5);
    expect(result.pending).toBe(5);
    expect(result.available).toBe(9);
  });

  it("daniela.cantu@gruponorte.mx (Tecnología, hired 2021-02-22): 5 years, earned 20; -2 MANUAL_CORRECTION and 5 days PENDING within the current period => available 13", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2021-02-22"),
      asOf,
      adjustments: [{ days: -2, effectiveDate: utc("2026-09-01") }],
      leaveRequests: [
        {
          startDate: utc("2026-12-14"),
          businessDays: 5,
          status: "PENDING",
          countsAgainstVacationBalance: true,
        },
      ],
    });
    expect(result.yearsOfService).toBe(5);
    expect(result.earned).toBe(20);
    expect(result.adjustments).toBe(-2);
    expect(result.approved).toBe(0);
    expect(result.pending).toBe(5);
    expect(result.available).toBe(13);
  });

  it("brenda.najera@gruponorte.mx (Ventas, hired 2026-05-04): less than 1 year of service, earned 0, no adjustments/requests", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2026-05-04"),
      asOf,
      adjustments: [],
      leaveRequests: [],
    });
    expect(result.yearsOfService).toBe(0);
    expect(result.earned).toBe(0);
    expect(result.available).toBe(0);
    expect(result.period.start.toISOString()).toBe(utc("2026-05-04").toISOString());
    expect(result.period.end.toISOString()).toBe(utc("2027-05-03").toISOString());
  });

  it("gustavo.pena@gruponorte.mx (Ventas, hired 2025-08-01): 1 year, earned 12; 5 days APPROVED within the current period => available 7", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2025-08-01"),
      asOf,
      adjustments: [],
      leaveRequests: [
        {
          startDate: utc("2027-01-04"),
          businessDays: 5,
          status: "APPROVED",
          countsAgainstVacationBalance: true,
        },
      ],
    });
    expect(result.yearsOfService).toBe(1);
    expect(result.earned).toBe(12);
    expect(result.period.start.toISOString()).toBe(utc("2026-08-01").toISOString());
    expect(result.period.end.toISOString()).toBe(utc("2027-07-31").toISOString());
    expect(result.approved).toBe(5);
    expect(result.available).toBe(7);
  });

  it("adriana.villegas@gruponorte.mx (Operaciones, hired 2022-10-08): 4 years, earned 18; 4 days PENDING within the current period => available 14", () => {
    const result = calculateVacationBalance({
      hireDate: utc("2022-10-08"),
      asOf,
      adjustments: [],
      leaveRequests: [
        {
          startDate: utc("2027-02-01"),
          businessDays: 4,
          status: "PENDING",
          countsAgainstVacationBalance: true,
        },
      ],
    });
    expect(result.yearsOfService).toBe(4);
    expect(result.earned).toBe(18);
    expect(result.period.start.toISOString()).toBe(utc("2026-10-08").toISOString());
    expect(result.period.end.toISOString()).toBe(utc("2027-10-07").toISOString());
    expect(result.pending).toBe(4);
    expect(result.available).toBe(14);
  });

  describe("rh@demo.com (Alejandra Reyes, hired 2020-11-01) around her 6th anniversary", () => {
    it("the day before the anniversary (asOf = 2026-10-31): still 5 years, earned 20, period 2025-11-01 -> 2026-10-31", () => {
      const result = calculateVacationBalance({
        hireDate: utc("2020-11-01"),
        asOf: utc("2026-10-31"),
        adjustments: [],
        leaveRequests: [],
      });
      expect(result.yearsOfService).toBe(5);
      expect(result.earned).toBe(20);
      expect(result.period.start.toISOString()).toBe(utc("2025-11-01").toISOString());
      expect(result.period.end.toISOString()).toBe(utc("2026-10-31").toISOString());
    });

    it("the exact anniversary day (asOf = 2026-11-01): already 6 years, earned 22, period 2026-11-01 -> 2027-10-31", () => {
      const result = calculateVacationBalance({
        hireDate: utc("2020-11-01"),
        asOf: utc("2026-11-01"),
        adjustments: [],
        leaveRequests: [],
      });
      expect(result.yearsOfService).toBe(6);
      expect(result.earned).toBe(22);
      expect(result.period.start.toISOString()).toBe(utc("2026-11-01").toISOString());
      expect(result.period.end.toISOString()).toBe(utc("2027-10-31").toISOString());
    });
  });
});
