// Holidays-independent vacation math: roster profile, proportional-basis cost,
// and the paid-vacation pay estimate. Split out of vacation.ts so App.tsx (not
// lazy-loaded) can use estimateVacationPay for the Home projected total without
// pulling the heavy date-holidays dep into the main bundle — that stays behind
// VacationPlanner's React.lazy boundary. See CLAUDE.md's "heavy deps get
// lazy-loaded" convention.

import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { GrossRate, Payslip, Shift } from "./types";
import { netFactorForMonth, rateForDate } from "./earnings";

export interface WeekdayProfile {
  p: number; // probability the user is scheduled that weekday (0..1)
  n: number; // distinct dates worked on that weekday (sample size)
}

function countWeekdayOccurrences(minIso: string, maxIso: string, wd: number): number {
  let c = 0;
  for (const d of eachDayOfInterval({ start: parseISO(minIso), end: parseISO(maxIso) })) {
    if (getDay(d) === wd) c += 1;
  }
  return c;
}

/** Per-weekday roster profile derived from worked history. */
export function buildWeekdayProfile(worked: Shift[]): WeekdayProfile[] {
  const blank: WeekdayProfile[] = Array.from({ length: 7 }, () => ({ p: 0, n: 0 }));
  const ws = worked.filter((s) => s.status === "worked" && s.date && s.shiftType !== "meeting");
  if (ws.length === 0) return blank;

  const dates = ws.map((s) => s.date).sort();
  const minIso = dates[0];
  const maxIso = dates[dates.length - 1];

  for (let wd = 0; wd < 7; wd++) {
    const distinctDates = new Set(ws.filter((s) => getDay(parseISO(s.date)) === wd).map((s) => s.date));
    const occ = countWeekdayOccurrences(minIso, maxIso, wd);
    // A scheduled day costs ONE vacation day regardless of crossing midnight.
    blank[wd] = { p: occ > 0 ? Math.min(1, distinctDates.size / occ) : 0, n: distinctDates.size };
  }
  return blank;
}

/** Average distinct working-days per week across the worked history. */
export function avgWorkingDaysPerWeek(worked: Shift[]): number {
  const dates = worked
    .filter((s) => s.status === "worked" && s.date && s.shiftType !== "meeting")
    .map((s) => s.date)
    .sort();
  if (dates.length === 0) return 0;
  const spanDays =
    Math.abs(parseISO(dates[dates.length - 1]).getTime() - parseISO(dates[0]).getTime()) /
      86_400_000 +
    1;
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

/**
 * Average gross pay per worked shift over a trailing window (default last 13
 * weeks / 91 days, the usual Urlaubsentgelt reference period) ending `asOfIso`.
 * Falls back to all worked history if the window is empty. Used as the flat
 * per-day rate for estimated paid vacation days — there's no real shift to price.
 */
export function avgGrossPerWorkedDay(
  worked: Shift[],
  rates: GrossRate[],
  asOfIso: string,
  windowDays = 91,
): number {
  const cutoff = new Date(asOfIso + "T00:00");
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const isCandidate = (s: Shift) => s.status === "worked" && s.shiftType !== "meeting";
  let sample = worked.filter((s) => isCandidate(s) && s.date >= cutoffIso && s.date <= asOfIso);
  if (sample.length === 0) sample = worked.filter(isCandidate);
  if (sample.length === 0) return 0;
  const total = sample.reduce((sum, s) => {
    const rate = s.grossRate ?? rateForDate(s.date, rates) ?? 0;
    return sum + (s.actualHours ?? 0) * rate;
  }, 0);
  return total / sample.length;
}

export interface VacationPayDay {
  date: string; // ISO yyyy-MM-dd
  p: number; // profile probability for this weekday (informational)
}

/**
 * Specific calendar dates within [fromIso, toIso] estimated as paid vacation.
 *
 * NOT a per-weekday >=50% cutoff — several weekdays can each individually sit
 * around 50% without you ever working all of them the same week (that double-
 * counts and overshoots your real weekly average). Instead: sum each day's
 * weekday-probability across the range (the same Bernoulli-expectation figure
 * as the "shifts you'd miss" card), subtract days still actually on the roster,
 * round to a target day-count, then rank the remaining candidate days by
 * probability and take only that many — the days you're MOST likely to have
 * been scheduled, capped at how many the average says you'd really work.
 */
export function estimateVacationPayDays(
  fromIso: string,
  toIso: string,
  worked: Shift[],
  scheduledInRange: Shift[],
): VacationPayDay[] {
  if (toIso < fromIso) return [];
  const profile = buildWeekdayProfile(worked);
  const rostered = new Set(
    scheduledInRange
      .filter((s) => s.status !== "swapped-out" && s.shiftType !== "meeting")
      .map((s) => s.date),
  );
  let expected = 0;
  const candidates: VacationPayDay[] = [];
  for (const d of eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) })) {
    const iso = format(d, "yyyy-MM-dd");
    const { p } = profile[getDay(d)];
    expected += p; // still-rostered days count toward the baseline too (see below)
    if (!rostered.has(iso)) candidates.push({ date: iso, p });
  }
  const target = Math.min(candidates.length, Math.round(Math.max(0, expected - rostered.size)));
  return candidates
    .slice()
    .sort((a, b) => b.p - a.p || a.date.localeCompare(b.date))
    .slice(0, target)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface VacationPayEstimate {
  days: number; // estimated paid-vacation days (profile-expected minus what's still on the roster)
  avgDayGross: number; // flat gross €/day used
  gross: number;
  net: number;
}

const ZERO_PAY_ESTIMATE: VacationPayEstimate = { days: 0, avgDayGross: 0, gross: 0, net: 0 };

/**
 * Light estimate of paid-vacation days + pay for [fromIso, toIso] — the aggregate
 * counterpart of estimateVacationPayDays (days.length priced at your recent
 * average day's gross, run through the month's net factor).
 *
 * This is a forward guess, not payroll math — Urlaubsentgelt is legally an
 * average-earnings calculation, which the payslip settles for real once it
 * arrives.
 */
export function estimateVacationPay(
  fromIso: string,
  toIso: string,
  worked: Shift[],
  scheduledInRange: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
): VacationPayEstimate {
  if (toIso < fromIso) return ZERO_PAY_ESTIMATE;
  const days = estimateVacationPayDays(fromIso, toIso, worked, scheduledInRange);
  if (days.length === 0) return ZERO_PAY_ESTIMATE;

  const avgDayGross = avgGrossPerWorkedDay(worked, rates, toIso);
  const gross = days.length * avgDayGross;
  const { factor } = netFactorForMonth(toIso.slice(0, 7), payslips);
  const net = gross * (factor ?? 1);
  return { days: days.length, avgDayGross, gross, net };
}
