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
// Holidays-independent math (roster profile, proportional cost, pay estimate) lives in
// vacationPay.ts, kept dep-free so App.tsx can use it without pulling date-holidays out
// from behind VacationPlanner's lazy-load boundary. Re-exported here for convenience.

import Holidays from "date-holidays";
import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { Shift } from "./types";
import { avgWorkingDaysPerWeek, buildWeekdayProfile, estimateScheduledCost } from "./vacationPay";

export * from "./vacationPay";

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

export interface VacationCalc {
  calendarDays: number;
  werktage: number; // Werktage-basis cost vs the 24 budget
  arbeitstage: number; // Mon–Fri minus holidays
  holidays: Holiday[];
  scheduleCost: ReturnType<typeof estimateScheduledCost>; // proportional-basis cost (scheduled shifts)
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
