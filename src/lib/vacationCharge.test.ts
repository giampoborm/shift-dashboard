import { describe, it, expect } from "vitest";
import {
  allocateVacations,
  calibrateCharge,
  chargeVacation,
  describeCalibration,
  describeEligibleWeekdays,
  eligibleDaysInRange,
  hoursPerEligibleDay,
  payrollDaysTakenInYear,
  vacationBudgetUse,
  type ChargeModel,
} from "./vacationCharge";
import { buildRosterHours } from "./vacationPay";
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

/** Tue–Sun: the venue is shut Mondays. */
const ELIGIBLE = [0, 2, 3, 4, 5, 6];
/** His real shape: 4 shifts of 7 h a week = 28 h. */
const MODEL: ChargeModel = { weeklyHours: 28, eligibleWeekdays: ELIGIBLE, dayHours: 6 };

describe("the charge model", () => {
  it("spreads a week's hours across the eligible days", () => {
    expect(hoursPerEligibleDay(MODEL)).toBeCloseTo(28 / 6, 5); // 4.67 h
    expect(hoursPerEligibleDay({ ...MODEL, eligibleWeekdays: [2, 3, 4, 5, 6] })).toBeCloseTo(5.6, 5);
    expect(hoursPerEligibleDay({ ...MODEL, eligibleWeekdays: [] })).toBe(0);
  });

  it("counts only the eligible days in a range", () => {
    // Mon 3 – Tue 11 Aug: 9 calendar days, both Mondays skipped.
    expect(eligibleDaysInRange("2026-08-03", "2026-08-11", ELIGIBLE)).toBe(7);
    expect(eligibleDaysInRange("2026-08-03", "2026-08-03", ELIGIBLE)).toBe(0); // a Monday
    expect(eligibleDaysInRange("2026-08-11", "2026-08-03", ELIGIBLE)).toBe(0); // inverted
  });

  it("reproduces the August 2026 payslip (3–11 Aug: 6,00 Tage / 36,00 STD)", () => {
    const c = chargeVacation("2026-08-03", "2026-08-11", MODEL);
    expect(c.eligibleDays).toBe(7);
    expect(c.missedHours).toBeCloseTo(32.67, 2); // 7 x 4.67
    expect(c.rawDays).toBeCloseTo(5.44, 2);
    expect(c.days).toBe(6);
    expect(c.paidHours).toBeCloseTo(36, 5);
  });

  it("charges more days than shifts missed — a 7 h shift outlasts a 6 h vacation day", () => {
    const c = chargeVacation("2026-08-03", "2026-08-09", MODEL); // a full week
    expect(c.missedHours).toBeCloseTo(28, 5);
    expect(c.days).toBe(5); // 4.67 rounded up, not the 4 shifts he'd miss
  });

  it("rounds any part-day UP, as the manager does", () => {
    const c = chargeVacation("2026-08-04", "2026-08-05", MODEL); // Tue + Wed
    expect(c.rawDays).toBeCloseTo(9.33 / 6, 2);
    expect(c.days).toBe(2);
  });

  it("charges nothing for a day you could never have been rostered", () => {
    expect(chargeVacation("2026-08-03", "2026-08-03", MODEL).days).toBe(0); // Monday
  });

  it("is barely moved by widening eligibility — the count is on both sides of the ÷", () => {
    // The bug that killed model 1: ticking "Sunday" conjured an extra paid day.
    // Here the same range costs 6 days whether you spread over 5, 6 or 7 weekdays.
    const five = chargeVacation("2026-08-03", "2026-08-11", {
      ...MODEL,
      eligibleWeekdays: [2, 3, 4, 5, 6],
    });
    const seven = chargeVacation("2026-08-03", "2026-08-11", {
      ...MODEL,
      eligibleWeekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(five.days).toBe(6);
    expect(seven.days).toBe(6);
    expect(chargeVacation("2026-08-03", "2026-08-11", MODEL).days).toBe(6);
  });

  it("still counts the day you come back on, however rarely you work that weekday", () => {
    // The bug that killed model 2: a per-weekday historical profile scored an
    // irregular Tuesday near zero, so the returning Tue 11 Aug added nothing and
    // the range came out at 5 days. Eligibility, not history, decides here.
    const week = chargeVacation("2026-08-03", "2026-08-09", MODEL);
    const weekPlusTuesday = chargeVacation("2026-08-03", "2026-08-11", MODEL);
    expect(weekPlusTuesday.eligibleDays).toBe(week.eligibleDays + 1);
    expect(weekPlusTuesday.days).toBe(week.days + 1);
  });

  it("splits at month boundaries and rounds each payslip separately", () => {
    const c = chargeVacation("2026-08-31", "2026-09-06", MODEL);
    expect(c.segments.map((s) => s.month)).toEqual(["2026-08", "2026-09"]);
    expect(c.segments[0].days).toBe(0); // Mon 31 Aug alone: not an eligible day
    expect(c.segments[1].days).toBe(5); // Tue–Sun: the usual 28 h
    expect(c.days).toBe(5);
  });

  it("returns nothing for an inverted range or a zero-length day", () => {
    expect(chargeVacation("2026-08-10", "2026-08-01", MODEL).days).toBe(0);
    expect(chargeVacation("2026-08-03", "2026-08-11", { ...MODEL, dayHours: 0 }).days).toBe(0);
  });
});

describe("describeEligibleWeekdays", () => {
  it("names a contiguous run in Monday-first reading order", () => {
    expect(describeEligibleWeekdays(ELIGIBLE)).toBe("Tue–Sun");
    expect(describeEligibleWeekdays([2, 3, 4, 5, 6])).toBe("Tue–Sat");
    expect(describeEligibleWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(describeEligibleWeekdays([2, 5])).toBe("Tue, Fri");
    expect(describeEligibleWeekdays([])).toBe("no days");
  });
});

describe("buildRosterHours", () => {
  const weeks = ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23", "2026-06-30"];
  const history = weeks.flatMap((tue) => [
    shift(tue, 7),
    shift(addDays(tue, 1), 7),
    shift(addDays(tue, 3), 7),
    shift(addDays(tue, 4), 7),
  ]);

  it("derives weekly hours from the observation window", () => {
    const r = buildRosterHours(history);
    expect(r.days).toBe(20);
    expect(r.weeklyHours).toBeGreaterThan(26);
    expect(r.weeklyHours).toBeLessThan(31);
  });

  it("counts a sick day at the roster mean rather than as a free day", () => {
    const withSick = [...history.slice(0, -1), shift(addDays(weeks[4], 4), 0, "sick")];
    expect(buildRosterHours(withSick).hours).toBeCloseTo(buildRosterHours(history).hours, 5);
  });

  it("erases vacation days from hours AND window, so time off doesn't shrink it", () => {
    const away = new Set(["2026-06-16", "2026-06-17", "2026-06-19", "2026-06-20"]);
    const gapped = history.filter((s) => !away.has(s.date));
    expect(buildRosterHours(gapped).weeklyHours).toBeLessThan(
      buildRosterHours(gapped, away).weeklyHours,
    );
  });

  it("returns zeroes for an empty history", () => {
    expect(buildRosterHours([]).weeklyHours).toBe(0);
  });
});

describe("the finite entitlement", () => {
  it("pays only up to the year's budget, then leaves the rest unpaid", () => {
    const segs = allocateVacations([vacation("2026-08-03", "2026-08-30", { id: 1 })], MODEL, 8);
    expect(segs.reduce((n, s) => n + s.paidDays, 0)).toBe(8);
    expect(segs.reduce((n, s) => n + s.unpaidDays, 0)).toBeGreaterThan(0);
  });

  it("consumes the budget in DATE order, not insertion order", () => {
    const later = vacation("2026-09-01", "2026-09-07", { id: 1 });
    const earlier = vacation("2026-07-07", "2026-07-13", { id: 2 });
    const segs = allocateVacations([later, earlier], MODEL, 5);
    expect(segs.find((s) => s.month === "2026-07")!.paidDays).toBe(5);
    expect(segs.find((s) => s.month === "2026-09")!.paidDays).toBe(0);
  });

  it("gives each calendar year its own budget", () => {
    const segs = allocateVacations(
      [
        vacation("2026-12-01", "2026-12-28", { id: 1 }),
        vacation("2027-01-05", "2027-01-11", { id: 2 }),
      ],
      MODEL,
      10,
    );
    const jan = segs.find((s) => s.month === "2027-01")!;
    expect(jan.paidDays).toBe(jan.days);
  });

  it("uses a finished vacation's saved count instead of re-deriving it", () => {
    const vacs = [vacation("2026-07-07", "2026-07-13", { id: 1, payrollDays: 3 })];
    const segs = allocateVacations(vacs, MODEL, 20, "2026-09-07");
    expect(segs.reduce((n, s) => n + s.days, 0)).toBe(3); // not the model's 5
    expect(segs.every((s) => s.fromSnapshot)).toBe(true);
  });
});

describe("vacationBudgetUse", () => {
  const others = [vacation("2026-07-07", "2026-07-13", { id: 1 })]; // 5 days

  it("reports what's free before and after a candidate range", () => {
    const use = vacationBudgetUse("2026-08-03", "2026-08-09", others, MODEL, 20);
    expect(use.charged).toBe(5);
    expect(use.paid).toBe(5);
    expect(use.availableBefore).toBe(15);
    expect(use.availableAfter).toBe(10);
  });

  it("flags the part of a range the entitlement no longer covers", () => {
    const use = vacationBudgetUse("2026-08-03", "2026-08-09", others, MODEL, 7);
    expect(use.paid).toBe(2);
    expect(use.unpaid).toBe(3);
  });
});

describe("payrollDaysTakenInYear", () => {
  const past = vacation("2026-07-07", "2026-07-13", { id: 1, payrollDays: 9 });
  const future = vacation("2026-12-01", "2026-12-07", { id: 2, payrollDays: 99 });

  it("keeps a finished vacation's snapshot — a paid month is never re-costed", () => {
    expect(payrollDaysTakenInYear([past], 2026, MODEL, "2026-09-07")).toBe(9);
  });

  it("re-estimates a vacation that hasn't happened yet", () => {
    expect(payrollDaysTakenInYear([future], 2026, MODEL, "2026-09-07")).toBe(5);
  });

  it("prefers the snapshot when the caller can't say when 'now' is", () => {
    expect(payrollDaysTakenInYear([future], 2026, MODEL)).toBe(99);
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
    const cal = calibrateCharge([slip({ vacationDays: 6, vacationHours: 36 })], [august], MODEL);
    expect(cal.usable).toBe(1);
    expect(cal.matches).toBe(true);
    expect(cal.dayHours).toBe(6);
    // Inverting the rule: 36 h x 6 eligible/week ÷ 7 eligible days away.
    expect(cal.impliedWeeklyHours).toBeCloseTo((36 * 6) / 7, 5);
    expect(describeCalibration(cal)).toMatch(/Matches 1 payslip/);
  });

  it("flags a mismatch when the logged hours no longer explain the slip", () => {
    const thin = { ...MODEL, weeklyHours: 14 }; // half the hours -> 3 days
    const cal = calibrateCharge([slip({ vacationDays: 6, vacationHours: 36 })], [august], thin);
    expect(cal.matches).toBe(false);
    expect(cal.misses.map((c) => c.month)).toEqual(["2026-08"]);
    expect(describeCalibration(cal)).toMatch(/payroll charged 6 days/);
  });

  it("blames neither side — one payslip can't say which is off", () => {
    const thin = { ...MODEL, weeklyHours: 14 };
    const cal = calibrateCharge([slip({ vacationDays: 6, vacationHours: 36 })], [august], thin);
    expect(describeCalibration(cal)).not.toMatch(/log|your hours|probably/i);
  });

  it("spots payroll pricing a vacation at the CONTRACT week, not the real one", () => {
    // 20 payroll days x 6 h ÷ (24 Werktage / 6 = 4 weeks) = 30 h/week — a figure
    // that owes nothing to what he actually worked. The August slip's 36 h over 7
    // eligible days implies 30.9, which lands on it; his log says 25.5.
    const ENT = { vacationPayrollDays: 20, vacationWerktage: 24 };
    const logged = { ...MODEL, weeklyHours: 25.5 };
    const cal = calibrateCharge(
      [slip({ vacationDays: 6, vacationHours: 36 })],
      [august],
      logged,
      ENT,
    );
    expect(cal.entitlementWeeklyHours).toBeCloseTo(30, 5);
    expect(cal.impliedWeeklyHours).toBeCloseTo((36 * 6) / 7, 5); // 30.86
    expect(cal.impliedIsContractual).toBe(true);
  });

  it("doesn't cry 'contractual' when the roster already explains the slip", () => {
    const ENT = { vacationPayrollDays: 20, vacationWerktage: 24 };
    const cal = calibrateCharge(
      [slip({ vacationDays: 6, vacationHours: 36 })],
      [august],
      { ...MODEL, weeklyHours: 30.5 }, // log and contract agree — nothing to explain
      ENT,
    );
    expect(cal.impliedIsContractual).toBe(false);
  });

  it("has no contract figure to compare against when none is supplied", () => {
    const cal = calibrateCharge([slip({ vacationDays: 6, vacationHours: 36 })], [august], MODEL);
    expect(cal.entitlementWeeklyHours).toBeNull();
    expect(cal.impliedIsContractual).toBe(false);
  });

  it("says nothing about a slip whose vacation was never recorded", () => {
    const cal = calibrateCharge([slip({ vacationDays: 6, vacationHours: 36 })], [], MODEL);
    expect(cal.usable).toBe(0);
    expect(cal.matches).toBe(true); // no evidence is not counter-evidence
    expect(describeCalibration(cal)).toMatch(/Not checked/);
  });

  it("stops grading itself against a slip payroll got wrong", () => {
    // 8/2026: the manager's own message counted 9 days away for an 8-day trip, so
    // his 6 is the wrong answer key. Marking it must silence the check WITHOUT
    // touching the figures — he was still charged 6 days and paid for 36 h.
    const wrong = slip({ vacationDays: 6, vacationHours: 36, vacationDisputed: true });
    const cal = calibrateCharge([wrong], [august], { ...MODEL, weeklyHours: 25.5 });
    expect(cal.disputed).toBe(1);
    expect(cal.usable).toBe(0);
    expect(cal.misses).toEqual([]);
    expect(cal.matches).toBe(true);
    expect(describeCalibration(cal)).toMatch(/set aside as payroll's own error/);
    // The hours-per-day ratio survives: 36 ÷ 6 = 6 h holds however many days
    // payroll thought he was away.
    expect(cal.dayHours).toBe(6);
  });

  it("keeps checking the slips that aren't disputed", () => {
    const wrong = slip({ vacationDays: 6, vacationHours: 36, vacationDisputed: true });
    const ok = slip({ month: "2026-09", vacationDays: 5, vacationHours: 30 });
    const september = vacation("2026-09-01", "2026-09-07", { id: 2 });
    const cal = calibrateCharge([wrong, ok], [august, september], MODEL);
    expect(cal.disputed).toBe(1);
    expect(cal.usable).toBe(1);
    expect(cal.matches).toBe(true); // Sept: 6 eligible x 4.67 = 28 h -> 5 days
  });

  it("notices payslips that disagree about the flat day length", () => {
    const cal = calibrateCharge(
      [
        slip({ vacationDays: 6, vacationHours: 36 }),
        slip({ month: "2026-09", vacationDays: 2, vacationHours: 16 }),
      ],
      [august],
      MODEL,
    );
    expect(cal.dayHoursConflict).toBe(true);
    expect(cal.dayHours).toBeNull();
  });
});
