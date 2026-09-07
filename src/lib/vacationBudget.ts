// Which vacation days are actually PAID, and which are days off you don't get paid for.
//
// The counting rule (vacationPayroll.ts) says how many days a range costs. It does
// not say whether payroll will pay for them, because the entitlement is finite:
//
//   Entgeltabrechnung 8/2026 — Tage LJ alt 20,00 | Genommen 6,00 | Tage verfuegbar 14,00
//
// That last figure is the one this module models. Once the year's 20 days are used,
// further time off is unpaid leave: it still costs you the day, but it earns no
// Urlaubsentgelt. Without this, booking a 3-week trip in November quotes three weeks
// of vacation pay you would never receive, and the month total is simply wrong.
//
// The whole module is built on ONE primitive: `paidChargedDates`. Everything else
// filters through it, so the paid/unpaid split can never disagree between the
// planner card, the month projection and the yearly balance.
//
// Rules it encodes:
//  * The entitlement is PER CALENDAR YEAR, so a range crossing New Year is split
//    and each part charged against its own year's budget.
//  * Days are consumed in DATE order, not in the order you happened to record them.
//    An earlier trip eats the budget first, whichever you typed in first.
//
// Dep-free (no date-holidays), like the rest of the payroll basis.

import type { Vacation } from "./types";
import { chargeableVacationDates, DEFAULT_CHARGEABLE_WEEKDAYS } from "./vacationPayroll";

/** Every charged date across every vacation, de-duplicated and in date order. */
export function allChargedDates(
  vacations: Vacation[],
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): string[] {
  const out = new Set<string>();
  for (const v of vacations) {
    for (const d of chargeableVacationDates(v.from, v.to, weekdays)) out.add(d);
  }
  return [...out].sort();
}

/**
 * The charged dates the entitlement actually covers.
 *
 * Walks every recorded vacation day in date order and hands out each year's budget
 * until it runs out. Dates not in the returned set are days off that earn nothing.
 */
export function paidChargedDates(
  vacations: Vacation[],
  entitlement: number,
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): Set<string> {
  const paid = new Set<string>();
  const usedByYear = new Map<string, number>();
  for (const date of allChargedDates(vacations, weekdays)) {
    const year = date.slice(0, 4);
    const used = usedByYear.get(year) ?? 0;
    if (used < entitlement) {
      paid.add(date);
      usedByYear.set(year, used + 1);
    }
  }
  return paid;
}

export interface VacationBudgetUse {
  /** Days the counting rule charges for this range. */
  charged: number;
  /** Of those, the ones the entitlement covers — the only ones that pay. */
  paid: number;
  /** Days off beyond the entitlement: still time away, but €0. */
  unpaid: number;
  /** Entitlement still free before this range starts (its first year). */
  availableBefore: number;
  /** Entitlement left after it. */
  availableAfter: number;
  /** The charged dates that pay, in date order. */
  paidDates: string[];
  /** The charged dates that don't. */
  unpaidDates: string[];
}

/**
 * What a range costs against the budget, given everything else already recorded.
 *
 * `others` should be the recorded vacations EXCLUDING this range — when planning a
 * new trip it is simply the saved list; when re-examining a saved one, filter it out
 * first so it doesn't consume its own budget.
 */
export function vacationBudgetUse(
  fromIso: string,
  toIso: string,
  others: Vacation[],
  entitlement: number,
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): VacationBudgetUse {
  const candidate: Vacation = {
    from: fromIso,
    to: toIso,
    werktage: 0,
    scheduledCost: 0,
    createdAt: "",
  };
  const mine = chargeableVacationDates(fromIso, toIso, weekdays);
  const paidSet = paidChargedDates([...others, candidate], entitlement, weekdays);

  const paidDates = mine.filter((d) => paidSet.has(d));
  const unpaidDates = mine.filter((d) => !paidSet.has(d));

  // Budget free before this range, measured in its opening year.
  const year = fromIso.slice(0, 4);
  const consumedBefore = allChargedDates(others, weekdays).filter(
    (d) => d.slice(0, 4) === year && d < fromIso,
  ).length;
  const availableBefore = Math.max(0, entitlement - consumedBefore);

  return {
    charged: mine.length,
    paid: paidDates.length,
    unpaid: unpaidDates.length,
    availableBefore,
    availableAfter: Math.max(0, availableBefore - paidDates.filter((d) => d.slice(0, 4) === year).length),
    paidDates,
    unpaidDates,
  };
}

/** Paid charged dates falling inside a "yyyy-MM" month, across all vacations. */
export function paidChargedDatesInMonth(
  month: string,
  vacations: Vacation[],
  entitlement: number,
  weekdays: number[] = DEFAULT_CHARGEABLE_WEEKDAYS,
): string[] {
  return [...paidChargedDates(vacations, entitlement, weekdays)]
    .filter((d) => d.slice(0, 7) === month)
    .sort();
}
