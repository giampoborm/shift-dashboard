// Holidays-independent vacation math: the ROSTER side of a vacation — how often you
// are really scheduled, how many shifts a range would cost you, and what those shifts
// would have tipped. Split out of vacation.ts so callers outside VacationPlanner's
// React.lazy boundary can use it without pulling the heavy date-holidays dep into the
// main bundle. See CLAUDE.md's "heavy deps get lazy-loaded" convention.
//
// It serves two consumers with different questions:
//   * "how many SHIFTS would I miss" — buildWeekdayProfile / estimateScheduledCost.
//     Opportunity cost: those shifts' tips are gone and nothing replaces them.
//   * "how many HOURS would I miss" — buildWeekdayHoursProfile / expectedHoursInRange.
//     This is the input payroll charges against: hours ÷ the flat 6 h vacation day,
//     rounded up. See lib/vacationCharge.ts.
// Those are different numbers on purpose — a ~7 h shift is more than one 6 h
// vacation day — and conflating them is the bug this module was reworked to fix.
//
// The PAY side lives in vacationPayroll.ts. The probabilistic pay estimators that
// used to live here (estimateVacationPay / estimateVacationPayDays /
// avgGrossPerWorkedDay) guessed at the flat day and are gone — don't reintroduce a
// second, softer answer next to the deterministic one.

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

// ---------------------------------------------------------------------------
// HOURS side of the roster — the input the payroll charge is actually computed
// from (see lib/vacationCharge.ts).
//
// The employer does not count your days off. It counts the HOURS you would have
// worked and divides them by the flat 6 h a vacation day is paid at. That is why
// four ~7 h shifts a week cost more than four vacation days: 28 h / 6 = 4.67.
// ---------------------------------------------------------------------------

/** Hours one rostered shift represents, falling back to the roster mean when the
 *  shift has no logged hours (typical of a sick day, which is rostered all the
 *  same). A shift with no hours at all would otherwise read as a free day. */
function shiftHoursWithFallback(s: Shift, mean: number): number {
  return s.actualHours != null && s.actualHours > 0 ? s.actualHours : mean;
}

export interface WeekdayHours {
  /** Expected hours rostered on that weekday — Σ hours ÷ times the weekday occurred. */
  hours: number;
  /** Distinct dates observed on that weekday (sample size). */
  n: number;
}

/**
 * Per-weekday expected ROSTERED HOURS, from the same window and the same
 * worked+sick definition as buildWeekdayProfile. Vacation dates are erased from
 * both the numerator and the denominator, so a holiday can't read as "he works
 * fewer hours" and quietly shrink what the next one costs.
 *
 * Per weekday rather than a flat weekly average because a range is rarely a whole
 * number of weeks: a Sat–Sun break should cost his weekend hours, not 2/7ths of
 * the week. Summed over a full week it is exactly the weekly average, so the two
 * views never disagree.
 */
export function buildWeekdayHoursProfile(
  history: Shift[],
  vacationDates?: Set<string>,
): WeekdayHours[] {
  const blank: WeekdayHours[] = Array.from({ length: 7 }, () => ({ hours: 0, n: 0 }));
  const ws = withoutDates(history.filter(wasRostered), vacationDates);
  if (ws.length === 0) return blank;

  const known = ws.map((s) => s.actualHours).filter((h): h is number => h != null && h > 0);
  const mean = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0;

  const dates = ws.map((s) => s.date).sort();
  const minIso = dates[0];
  const maxIso = dates[dates.length - 1];

  for (let wd = 0; wd < 7; wd++) {
    const onDay = ws.filter((s) => getDay(parseISO(s.date)) === wd);
    const occ = countWeekdayOccurrences(minIso, maxIso, wd, vacationDates);
    const total = onDay.reduce((sum, s) => sum + shiftHoursWithFallback(s, mean), 0);
    blank[wd] = { hours: occ > 0 ? total / occ : 0, n: new Set(onDay.map((s) => s.date)).size };
  }
  return blank;
}

/** Expected hours in a typical week — the sum of the per-weekday expectations. */
export function avgWeeklyHours(profile: WeekdayHours[]): number {
  return profile.reduce((sum, d) => sum + d.hours, 0);
}

/** Total sample size behind an hours profile — how many rostered days it saw. */
export function hoursProfileSample(profile: WeekdayHours[]): number {
  return profile.reduce((sum, d) => sum + d.n, 0);
}

/** Hours you'd have been rostered for across [fromIso, toIso], inclusive. */
export function expectedHoursInRange(
  fromIso: string,
  toIso: string,
  profile: WeekdayHours[],
): number {
  if (!fromIso || !toIso || toIso < fromIso) return 0;
  let hours = 0;
  for (const d of eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) })) {
    hours += profile[getDay(d)].hours;
  }
  return hours;
}
