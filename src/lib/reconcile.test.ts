import { describe, it, expect } from "vitest";
import { reconcileMonth } from "./reconcile";
import type { GrossRate, Payslip, Shift } from "./types";

const rates: GrossRate[] = [{ effectiveFrom: "2026-01-01", rate: 15 }];

function worked(date: string, hours: number, grossRate?: number): Shift {
  return {
    date,
    station: "BAR",
    shiftType: "closing",
    openEnd: false,
    crossesMidnight: false,
    status: "worked",
    actualHours: hours,
    grossRate,
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const juneSlip: Payslip = { month: "2026-06", totalGross: 300, totalHours: 20, totalNet: 240 };

describe("reconcileMonth", () => {
  it("reports agreement when logged hours × rate match the slip", () => {
    const shifts = [worked("2026-06-05", 10), worked("2026-06-12", 10)];
    const r = reconcileMonth("2026-06", shifts, rates, [juneSlip])!;
    expect(r.discrepant).toBe(false);
    expect(r.derivedGross).toBeCloseTo(300);
    expect(r.derivedNet).toBeCloseTo(240); // slip factor 0.8 applied
    expect(r.deltaGross).toBeCloseTo(0);
    expect(r.deltaHours).toBeCloseTo(0);
  });

  it("flags a missed shift with signed deltas on hours, brutto and netto", () => {
    const shifts = [worked("2026-06-05", 10)]; // second 10h shift never logged
    const r = reconcileMonth("2026-06", shifts, rates, [juneSlip])!;
    expect(r.discrepant).toBe(true);
    expect(r.deltaHours).toBeCloseTo(-10);
    expect(r.deltaGross).toBeCloseTo(-150);
    expect(r.deltaNet).toBeCloseTo(-120); // −150 × 0.8
  });

  it("stays quiet inside the € tolerance (rounding noise)", () => {
    const slip: Payslip = { month: "2026-06", totalGross: 150.5, totalHours: 10, totalNet: 120 };
    const r = reconcileMonth("2026-06", [worked("2026-06-05", 10)], rates, [slip])!;
    expect(r.deltaGross).toBeCloseTo(-0.5);
    expect(r.discrepant).toBe(false);
  });

  it("returns null without a payslip for the month", () => {
    expect(reconcileMonth("2026-05", [worked("2026-05-05", 10)], rates, [juneSlip])).toBeNull();
  });

  it("returns null when nothing worked is logged in the month", () => {
    const planned: Shift = { ...worked("2026-06-05", 10), status: "planned" };
    expect(reconcileMonth("2026-06", [planned], rates, [juneSlip])).toBeNull();
  });

  it("returns null for a zero-gross slip (nothing to compare against)", () => {
    const slip: Payslip = { month: "2026-06", totalGross: 0, totalHours: 0, totalNet: 0 };
    expect(reconcileMonth("2026-06", [worked("2026-06-05", 10)], rates, [slip])).toBeNull();
  });

  it("prefers the shift's own rate snapshot over the rate table", () => {
    const r = reconcileMonth("2026-06", [worked("2026-06-05", 10, 14.5)], rates, [juneSlip])!;
    expect(r.derivedGross).toBeCloseTo(145);
  });

  it("ignores shifts from other months", () => {
    const shifts = [worked("2026-06-05", 10), worked("2026-06-12", 10), worked("2026-07-01", 8)];
    const r = reconcileMonth("2026-06", shifts, rates, [juneSlip])!;
    expect(r.loggedShifts).toBe(2);
    expect(r.derivedGross).toBeCloseTo(300);
  });
});
