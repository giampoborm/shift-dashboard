// Payslip reconciliation — compares what the logged shifts say a month's wage
// should be (Σ hours × rate: the app's derived brutto, and netto via the slip's
// own net factor) against the real payslip entered in Settings. Pure; the red "!"
// on Home's salary card and its detail popup read from this.
//
// Note the built-in coupling: the app's netto is ALWAYS gross × (slip net ÷ slip
// gross), so when logged hours match payroll's hours the derived figures land on
// the payslip by construction. A discrepancy therefore means the HOURS (or rate)
// disagree — a missed shift, payroll counting differently, or a correction/bonus.
//
// Vacation is folded in the same way sick days are, but from the `vacations` table
// rather than the shift list: a vacation is a RANGE, not a set of shifts, and the
// slip pays it on its own line (Lohnart 171 "Urlaub"). Without it a month with time
// off always looks short by exactly those hours — August 2026 by 36,00.

import type { GrossRate, Payslip, Shift } from "./types";
import { isPaidShift, monthOf, rateForDate } from "./earnings";

/** Derived-vs-payslip gaps below this many € are rounding noise, not discrepancies. */
export const RECONCILE_TOLERANCE_EUR = 1;

export interface Reconciliation {
  slip: Payslip;
  loggedShifts: number;
  loggedHours: number;
  derivedGross: number; // Σ hours × rate over the month's paid shifts (worked + sick) + vacation
  derivedNet: number; // derivedGross × the slip's own net factor
  vacationDays: number; // payroll vacation days in the month (slip's Lohnart 620)
  vacationHours: number; // their paid hours (slip's Lohnart 171)
  vacationGross: number;
  deltaHours: number; // logged − slip
  deltaGross: number; // derived − slip
  deltaNet: number;
  discrepant: boolean; // |deltaGross| beyond tolerance
  /** True when the vacation figures above are the slip's own, not the rule's guess. */
  vacationObserved: boolean;
  /** Days the counting rule predicted for this month, when there was a slip to check. */
  vacationDaysExpected: number | null;
  /** The rule predicted a different number of days than the slip charged.
   *
   *  Deliberately INDEPENDENT of `discrepant`. Because vacation pay now takes its
   *  figures from the slip when the slip has them, the money reconciles by
   *  construction — so a counting rule that has drifted out of date would leave no
   *  trace in the euro totals at all. This flag is the only place it shows up. */
  ruleStale: boolean;
  /** Which component the MONEY discrepancy is attributable to. */
  cause: DiscrepancyCause;
  /** Anything worth a badge: a money gap, or a counting rule that no longer holds. */
  needsAttention: boolean;
}

/**
 * What a discrepancy is blamed on. Worth attributing because the app's netto is
 * gross × the slip's own net factor, so a gap can never be "the tax was wrong" —
 * it is always hours, or the vacation count, or something unmodelled.
 */
export type DiscrepancyCause = "none" | "vacation-rule" | "hours" | "unknown";

/** Vacation the employer paid in this month, from lib/vacationPayroll. */
export interface ReconcileVacation {
  days: number;
  hours: number;
  gross: number;
  /** True when days/hours came off the payslip rather than from the counting rule. */
  observed?: boolean;
  /** What the counting rule predicted, for comparison against an observed count. */
  expectedDays?: number;
}

/**
 * Compare a month's PAID shifts (worked + sick — the employer pays both), plus any
 * paid vacation days, against its payslip. Returns null when there is
 * no usable payslip for the month or nothing logged to compare against (e.g.
 * months from before the history starts).
 */
export function reconcileMonth(
  month: string,
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  vacation: ReconcileVacation = { days: 0, hours: 0, gross: 0 },
): Reconciliation | null {
  const slip = payslips.find((p) => p.month === month);
  if (!slip || !(slip.totalGross > 0)) return null;
  const paidM = shifts.filter((s) => isPaidShift(s) && monthOf(s.date) === month);
  if (paidM.length === 0 && vacation.days === 0) return null;

  let loggedHours = vacation.hours;
  let derivedGross = vacation.gross;
  for (const s of paidM) {
    const h = s.actualHours ?? 0;
    loggedHours += h;
    derivedGross += h * (s.grossRate ?? rateForDate(s.date, rates) ?? 0);
  }
  const factor = slip.totalNet / slip.totalGross;
  const derivedNet = derivedGross * factor;
  const deltaGross = derivedGross - slip.totalGross;
  const discrepant = Math.abs(deltaGross) > RECONCILE_TOLERANCE_EUR;

  // The counting rule is stale when the slip charged a different number of vacation
  // days than the rule predicted. This is the self-check that makes the whole
  // vacation model honest over time: payroll changing how it counts shows up here
  // rather than silently skewing every future estimate.
  const expected = vacation.expectedDays;
  const ruleStale =
    !!vacation.observed && expected != null && Math.abs(expected - vacation.days) > 0.001;

  let cause: DiscrepancyCause = "none";
  if (discrepant) {
    if (ruleStale) cause = "vacation-rule";
    else if (Math.abs(loggedHours - slip.totalHours) > 0.01) cause = "hours";
    else cause = "unknown";
  }

  return {
    slip,
    loggedShifts: paidM.length,
    loggedHours,
    derivedGross,
    derivedNet,
    vacationDays: vacation.days,
    vacationHours: vacation.hours,
    vacationGross: vacation.gross,
    deltaHours: loggedHours - slip.totalHours,
    deltaGross,
    deltaNet: derivedNet - slip.totalNet,
    discrepant,
    vacationObserved: !!vacation.observed,
    vacationDaysExpected: expected ?? null,
    ruleStale,
    cause,
    needsAttention: discrepant || ruleStale,
  };
}
