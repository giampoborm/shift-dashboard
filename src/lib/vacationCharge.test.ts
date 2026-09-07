import { describe, it, expect } from "vitest";
import {
  allocateVacations,
  calibrateCharge,
  chargeVacation,
  describeCalibration,
  payrollDaysTakenInYear,
  vacationBudgetUse,
} from "./vacationCharge";
import { buildWeekdayHoursProfile } from "./vacationPay";
import type { Payslip, Shift, Vacation } from "./types";

function shift(date: string, hours: number, status: Shift["status"] = "worked"): Shift {
  return {
    date,
    station: "BAR",
    shiftType: "closing",
    openEnd: false,
    crossesMidnight: false,
    status,
    actualHours: hours,
    tips: 50,
    grossRate: 15.5,
    source: "test",
    createdAt: "now",
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function vacation(from: string, to: string, extra: Partial<Vacation> = {}): Vacation {
  return { from, to, werktage: 0, scheduledCost: 0, createdAt: "now", ...extra };
}

/** The user's real shape: Tue/Wed/Fri/Sat, 7 h each = 28 h a week. */
const REAL_ROSTER = buildWeekdayHoursProfile(
  ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23", "2026-06-30"].flatMap((tue) => [
    shift(tue, 7),
    shift(addDays(tue, 1), 7),
    shift(addDays(tue, 3), 7),
    shift(addDays(tue, 4), 7),
  ]),
);

describe("the hours model", () => {
  it("charges MORE days than shifts missed, because a 7 h shift > a 6 h vacation day", () => {
    // A full week off: 4 shifts missed, but 28 h / 6 = 4.67 -> 5 days charged.
    const c = chargeVacation("2026-08-03", "2026-08-09", REAL_ROSTER, 6);
    expect(c.missedHours).toBeCloseTo(28, 5);
    expect(c.rawDays).toBeCloseTo(28 / 6, 5);
    expect(c.days).toBe(5);
    expect(c.paidHours).toBeCloseTo(30, 5);
  });

  it("reproduces the August 2026 payslip (3–11 Aug: 6,00 Tage / 36,00 STD)", () => {
    const c = chargeVacation("2026-08-03", "2026-08-11", REAL_ROSTER, 6);
    expect(c.missedHours).toBeCloseTo(35, 5); // a week + the trailing Tue's 7 h
    expect(c.days).toBe(6);
    expect(c.paidHours).toBeCloseTo(36, 5);
  });

  it("rounds any part-day UP, as the manager does", () => {
    // Two 7 h shifts = 14 h = 2.33 days -> 3.
    const c = chargeVacation("2026-08-04", "2026-08-05", REAL_ROSTER, 6);
    expect(c.rawDays).toBeCloseTo(14 / 6, 5);
    expect(c.days).toBe(3);
  });

  it("charges nothing for days you'd never have worked", () => {
    // Mon + Thu + Sun: never rostered, so no hours are missed and nothing is charged.
    expect(chargeVacation("2026-08-03", "2026-08-03", REAL_ROSTER, 6).days).toBe(0);
    expect(chargeVacation("2026-08-06", "2026-08-06", REAL_ROSTER, 6).days).toBe(0);
    expect(chargeVacation("2026-08-09", "2026-08-09", REAL_ROSTER, 6).days).toBe(0);
  });

  it("is driven by HOURS, not by which weekdays you're available on", () => {
    // The bug this model replaced: under the old calendar-weekday rule, saying you
    // are also available on Sundays invented an extra paid vacation day. Here the
    // same 28 h spread over 5 days instead of 4 costs exactly the same week off.
    const spreadOver5 = buildWeekdayHoursProfile(
      ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23", "2026-06-30"].flatMap((tue) => [
        shift(tue, 5.6),
        shift(addDays(tue, 1), 5.6),
        shift(addDays(tue, 3), 5.6),
        shift(addDays(tue, 4), 5.6),
        shift(addDays(tue, 5), 5.6), // now Sundays too
      ]),
    );
    const four = chargeVacation("2026-08-03", "2026-08-09", REAL_ROSTER, 6);
    const five = chargeVacation("2026-08-03", "2026-08-09", spreadOver5, 6);
    expect(five.missedHours).toBeCloseTo(four.missedHours, 5);
    expect(five.days).toBe(four.days);
  });

  it("splits at month boundaries and rounds each payslip separately", () => {
    const c = chargeVacation("2026-08-31", "2026-09-06", REAL_ROSTER, 6);
    expect(c.segments.map((s) => s.month)).toEqual(["2026-08", "2026-09"]);
    expect(c.segments[0].days).toBe(0); // Mon 31 Aug alone: no hours
    expect(c.segments[1].days).toBe(5); // Tue–Sun: the usual 28 h
    expect(c.days).toBe(5);
  });

  it("returns nothing for an inverted range", () => {
    expect(chargeVacation("2026-08-10", "2026-08-01", REAL_ROSTER, 6).days).toBe(0);
  });
});

describe("the finite entitlement", () => {
  it("pays only up to the year's budget, then leaves the rest unpaid", () => {
    const vacs = [vacation("2026-08-03", "2026-08-30", { id: 1 })]; // 4 weeks ~ 20 days
    const segs = allocateVacations(vacs, REAL_ROSTER, 6, 8);
    expect(segs.reduce((n, s) => n + s.paidDays, 0)).toBe(8);
    expect(segs.reduce((n, s) => n + s.unpaidDays, 0)).toBeGreaterThan(0);
  });

  it("consumes the budget in DATE order, not insertion order", () => {
    const later = vacation("2026-09-01", "2026-09-07", { id: 1 });
    const earlier = vacation("2026-07-07", "2026-07-13", { id: 2 });
    const segs = allocateVacations([later, earlier], REAL_ROSTER, 6, 5);
    const july = segs.find((s) => s.month === "2026-07")!;
    const sept = segs.find((s) => s.month === "2026-09")!;
    expect(july.paidDays).toBe(5); // typed in second, but it happens first
    expect(sept.paidDays).toBe(0);
  });

  it("gives each calendar year its own budget", () => {
    const vacs = [
      vacation("2026-12-01", "2026-12-28", { id: 1 }),
      vacation("2027-01-05", "2027-01-11", { id: 2 }),
    ];
    const segs = allocateVacations(vacs, REAL_ROSTER, 6, 10);
    expect(segs.filter((s) => s.month.startsWith("2026")).every((s) => s.unpaidDays >= 0)).toBe(true);
    const jan = segs.find((s) => s.month === "2027-01")!;
    expect(jan.paidDays).toBe(jan.days); // the new year starts fresh
  });
});

describe("vacationBudgetUse", () => {
  it("reports what's free before and after a candidate range", () => {
    const others = [vacation("2026-07-07", "2026-07-13", { id: 1 })]; // 5 days
    const use = vacationBudgetUse("2026-08-03", "2026-08-09", others, REAL_ROSTER, 6, 20);
    expect(use.charged).toBe(5);
    expect(use.paid).toBe(5);
    expect(use.unpaid).toBe(0);
    expect(use.availableBefore).toBe(15);
    expect(use.availableAfter).toBe(10);
  });

  it("flags the part of a range the entitlement no longer covers", () => {
    const others = [vacation("2026-07-07", "2026-07-13", { id: 1 })]; // 5 days
    const use = vacationBudgetUse("2026-08-03", "2026-08-09", others, REAL_ROSTER, 6, 7);
    expect(use.charged).toBe(5);
    expect(use.paid).toBe(2);
    expect(use.unpaid).toBe(3);
  });
});

describe("payrollDaysTakenInYear", () => {
  const past = vacation("2026-07-07", "2026-07-13", { id: 1, payrollDays: 9 }); // odd on purpose
  const future = vacation("2026-12-01", "2026-12-07", { id: 2, payrollDays: 99 });

  it("keeps a finished vacation's snapshot — a paid month is never re-costed", () => {
    expect(payrollDaysTakenInYear([past], 2026, REAL_ROSTER, 6, "2026-09-07")).toBe(9);
  });

  it("re-estimates a vacation that hasn't happened yet", () => {
    expect(payrollDaysTakenInYear([future], 2026, REAL_ROSTER, 6, "2026-09-07")).toBe(5);
  });

  it("prefers the snapshot when the caller can't say when 'now' is", () => {
    expect(payrollDaysTakenInYear([future], 2026, REAL_ROSTER, 6)).toBe(99);
  });
});

describe("calibrateCharge", () => {
  const august = vacation("2026-08-03", "2026-08-11", { id: 1 });
  const slip = (extra: Partial<Payslip>): Payslip => ({
    month: "2026-08",
    totalGross: 2000,
    totalHours: 130,
    totalNet: 1500,
    ...extra,
  });

  it("confirms the model when it reproduces the slip's day count", () => {
    const cal = calibrateCharge(
      [slip({ vacationDays: 6, vacationHours: 36 })],
      [august],
      REAL_ROSTER,
      6,
    );
    expect(cal.usable).toBe(1);
    expect(cal.matches).toBe(true);
    expect(cal.dayHours).toBe(6);
    expect(cal.weeklyHours).toBeCloseTo(28, 5);
    // 36 h over 9 calendar days away implies payroll costed him at 28 h/week.
    expect(cal.impliedWeeklyHours).toBeCloseTo(28, 5);
    expect(describeCalibration(cal)).toMatch(/Matches 1 payslip/);
  });

  it("flags a mismatch when the roster no longer explains the slip", () => {
    const cal = calibrateCharge(
      [slip({ vacationDays: 8, vacationHours: 48 })],
      [august],
      REAL_ROSTER,
      6,
    );
    expect(cal.matches).toBe(false);
    expect(describeCalibration(cal)).toMatch(/charged 8 days/);
  });

  it("says nothing about a slip whose vacation was never recorded", () => {
    const cal = calibrateCharge([slip({ vacationDays: 6, vacationHours: 36 })], [], REAL_ROSTER, 6);
    expect(cal.usable).toBe(0);
    expect(cal.matches).toBe(true); // no evidence is not counter-evidence
    expect(describeCalibration(cal)).toMatch(/Not checked/);
  });

  it("notices payslips that disagree about the flat day length", () => {
    const cal = calibrateCharge(
      [
        slip({ vacationDays: 6, vacationHours: 36 }),
        slip({ month: "2026-09", vacationDays: 2, vacationHours: 16 }),
      ],
      [august],
      REAL_ROSTER,
      6,
    );
    expect(cal.dayHoursConflict).toBe(true);
    expect(cal.dayHours).toBeNull();
  });
});
