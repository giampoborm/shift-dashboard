// The anchor test for this module is the real payslip it was derived from:
// Entgeltabrechnung 8/2026, vacation Mon 3 Aug – Tue 11 Aug 2026 ->
//   Lohnart 620 Genommene Urlaubstage = 6,00
//   Lohnart 171 Urlaub = 36,00 STD x 15,50 = 558,00
//   Urlaub block: Tage LJ alt 20,00 | Genommen 6,00 | Tage verfuegbar 14,00
// If a change to this file stops reproducing those numbers, the change is wrong.

import { describe, it, expect } from "vitest";
import {
  chargeableVacationDates,
  chargedDatesInMonth,
  countChargeableVacationDays,
  DEFAULT_CHARGEABLE_WEEKDAYS,
  DEFAULT_VACATION_DAY_HOURS,
  DEFAULT_VACATION_PAYROLL_DAYS,
  describeChargeableWeekdays,
  payrollDaysTakenInYear,
  vacationPayForMonth,
  vacationPayrollPay,
} from "./vacationPayroll";
import type { GrossRate, Payslip, Settings, Vacation } from "./types";

const RATES: GrossRate[] = [
  { effectiveFrom: "2026-01-01", rate: 14.5 },
  { effectiveFrom: "2026-04-01", rate: 15.5 },
];

// August's own slip: net factor = 1453.33 / 1957.65.
const PAYSLIPS: Payslip[] = [
  { month: "2026-08", totalGross: 1957.65, totalHours: 126.3, totalNet: 1453.33 },
];

const SETTINGS: Pick<
  Settings,
  "vacationDayHours" | "vacationChargeableWeekdays" | "vacationPayrollDays"
> = {
  vacationDayHours: DEFAULT_VACATION_DAY_HOURS,
  vacationChargeableWeekdays: DEFAULT_CHARGEABLE_WEEKDAYS,
  vacationPayrollDays: DEFAULT_VACATION_PAYROLL_DAYS,
};

function vacation(from: string, to: string, payrollDays?: number): Vacation {
  return { from, to, werktage: 0, scheduledCost: 0, payrollDays, createdAt: "now" };
}

describe("the August 2026 payslip", () => {
  it("charges exactly 6 days for Mon 3 – Tue 11 Aug", () => {
    expect(countChargeableVacationDays("2026-08-03", "2026-08-11")).toBe(6);
  });

  it("charges Tue–Sat of the first week plus the trailing Tuesday", () => {
    expect(chargeableVacationDates("2026-08-03", "2026-08-11")).toEqual([
      "2026-08-04", // Tue
      "2026-08-05", // Wed
      "2026-08-06", // Thu
      "2026-08-07", // Fri
      "2026-08-08", // Sat
      "2026-08-11", // Tue — 1 day charged, and he is never rostered on a Tuesday
    ]);
    // Mon 3, Sun 9, Mon 10 are free: the venue is shut Mondays, payroll skips Sundays.
  });

  it("pays 36,00 h = €558,00 gross, matching Lohnart 171", () => {
    const pay = vacationPayrollPay("2026-08-03", "2026-08-11", SETTINGS, RATES, PAYSLIPS);
    expect(pay.days).toBe(6);
    expect(pay.hours).toBe(36);
    expect(pay.gross).toBeCloseTo(558, 2);
    expect(pay.net).toBeCloseTo(558 * (1453.33 / 1957.65), 2);
  });

  it("leaves 14 of the 20-day entitlement", () => {
    const taken = payrollDaysTakenInYear([vacation("2026-08-03", "2026-08-11", 6)], 2026);
    expect(SETTINGS.vacationPayrollDays - taken).toBe(14);
  });

  it("is the only counting rule that yields 6 — the rivals all miss", () => {
    const rules: Record<string, number[]> = {
      "Mon–Fri (5-day week)": [1, 2, 3, 4, 5],
      "Mon–Sat (Werktage)": [1, 2, 3, 4, 5, 6],
      "Tue–Sun (open days)": [2, 3, 4, 5, 6, 0],
    };
    for (const weekdays of Object.values(rules)) {
      expect(countChargeableVacationDays("2026-08-03", "2026-08-11", weekdays)).not.toBe(6);
    }
  });
});

describe("chargeableVacationDates", () => {
  it("returns nothing for a reversed or blank range", () => {
    expect(chargeableVacationDates("2026-08-10", "2026-08-03")).toEqual([]);
    expect(chargeableVacationDates("", "2026-08-03")).toEqual([]);
  });

  it("charges a single chargeable day, and nothing for a lone Monday", () => {
    expect(countChargeableVacationDays("2026-08-04", "2026-08-04")).toBe(1);
    expect(countChargeableVacationDays("2026-08-03", "2026-08-03")).toBe(0);
  });

  it("charges 5 days per full week — 20 days is exactly 4 weeks", () => {
    expect(countChargeableVacationDays("2026-08-03", "2026-08-09")).toBe(5);
    expect(countChargeableVacationDays("2026-08-03", "2026-08-30")).toBe(20);
  });
});

describe("vacationPayrollPay", () => {
  it("prices each day at the rate in force THAT day, across a raise", () => {
    // Tue 31 Mar (€14.50) + Wed 1 – Sat 4 Apr (€15.50).
    const pay = vacationPayrollPay("2026-03-31", "2026-04-04", SETTINGS, RATES, []);
    expect(pay.days).toBe(5);
    expect(pay.gross).toBeCloseTo(6 * 14.5 + 4 * 6 * 15.5, 2);
  });

  it("still reports the day length when nothing is charged", () => {
    const pay = vacationPayrollPay("2026-08-03", "2026-08-03", SETTINGS, RATES, PAYSLIPS);
    expect(pay.days).toBe(0);
    expect(pay.gross).toBe(0);
    expect(pay.dayHours).toBe(6);
  });
});

describe("vacationPayForMonth", () => {
  const vacations = [vacation("2026-08-03", "2026-08-11", 6)];

  it("clips to the month and splits banked vs projected around today", () => {
    const mid = vacationPayForMonth("2026-08", vacations, SETTINGS, RATES, PAYSLIPS, "2026-08-06");
    expect(mid.days).toBe(6);
    expect(mid.hours).toBe(36);
    expect(mid.banked.days).toBe(3); // 4, 5, 6 Aug
    expect(mid.projected.days).toBe(3); // 7, 8, 11 Aug
    expect(mid.banked.gross + mid.projected.gross).toBeCloseTo(558, 2);
  });

  it("banks the lot once the vacation is over", () => {
    const after = vacationPayForMonth("2026-08", vacations, SETTINGS, RATES, PAYSLIPS, "2026-09-01");
    expect(after.banked.days).toBe(6);
    expect(after.projected.days).toBe(0);
  });

  it("ignores months the vacation doesn't touch", () => {
    expect(vacationPayForMonth("2026-07", vacations, SETTINGS, RATES, PAYSLIPS, "2026-09-01").days).toBe(0);
  });

  it("splits a vacation spanning a month boundary", () => {
    const across = [vacation("2026-08-28", "2026-09-05")];
    const aug = vacationPayForMonth("2026-08", across, SETTINGS, RATES, PAYSLIPS, "2026-12-31");
    const sep = vacationPayForMonth("2026-09", across, SETTINGS, RATES, PAYSLIPS, "2026-12-31");
    expect(aug.days + sep.days).toBe(countChargeableVacationDays("2026-08-28", "2026-09-05"));
  });
});

describe("chargedDatesInMonth", () => {
  it("de-duplicates overlapping vacations", () => {
    const dates = chargedDatesInMonth("2026-08", [
      vacation("2026-08-03", "2026-08-08"),
      vacation("2026-08-06", "2026-08-11"),
    ]);
    expect(dates).toEqual(chargeableVacationDates("2026-08-03", "2026-08-11"));
  });
});

describe("payrollDaysTakenInYear", () => {
  it("prefers the snapshot so a later settings change can't rewrite history", () => {
    // Snapshot says 6; a Mon–Sat rule would recompute 8. The snapshot wins.
    const taken = payrollDaysTakenInYear([vacation("2026-08-03", "2026-08-11", 6)], 2026, [1, 2, 3, 4, 5, 6]);
    expect(taken).toBe(6);
  });

  it("recomputes for records saved before the payroll basis existed", () => {
    expect(payrollDaysTakenInYear([vacation("2026-08-03", "2026-08-11")], 2026)).toBe(6);
  });

  it("counts only the requested year", () => {
    expect(payrollDaysTakenInYear([vacation("2025-08-04", "2025-08-08", 5)], 2026)).toBe(0);
  });
});

describe("describeChargeableWeekdays", () => {
  it("collapses a contiguous run", () => {
    expect(describeChargeableWeekdays(DEFAULT_CHARGEABLE_WEEKDAYS)).toBe("Tue–Sat");
  });

  it("lists a scattered set", () => {
    expect(describeChargeableWeekdays([1, 5])).toBe("Mon, Fri");
  });

  it("handles the empty set", () => {
    expect(describeChargeableWeekdays([])).toBe("no days");
  });
});

// The 8/2026 payslip charged 6 days for a vacation recorded as 3–11 Aug, and TWO
// counting rules reproduce that 6 — but only by disagreeing about the end date.
//
// Payroll has since confirmed the range ended the 11th and that Mondays aren't
// charged, which leaves Tue–Sat alone; vacationRuleFit.test.ts pins that resolution.
// These cases stay because they document the arithmetic the counting function does in
// ISOLATION, with no entitlement constraint and no end-date correction applied. That
// is genuinely still ambiguous, and a future reader deserves to see why the fit engine
// exists rather than inheriting a constant that looks arbitrary.
describe("counting alone cannot separate the two rules (the reason vacationRuleFit exists)", () => {
  const TUE_SAT = [2, 3, 4, 5, 6];
  const MON_FRI = [1, 2, 3, 4, 5];

  it("Tue–Sat reproduces the observed 6 days over 3–11 Aug", () => {
    expect(countChargeableVacationDays("2026-08-03", "2026-08-11", TUE_SAT)).toBe(6);
  });

  it("Mon–Fri reproduces the same 6 days if the range ended on the 10th", () => {
    expect(countChargeableVacationDays("2026-08-03", "2026-08-10", MON_FRI)).toBe(6);
  });

  it("no roster-based count could reach 6 — he was rostered on zero of those days", () => {
    // The 3–9 Aug plan lists Gianpaolo nowhere; his usual rate is ~3.9 days/week.
    // So payroll counted the calendar, whichever five weekdays it uses.
    expect(countChargeableVacationDays("2026-08-03", "2026-08-11", [])).toBe(0);
  });

  it("both rules agree on any whole number of weeks — only edges differ", () => {
    // Mon 3 Aug through Sun 16 Aug = exactly two weeks.
    expect(countChargeableVacationDays("2026-08-03", "2026-08-16", TUE_SAT)).toBe(10);
    expect(countChargeableVacationDays("2026-08-03", "2026-08-16", MON_FRI)).toBe(10);
  });
});

describe("vacationPayForMonth — estimate forward, observe backward", () => {
  const AUG: Vacation = {
    from: "2026-08-03",
    to: "2026-08-11",
    werktage: 0,
    scheduledCost: 0,
    createdAt: "",
  };

  it("predicts from the rule when the slip carries no vacation figures", () => {
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, RATES, PAYSLIPS, "2026-08-31");
    expect(r.observed).toBe(false);
    expect(r.days).toBe(6);
    expect(r.hours).toBe(36);
    expect(r.banked.gross).toBeCloseTo(558); // 36 x 15.50, the slip's Urlaub line
  });

  it("uses the slip's own figures once it records them, and banks all of it", () => {
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationDays: 6, vacationHours: 36 }];
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, RATES, slips, "2026-08-31");
    expect(r.observed).toBe(true);
    expect(r.days).toBe(6);
    expect(r.hours).toBe(36);
    expect(r.projected.days).toBe(0);
    expect(r.banked.gross).toBeCloseTo(558);
  });

  it("prefers the slip even when it disagrees with the rule — never re-derive a handed figure", () => {
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationDays: 7, vacationHours: 42 }];
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, RATES, slips, "2026-08-31");
    expect(r.days).toBe(7);
    expect(r.banked.gross).toBeCloseTo(651); // 42 x 15.50
  });

  it("keeps a settings change from rewriting an already-paid month", () => {
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationDays: 6, vacationHours: 36 }];
    const changed = { ...SETTINGS, vacationChargeableWeekdays: [1, 2, 3, 4, 5] };
    const r = vacationPayForMonth("2026-08", [AUG], changed, RATES, slips, "2026-08-31");
    expect(r.days).toBe(6); // not the 7 that Mon-Fri would now predict
  });

  it("treats a missing vacationDays as no evidence, not as zero", () => {
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationHours: 36 }];
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, RATES, slips, "2026-08-31");
    expect(r.observed).toBe(false);
    expect(r.days).toBe(6);
  });

  it("still splits banked vs projected for a future vacation", () => {
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, RATES, PAYSLIPS, "2026-08-06");
    expect(r.banked.days).toBe(3); // Aug 4, 5, 6
    expect(r.projected.days).toBe(3); // Aug 7, 8, 11
  });
});

describe("vacationPayForMonth — observed pay across a mid-month raise", () => {
  // Nothing validates that a raise starts on the 1st (validateRate only checks the
  // date parses), so the observed branch must price per date like the projected one.
  const MID_MONTH_RAISE: GrossRate[] = [
    { effectiveFrom: "2026-01-01", rate: 10 },
    { effectiveFrom: "2026-08-07", rate: 20 },
  ];
  const AUG: Vacation = {
    from: "2026-08-03",
    to: "2026-08-11",
    werktage: 0,
    scheduledCost: 0,
    createdAt: "",
  };
  // Tue-Sat charges Aug 4, 5, 6 at €10 and Aug 7, 8, 11 at €20; 6 h each.
  const EXPECTED = 3 * 6 * 10 + 3 * 6 * 20;

  it("prices the projected branch per date", () => {
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, MID_MONTH_RAISE, PAYSLIPS, "2026-08-31");
    expect(r.banked.gross).toBeCloseTo(EXPECTED); // 540, not 36 x 10
  });

  it("prices the observed branch per date too, not all at the month's opening rate", () => {
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationDays: 6, vacationHours: 36 }];
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, MID_MONTH_RAISE, slips, "2026-08-31");
    expect(r.observed).toBe(true);
    expect(r.banked.gross).toBeCloseTo(EXPECTED);
    expect(r.banked.gross).not.toBeCloseTo(36 * 10); // the old month-start-rate bug
  });

  it("still totals hours x rate when the rate is flat", () => {
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationDays: 6, vacationHours: 36 }];
    const r = vacationPayForMonth("2026-08", [AUG], SETTINGS, RATES, slips, "2026-08-31");
    expect(r.banked.gross).toBeCloseTo(36 * 15.5);
  });

  it("falls back to the month's opening rate when no charged dates exist to spread over", () => {
    // Slip records vacation but no range was ever logged — nothing to price per date.
    const slips: Payslip[] = [{ ...PAYSLIPS[0], vacationDays: 6, vacationHours: 36 }];
    const r = vacationPayForMonth("2026-08", [], SETTINGS, MID_MONTH_RAISE, slips, "2026-08-31");
    expect(r.banked.gross).toBeCloseTo(36 * 10);
  });
});

describe("payrollDaysTakenInYear — past is history, future is an estimate", () => {
  const MON_THU = [1, 2, 3, 4];
  // Saved under a rule that charged 4; Tue-Sat charges 5 for Mon 3 - Sat 8 Aug.
  const booked = (over: Partial<Vacation> = {}): Vacation => ({
    from: "2026-08-03",
    to: "2026-08-08",
    werktage: 0,
    scheduledCost: 0,
    payrollDays: 4,
    createdAt: "",
    ...over,
  });

  it("keeps the snapshot for a vacation already taken", () => {
    // Changing the rule afterwards must not rewrite what payroll charged.
    expect(payrollDaysTakenInYear([booked()], 2026, DEFAULT_CHARGEABLE_WEEKDAYS, "2026-09-07")).toBe(4);
  });

  it("re-costs a vacation that hasn't happened yet under the current rule", () => {
    // Booked ahead; the rule has since been refined. The balance should follow.
    expect(payrollDaysTakenInYear([booked()], 2026, DEFAULT_CHARGEABLE_WEEKDAYS, "2026-07-01")).toBe(5);
    expect(payrollDaysTakenInYear([booked()], 2026, MON_THU, "2026-07-01")).toBe(4);
  });

  it("treats a vacation still running as not yet settled", () => {
    expect(payrollDaysTakenInYear([booked()], 2026, DEFAULT_CHARGEABLE_WEEKDAYS, "2026-08-05")).toBe(5);
  });

  it("recomputes when a past record predates the payroll basis", () => {
    const old = booked({ payrollDays: undefined });
    expect(payrollDaysTakenInYear([old], 2026, DEFAULT_CHARGEABLE_WEEKDAYS, "2026-09-07")).toBe(5);
  });

  it("keeps the snapshot when no date is supplied — the conservative default", () => {
    expect(payrollDaysTakenInYear([booked()], 2026, DEFAULT_CHARGEABLE_WEEKDAYS)).toBe(4);
  });

  it("ignores vacations from other years", () => {
    const lastYear = booked({ from: "2025-08-03", to: "2025-08-08" });
    expect(payrollDaysTakenInYear([lastYear], 2026, DEFAULT_CHARGEABLE_WEEKDAYS, "2026-09-07")).toBe(0);
  });
});
