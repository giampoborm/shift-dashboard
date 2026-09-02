// Payslip reconciliation — compares what the logged shifts say a month's wage
// should be (Σ hours × rate: the app's derived brutto, and netto via the slip's
// own net factor) against the real payslip entered in Settings. Pure; the red "!"
// on Home's salary card and its detail popup read from this.
//
// Note the built-in coupling: the app's netto is ALWAYS gross × (slip net ÷ slip
// gross), so when logged hours match payroll's hours the derived figures land on
// the payslip by construction. A discrepancy therefore means the HOURS (or rate)
// disagree — a missed shift, payroll counting differently, or a correction/bonus.

import type { GrossRate, Payslip, Shift } from "./types";
import { isPaidShift, monthOf, rateForDate } from "./earnings";

/** Derived-vs-payslip gaps below this many € are rounding noise, not discrepancies. */
export const RECONCILE_TOLERANCE_EUR = 1;

export interface Reconciliation {
  slip: Payslip;
  loggedShifts: number;
  loggedHours: number;
  derivedGross: number; // Σ hours × rate over the month's paid shifts (worked + sick)
  derivedNet: number; // derivedGross × the slip's own net factor
  deltaHours: number; // logged − slip
  deltaGross: number; // derived − slip
  deltaNet: number;
  discrepant: boolean; // |deltaGross| beyond tolerance
}

/**
 * Compare a month's PAID shifts (worked + sick — the employer pays both) against
 * its payslip. Returns null when there is
 * no usable payslip for the month or nothing logged to compare against (e.g.
 * months from before the history starts).
 */
export function reconcileMonth(
  month: string,
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
): Reconciliation | null {
  const slip = payslips.find((p) => p.month === month);
  if (!slip || !(slip.totalGross > 0)) return null;
  const paidM = shifts.filter((s) => isPaidShift(s) && monthOf(s.date) === month);
  if (paidM.length === 0) return null;

  let loggedHours = 0;
  let derivedGross = 0;
  for (const s of paidM) {
    const h = s.actualHours ?? 0;
    loggedHours += h;
    derivedGross += h * (s.grossRate ?? rateForDate(s.date, rates) ?? 0);
  }
  const factor = slip.totalNet / slip.totalGross;
  const derivedNet = derivedGross * factor;
  const deltaGross = derivedGross - slip.totalGross;

  return {
    slip,
    loggedShifts: paidM.length,
    loggedHours,
    derivedGross,
    derivedNet,
    deltaHours: loggedHours - slip.totalHours,
    deltaGross,
    deltaNet: derivedNet - slip.totalNet,
    discrepant: Math.abs(deltaGross) > RECONCILE_TOLERANCE_EUR,
  };
}
