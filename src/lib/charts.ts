// Pure chart aggregations. No React, no recharts, no DB — each function takes the
// same (shifts, rates, payslips, settings) the rest of the app passes around and
// returns plain rows the chart components map straight onto recharts series.
//
// All money math goes through computeShiftEarnings so the invariants hold here too:
//   - tips never run through tax math (usableTips = tips × (1 − tipPoolRate))
//   - gross comes from the authoritative rate table snapshot
// tips/hour uses REPORTED tips ÷ hours, matching the ShiftTable "Tips/h" column.
//
// TWO MONEY UNIVERSES, deliberately kept apart:
//   - What a MONTH PAID (byMonth, takeHomeComposition) counts every euro that
//     reaches him: worked shifts, sick days (Entgeltfortzahlung keeps the wage
//     running — hence isPaidShift, never a bare status === "worked"), and paid
//     vacation. Vacation produces NO shift rows at all — it is a range in its own
//     table — so without the explicit merge below a month off reads as a month
//     unpaid, while the Home card for the same month reads it correctly.
//   - What a SHIFT PAYS (byType, tipsPerHour) stays strictly on worked shifts: a
//     sick day has no tips and its hours were never stood, and a vacation day has
//     no shift type, so either would only drag the per-shift stats.

import type { GrossRate, Payslip, Settings, Shift, ShiftType, Vacation } from "./types";
import { computeShiftEarnings, isPaidShift, monthOf } from "./earnings";
import { allocateVacations, type ChargeModel } from "./vacationCharge";
import { vacationPayForMonth, type PayrollSettings } from "./vacationPayroll";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "yyyy-MM" -> "Apr '26". */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const idx = Number(m[2]) - 1;
  return `${MONTHS[idx] ?? m[2]} '${m[1].slice(2)}`;
}

/**
 * Everything needed to price the paid vacation landing in a month. Optional on the
 * chart functions: pass it and vacation pay is counted, omit it (tests, callers
 * with no vacation data) and the charts behave as they did before.
 *
 * `settings` is the payroll slice only — the tip-pool rate stays on the main
 * `settings` argument, so existing callers/tests keep compiling.
 */
export interface VacationPayContext {
  vacations: Vacation[];
  model: ChargeModel;
  settings: PayrollSettings;
  todayIso: string;
  /** Window the caller is charting, "yyyy-MM" inclusive. Vacation outside it is
   *  dropped, so a "6M" range can't sprout a bar for a trip two years back.
   *  Omit either end for unbounded (the "All" range); the span of the charted
   *  shifts is then used as the fallback bound. Both must be given for a window
   *  with NO paid shifts in it — a stretch spent entirely on vacation — to chart,
   *  since there is no shift span to fall back on. */
  from?: string;
  to?: string;
}

export interface MonthPoint {
  month: string; // "yyyy-MM"
  label: string; // "Apr '26"
  shifts: number; // PAID shifts (worked + sick)
  sickShifts: number;
  hours: number; // paid hours, sick days included
  workedHours: number; // hours actually stood — the tips/hour denominator
  netWage: number; // shift wage, sick days included
  vacationPay: number; // net paid vacation landing in the month (no shift rows exist for it)
  usableTips: number;
  takeHome: number; // netWage + vacationPay + usableTips
  reportedTips: number;
  tipsPerHour: number | null; // reported tips ÷ hours WORKED
}

/**
 * Net vacation pay per month, keyed "yyyy-MM".
 *
 * Months come from the allocated segments, plus any payslip that recorded vacation
 * days itself — a trip logged after the fact (or one the model charges 0 days for)
 * still shows on the slip, and the slip is the authority. Pricing, the
 * payslip-wins precedence and the past/future split all live in
 * vacationPayForMonth; this only decides WHICH months to ask about.
 */
function vacationNetByMonth(
  ctx: VacationPayContext | undefined,
  rates: GrossRate[],
  payslips: Payslip[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!ctx) return out;
  const months = new Set<string>();
  for (const seg of allocateVacations(
    ctx.vacations,
    ctx.model,
    ctx.settings.vacationPayrollDays,
    ctx.todayIso,
  )) {
    months.add(seg.month);
  }
  for (const p of payslips) if (p.vacationDays) months.add(p.month);
  for (const month of months) {
    const pay = vacationPayForMonth(
      month,
      ctx.vacations,
      ctx.model,
      ctx.settings,
      rates,
      payslips,
      ctx.todayIso,
    );
    const net = pay.banked.net + pay.projected.net;
    if (net > 0) out.set(month, net);
  }
  return out;
}

function emptyMonth(month: string): MonthPoint {
  return {
    month,
    label: monthLabel(month),
    shifts: 0,
    sickShifts: 0,
    hours: 0,
    workedHours: 0,
    netWage: 0,
    vacationPay: 0,
    usableTips: 0,
    takeHome: 0,
    reportedTips: 0,
    tipsPerHour: null,
  };
}

/**
 * One point per calendar month, sorted chronologically — what each month actually
 * paid (see the two-universes note at the top of the file).
 *
 * Vacation pay is merged in for months inside the charted window (see
 * VacationPayContext.from/to). Clamping is what keeps the range tabs meaningful —
 * a "3M" chart can't sprout a bar for a trip two years back — while a month spent
 * entirely on vacation still gets its bar.
 *
 * ⚠ This NEVER reads Payslip.totalNet/totalGross. Home substitutes those for the
 * banked wage when a slip is marked authoritative; here the wage is always summed
 * bottom-up per shift and the vacation top-up priced independently, which is
 * exactly why adding the two can't double-count. The two surfaces may therefore
 * print slightly different totals for such a month — that is the design, not a
 * bug to "fix" by wiring slip totals in here.
 */
export function byMonth(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
  vacation?: VacationPayContext,
): MonthPoint[] {
  const map = new Map<string, MonthPoint>();
  for (const s of shifts) {
    if (!isPaidShift(s)) continue;
    const month = monthOf(s.date);
    let p = map.get(month);
    if (!p) {
      p = emptyMonth(month);
      map.set(month, p);
    }
    const e = computeShiftEarnings(s, rates, payslips, settings);
    const hours = s.actualHours ?? 0;
    const sick = s.status === "sick";
    p.shifts += 1;
    p.hours += hours;
    p.netWage += e.netPay;
    p.takeHome += e.takeHome;
    if (sick) {
      // computeShiftEarnings already zeroes a sick day's tips; the reported figure
      // has to be dropped here too, or re-marking a logged shift as sick would
      // leave its old tips inflating tips/hour.
      p.sickShifts += 1;
    } else {
      p.workedHours += hours;
      p.usableTips += e.usableTips;
      p.reportedTips += s.tips ?? 0;
    }
  }

  // Clamp to the charted window — the caller's bounds where it gave them, else the
  // span of the shifts it passed. Deliberately NOT gated on there being any shifts:
  // a window spent entirely on vacation has no shift span, and dropping its pay
  // would leave the one case this feature most exists for reading as €0.
  const shiftMonths = Array.from(map.keys()).sort();
  const lo = vacation?.from ?? shiftMonths[0];
  const hi = vacation?.to ?? shiftMonths[shiftMonths.length - 1];
  for (const [month, net] of vacationNetByMonth(vacation, rates, payslips)) {
    if (lo && month < lo) continue;
    if (hi && month > hi) continue;
    let p = map.get(month);
    if (!p) {
      p = emptyMonth(month);
      map.set(month, p);
    }
    p.vacationPay += net;
    p.takeHome += net;
  }

  const rows = Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
  for (const p of rows) p.tipsPerHour = p.workedHours > 0 ? p.reportedTips / p.workedHours : null;
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

/**
 * One row per shift type, in the canonical type order.
 *
 * STRICTLY worked shifts — the "what a shift pays" universe. Sick days and
 * vacation belong to the month totals, not here: neither stood an hour or earned
 * a tip, and vacation has no shift type at all.
 */
export function byType(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): TypePoint[] {
  const order: ShiftType[] = [
    "opening",
    "late-morning",
    "mid-day",
    "early-closing",
    "closing",
    "meeting",
  ];
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

/**
 * Take-home split into its sources — the share pie.
 *
 * Built from byMonth's rows rather than re-walking the shifts, so the pie can
 * never disagree with the bars above it: same paid-shift rule, same vacation
 * months, same span.
 */
export function takeHomeComposition(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
  vacation?: VacationPayContext,
): CompositionSlice[] {
  let netWage = 0;
  let vacationPay = 0;
  let usableTips = 0;
  for (const m of byMonth(shifts, rates, payslips, settings, vacation)) {
    netWage += m.netWage;
    vacationPay += m.vacationPay;
    usableTips += m.usableTips;
  }
  const out: CompositionSlice[] = [];
  if (netWage > 0) out.push({ name: "Net wage", value: netWage });
  if (vacationPay > 0) out.push({ name: "Vacation pay", value: vacationPay });
  if (usableTips > 0) out.push({ name: "Usable tips", value: usableTips });
  return out;
}
