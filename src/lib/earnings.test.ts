import { describe, it, expect } from "vitest";
import {
  computeShiftEarnings,
  netFactorForMonth,
  rateForDate,
  usableTips,
  sumEarnings,
} from "./earnings";
import type { GrossRate, Payslip, Shift } from "./types";

const rates: GrossRate[] = [
  { effectiveFrom: "2026-01-01", rate: 14.5 },
  { effectiveFrom: "2026-04-01", rate: 15.5 },
];

// Real payslips from data/payslips.csv
const payslips: Payslip[] = [
  { month: "2026-02", totalGross: 1931.4, totalHours: 133.2, totalNet: 1437.59 },
  { month: "2026-03", totalGross: 1899.5, totalHours: 131, totalNet: 1418 },
  { month: "2026-04", totalGross: 1371.75, totalHours: 88.5, totalNet: 1074.84 },
  { month: "2026-05", totalGross: 1691.05, totalHours: 109.1, totalNet: 1289.44 },
];

const settings = { tipPoolRate: 0.05 };

function shift(partial: Partial<Shift>): Shift {
  return {
    date: "2026-02-01",
    station: "BAR",
    shiftType: "opening",
    openEnd: false,
    crossesMidnight: false,
    status: "worked",
    source: "test",
    createdAt: "now",
    ...partial,
  };
}

describe("rateForDate", () => {
  it("picks the rate in effect (raise in April)", () => {
    expect(rateForDate("2026-03-31", rates)).toBe(14.5);
    expect(rateForDate("2026-04-01", rates)).toBe(15.5);
    expect(rateForDate("2026-06-14", rates)).toBe(15.5);
  });
  it("returns undefined before any rate", () => {
    expect(rateForDate("2025-12-31", rates)).toBeUndefined();
  });
});

describe("netFactorForMonth", () => {
  it("matches the real February payslip (net/gross)", () => {
    const { factor, estimated } = netFactorForMonth("2026-02", payslips);
    expect(estimated).toBe(false);
    expect(factor!).toBeCloseTo(1437.59 / 1931.4, 6);
    expect(factor!).toBeCloseTo(0.7443, 3);
  });
  it("falls back to aggregate when month missing", () => {
    const { factor, estimated } = netFactorForMonth("2026-09", payslips);
    expect(estimated).toBe(true);
    expect(factor).not.toBeNull();
  });
});

describe("usableTips", () => {
  it("applies the 5% pool cut", () => {
    expect(usableTips(100, 0.05)).toBeCloseTo(95);
  });
});

describe("computeShiftEarnings", () => {
  it("reproduces the Feb 1 grounded row (7h @ 14.5, €38 tips)", () => {
    const e = computeShiftEarnings(
      shift({ date: "2026-02-01", actualHours: 7, tips: 38, grossRate: 14.5 }),
      rates,
      payslips,
      settings,
    );
    expect(e.grossPay).toBeCloseTo(101.5); // matches CSV "stipendio nuovo"
    expect(e.netPay).toBeCloseTo(101.5 * (1437.59 / 1931.4), 4);
    expect(e.usableTips).toBeCloseTo(38 * 0.95);
    expect(e.takeHome).toBeCloseTo(e.netPay + e.usableTips);
    expect(e.workingDays).toBe(1);
    expect(e.tipsPerHour).toBeCloseTo(38 / 7);
  });

  it("counts a midnight-crossing shift as 2 working days", () => {
    const e = computeShiftEarnings(
      shift({ crossesMidnight: true, actualHours: 7.7 }),
      rates,
      payslips,
      settings,
    );
    expect(e.workingDays).toBe(2);
  });

  it("looks up rate from the table when no snapshot present", () => {
    const e = computeShiftEarnings(
      shift({ date: "2026-04-02", actualHours: 7.5, grossRate: undefined }),
      rates,
      payslips,
      settings,
    );
    expect(e.grossPay).toBeCloseTo(7.5 * 15.5);
  });
});

describe("sumEarnings", () => {
  it("aggregates totals across shifts", () => {
    const shifts = [
      shift({ date: "2026-02-01", actualHours: 7, tips: 38, grossRate: 14.5 }),
      shift({ date: "2026-02-05", actualHours: 6.2, tips: 56, grossRate: 14.5 }),
    ];
    const t = sumEarnings(shifts, rates, payslips, settings);
    expect(t.shifts).toBe(2);
    expect(t.hours).toBeCloseTo(13.2);
    expect(t.grossPay).toBeCloseTo(7 * 14.5 + 6.2 * 14.5);
    expect(t.reportedTips).toBe(94);
    expect(t.usableTips).toBeCloseTo(94 * 0.95);
  });
});
