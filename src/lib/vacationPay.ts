// Holidays-independent vacation math: the ROSTER side of a vacation — how often you
// are really scheduled, how many shifts a range would cost you, and what those shifts
// would have tipped. Split out of vacation.ts so callers outside VacationPlanner's
// React.lazy boundary can use it without pulling the heavy date-holidays dep into the
// main bundle. See CLAUDE.md's "heavy deps get lazy-loaded" convention.
//
// The PAY side moved to vacationPayroll.ts once the 8/2026 payslip revealed the real
// rule: a flat 6 h per chargeable weekday. The probabilistic estimators that used to
// live here (estimateVacationPay / estimateVacationPayDays / avgGrossPerWorkedDay)
// guessed at that number and are gone — don't reintroduce a second, softer answer
// next to the deterministic one.

import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { Shift } from "./types";
import { isPaidShift } from "./earnings";

/**
 * Days you were ON THE ROSTER: worked, or rostered-and-missed-sick. Being ill
 * doesn't make you a less-scheduled employee, so sick days belong in the roster
 * frequency the vacation budget and cost are derived from — otherwise a bad flu
 * would quietly shrink your entitlement. Meetings never do (not floor roster).
 *
 * The `history` these read is the FULL shift list; they filter it themselves.
 */
function wasRostered(s: Shift): boolean {
  return isPaidShift(s) && !!s.date && s.shiftType !== "meeting";
}

/**
 * Dates to erase from the roster observation window entirely — the days you were
 * on vacation. Same reasoning as counting sick days as rostered, one level up: a
 * vacation is not evidence that you work less. Leaving those days in the
 * denominator would let every holiday you take quietly shrink the days/week the
 * proportional entitlement is derived from, so the numerator AND the denominator
 * drop them. Pass the charged dates from lib/vacationPayroll.
 */
function withoutDates<T extends { date: string }>(rows: T[], exclude?: Set<string>): T[] {
  return exclude && exclude.size > 0 ? rows.filter((r) => !exclude.has(r.date)) : rows;
}

export interface WeekdayProfile {
  p: number; // probability the user is scheduled that weekday (0..1)
  n: number; // distinct dates worked on that weekday (sample size)
}

function countWeekdayOccurrences(
  minIso: string,
  maxIso: string,
  wd: number,
  exclude?: Set<string>,
): number {
  let c = 0;
  for (const d of eachDayOfInterval({ start: parseISO(minIso), end: parseISO(maxIso) })) {
    if (getDay(d) !== wd) continue;
    if (exclude?.has(format(d, "yyyy-MM-dd"))) continue;
    c += 1;
  }
  return c;
}

/**
 * Per-weekday roster profile derived from rostered history (worked + sick).
 * `vacationDates` are removed from the observation window so a holiday doesn't
 * read as "he wasn't scheduled that Thursday".
 */
export function buildWeekdayProfile(history: Shift[], vacationDates?: Set<string>): WeekdayProfile[] {
  const blank: WeekdayProfile[] = Array.from({ length: 7 }, () => ({ p: 0, n: 0 }));
  const ws = withoutDates(history.filter(wasRostered), vacationDates);
  if (ws.length === 0) return blank;

  const dates = ws.map((s) => s.date).sort();
  const minIso = dates[0];
  const maxIso = dates[dates.length - 1];

  for (let wd = 0; wd < 7; wd++) {
    const distinctDates = new Set(ws.filter((s) => getDay(parseISO(s.date)) === wd).map((s) => s.date));
    const occ = countWeekdayOccurrences(minIso, maxIso, wd, vacationDates);
    // A scheduled day costs ONE vacation day regardless of crossing midnight.
    blank[wd] = { p: occ > 0 ? Math.min(1, distinctDates.size / occ) : 0, n: distinctDates.size };
  }
  return blank;
}

/**
 * Average distinct working-days per week across the rostered history (worked +
 * sick). Days inside `vacationDates` are subtracted from the span as well as the
 * count, so time off neither inflates nor deflates the figure.
 */
export function avgWorkingDaysPerWeek(history: Shift[], vacationDates?: Set<string>): number {
  const dates = withoutDates(history.filter(wasRostered), vacationDates).map((s) => s.date).sort();
  if (dates.length === 0) return 0;
  const minIso = dates[0];
  const maxIso = dates[dates.length - 1];
  let spanDays =
    Math.abs(parseISO(maxIso).getTime() - parseISO(minIso).getTime()) / 86_400_000 + 1;
  if (vacationDates) {
    for (const d of vacationDates) if (d >= minIso && d <= maxIso) spanDays -= 1;
  }
  if (spanDays <= 0) return 0;
  return new Set(dates).size / (spanDays / 7);
}

/**
 * Proportional (BAG) entitlement: convert the Werktage budget to the user's
 * actual working-day basis. 24 Werktage @ 6-day week → 24 × daysPerWeek / 6.
 */
export function proportionalEntitlement(werktageBudget: number, daysPerWeek: number): number {
  return (werktageBudget * daysPerWeek) / 6;
}

export interface ScheduleCost {
  expected: number; // expected scheduled shifts the vacation costs
  low: number; // expected − 1 sd (clamped at 0)
  high: number; // expected + 1 sd
}

/** Estimate the scheduled-shift cost range of a vacation from the roster profile. */
export function estimateScheduledCost(
  fromIso: string,
  toIso: string,
  profile: WeekdayProfile[],
): ScheduleCost {
  if (toIso < fromIso) return { expected: 0, low: 0, high: 0 };
  let expected = 0;
  let variance = 0;
  for (const d of eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) })) {
    const { p } = profile[getDay(d)];
    expected += p;
    variance += p * (1 - p); // Bernoulli spread
  }
  const sd = Math.sqrt(variance);
  return { expected, low: Math.max(0, expected - sd), high: expected + sd };
}
