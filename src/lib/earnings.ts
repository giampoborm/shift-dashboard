// Pure earnings math. No DB, no React — everything takes its inputs as arguments
// so it is trivially unit-testable. See earnings.test.ts for the grounded checks.
//
// Model (from CLAUDE.md):
//   GROSS        = hours * grossRate(shift date)        [rate table is authoritative]
//   net_factor   = payslip total_net / total_gross      [per month, effective-dated]
//   NET wage     = GROSS * net_factor(period)
//   usable_tips  = reported_tips * (1 - tip_pool_rate)
//   TAKE-HOME    = NET wage + usable_tips
// Tips are tax/SV-free (§3 Nr. 51 EStG) — never run them through the tax math.

import type { GrossRate, Payslip, Settings, Shift, ShiftEarnings } from "./types";

/** Month key "yyyy-MM" from an ISO date. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * Gross €/h in effect on `date`. Picks the latest rate whose effectiveFrom <= date.
 * Returns undefined if no rate covers the date.
 */
export function rateForDate(date: string, rates: GrossRate[]): number | undefined {
  let best: GrossRate | undefined;
  for (const r of rates) {
    if (r.effectiveFrom <= date) {
      if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
    }
  }
  return best?.rate;
}

/**
 * Net factor for a given "yyyy-MM". Uses that month's payslip when present;
 * otherwise falls back to the aggregate net/gross across all payslips.
 * Returns { factor, estimated }. factor is null only when there are no payslips at all.
 */
export function netFactorForMonth(
  month: string,
  payslips: Payslip[],
): { factor: number | null; estimated: boolean } {
  const exact = payslips.find((p) => p.month === month);
  if (exact && exact.totalGross > 0) {
    return { factor: exact.totalNet / exact.totalGross, estimated: false };
  }
  const totalGross = payslips.reduce((s, p) => s + p.totalGross, 0);
  const totalNet = payslips.reduce((s, p) => s + p.totalNet, 0);
  if (totalGross > 0) return { factor: totalNet / totalGross, estimated: true };
  return { factor: null, estimated: true };
}

export function grossPay(hours: number, rate: number): number {
  return hours * rate;
}

export function usableTips(tips: number, tipPoolRate: number): number {
  return tips * (1 - tipPoolRate);
}

/**
 * Compute all derived earnings for one shift. `grossRate` is taken from the shift's
 * own snapshot when present, else looked up from the rate table.
 */
export function computeShiftEarnings(
  shift: Shift,
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): ShiftEarnings {
  const hours = shift.actualHours ?? 0;
  const rate = shift.grossRate ?? rateForDate(shift.date, rates) ?? 0;
  const gross = grossPay(hours, rate);

  const { factor, estimated } = netFactorForMonth(monthOf(shift.date), payslips);
  const netFactorUsed = factor ?? 1; // no payslips at all => show gross as net
  const net = gross * netFactorUsed;

  const tips = usableTips(shift.tips ?? 0, settings.tipPoolRate);
  const takeHome = net + tips;
  const workingDays = shift.crossesMidnight ? 2 : 1;

  return {
    grossPay: gross,
    netPay: net,
    usableTips: tips,
    takeHome,
    tipsPerHour: hours > 0 ? (shift.tips ?? 0) / hours : null,
    netPerHour: hours > 0 ? net / hours : null,
    workingDays,
    netFactorUsed,
    netFactorEstimated: estimated || factor === null,
  };
}

export interface EarningsTotals {
  shifts: number;
  hours: number;
  grossPay: number;
  netPay: number;
  reportedTips: number;
  usableTips: number;
  takeHome: number;
  workingDays: number;
}

/** Aggregate earnings across many shifts. */
export function sumEarnings(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): EarningsTotals {
  const t: EarningsTotals = {
    shifts: 0,
    hours: 0,
    grossPay: 0,
    netPay: 0,
    reportedTips: 0,
    usableTips: 0,
    takeHome: 0,
    workingDays: 0,
  };
  for (const s of shifts) {
    const e = computeShiftEarnings(s, rates, payslips, settings);
    t.shifts += 1;
    t.hours += s.actualHours ?? 0;
    t.grossPay += e.grossPay;
    t.netPay += e.netPay;
    t.reportedTips += s.tips ?? 0;
    t.usableTips += e.usableTips;
    t.takeHome += e.takeHome;
    t.workingDays += e.workingDays;
  }
  return t;
}
