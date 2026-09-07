// Vacation calculator.
//
// TWO views of the same time off, because payroll and the contract count it in
// different units:
//
//  0. Payroll (what HR actually deducts) — the headline, and the only one that is
//     auditable against a payslip: the HOURS you'd have worked in the range ÷ the
//     flat 6 h a vacation day is paid at, rounded up, against a 20-day
//     entitlement. That is why four ~7 h shifts a week cost ~4.7 days, not 4.
//     The mechanism and its evidence live in vacationCharge.ts; the pricing in
//     vacationPayroll.ts.
//  1. Werktage (legal/contract count) — deterministic: Mon–Sat in the range, minus
//     Berlin public holidays, against the 24 of contract §8. Paperwork, not pay.
//
// They are units, not rivals: never mix consumption from one with the budget of
// the other.
//
// Alongside them, "shifts you'd miss" is reported as a RANGE — not a budget, an
// opportunity cost: the tips of those shifts are simply gone, and no payslip line
// replaces them.
//
// The pure functions take plain inputs; berlinHolidays() wraps the date-holidays
// dep. Everything holidays-independent lives in vacationPay.ts (roster side) and
// vacationCharge.ts / vacationPayroll.ts (payroll side), kept dep-free so App.tsx
// can use them without pulling date-holidays out from behind VacationPlanner's
// lazy-load boundary. Re-exported here for convenience.

import Holidays from "date-holidays";
import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { Shift } from "./types";
import {
  avgWeeklyHours,
  avgWorkingDaysPerWeek,
  buildWeekdayHoursProfile,
  buildWeekdayProfile,
  estimateScheduledCost,
} from "./vacationPay";
import { chargeVacation } from "./vacationCharge";

export * from "./vacationPay";
export * from "./vacationCharge";
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
  /** Payroll-basis cost vs the 20-day entitlement — the real deduction. */
  charge: ReturnType<typeof chargeVacation>;
  werktage: number; // Werktage-basis cost vs the 24 budget
  arbeitstage: number; // Mon–Fri minus holidays
  holidays: Holiday[];
  /** Shifts you'd miss — lost tips, not a budget. */
  scheduleCost: ReturnType<typeof estimateScheduledCost>;
  daysPerWeek: number; // avg working-days/week from history
  weeklyHours: number; // avg rostered hours/week — the input to the payroll charge
}

export interface VacationCalcOptions {
  /** Flat hours one vacation day is paid at. */
  dayHours: number;
  /** Days already spent on vacation — removed from the roster observation window
   *  so past time off can't shrink the estimate of a typical week. */
  vacationDates?: Set<string>;
}

/** One-shot calculation for a date range. `history` is the full shift list —
 *  the roster-profile helpers pick out the rostered days (worked + sick). */
export function calcVacation(
  fromIso: string,
  toIso: string,
  history: Shift[],
  opts: VacationCalcOptions,
): VacationCalc {
  const { dayHours, vacationDates } = opts;
  const holidays = berlinHolidays(fromIso, toIso);
  const holidaySet = new Set(holidays.map((h) => h.date));
  const calendarDays =
    toIso < fromIso
      ? 0
      : eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) }).length;
  const hoursProfile = buildWeekdayHoursProfile(history, vacationDates);
  return {
    calendarDays,
    charge: chargeVacation(fromIso, toIso, hoursProfile, dayHours),
    werktage: countWerktage(fromIso, toIso, holidaySet, true),
    arbeitstage: countWerktage(fromIso, toIso, holidaySet, false),
    holidays,
    scheduleCost: estimateScheduledCost(fromIso, toIso, buildWeekdayProfile(history, vacationDates)),
    daysPerWeek: avgWorkingDaysPerWeek(history, vacationDates),
    weeklyHours: avgWeeklyHours(hoursProfile),
  };
}
