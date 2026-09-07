// Vacation calculator.
//
// THREE views of the same time off, because the contract, payroll, and reality each
// count it differently:
//
//  0. Payroll (what HR actually deducts) — the headline, because it is the only one
//     that is auditable: chargeable weekdays in the range, paid a flat 6 h each,
//     against a 20-day entitlement. Reverse-engineered from a real payslip; lives in
//     vacationPayroll.ts, which documents the evidence.
//  1. Werktage (legal/contract count) — deterministic: Mon–Sat in the range, minus
//     Berlin public holidays. This is what's deducted from the 24-day budget.
//  2. Schedule-based cost — a RANGE: how many working-days the vacation actually costs
//     given the user's typical roster, estimated from historical weekday frequency.
//     A midnight-crossing night shift counts as 2 working days.
//
// They are units, not rivals: never mix consumption from one with the budget of another.
//
// The pure functions take plain inputs; berlinHolidays() wraps the date-holidays dep.
// Holidays-independent math (roster profile, proportional cost, pay estimate) lives in
// vacationPay.ts, kept dep-free so App.tsx can use it without pulling date-holidays out
// from behind VacationPlanner's lazy-load boundary. Re-exported here for convenience.

import Holidays from "date-holidays";
import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { Shift } from "./types";
import { avgWorkingDaysPerWeek, buildWeekdayProfile, estimateScheduledCost } from "./vacationPay";
import { chargeableVacationDates, DEFAULT_CHARGEABLE_WEEKDAYS } from "./vacationPayroll";

export * from "./vacationPay";
export * from "./vacationPayroll";

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
  payrollDays: number; // payroll-basis cost vs the 20-day entitlement — the real deduction
  payrollDates: string[]; // the specific days charged
  werktage: number; // Werktage-basis cost vs the 24 budget
  arbeitstage: number; // Mon–Fri minus holidays
  holidays: Holiday[];
  scheduleCost: ReturnType<typeof estimateScheduledCost>; // proportional-basis cost (scheduled shifts)
  daysPerWeek: number; // avg working-days/week from history
}

export interface VacationCalcOptions {
  /** Weekdays payroll charges (getDay numbering). Defaults to Tue–Sat. */
  chargeableWeekdays?: number[];
  /** Days already spent on vacation — removed from the roster observation window
   *  so past time off can't shrink the proportional entitlement. */
  vacationDates?: Set<string>;
}

/** One-shot calculation for a date range. `history` is the full shift list —
 *  the roster-profile helpers pick out the rostered days (worked + sick). */
export function calcVacation(
  fromIso: string,
  toIso: string,
  history: Shift[],
  opts: VacationCalcOptions = {},
): VacationCalc {
  const { chargeableWeekdays = DEFAULT_CHARGEABLE_WEEKDAYS, vacationDates } = opts;
  const holidays = berlinHolidays(fromIso, toIso);
  const holidaySet = new Set(holidays.map((h) => h.date));
  const calendarDays =
    toIso < fromIso ? 0 : eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) }).length;
  const payrollDates = chargeableVacationDates(fromIso, toIso, chargeableWeekdays);
  return {
    calendarDays,
    payrollDays: payrollDates.length,
    payrollDates,
    werktage: countWerktage(fromIso, toIso, holidaySet, true),
    arbeitstage: countWerktage(fromIso, toIso, holidaySet, false),
    holidays,
    scheduleCost: estimateScheduledCost(fromIso, toIso, buildWeekdayProfile(history, vacationDates)),
    daysPerWeek: avgWorkingDaysPerWeek(history, vacationDates),
  };
}
