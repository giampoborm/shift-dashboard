import { describe, it, expect } from "vitest";
import { byMonth, byType, monthLabel, takeHomeComposition } from "./charts";
import type { GrossRate, Payslip, Shift } from "./types";

const rates: GrossRate[] = [
  { effectiveFrom: "2026-01-01", rate: 14.5 },
  { effectiveFrom: "2026-04-01", rate: 15.5 },
];
const payslips: Payslip[] = [
  { month: "2026-02", totalGross: 1931.4, totalHours: 133.2, totalNet: 1437.59 },
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

describe("monthLabel", () => {
  it("formats yyyy-MM", () => {
    expect(monthLabel("2026-04")).toBe("Apr '26");
    expect(monthLabel("2026-12")).toBe("Dec '26");
  });
  it("passes through bad input", () => {
    expect(monthLabel("nope")).toBe("nope");
  });
});

describe("byMonth", () => {
  it("groups worked shifts per month, sorted, with tips/hour", () => {
    const shifts = [
      shift({ date: "2026-03-10", actualHours: 5, tips: 20, grossRate: 14.5 }),
      shift({ date: "2026-02-01", actualHours: 7, tips: 38, grossRate: 14.5 }),
      shift({ date: "2026-02-05", actualHours: 3, tips: 12, grossRate: 14.5 }),
    ];
    const rows = byMonth(shifts, rates, payslips, settings);
    expect(rows.map((r) => r.month)).toEqual(["2026-02", "2026-03"]);
    const feb = rows[0];
    expect(feb.shifts).toBe(2);
    expect(feb.hours).toBeCloseTo(10);
    expect(feb.reportedTips).toBe(50);
    expect(feb.usableTips).toBeCloseTo(50 * 0.95);
    expect(feb.tipsPerHour).toBeCloseTo(50 / 10);
    expect(feb.label).toBe("Feb '26");
  });
  it("ignores planned shifts", () => {
    const rows = byMonth([shift({ status: "planned", actualHours: undefined })], rates, payslips, settings);
    expect(rows).toEqual([]);
  });
});

describe("byType", () => {
  it("aggregates per type in canonical order with tips/hour", () => {
    const shifts = [
      shift({ shiftType: "closing", date: "2026-02-02", actualHours: 8, tips: 80, grossRate: 14.5 }),
      shift({ shiftType: "opening", date: "2026-02-01", actualHours: 5, tips: 10, grossRate: 14.5 }),
      shift({ shiftType: "opening", date: "2026-02-03", actualHours: 5, tips: 30, grossRate: 14.5 }),
    ];
    const rows = byType(shifts, rates, payslips, settings);
    expect(rows.map((r) => r.type)).toEqual(["opening", "closing"]);
    const opening = rows[0];
    expect(opening.shifts).toBe(2);
    expect(opening.tipsPerHour).toBeCloseTo(40 / 10);
    const closing = rows[1];
    expect(closing.tipsPerHour).toBeCloseTo(80 / 8);
  });
});

describe("takeHomeComposition", () => {
  it("splits take-home into net wage and usable tips", () => {
    const slices = takeHomeComposition(
      [shift({ date: "2026-02-01", actualHours: 7, tips: 38, grossRate: 14.5 })],
      rates,
      payslips,
      settings,
    );
    expect(slices.map((s) => s.name)).toEqual(["Net wage", "Usable tips"]);
    expect(slices[1].value).toBeCloseTo(38 * 0.95);
  });
  it("omits zero slices", () => {
    const slices = takeHomeComposition(
      [shift({ actualHours: 7, tips: 0, grossRate: 14.5 })],
      rates,
      payslips,
      settings,
    );
    expect(slices.map((s) => s.name)).toEqual(["Net wage"]);
  });
});
