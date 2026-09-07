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

describe("reconcileMonth with sick days", () => {
  it("counts a sick day's continued wage — payroll pays it, so the slip includes it", () => {
    const sick: Shift = { ...worked("2026-06-19", 10), status: "sick" };
    const shifts = [worked("2026-06-05", 10), sick];
    const r = reconcileMonth("2026-06", shifts, rates, [juneSlip])!;
    expect(r.loggedShifts).toBe(2);
    expect(r.loggedHours).toBeCloseTo(20);
    expect(r.derivedGross).toBeCloseTo(300);
    expect(r.discrepant).toBe(false); // would flag a false €150 gap if sick were dropped
  });
});

describe("reconcileMonth — paid vacation", () => {
  // August 2026 for real: 90,30 h worked + 36,00 h Urlaub = the slip's 126,30 h.
  // Without the vacation line the month reads as short by exactly 36 h / €558.
  const slip: Payslip = {
    month: "2026-08",
    totalGross: 1957.65,
    totalHours: 126.3,
    totalNet: 1453.33,
  };
  const augRates: GrossRate[] = [{ effectiveFrom: "2026-04-01", rate: 15.5 }];
  const august: Shift[] = [worked("2026-08-12", 90.3, 15.5)];
  const vacation = { days: 6, hours: 36, gross: 558 };

  it("closes the gap that the Urlaub line accounts for", () => {
    const r = reconcileMonth("2026-08", august, augRates, [slip], vacation)!;
    expect(r.loggedHours).toBeCloseTo(126.3, 2);
    expect(r.derivedGross).toBeCloseTo(1957.65, 2);
    expect(r.deltaHours).toBeCloseTo(0, 2);
    expect(r.discrepant).toBe(false);
    expect(r.vacationDays).toBe(6);
    expect(r.vacationHours).toBe(36);
  });

  it("reports a false 36 h shortfall when vacation is ignored", () => {
    const r = reconcileMonth("2026-08", august, augRates, [slip])!;
    expect(r.deltaHours).toBeCloseTo(-36, 2);
    expect(r.discrepant).toBe(true);
  });

  it("reconciles a month that is nothing but vacation", () => {
    const r = reconcileMonth("2026-08", [], augRates, [
      { month: "2026-08", totalGross: 558, totalHours: 36, totalNet: 414 },
    ], vacation)!;
    expect(r).not.toBeNull();
    expect(r.loggedShifts).toBe(0);
    expect(r.discrepant).toBe(false);
  });

  it("still returns null for a month with neither shifts nor vacation", () => {
    expect(reconcileMonth("2026-08", [], augRates, [slip])).toBeNull();
  });
});

describe("reconcileMonth — discrepancy attribution", () => {
  // 20 h logged + 6 vacation days x 6 h = 36 h -> 56 h x €15 = €840.
  const augSlip: Payslip = { month: "2026-08", totalGross: 840, totalHours: 56, totalNet: 672 };
  const shifts = [worked("2026-08-14", 10), worked("2026-08-15", 10)];
  const vac = { days: 6, hours: 36, gross: 540, observed: true, expectedDays: 6 };

  it("blames nothing when the rule and the slip agree", () => {
    const r = reconcileMonth("2026-08", shifts, rates, [augSlip], vac)!;
    expect(r.discrepant).toBe(false);
    expect(r.cause).toBe("none");
    expect(r.ruleStale).toBe(false);
    expect(r.vacationObserved).toBe(true);
    expect(r.vacationDaysExpected).toBe(6);
  });

  it("catches a stale counting rule even though the money reconciles", () => {
    // The slip charged 7 days where the rule predicted 6. Because vacation pay now
    // takes its figures FROM the slip, the euros agree perfectly — so this is the
    // case that would go unnoticed without a staleness flag of its own.
    const slip: Payslip = { month: "2026-08", totalGross: 930, totalHours: 62, totalNet: 744 };
    const r = reconcileMonth("2026-08", shifts, rates, [slip], {
      days: 7,
      hours: 42,
      gross: 630,
      observed: true,
      expectedDays: 6,
    })!;
    expect(r.discrepant).toBe(false);
    expect(r.cause).toBe("none");
    expect(r.ruleStale).toBe(true);
    expect(r.needsAttention).toBe(true);
  });

  it("blames the rule ahead of hours when both are off", () => {
    const slip: Payslip = { month: "2026-08", totalGross: 930, totalHours: 62, totalNet: 744 };
    const r = reconcileMonth("2026-08", [worked("2026-08-14", 10)], rates, [slip], {
      days: 7,
      hours: 42,
      gross: 630,
      observed: true,
      expectedDays: 6,
    })!;
    expect(r.discrepant).toBe(true);
    expect(r.cause).toBe("vacation-rule");
  });

  it("blames hours for a missed shift, not the vacation rule", () => {
    const r = reconcileMonth("2026-08", [worked("2026-08-14", 10)], rates, [augSlip], vac)!;
    expect(r.discrepant).toBe(true);
    expect(r.ruleStale).toBe(false);
    expect(r.cause).toBe("hours");
  });

  it("cannot call the rule stale from a prediction alone", () => {
    // Same mismatch, but the slip carried no vacation figure to check against.
    const slip: Payslip = { month: "2026-08", totalGross: 930, totalHours: 62, totalNet: 744 };
    const r = reconcileMonth("2026-08", shifts, rates, [slip], {
      days: 6,
      hours: 36,
      gross: 540,
      expectedDays: 6,
    })!;
    expect(r.vacationObserved).toBe(false);
    expect(r.ruleStale).toBe(false);
    expect(r.cause).toBe("hours");
  });

  it("falls back to unknown when hours match but the money still doesn't", () => {
    // Hours agree exactly; the gap is a bonus or correction the app can't model.
    const slip: Payslip = { month: "2026-08", totalGross: 940, totalHours: 56, totalNet: 752 };
    const r = reconcileMonth("2026-08", shifts, rates, [slip], vac)!;
    expect(r.discrepant).toBe(true);
    expect(r.cause).toBe("unknown");
  });

  it("defaults the new fields when no vacation is passed at all", () => {
    const r = reconcileMonth("2026-06", [worked("2026-06-05", 20)], rates, [juneSlip])!;
    expect(r.vacationObserved).toBe(false);
    expect(r.vacationDaysExpected).toBeNull();
    expect(r.ruleStale).toBe(false);
  });
});

describe("reconcileMonth — needsAttention", () => {
  const juneShifts = [worked("2026-06-05", 10), worked("2026-06-12", 10)];

  it("is quiet when the money and the rule both hold", () => {
    const r = reconcileMonth("2026-06", juneShifts, rates, [juneSlip])!;
    expect(r.needsAttention).toBe(false);
  });

  it("fires on a plain money gap", () => {
    const r = reconcileMonth("2026-06", [worked("2026-06-05", 10)], rates, [juneSlip])!;
    expect(r.needsAttention).toBe(true);
  });
});
