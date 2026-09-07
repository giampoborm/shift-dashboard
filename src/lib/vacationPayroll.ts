// The PAYROLL vacation basis — how the employer actually counts and pays a day off.
// Unlike the other two bases in vacation.ts (Werktage from the contract, proportional
// from your roster), this one is not a model: it is reverse-engineered from a real
// payslip and reproduces its numbers exactly.
//
// Grounded in Entgeltabrechnung 8/2026 (vacation Mon 3 Aug – Tue 11 Aug):
//   Lohnart 171  Urlaub                 36,00 STD x 15,50 = 558,00
//   Lohnart 620  Genommene Urlaubstage   6,00
//   Urlaub block: Tage LJ alt 20,00 | Genommen 6,00 | Tage verfuegbar 14,00
//
// Two constants fall out of that, and July's slip confirms the first independently
// (Lohnart 164 LFZ Krank = 6,00 STD for one sick day):
//
//  1. A day is a FLAT 6.00 h — never your actual shift length. 36 / 6 = 6,00 h/day.
//     SOLID: July's slip confirms the same 6,00 h for one sick day, independently.
//  2. Days are charged by the CALENDAR, not by your roster — 5 chargeable days per
//     week. Also solid, two ways: no roster-based count reaches 6 (you're rostered
//     ~3.9 days/week, and the 3–9 Aug plan lists you on zero days), and 5/week x 4
//     weeks = exactly the 20-day entitlement on the slip.
//
// WHICH five weekdays was the open question, and this module does not decide it.
// Two rules both produce the observed 6, differing only in where the range ends:
//     Tue–Sat over 3–11 Aug  -> Tue4 Wed5 Thu6 Fri7 Sat8 Tue11        = 6
//     Mon–Fri over 3–10 Aug  -> Mon3 Tue4 Wed5 Thu6 Fri7 Mon10        = 6
//
// RESOLVED (2026-09-07), two ways — and note the code does not hardcode either:
//  * Payroll confirmed the range ended the 11th and that Mondays are not charged,
//    which leaves Tue–Sat alone (Mon–Fri over 3–11 Aug would charge 7, not 6).
//  * lib/vacationRuleFit.ts reaches the same answer FROM THE DATA, by keeping every
//    counting rule consistent with every payslip and pruning by the days-per-week
//    the entitlement implies. That is the mechanism to extend if payroll ever
//    changes how it counts — don't come back here and edit a constant.
//
// This is why all three numbers are Settings, not constants: the fit proposes, the
// user applies, and an already-paid month is priced from its own payslip rather than
// re-derived. Rules of the same weekly length agree on any whole number of weeks and
// diverge only at a range's edges, so day-level advice must be gated on
// `predictChargedDays(...).agree` rather than assumed safe.
//
// Dep-free (no date-holidays) so App.tsx can use it outside the lazy boundary.

import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { GrossRate, Payslip, Settings, Vacation } from "./types";
import { netFactorForMonth, rateForDate } from "./earnings";

/** Weekdays payroll charges a vacation day for, getDay() numbering. Tue–Sat. */
export const DEFAULT_CHARGEABLE_WEEKDAYS = [2, 3, 4, 5, 6];
/** Flat hours one vacation day is paid at. */
export const DEFAULT_VACATION_DAY_HOURS = 6;
/** Annual entitlement in payroll days ("Tage LJ alt"). */
export const DEFAULT_VACATION_PAYROLL_DAYS = 20;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human label for a chargeable-weekday set, e.g. [2,3,4,5,6] -> "Tue–Sat". */
export function describeChargeableWeekdays(weekdays: number[]): string {
  const set = [...new Set(weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (set.length === 0) return "no days";
  // Contiguous run (in Mon-first reading order) collapses to "X–Y".
  const contiguous = set.every((d, i) => i === 0 || d === set[i - 1] + 1);
  if (contiguous && set.length > 2) return `${WEEKDAY_SHORT[set[0]]}–${WEEKDAY_SHORT[set[set.length - 1]]}`;
  return set.map((d) => WEEKDAY_SHORT[d]).join(", ");
}

/**
 * The specific calendar dates in [fromIso, toIso] payroll charges a vacation day
 * for. Public holidays are deliberately NOT excluded: the observed rule is purely
 * "is this weekday chargeable", and no holiday fell in the August range to test
 * against, so subtracting them would be invention rather than evidence.
 */
export function chargeableVacationDates(
  fromIso: string,
  toIso: string,
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): string[] {
  if (!fromIso || !toIso || toIso < fromIso) return [];
  const set = new Set(weekdays);
  return eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) })
    .filter((d) => set.has(getDay(d)))
    .map((d) => format(d, "yyyy-MM-dd"));
}

/** How many vacation days payroll deducts for [fromIso, toIso]. */
export function countChargeableVacationDays(
  fromIso: string,
  toIso: string,
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): number {
  return chargeableVacationDates(fromIso, toIso, weekdays).length;
}

type PayrollSettings = Pick<
  Settings,
  "vacationDayHours" | "vacationChargeableWeekdays" | "vacationPayrollDays"
>;

export interface VacationPayrollPay {
  days: number; // chargeable days ("Genommene Urlaubstage")
  hours: number; // days x dayHours ("Urlaub" STD)
  gross: number; // Σ per-day hours x the rate in force THAT day (a raise mid-vacation is handled)
  net: number; // gross x the month's net factor
  dayHours: number;
  dates: string[];
}

const ZERO: VacationPayrollPay = { days: 0, hours: 0, gross: 0, net: 0, dayHours: 0, dates: [] };

/**
 * What payroll pays for a vacation range. Deterministic — this is arithmetic the
 * payslip can be checked against, not the forward guess in vacationPay.ts.
 */
export function vacationPayrollPay(
  fromIso: string,
  toIso: string,
  settings: PayrollSettings,
  rates: GrossRate[],
  payslips: Payslip[],
): VacationPayrollPay {
  const dates = chargeableVacationDates(fromIso, toIso, settings.vacationChargeableWeekdays);
  if (dates.length === 0) return { ...ZERO, dayHours: settings.vacationDayHours };
  const dayHours = settings.vacationDayHours;

  let gross = 0;
  let net = 0;
  for (const date of dates) {
    const dayGross = dayHours * (rateForDate(date, rates) ?? 0);
    const { factor } = netFactorForMonth(date.slice(0, 7), payslips);
    gross += dayGross;
    net += dayGross * (factor ?? 1);
  }
  return { days: dates.length, hours: dates.length * dayHours, gross, net, dayHours, dates };
}

/**
 * EVERY calendar day covered by the given vacations — charged or not.
 *
 * This is the set to erase from the roster observation window (see vacationPay.ts):
 * for that purpose what matters is that you were unavailable, not that payroll
 * billed you. The uncharged Sundays and Mondays inside a vacation are days you
 * were away too, and leaving them in the denominator would still drag the
 * days/week the proportional entitlement is derived from.
 */
export function vacationCalendarDates(vacations: Vacation[]): Set<string> {
  const out = new Set<string>();
  for (const v of vacations) {
    if (!v.from || !v.to || v.to < v.from) continue;
    for (const d of eachDayOfInterval({ start: parseISO(v.from), end: parseISO(v.to) })) {
      out.add(format(d, "yyyy-MM-dd"));
    }
  }
  return out;
}

/** Charged vacation dates that fall inside a "yyyy-MM" month, across all vacations. */
export function chargedDatesInMonth(
  month: string,
  vacations: Vacation[],
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): string[] {
  const out = new Set<string>();
  for (const v of vacations) {
    for (const d of chargeableVacationDates(v.from, v.to, weekdays)) {
      if (d.slice(0, 7) === month) out.add(d);
    }
  }
  return [...out].sort();
}

/**
 * What the payslip itself recorded for a month's vacation, if anything. This is
 * observed fact, not a prediction — the two numbers printed on the slip.
 */
export function observedVacationForMonth(
  month: string,
  payslips: Payslip[],
): { days: number; hours: number } | null {
  const slip = payslips.find((p) => p.month === month);
  if (!slip || slip.vacationDays == null) return null;
  return { days: slip.vacationDays, hours: slip.vacationHours ?? 0 };
}

export interface MonthVacationPay {
  days: number;
  hours: number;
  banked: { days: number; gross: number; net: number };
  projected: { days: number; gross: number; net: number };
  /** True when these figures came off the payslip rather than from the rule. */
  observed: boolean;
}

/**
 * Vacation pay landing in one month, split by whether the day has already passed.
 * Past days are banked (a known amount the payslip will show); future days are
 * projected. Wage only — a vacation day structurally carries no tips.
 *
 * ESTIMATE FORWARD, OBSERVE BACKWARD: if the month's payslip records what payroll
 * actually charged, those numbers win outright and the whole amount is banked.
 * Never re-derive a figure you have already been handed — that is what makes the
 * month total correct even in the window where the counting rule is still
 * ambiguous, and what stops a later settings change from rewriting a paid month.
 */
export function vacationPayForMonth(
  month: string,
  vacations: Vacation[],
  settings: PayrollSettings,
  rates: GrossRate[],
  payslips: Payslip[],
  todayIso: string,
): MonthVacationPay {
  const { factor } = netFactorForMonth(month, payslips);
  const observed = observedVacationForMonth(month, payslips);

  if (observed) {
    // Price the slip's hours PER DATE, exactly as the projected branch below does,
    // so a raise landing mid-vacation is handled. The slip gives a monthly total,
    // not a per-day breakdown, so spread it evenly over the charged dates the rule
    // identifies — the flat-day rule means every charged day carries equal hours.
    // With no charged dates to spread over (an unrecorded vacation, or a rule that
    // has drifted), fall back to the month's opening rate.
    const spreadDates = chargedDatesInMonth(month, vacations, settings.vacationChargeableWeekdays);
    let gross: number;
    if (spreadDates.length > 0) {
      const hoursPerDate = observed.hours / spreadDates.length;
      gross = spreadDates.reduce((sum, d) => sum + hoursPerDate * (rateForDate(d, rates) ?? 0), 0);
    } else {
      gross = observed.hours * (rateForDate(`${month}-01`, rates) ?? 0);
    }
    return {
      days: observed.days,
      hours: observed.hours,
      banked: { days: observed.days, gross, net: gross * (factor ?? 1) },
      projected: { days: 0, gross: 0, net: 0 },
      observed: true,
    };
  }

  const dates = chargedDatesInMonth(month, vacations, settings.vacationChargeableWeekdays);
  const banked = { days: 0, gross: 0, net: 0 };
  const projected = { days: 0, gross: 0, net: 0 };

  for (const date of dates) {
    const dayGross = settings.vacationDayHours * (rateForDate(date, rates) ?? 0);
    const bucket = date <= todayIso ? banked : projected;
    bucket.days += 1;
    bucket.gross += dayGross;
    bucket.net += dayGross * (factor ?? 1);
  }
  return {
    days: dates.length,
    hours: dates.length * settings.vacationDayHours,
    banked,
    projected,
    observed: false,
  };
}

/**
 * Payroll days used in a calendar year.
 *
 * PAST vacations keep the snapshot taken when they were saved — that is what
 * payroll actually charged, and a later settings change must not rewrite history.
 * A vacation that hasn't finished yet is still an ESTIMATE, so it is recomputed
 * from the current rule every time: booking a trip months ahead and then refining
 * the counting rule should update what that trip is going to cost, not leave a
 * stale figure sitting in your balance.
 *
 * Pass `todayIso` to get that split. WITHOUT it the snapshot always wins: a caller
 * that can't say when "now" is gets the conservative, history-preserving answer
 * rather than silently re-costing vacations that were already paid.
 */
export function payrollDaysTakenInYear(
  vacations: Vacation[],
  year: number,
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
  todayIso?: string,
): number {
  const y = String(year);
  return vacations
    .filter((v) => v.from.slice(0, 4) === y)
    .reduce((sum, v) => {
      const finished = todayIso == null || v.to < todayIso;
      const days =
        finished && v.payrollDays != null
          ? v.payrollDays
          : countChargeableVacationDays(v.from, v.to, weekdays);
      return sum + days;
    }, 0);
}
