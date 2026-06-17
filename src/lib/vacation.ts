// Vacation calculator.
//
// Two views, because the user's contract (§8) states 24 Werktage but is "proportional
// to actual schedule" and the user is unsure how a day is spent:
//
//  1. Werktage (legal/contract count) — deterministic: Mon–Sat in the range, minus
//     Berlin public holidays. This is what's deducted from the 24-day budget.
//  2. Schedule-based cost — a RANGE: how many working-days the vacation actually costs
//     given the user's typical roster, estimated from historical weekday frequency.
//     A midnight-crossing night shift counts as 2 working days.
//
// The pure functions take plain inputs; berlinHolidays() wraps the date-holidays dep.

import Holidays from "date-holidays";
import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { Shift } from "./types";

export interface Holiday {
  date: string; // ISO yyyy-MM-dd
  name: string;
}

/** Berlin public holidays (type "public") between two ISO dates, inclusive. */
export function berlinHolidays(fromIso: string, toIso: string): Holiday[] {
  const hd = new Holidays("DE", "BE");
  const fromY = Number(fromIso.slice(0, 4));
  const toY = Number(toIso.slice(0, 4));
  const out: Holiday[] = [];
  for (let y = fromY; y <= toY; y++) {
    for (const h of hd.getHolidays(y)) {
      if (h.type !== "public") continue;
      const date = String(h.date).slice(0, 10);
      if (date >= fromIso && date <= toIso) out.push({ date, name: h.name });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Werktage in [from, to]: every day except Sundays and the given holiday dates.
 * Pass includeSaturday=false to count Arbeitstage (Mon–Fri) instead.
 */
export function countWerktage(
  fromIso: string,
  toIso: string,
  holidayDates: Set<string>,
  includeSaturday = true,
): number {
  if (toIso < fromIso) return 0;
  let c = 0;
  for (const d of eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) })) {
    const wd = getDay(d); // 0=Sun … 6=Sat
    if (wd === 0) continue; // Sunday is never a Werktag
    if (!includeSaturday && wd === 6) continue;
    if (holidayDates.has(format(d, "yyyy-MM-dd"))) continue;
    c += 1;
  }
  return c;
}

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
  const ws = worked.filter((s) => s.status === "worked" && s.date);
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
  const dates = worked.filter((s) => s.status === "worked" && s.date).map((s) => s.date).sort();
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

export interface VacationCalc {
  calendarDays: number;
  werktage: number; // Werktage-basis cost vs the 24 budget
  arbeitstage: number; // Mon–Fri minus holidays
  holidays: Holiday[];
  scheduleCost: ScheduleCost; // proportional-basis cost (scheduled shifts)
  daysPerWeek: number; // avg working-days/week from history
}

/** One-shot calculation for a date range. */
export function calcVacation(fromIso: string, toIso: string, worked: Shift[]): VacationCalc {
  const holidays = berlinHolidays(fromIso, toIso);
  const holidaySet = new Set(holidays.map((h) => h.date));
  const calendarDays =
    toIso < fromIso ? 0 : eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) }).length;
  return {
    calendarDays,
    werktage: countWerktage(fromIso, toIso, holidaySet, true),
    arbeitstage: countWerktage(fromIso, toIso, holidaySet, false),
    holidays,
    scheduleCost: estimateScheduledCost(fromIso, toIso, buildWeekdayProfile(worked)),
    daysPerWeek: avgWorkingDaysPerWeek(worked),
  };
}
