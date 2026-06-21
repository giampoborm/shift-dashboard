import { describe, expect, it } from "vitest";
import {
  blendedNetFactor,
  parseNum,
  payslipNetFactor,
  sortPayslips,
  sortRates,
  validatePayslip,
  validateRate,
  validateSettings,
} from "./settingsStore";
import type { GrossRate, Payslip, Settings } from "./types";

const GOOD_SETTINGS: Settings = {
  userName: "Gianpaolo",
  tipPoolRate: 0.05,
  closingTime: "01:00",
  vacationWerktage: 24,
  recencyHalfLifeDays: 45,
};

describe("parseNum", () => {
  it("parses plain and comma decimals, rejects junk", () => {
    expect(parseNum("14.5")).toBe(14.5);
    expect(parseNum("14,5")).toBe(14.5);
    expect(parseNum("  60 ")).toBe(60);
    expect(parseNum("")).toBeNull();
    expect(parseNum("abc")).toBeNull();
  });
});

describe("validateSettings", () => {
  it("accepts good settings", () => {
    expect(validateSettings(GOOD_SETTINGS)).toEqual([]);
  });
  it("rejects out-of-range tip pool rate", () => {
    expect(validateSettings({ ...GOOD_SETTINGS, tipPoolRate: 1 })).toHaveLength(1);
    expect(validateSettings({ ...GOOD_SETTINGS, tipPoolRate: -0.1 })).toHaveLength(1);
  });
  it("rejects bad closing time and empty name", () => {
    expect(validateSettings({ ...GOOD_SETTINGS, closingTime: "25:00" })).toHaveLength(1);
    expect(validateSettings({ ...GOOD_SETTINGS, closingTime: "1am" })).toHaveLength(1);
    expect(validateSettings({ ...GOOD_SETTINGS, userName: "  " })).toHaveLength(1);
  });
  it("rejects non-positive Werktage", () => {
    expect(validateSettings({ ...GOOD_SETTINGS, vacationWerktage: 0 })).toHaveLength(1);
  });
  it("accepts 0 recency half-life but rejects negatives", () => {
    expect(validateSettings({ ...GOOD_SETTINGS, recencyHalfLifeDays: 0 })).toEqual([]);
    expect(validateSettings({ ...GOOD_SETTINGS, recencyHalfLifeDays: -5 })).toHaveLength(1);
  });
});

describe("validateRate", () => {
  it("accepts a good rate", () => {
    expect(validateRate({ effectiveFrom: "2026-04-01", rate: 15.5 })).toEqual([]);
  });
  it("rejects bad date and non-positive rate", () => {
    expect(validateRate({ effectiveFrom: "2026-13-01", rate: 15.5 })).toHaveLength(1);
    expect(validateRate({ effectiveFrom: "2026-04-01", rate: 0 })).toHaveLength(1);
    expect(validateRate({ effectiveFrom: "April", rate: -1 })).toHaveLength(2);
  });
});

describe("validatePayslip", () => {
  it("accepts a real payslip", () => {
    expect(validatePayslip({ month: "2026-04", totalGross: 1371.75, totalHours: 88.5, totalNet: 1074.84 })).toEqual([]);
  });
  it("rejects net above gross (would push net factor > 1)", () => {
    const errs = validatePayslip({ month: "2026-04", totalGross: 100, totalHours: 10, totalNet: 120 });
    expect(errs.some((e) => /Net cannot exceed gross/.test(e))).toBe(true);
  });
  it("rejects bad month and non-positive amounts", () => {
    expect(validatePayslip({ month: "2026-4", totalGross: 100, totalHours: 10, totalNet: 80 })).toHaveLength(1);
    expect(validatePayslip({ month: "2026-04", totalGross: 0, totalHours: 0, totalNet: -1 })).toHaveLength(3);
  });
});

describe("sorting", () => {
  it("sorts rates oldest-first without mutating input", () => {
    const input: GrossRate[] = [
      { effectiveFrom: "2026-04-01", rate: 15.5 },
      { effectiveFrom: "2026-01-01", rate: 14.5 },
    ];
    expect(sortRates(input).map((r) => r.effectiveFrom)).toEqual(["2026-01-01", "2026-04-01"]);
    expect(input[0].effectiveFrom).toBe("2026-04-01"); // unchanged
  });
  it("sorts payslips oldest-first", () => {
    const input: Payslip[] = [
      { month: "2026-05", totalGross: 1, totalHours: 1, totalNet: 1 },
      { month: "2026-02", totalGross: 1, totalHours: 1, totalNet: 1 },
    ];
    expect(sortPayslips(input).map((p) => p.month)).toEqual(["2026-02", "2026-05"]);
  });
});

describe("net factor previews", () => {
  it("computes per-payslip net factor", () => {
    expect(payslipNetFactor({ month: "2026-02", totalGross: 1931.4, totalHours: 133.2, totalNet: 1437.59 }))
      .toBeCloseTo(0.7443, 3);
    expect(payslipNetFactor({ month: "x", totalGross: 0, totalHours: 0, totalNet: 0 })).toBeNull();
  });
  it("blends across all payslips and is null when empty", () => {
    const slips: Payslip[] = [
      { month: "2026-02", totalGross: 1000, totalHours: 100, totalNet: 750 },
      { month: "2026-03", totalGross: 1000, totalHours: 100, totalNet: 770 },
    ];
    expect(blendedNetFactor(slips)).toBeCloseTo(0.76, 5); // (750+770)/2000
    expect(blendedNetFactor([])).toBeNull();
  });
});
