import { describe, expect, it } from "vitest";
import { formatBusinessDays, formatDays, formatNumber, formatSigned } from "./numbers";

describe("number formatting", () => {
  it("uses the real minus sign for negatives", () => {
    expect(formatNumber(-3)).toBe("−3");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(14)).toBe("14");
  });

  it("adds + only to positive amounts", () => {
    expect(formatSigned(2)).toBe("+2");
    expect(formatSigned(0)).toBe("0");
    expect(formatSigned(-5)).toBe("−5");
  });

  it("pluralizes days", () => {
    expect(formatDays(1)).toBe("1 día");
    expect(formatDays(-1)).toBe("−1 día");
    expect(formatDays(3)).toBe("3 días");
    expect(formatBusinessDays(1)).toBe("1 día hábil");
    expect(formatBusinessDays(2)).toBe("2 días hábiles");
  });
});
