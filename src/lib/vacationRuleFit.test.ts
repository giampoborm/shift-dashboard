import { describe, expect, it } from "vitest";
import type { Payslip, Vacation } from "./types";
import {
  CANDIDATE_RULES,
  describeFit,
  fitChargeRules,
  impliedPerWeek,
  observationsFrom,
  predictChargedDays,
  predictChargedDaysInMonth,
  ruleByLabel,
  ruleForWeekdays,
} from "./vacationRuleFit";

// The one real observation the whole feature rests on: Entgeltabrechnung 8/2026.
// Vacation Mon 3 Aug - Tue 11 Aug 2026, slip says 6,00 days / 36,00 h.
const AUG: Vacation = {
  from: "2026-08-03",
  to: "2026-08-11",
  werktage: 0,
  scheduledCost: 0,
  createdAt: "2026-08-01",
};
const augSlip = (over: Partial<Payslip> = {}): Payslip => ({
  month: "2026-08",
  totalGross: 0,
  totalHours: 0,
  totalNet: 0,
  vacationDays: 6,
  vacationHours: 36,
  ...over,
});

const labels = (rules: { label: string }[]) => rules.map((r) => r.label);

describe("candidate space", () => {
  it("is the ten contiguous Mon-first runs of 4 to 7 days", () => {
    expect(CANDIDATE_RULES).toHaveLength(10);
    expect(labels(CANDIDATE_RULES)).toEqual([
      "Mon–Thu",
      "Tue–Fri",
      "Wed–Sat",
      "Thu–Sun",
      "Mon–Fri",
      "Tue–Sat",
      "Wed–Sun",
      "Mon–Sat",
      "Tue–Sun",
      "Mon–Sun",
    ]);
  });

  it("maps labels to getDay() weekday sets", () => {
    expect(ruleByLabel("Mon–Fri")?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(ruleByLabel("Tue–Sat")?.weekdays).toEqual([2, 3, 4, 5, 6]);
    expect(ruleByLabel("Wed–Sun")?.weekdays).toEqual([3, 4, 5, 6, 0]);
    expect(ruleByLabel("Mon–Sun")?.perWeek).toBe(7);
  });

  it("recognises a weekday set regardless of order", () => {
    expect(ruleForWeekdays([6, 2, 4, 3, 5])?.label).toBe("Tue–Sat");
    expect(ruleForWeekdays([1, 3, 5])).toBeUndefined(); // not contiguous, not a candidate
  });
});

describe("impliedPerWeek", () => {
  it("derives 5 chargeable days/week from 20 payroll days over 24 Werktage", () => {
    expect(impliedPerWeek({ vacationPayrollDays: 20, vacationWerktage: 24 })).toBe(5);
  });

  it("derives 6 for a Werktage-shaped entitlement", () => {
    expect(impliedPerWeek({ vacationPayrollDays: 24, vacationWerktage: 24 })).toBe(6);
  });

  it("stays silent when the entitlement doesn't divide into whole days", () => {
    expect(impliedPerWeek({ vacationPayrollDays: 22, vacationWerktage: 24 })).toBeUndefined();
    expect(impliedPerWeek({ vacationPayrollDays: 20, vacationWerktage: 0 })).toBeUndefined();
  });
});

describe("observationsFrom", () => {
  it("keeps only slips carrying vacation figures, oldest first", () => {
    const slips: Payslip[] = [
      augSlip(),
      { month: "2026-07", totalGross: 0, totalHours: 0, totalNet: 0 },
      { month: "2026-06", totalGross: 0, totalHours: 0, totalNet: 0, vacationDays: 0 },
    ];
    expect(observationsFrom(slips)).toEqual([
      { month: "2026-06", days: 0, hours: undefined },
      { month: "2026-08", days: 6, hours: 36 },
    ]);
  });

  it("treats a missing figure as no evidence, not as zero", () => {
    const slips: Payslip[] = [{ month: "2026-07", totalGross: 0, totalHours: 0, totalNet: 0 }];
    expect(observationsFrom(slips)).toEqual([]);
  });
});

describe("fitChargeRules — the August payslip", () => {
  it("narrows to Tue–Sat and Mon–Thu on the slip alone", () => {
    // Both charge exactly 6 over 3-11 Aug:
    //   Tue-Sat: Tue4 Wed5 Thu6 Fri7 Sat8 Tue11
    //   Mon-Thu: Mon3 Tue4 Wed5 Thu6 Mon10 Tue11
    const fit = fitChargeRules([augSlip()], [AUG]);
    expect(labels(fit.rules)).toEqual(["Mon–Thu", "Tue–Sat"]);
    expect(fit.resolved).toBe(false);
    expect(fit.conflict).toBe(false);
  });

  it("resolves to Tue–Sat once the 5-day/week entitlement prunes the space", () => {
    const fit = fitChargeRules([augSlip()], [AUG], { perWeek: 5 });
    expect(labels(fit.rules)).toEqual(["Tue–Sat"]);
    expect(fit.resolved).toBe(true);
  });

  it("rules out Mon–Fri, which would have charged 7 for that range", () => {
    const fit = fitChargeRules([augSlip()], [AUG], { perWeek: 5 });
    expect(labels(fit.rules)).not.toContain("Mon–Fri");
    expect(predictChargedDays("2026-08-03", "2026-08-11", [ruleByLabel("Mon–Fri")!]).min).toBe(7);
  });

  it("fits the flat 6.00 h per vacation day from hours / days", () => {
    expect(fitChargeRules([augSlip()], [AUG], { perWeek: 5 }).dayHours).toBe(6);
  });

  it("reports no day-hours when the slip omits the hours line", () => {
    const fit = fitChargeRules([augSlip({ vacationHours: undefined })], [AUG]);
    expect(fit.dayHours).toBeNull();
    expect(fit.dayHoursConflict).toBe(false);
  });

  it("flags slips that disagree about hours per day", () => {
    const july: Payslip = {
      month: "2026-07",
      totalGross: 0,
      totalHours: 0,
      totalNet: 0,
      vacationDays: 1,
      vacationHours: 8,
    };
    const fit = fitChargeRules([augSlip(), july], [AUG]);
    expect(fit.dayHoursConflict).toBe(true);
    expect(fit.dayHours).toBeNull();
  });
});

describe("fitChargeRules — edges", () => {
  it("keeps the whole space when there is no evidence at all", () => {
    const fit = fitChargeRules([], []);
    expect(fit.rules).toHaveLength(10);
    expect(fit.resolved).toBe(false);
    expect(fit.conflict).toBe(false);
    expect(fit.observations).toBe(0);
  });

  it("flags a conflict when no rule reproduces the slip", () => {
    const fit = fitChargeRules([augSlip({ vacationDays: 3 })], [AUG], { perWeek: 5 });
    expect(fit.conflict).toBe(true);
    expect(fit.resolved).toBe(false);
    // Falls back to the unpruned space rather than an empty list.
    expect(fit.rules.length).toBeGreaterThan(0);
  });

  it("splits a month-spanning vacation across the two slips that saw it", () => {
    const spanning: Vacation = {
      from: "2026-08-27",
      to: "2026-09-05",
      werktage: 0,
      scheduledCost: 0,
      createdAt: "",
    };
    // Tue-Sat: Aug 27,28,29 = 3 | Sep 1,2,3,4,5 = 5
    const slips: Payslip[] = [
      { month: "2026-08", totalGross: 0, totalHours: 0, totalNet: 0, vacationDays: 3 },
      { month: "2026-09", totalGross: 0, totalHours: 0, totalNet: 0, vacationDays: 5 },
    ];
    const fit = fitChargeRules(slips, [spanning], { perWeek: 5 });
    expect(labels(fit.rules)).toEqual(["Tue–Sat"]);
    expect(fit.observations).toBe(2);
  });

  it("counts a month with a recorded vacation but zero charged days as evidence", () => {
    // A Sunday-only range: only rules including Sunday charge anything.
    const sunday: Vacation = {
      from: "2026-08-09",
      to: "2026-08-09",
      werktage: 0,
      scheduledCost: 0,
      createdAt: "",
    };
    const slip: Payslip = {
      month: "2026-08",
      totalGross: 0,
      totalHours: 0,
      totalNet: 0,
      vacationDays: 0,
    };
    const fit = fitChargeRules([slip], [sunday]);
    expect(labels(fit.rules)).not.toContain("Wed–Sun");
    expect(labels(fit.rules)).toContain("Tue–Sat");
  });
});

describe("predictChargedDays — the agreement gate", () => {
  // The real historical ambiguity: both charge 5 days a week, so they agree on
  // whole weeks and part company only at a range's edges.
  const ambiguous = [ruleByLabel("Mon–Fri")!, ruleByLabel("Tue–Sat")!];

  it("agrees on a whole number of weeks", () => {
    // Mon 3 Aug - Sun 16 Aug is exactly two weeks: either 5-day rule charges 10.
    expect(predictChargedDays("2026-08-03", "2026-08-16", ambiguous)).toEqual({
      min: 10,
      max: 10,
      agree: true,
    });
  });

  it("disagrees at a range's edge, which is what gates day-level advice", () => {
    // The August range itself: Tue-Sat charges 6, Mon-Fri would have charged 7.
    const p = predictChargedDays("2026-08-03", "2026-08-11", ambiguous);
    expect(p.agree).toBe(false);
    expect(p.min).toBe(6);
    expect(p.max).toBe(7);
  });

  it("does NOT claim agreement across rules of different weekly lengths", () => {
    // Tue-Sat (5/week) vs Mon-Thu (4/week) diverge even on whole weeks, which is
    // why impliedPerWeek prunes to one length class before this ever matters.
    const mixed = [ruleByLabel("Tue–Sat")!, ruleByLabel("Mon–Thu")!];
    expect(predictChargedDays("2026-08-03", "2026-08-16", mixed)).toEqual({
      min: 8,
      max: 10,
      agree: false,
    });
  });

  it("is a single confident number once one rule survives", () => {
    expect(predictChargedDays("2026-08-03", "2026-08-11", [ruleByLabel("Tue–Sat")!])).toEqual({
      min: 6,
      max: 6,
      agree: true,
    });
  });

  it("handles an empty rule list without dividing by nothing", () => {
    expect(predictChargedDays("2026-08-03", "2026-08-11", [])).toEqual({
      min: 0,
      max: 0,
      agree: true,
    });
  });

  it("spans month boundaries", () => {
    // Tue-Sat over 27 Aug - 5 Sep = 3 in August + 5 in September.
    expect(predictChargedDays("2026-08-27", "2026-09-05", [ruleByLabel("Tue–Sat")!]).min).toBe(8);
  });
});

describe("predictChargedDaysInMonth", () => {
  it("ranges over the surviving rules", () => {
    const p = predictChargedDaysInMonth("2026-08", [AUG], [
      ruleByLabel("Tue–Sat")!,
      ruleByLabel("Mon–Fri")!,
    ]);
    expect(p).toEqual({ min: 6, max: 7, agree: false });
  });

  it("is zero for a month with no vacation in it", () => {
    expect(predictChargedDaysInMonth("2026-09", [AUG], [ruleByLabel("Tue–Sat")!])).toEqual({
      min: 0,
      max: 0,
      agree: true,
    });
  });
});

// The copy is user-facing, so these assert readability as much as correctness:
// no "candidates", no "hypotheses", no counts of internal state.
describe("describeFit", () => {
  const JARGON = /candidate|hypothes|prune|space|constraint|perWeek/i;

  it("says plainly that nothing has been checked yet", () => {
    expect(describeFit(fitChargeRules([], []))).toBe("Not checked against a payslip yet.");
  });

  it("credits the payslip once resolved, without restating the rule", () => {
    // The weekday set is shown next to this line, so repeating it here is noise.
    const fit = fitChargeRules([augSlip()], [AUG], { perWeek: 5 });
    expect(describeFit(fit)).toBe("Confirmed by 1 payslip.");
  });

  it("names both survivors and says when they differ, in plain English", () => {
    const text = describeFit(fitChargeRules([augSlip()], [AUG]));
    expect(text).toBe(
      "Mon–Thu and Tue–Sat both fit your 1 payslip equally well — they only differ when a vacation starts or ends mid-week.",
    );
  });

  it("explains a conflict as something to check, not as an error code", () => {
    const fit = fitChargeRules([augSlip({ vacationDays: 3 })], [AUG], { perWeek: 5 });
    expect(describeFit(fit)).toMatch(/check the vacation dates and the days you entered/);
  });

  it("blames payroll changing its counting once several slips disagree", () => {
    const july: Payslip = {
      month: "2026-07",
      totalGross: 0,
      totalHours: 0,
      totalNet: 0,
      vacationDays: 99,
    };
    const fit = fitChargeRules([augSlip(), july], [AUG], { perWeek: 5 });
    expect(describeFit(fit)).toMatch(/all 2 payslips/);
  });

  it("never leaks internal vocabulary into the UI", () => {
    const fits = [
      fitChargeRules([], []),
      fitChargeRules([augSlip()], [AUG]),
      fitChargeRules([augSlip()], [AUG], { perWeek: 5 }),
      fitChargeRules([augSlip({ vacationDays: 3 })], [AUG], { perWeek: 5 }),
    ];
    for (const f of fits) expect(describeFit(f)).not.toMatch(JARGON);
  });
});

describe("planned vacations — the saved setting stands until evidence exists", () => {
  const TUE_SAT = [2, 3, 4, 5, 6];
  const noEvidence: Payslip[] = [
    { month: "2026-08", totalGross: 1000, totalHours: 60, totalNet: 800 },
  ];

  it("does not manufacture uncertainty from an absence of payslips", () => {
    // Without this, a fresh install quotes a mid-week range as "5-7 days" across
    // Mon-Fri / Tue-Sat / Wed-Sun, contradicting the rule the user actually set.
    const fit = fitChargeRules(noEvidence, [], { perWeek: 5, current: TUE_SAT });
    expect(labels(fit.rules)).toEqual(["Tue–Sat"]);
    expect(predictChargedDays("2026-10-05", "2026-10-13", fit.rules)).toEqual({
      min: 6,
      max: 6,
      agree: true,
    });
  });

  it("still says plainly that nothing has confirmed it", () => {
    const fit = fitChargeRules(noEvidence, [], { perWeek: 5, current: TUE_SAT });
    expect(fit.resolved).toBe(false); // a setting, not a finding
    expect(fit.observations).toBe(0);
    expect(describeFit(fit)).toBe("Not checked against a payslip yet.");
  });

  it("falls back to the full space when the saved set isn't a recognisable rule", () => {
    const fit = fitChargeRules(noEvidence, [], { perWeek: 5, current: [1, 3, 5] });
    expect(fit.rules.length).toBeGreaterThan(1);
  });

  it("widens only for REAL ambiguity — evidence several rules explain", () => {
    const slip: Payslip = {
      month: "2026-08",
      totalGross: 0,
      totalHours: 0,
      totalNet: 0,
      vacationDays: 6,
    };
    const fit = fitChargeRules([slip], [AUG], { current: TUE_SAT }); // no perWeek pruning
    expect(labels(fit.rules)).toEqual(["Mon–Thu", "Tue–Sat"]);
    // Mon 5 - Sat 10 Oct: Mon-Thu charges Mon5..Thu8 = 4, Tue-Sat charges Tue6..Sat10 = 5.
    expect(predictChargedDays("2026-10-05", "2026-10-10", fit.rules)).toEqual({
      min: 4,
      max: 5,
      agree: false,
    });
  });

  it("lets evidence overrule the saved setting rather than deferring to it", () => {
    // Saved Tue-Sat, but the slip only fits Mon-Fri (7 days over 3-11 Aug).
    const slip: Payslip = {
      month: "2026-08",
      totalGross: 0,
      totalHours: 0,
      totalNet: 0,
      vacationDays: 7,
    };
    const fit = fitChargeRules([slip], [AUG], { perWeek: 5, current: TUE_SAT });
    expect(labels(fit.rules)).toEqual(["Mon–Fri"]);
    expect(fit.resolved).toBe(true);
  });
});
