// Fitting the payroll vacation rule to evidence, instead of asserting it.
//
// vacationPayroll.ts knows how to COUNT vacation days once you tell it which
// weekdays payroll charges. That "which" was originally reverse-engineered by hand
// from a single payslip, hardcoded as a default, and guarded by a comment asking
// the next reader not to build day-level advice until a human confirmed it.
//
// This module removes the human from that loop. The observation it rests on:
//
//   EVERY PAYSLIP IS A LABELLED EXAMPLE.
//
// A slip prints "Genommene Urlaubstage" (days charged) and "Urlaub ... STD" (hours
// paid) for a range the `vacations` table already holds. That is an input/output
// pair. So rather than storing one rule and hoping it stays true, we keep the SET
// of rules consistent with every observation, and narrow it as slips arrive:
//
//   0 observations          -> every candidate survives; the app says so.
//   Aug 2026 alone (6 days) -> Tue-Sat and Mon-Thu both survive.
//   + the 5-day/week constraint implied by the 20-day entitlement -> Tue-Sat, alone.
//
// The payoff is that ambiguity becomes a VALUE the UI can read, not a comment.
// Callers ask `predictChargedDays` for a range and get a min/max plus `agree`.
// Day-level advice can render itself only when `agree` is true, and self-hide when
// it isn't - the gate the roadmap was enforcing by hand.
//
// If payroll ever changes how it counts, the next slip simply fails to match and
// `conflict` goes true, which is the signal that the fit is stale.
//
// SCOPE: this fits the WEEKDAY SET and the FLAT DAY HOURS. It deliberately does
// not model public-holiday exclusion. Deciding that needs a vacation range that
// actually contains a holiday, and none does yet; adding the dimension now would
// either invent an answer or report permanent false ambiguity. It slots in as a
// second field on ChargeRule when such a range exists.
//
// Dep-free (no date-holidays), like vacationPayroll - usable outside the lazy boundary.

import type { Payslip, Settings, Vacation } from "./types";
import { chargedDatesInMonth, countChargeableVacationDays } from "./vacationPayroll";

/** Weekday order payroll rules are actually written in: Monday first. */
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
const MON_FIRST_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A candidate rule: a contiguous run of chargeable weekdays in Mon-first order. */
export interface ChargeRule {
  /** getDay() numbering (0=Sun ... 6=Sat), the shape vacationPayroll consumes. */
  weekdays: number[];
  /** Human label, e.g. "Tue-Sat". */
  label: string;
  /** Chargeable days per week - the run length. */
  perWeek: number;
}

function makeRule(start: number, length: number): ChargeRule {
  const idx = Array.from({ length }, (_, i) => start + i);
  return {
    weekdays: idx.map((i) => MON_FIRST[i]),
    label: `${MON_FIRST_LABEL[start]}–${MON_FIRST_LABEL[start + length - 1]}`,
    perWeek: length,
  };
}

/**
 * The hypothesis space: every contiguous 4-to-7-day run in a Mon-first week.
 * Non-wrapping on purpose - real payroll weeks start at their start and run
 * forward (Mon-Fri, Tue-Sat, Mon-Sat); none of them read "Fri through Mon".
 * Ten candidates, all of which a human would recognise as a plausible rule.
 */
export const CANDIDATE_RULES: ChargeRule[] = [4, 5, 6, 7].flatMap((length) =>
  Array.from({ length: 7 - length + 1 }, (_, start) => makeRule(start, length)),
);

/** Look a candidate up by label, e.g. "Tue-Sat". */
export function ruleByLabel(label: string): ChargeRule | undefined {
  return CANDIDATE_RULES.find((r) => r.label === label);
}

const weekdayKey = (weekdays: number[]) =>
  [...new Set(weekdays)].sort((a, b) => a - b).join(",");

/** The candidate matching an explicit weekday set, if it is one of ours. */
export function ruleForWeekdays(weekdays: number[]): ChargeRule | undefined {
  const key = weekdayKey(weekdays);
  return CANDIDATE_RULES.find((r) => weekdayKey(r.weekdays) === key);
}

/** One payslip's vacation figures - the labelled example. */
export interface VacationObservation {
  month: string; // "yyyy-MM"
  days: number; // slip's "Genommene Urlaubstage"
  hours?: number; // slip's "Urlaub" STD
}

/**
 * Payslips that actually carry vacation figures. A slip with no `vacationDays`
 * recorded says nothing - absence of the number is not evidence of zero.
 */
export function observationsFrom(payslips: Payslip[]): VacationObservation[] {
  return payslips
    .filter((p) => p.vacationDays != null)
    .map((p) => ({ month: p.month, days: p.vacationDays as number, hours: p.vacationHours }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export interface RuleFit {
  /** Candidates consistent with every observation (all of them when there are none). */
  rules: ChargeRule[];
  /** True once a single rule survives - the app can speak with confidence. */
  resolved: boolean;
  /** True when NO candidate explains the evidence: the rule changed, or a range is wrong. */
  conflict: boolean;
  /** How many payslips carried usable vacation figures. */
  observations: number;
  /** Chargeable days/week used to prune, when supplied. */
  perWeek?: number;
  /** Flat hours per vacation day implied by the slips (hours / days), if consistent. */
  dayHours: number | null;
  /** True when slips disagree with each other about hours-per-day. */
  dayHoursConflict: boolean;
}

/**
 * Chargeable days per week implied by the entitlement, or undefined if it doesn't
 * divide cleanly. The contract's 24 Werktage is 4 weeks (24 / 6), so a 20-day
 * payroll entitlement over those same 4 weeks means 5 chargeable days a week.
 * This is the constraint that separates Tue-Sat from Mon-Thu on one payslip.
 */
export function impliedPerWeek(
  settings: Pick<Settings, "vacationPayrollDays" | "vacationWerktage">,
): number | undefined {
  const weeks = settings.vacationWerktage / 6;
  if (!(weeks > 0)) return undefined;
  const perWeek = settings.vacationPayrollDays / weeks;
  return Number.isInteger(perWeek) && perWeek >= 4 && perWeek <= 7 ? perWeek : undefined;
}

const HOURS_EPSILON = 0.01;

function fitDayHours(observations: VacationObservation[]): {
  dayHours: number | null;
  conflict: boolean;
} {
  const perDay = observations
    .filter((o) => o.hours != null && o.days > 0)
    .map((o) => (o.hours as number) / o.days);
  if (perDay.length === 0) return { dayHours: null, conflict: false };
  const first = perDay[0];
  const conflict = perDay.some((h) => Math.abs(h - first) > HOURS_EPSILON);
  return { dayHours: conflict ? null : first, conflict };
}

/**
 * Narrow the candidate rules to those reproducing every payslip's vacation days.
 *
 * A month's prediction is the charged dates of ALL vacations that fall inside it,
 * so a range spanning a month boundary is split correctly across the two slips.
 */
export function fitChargeRules(
  payslips: Payslip[],
  vacations: Vacation[],
  opts: { perWeek?: number } = {},
): RuleFit {
  const observations = observationsFrom(payslips);
  const space = opts.perWeek
    ? CANDIDATE_RULES.filter((r) => r.perWeek === opts.perWeek)
    : CANDIDATE_RULES;

  const survivors = space.filter((rule) =>
    observations.every(
      (o) => chargedDatesInMonth(o.month, vacations, rule.weekdays).length === o.days,
    ),
  );

  const { dayHours, conflict: dayHoursConflict } = fitDayHours(observations);
  const conflict = survivors.length === 0;

  return {
    // On conflict, fall back to the unpruned space rather than handing callers an
    // empty list - the UI reports the conflict, and a wide-but-honest prediction
    // beats a confident wrong one.
    rules: conflict ? space : survivors,
    resolved: survivors.length === 1,
    conflict,
    observations: observations.length,
    perWeek: opts.perWeek,
    dayHours,
    dayHoursConflict,
  };
}

export interface DaysPrediction {
  min: number;
  max: number;
  /** True when every surviving rule charges the same number of days for this range. */
  agree: boolean;
}

function spread(counts: number[]): DaysPrediction {
  if (counts.length === 0) return { min: 0, max: 0, agree: true };
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return { min, max, agree: min === max };
}

/**
 * How many days a range costs, across every surviving rule.
 *
 * `agree` is the gate day-level advice should hang off: when the surviving rules
 * differ on THIS range, any claim about which specific day to trim is unfounded -
 * even though the same rules agree on, say, a whole number of weeks.
 */
export function predictChargedDays(
  fromIso: string,
  toIso: string,
  rules: ChargeRule[],
): DaysPrediction {
  return spread(rules.map((r) => countChargeableVacationDays(fromIso, toIso, r.weekdays)));
}

/** Charged days landing in one month, across every surviving rule. */
export function predictChargedDaysInMonth(
  month: string,
  vacations: Vacation[],
  rules: ChargeRule[],
): DaysPrediction {
  return spread(rules.map((r) => chargedDatesInMonth(month, vacations, r.weekdays).length));
}

/** One-line summary of where the fit stands, for the Settings panel. */
export function describeFit(fit: RuleFit): string {
  if (fit.conflict) {
    return fit.observations === 1
      ? "No counting rule reproduces your payslip — check the vacation dates or the figures entered."
      : `No single rule reproduces all ${fit.observations} payslips — payroll may have changed how it counts.`;
  }
  if (fit.observations === 0) {
    return "No payslip vacation figures entered yet, so the rule is an assumption. Add “Genommene Urlaubstage” to a payslip to pin it down.";
  }
  if (fit.resolved) {
    const n = fit.observations;
    return `${fit.rules[0].label}, confirmed by ${n} payslip${n === 1 ? "" : "s"}.`;
  }
  return `${fit.rules.length} rules still fit (${fit.rules
    .map((r) => r.label)
    .join(", ")}) — they agree on whole weeks and differ only at a range's edges.`;
}
