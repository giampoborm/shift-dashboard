import { describe, it, expect } from "vitest";
import { vacationCosts, vacationPayForMonth } from "./vacationPayroll";
import type { ChargeModel } from "./vacationCharge";
import type { GrossRate, Payslip, Vacation } from "./types";

/** 28 h a week, spread over the Tue–Sun he could be rostered on. */
const MODEL: ChargeModel = { weeklyHours: 28, eligibleWeekdays: [0, 2, 3, 4, 5, 6], dayHours: 6 };

const RATES: GrossRate[] = [{ effectiveFrom: "2026-01-01", rate: 15.5 }];
// net factor 0.75 — a round number so the arithmetic below is readable.
const PAYSLIPS: Payslip[] = [
  { month: "2026-08", totalGross: 2000, totalHours: 130, totalNet: 1500 },
  { month: "2026-09", totalGross: 2000, totalHours: 130, totalNet: 1500 },
];
const SETTINGS = { vacationPayrollDays: 20 };

function vacation(from: string, to: string, extra: Partial<Vacation> = {}): Vacation {
  return { from, to, werktage: 0, scheduledCost: 0, createdAt: "now", ...extra };
}

describe("vacationCosts", () => {
  it("prices only the entitlement-covered days, never the unpaid ones", () => {
    const vacs = [vacation("2026-08-03", "2026-08-09", { id: 1 })]; // 28 h -> 5 days
    const generous = vacationCosts(vacs, MODEL, SETTINGS, RATES, PAYSLIPS).get(1)!;
    expect(generous.days).toBe(5);
    expect(generous.paidDays).toBe(5);
    expect(generous.net).toBeCloseTo(5 * 6 * 15.5 * 0.75, 5);

    // Same range, but only 2 days of entitlement remain for the whole year.
    const broke = vacationCosts(
      vacs,
      MODEL,
      { vacationPayrollDays: 2 },
      RATES,
      PAYSLIPS,
    ).get(1)!;
    expect(broke.days).toBe(5); // still 5 days off
    expect(broke.paidDays).toBe(2);
    expect(broke.unpaidDays).toBe(3);
    expect(broke.net).toBeCloseTo(2 * 6 * 15.5 * 0.75, 5); // and only 2 are paid
  });

  it("lets an earlier vacation eat the budget first", () => {
    const vacs = [
      vacation("2026-07-07", "2026-07-13", { id: 1 }),
      vacation("2026-08-03", "2026-08-09", { id: 2 }),
    ];
    const costs = vacationCosts(vacs, MODEL, { vacationPayrollDays: 6 }, RATES, PAYSLIPS);
    expect(costs.get(1)!.paidDays).toBe(5);
    expect(costs.get(2)!.paidDays).toBe(1);
    expect(costs.get(2)!.unpaidDays).toBe(4);
  });

  it("reports a finished vacation's saved day count, capping its paid part", () => {
    const vacs = [vacation("2026-07-07", "2026-07-13", { id: 1, payrollDays: 3 })];
    const costs = vacationCosts(vacs, MODEL, SETTINGS, RATES, PAYSLIPS, "2026-09-07");
    expect(costs.get(1)!.days).toBe(3); // what payroll actually charged, not the model's 5
    expect(costs.get(1)!.paidDays).toBe(3); // never more than the snapshot
    // With no "today" to say what has been paid, the snapshot is still the safe answer.
    expect(vacationCosts(vacs, MODEL, SETTINGS, RATES, PAYSLIPS).get(1)!.days).toBe(3);
  });

  it("re-estimates a vacation that hasn't happened yet", () => {
    const vacs = [vacation("2026-12-01", "2026-12-07", { id: 1, payrollDays: 99 })];
    expect(vacationCosts(vacs, MODEL, SETTINGS, RATES, PAYSLIPS, "2026-09-07").get(1)!.days).toBe(5);
  });
});

describe("vacationPayForMonth", () => {
  const vacs = [vacation("2026-08-03", "2026-08-11", { id: 1 })]; // 35 h -> 6 days

  it("estimates forward from the model when no slip records the month", () => {
    const m = vacationPayForMonth("2026-08", vacs, MODEL, SETTINGS, RATES, PAYSLIPS, "2026-08-01");
    expect(m.observed).toBe(false);
    expect(m.days).toBe(6);
    expect(m.hours).toBeCloseTo(36, 5);
    expect(m.projected.net).toBeCloseTo(36 * 15.5 * 0.75, 5); // all still ahead
    expect(m.banked.net).toBeCloseTo(0, 5);
  });

  it("banks the whole amount and reports no unpaid days once the slip is in", () => {
    const slips: Payslip[] = [
      { ...PAYSLIPS[0], vacationDays: 6, vacationHours: 36 },
      PAYSLIPS[1],
    ];
    const m = vacationPayForMonth("2026-08", vacs, MODEL, SETTINGS, RATES, slips, "2026-09-07");
    expect(m.observed).toBe(true);
    expect(m.days).toBe(6);
    expect(m.hours).toBe(36);
    // The slip settled this month, so the estimate's unpaid guess must not leak out.
    expect(m.unpaidDays).toBe(0);
    expect(m.projected.net).toBe(0);
    expect(m.banked.net).toBeCloseTo(36 * 15.5 * 0.75, 5);
  });

  it("uses the saved day count for a past vacation, not a fresh estimate", () => {
    // The Home month line's bug: August was recorded as 6 days, but with no
    // vacation figures on the slip the month re-derived it from the roster and
    // showed 5 / 30 h while every other surface said 6 / 36.
    const recorded = [vacation("2026-08-03", "2026-08-11", { id: 1, payrollDays: 6 })];
    const m = vacationPayForMonth(
      "2026-08",
      recorded,
      // Logged hours that have drifted since — the model alone would now say 3 days.
      { ...MODEL, weeklyHours: 14 },
      SETTINGS,
      RATES,
      PAYSLIPS,
      "2026-09-07",
    );
    expect(m.days).toBe(6);
    expect(m.hours).toBe(36);
  });

  it("splits banked from projected by hours when today falls mid-vacation", () => {
    const m = vacationPayForMonth("2026-08", vacs, MODEL, SETTINGS, RATES, PAYSLIPS, "2026-08-06");
    expect(m.banked.net + m.projected.net).toBeCloseTo(36 * 15.5 * 0.75, 5);
    expect(m.banked.net).toBeGreaterThan(0);
    expect(m.projected.net).toBeGreaterThan(0);
  });

  it("pays nothing for a month whose days are all past the entitlement", () => {
    const m = vacationPayForMonth(
      "2026-08",
      vacs,
      MODEL,
      { vacationPayrollDays: 0 },
      RATES,
      PAYSLIPS,
      "2026-09-07",
    );
    expect(m.days).toBe(6);
    expect(m.unpaidDays).toBe(6);
    expect(m.hours).toBe(0);
    expect(m.banked.net + m.projected.net).toBe(0);
  });
});
