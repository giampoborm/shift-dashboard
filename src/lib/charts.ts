// Pure chart aggregations. No React, no recharts, no DB — each function takes the
// same (shifts, rates, payslips, settings) the rest of the app passes around and
// returns plain rows the chart components map straight onto recharts series.
//
// All money math goes through computeShiftEarnings so the invariants hold here too:
//   - tips never run through tax math (usableTips = tips × (1 − tipPoolRate))
//   - gross comes from the authoritative rate table snapshot
// tips/hour uses REPORTED tips ÷ hours, matching the ShiftTable "Tips/h" column.

import type { GrossRate, Payslip, Settings, Shift, ShiftType } from "./types";
import { computeShiftEarnings, monthOf } from "./earnings";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "yyyy-MM" -> "Apr '26". */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const idx = Number(m[2]) - 1;
  return `${MONTHS[idx] ?? m[2]} '${m[1].slice(2)}`;
}

export interface MonthPoint {
  month: string; // "yyyy-MM"
  label: string; // "Apr '26"
  shifts: number;
  hours: number;
  netWage: number;
  usableTips: number;
  takeHome: number;
  reportedTips: number;
  tipsPerHour: number | null; // reported tips ÷ hours
}

/** One point per calendar month (worked shifts only), sorted chronologically. */
export function byMonth(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): MonthPoint[] {
  const map = new Map<string, MonthPoint>();
  for (const s of shifts) {
    if (s.status !== "worked") continue;
    const month = monthOf(s.date);
    let p = map.get(month);
    if (!p) {
      p = {
        month,
        label: monthLabel(month),
        shifts: 0,
        hours: 0,
        netWage: 0,
        usableTips: 0,
        takeHome: 0,
        reportedTips: 0,
        tipsPerHour: null,
      };
      map.set(month, p);
    }
    const e = computeShiftEarnings(s, rates, payslips, settings);
    p.shifts += 1;
    p.hours += s.actualHours ?? 0;
    p.netWage += e.netPay;
    p.usableTips += e.usableTips;
    p.takeHome += e.takeHome;
    p.reportedTips += s.tips ?? 0;
  }
  const rows = Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
  for (const p of rows) p.tipsPerHour = p.hours > 0 ? p.reportedTips / p.hours : null;
  return rows;
}

export interface TypePoint {
  type: ShiftType;
  shifts: number;
  hours: number;
  reportedTips: number;
  usableTips: number;
  tipsPerHour: number | null; // reported tips ÷ hours
}

/** One row per shift type (worked shifts only), in the canonical type order. */
export function byType(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): TypePoint[] {
  const order: ShiftType[] = ["opening", "late-morning", "mid-day", "early-closing", "closing"];
  const map = new Map<ShiftType, TypePoint>();
  for (const s of shifts) {
    if (s.status !== "worked") continue;
    let p = map.get(s.shiftType);
    if (!p) {
      p = { type: s.shiftType, shifts: 0, hours: 0, reportedTips: 0, usableTips: 0, tipsPerHour: null };
      map.set(s.shiftType, p);
    }
    const e = computeShiftEarnings(s, rates, payslips, settings);
    p.shifts += 1;
    p.hours += s.actualHours ?? 0;
    p.reportedTips += s.tips ?? 0;
    p.usableTips += e.usableTips;
  }
  const rows: TypePoint[] = [];
  for (const t of order) {
    const p = map.get(t);
    if (!p) continue;
    p.tipsPerHour = p.hours > 0 ? p.reportedTips / p.hours : null;
    rows.push(p);
  }
  return rows;
}

export interface CompositionSlice {
  name: string;
  value: number;
}

/** Take-home split into net wage vs usable tips — the share pie. */
export function takeHomeComposition(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): CompositionSlice[] {
  let netWage = 0;
  let usableTips = 0;
  for (const s of shifts) {
    if (s.status !== "worked") continue;
    const e = computeShiftEarnings(s, rates, payslips, settings);
    netWage += e.netPay;
    usableTips += e.usableTips;
  }
  const out: CompositionSlice[] = [];
  if (netWage > 0) out.push({ name: "Net wage", value: netWage });
  if (usableTips > 0) out.push({ name: "Usable tips", value: usableTips });
  return out;
}
