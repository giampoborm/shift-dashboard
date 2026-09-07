// PRICING a vacation: turning the charged days from lib/vacationCharge.ts into
// euros, and deferring to the payslip once one exists.
//
// The COUNTING lives next door in vacationCharge.ts (hours you'd have worked ÷ the
// flat 6 h day, rounded up per month). This module only answers "and what does
// that pay". Split that way because counting is roster maths and pricing is rate
// -table maths, and mixing them is what made the old module hard to follow.
//
// Grounded in Entgeltabrechnung 8/2026 (vacation Mon 3 Aug – Tue 11 Aug):
//   Lohnart 171  Urlaub                 36,00 STD x 15,50 = 558,00
//   Lohnart 620  Genommene Urlaubstage   6,00
//   Urlaub block: Tage LJ alt 20,00 | Genommen 6,00 | Tage verfuegbar 14,00
//
// Two facts fall out, and July's slip confirms the first independently (Lohnart
// 164 LFZ Krank = 6,00 STD for one sick day):
//   1. A vacation day is a FLAT 6,00 h, never your real shift length.
//   2. "Tage LJ alt 20,00" is a finite annual budget — past it, time off is unpaid.
//
// Dep-free (no date-holidays) so App.tsx can use it outside the lazy boundary.

import { eachDayOfInterval, format, parseISO } from "date-fns";
import type { GrossRate, Payslip, Settings, Vacation } from "./types";
import { netFactorForMonth, rateForDate } from "./earnings";
import { expectedHoursInRange, type WeekdayHours } from "./vacationPay";
import {
  allocateVacations,
  chargeVacation,
  type AllocatedSegment,
  type VacationCharge,
} from "./vacationCharge";

export type PayrollSettings = Pick<Settings, "vacationDayHours" | "vacationPayrollDays">;

/**
 * EVERY calendar day covered by the given vacations.
 *
 * This is the set to erase from the roster observation window (see vacationPay.ts)
 * and the set of days you are unavailable to work. It is deliberately the whole
 * range: the charge is an hours total, not a list of billed dates, so there is no
 * such thing as "a day inside the vacation that doesn't count".
 */
export function vacationCalendarDates(vacations: Vacation[]): Set<string> {
  const out = new Set<string>();
  for (const v of vacations) {
    if (!v.from || !v.to || v.to < v.from) continue;
    for (const d of eachDayOfInterval({ start: parseISO(v.from), end: parseISO(v.to) })) {
      out.add(format(d, "yyyy-MM-dd"));
    }
  }
  return out;
}

export interface VacationPayrollPay extends VacationCharge {
  /** Gross Urlaubsentgelt: paid days x dayHours x the rate in force. */
  gross: number;
  /** Gross x the month's net factor. */
  net: number;
}

/**
 * What payroll pays for a range, ignoring the entitlement (see vacationBudgetUse
 * for the paid/unpaid split). Each month segment is priced at the rate in force on
 * its first day: the charge is a monthly hours total with no individual dates
 * attached, so there is nothing finer to price it at — and a raise landing
 * mid-vacation still lands on the right side of a month boundary.
 */
export function vacationPayrollPay(
  fromIso: string,
  toIso: string,
  profile: WeekdayHours[],
  settings: PayrollSettings,
  rates: GrossRate[],
  payslips: Payslip[],
): VacationPayrollPay {
  const charge = chargeVacation(fromIso, toIso, profile, settings.vacationDayHours);
  let gross = 0;
  let net = 0;
  for (const seg of charge.segments) {
    const segGross = seg.days * settings.vacationDayHours * (rateForDate(seg.from, rates) ?? 0);
    const { factor } = netFactorForMonth(seg.month, payslips);
    gross += segGross;
    net += segGross * (factor ?? 1);
  }
  return { ...charge, gross, net };
}

export interface VacationCost {
  /** Days charged — the snapshot for a finished vacation, else the model's estimate. */
  days: number;
  /** Of those, the ones the year's entitlement covers. Only these pay. */
  paidDays: number;
  unpaidDays: number;
  /** Paid hours (paidDays x the flat day). */
  hours: number;
  gross: number;
  net: number;
}

/**
 * What every recorded vacation costs and pays, keyed by id.
 *
 * Exists so no caller hand-rolls this arithmetic: pricing a vacation means
 * pricing its ENTITLEMENT-COVERED days, and a call site that prices `days`
 * instead quietly promises money for unpaid leave. Routing through
 * `allocateVacations` is also what keeps the calendar, the month projection and
 * the yearly balance quoting the same numbers.
 *
 * With `todayIso`, a finished vacation reports the day count it was saved with —
 * what payroll actually charged — capped so its paid part can never exceed it.
 */
export function vacationCosts(
  vacations: Vacation[],
  profile: WeekdayHours[],
  settings: PayrollSettings,
  rates: GrossRate[],
  payslips: Payslip[],
  todayIso?: string,
): Map<number, VacationCost> {
  const out = new Map<number, VacationCost>();
  const allocated = allocateVacations(
    vacations,
    profile,
    settings.vacationDayHours,
    settings.vacationPayrollDays,
    todayIso,
  );
  for (const v of vacations) {
    if (v.id == null) continue;
    const mine = allocated.filter((s) => s.vacationId === v.id);
    let paidDays = mine.reduce((n, s) => n + s.paidDays, 0);
    let gross = 0;
    let net = 0;
    for (const seg of mine) {
      const segGross = seg.paidDays * settings.vacationDayHours * (rateForDate(seg.from, rates) ?? 0);
      const { factor } = netFactorForMonth(seg.month, payslips);
      gross += segGross;
      net += segGross * (factor ?? 1);
    }
    // `allocateVacations` has already substituted the snapshot for a finished trip.
    const days = mine.reduce((n, s) => n + s.days, 0);
    paidDays = Math.min(paidDays, days);
    out.set(v.id, {
      days,
      paidDays,
      unpaidDays: days - paidDays,
      hours: paidDays * settings.vacationDayHours,
      gross,
      net,
    });
  }
  return out;
}

/**
 * What the payslip itself recorded for a month's vacation, if anything. This is
 * observed fact, not a prediction — the two numbers printed on the slip.
 */
export function observedVacationForMonth(
  month: string,
  payslips: Payslip[],
): { days: number; hours: number } | null {
  const slip = payslips.find((p) => p.month === month);
  if (!slip || slip.vacationDays == null) return null;
  return { days: slip.vacationDays, hours: slip.vacationHours ?? 0 };
}

export interface MonthVacationPay {
  days: number;
  hours: number;
  /** Charged days the year's entitlement no longer covers: time off worth 0 EUR. */
  unpaidDays: number;
  banked: { days: number; gross: number; net: number };
  projected: { days: number; gross: number; net: number };
  /** True when these figures came off the payslip rather than from the model. */
  observed: boolean;
  /** Where the day count came from, so the UI can say so rather than leaving the
   *  reader to wonder why Home and the planner ever differ. */
  source: "payslip" | "recorded" | "estimated";
}

/** The allocated segments of every recorded vacation landing in one month.
 *  Pass `todayIso` so a finished vacation reports what it was charged rather than
 *  being re-estimated — see allocateVacations. */
export function segmentsInMonth(
  month: string,
  vacations: Vacation[],
  profile: WeekdayHours[],
  settings: PayrollSettings,
  todayIso?: string,
): AllocatedSegment[] {
  return allocateVacations(
    vacations,
    profile,
    settings.vacationDayHours,
    settings.vacationPayrollDays,
    todayIso,
  ).filter((s) => s.month === month);
}

/**
 * Vacation pay landing in one month, split by whether the days have already passed.
 * Past days are banked (an amount the payslip will show); future days are
 * projected. Wage only — a vacation day structurally carries no tips.
 *
 * ESTIMATE FORWARD, OBSERVE BACKWARD: if the month's payslip records what payroll
 * actually charged, those numbers win outright and the whole amount is banked.
 * Never re-derive a figure you have already been handed — that is what stops a
 * later change to the roster (and so to the estimate) from rewriting a paid month.
 *
 * The banked/projected split is by HOURS, not by dates: the charge has no billed
 * dates to sort into past and future, so a segment straddling today is divided in
 * the proportion of its expected hours that have already gone by. The month total
 * is unaffected either way.
 */
export function vacationPayForMonth(
  month: string,
  vacations: Vacation[],
  profile: WeekdayHours[],
  settings: PayrollSettings,
  rates: GrossRate[],
  payslips: Payslip[],
  todayIso: string,
): MonthVacationPay {
  const { factor } = netFactorForMonth(month, payslips);
  const segments = segmentsInMonth(month, vacations, profile, settings, todayIso);
  const observed = observedVacationForMonth(month, payslips);

  if (observed) {
    // Price the slip's own hours at the month's rate rather than re-deriving them.
    const rate = rateForDate(segments[0]?.from ?? `${month}-01`, rates) ?? 0;
    const gross = observed.hours * rate;
    return {
      days: observed.days,
      hours: observed.hours,
      // Zero, not the model's guess: the slip is authoritative here precisely
      // because the estimate may be stale, so an "N days unpaid" warning derived
      // from that estimate would be describing a month the slip has already
      // settled. Everything the slip paid for is, by definition, paid.
      unpaidDays: 0,
      banked: { days: observed.days, gross, net: gross * (factor ?? 1) },
      projected: { days: 0, gross: 0, net: 0 },
      observed: true,
      source: "payslip",
    };
  }

  const banked = { days: 0, gross: 0, net: 0 };
  const projected = { days: 0, gross: 0, net: 0 };

  for (const seg of segments) {
    // Only entitlement-covered days earn anything; the rest is unpaid leave.
    const gross = seg.paidDays * settings.vacationDayHours * (rateForDate(seg.from, rates) ?? 0);
    const net = gross * (factor ?? 1);
    const pastShare =
      seg.to <= todayIso
        ? 1
        : seg.from > todayIso
          ? 0
          : seg.missedHours > 0
            ? expectedHoursInRange(seg.from, todayIso, profile) / seg.missedHours
            : 0;
    banked.days += seg.paidDays * pastShare;
    banked.gross += gross * pastShare;
    banked.net += net * pastShare;
    projected.days += seg.paidDays * (1 - pastShare);
    projected.gross += gross * (1 - pastShare);
    projected.net += net * (1 - pastShare);
  }

  return {
    days: segments.reduce((n, s) => n + s.days, 0),
    hours: segments.reduce((n, s) => n + s.paidDays, 0) * settings.vacationDayHours,
    unpaidDays: segments.reduce((n, s) => n + s.unpaidDays, 0),
    banked,
    projected,
    observed: false,
    source:
      segments.length > 0 && segments.every((s) => s.fromSnapshot) ? "recorded" : "estimated",
  };
}
