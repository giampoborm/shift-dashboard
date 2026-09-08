// Pure validation + normalization for the editable settings, gross-rate table,
// and payslips. No DB, no React — the Settings component owns the Dexie writes
// (same pattern as ShiftEditor); this module is just the testable logic that
// guards what gets written. The earnings invariants depend on these staying sane:
//   - rate table is authoritative for gross  -> a bad rate corrupts every shift
//   - net_factor = totalNet / totalGross      -> a bad payslip skews the month
// so we validate before save and never silently coerce nonsense.

import { netFactorForMonth } from "./earnings";
import type { GrossRate, Payslip, Settings } from "./types";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // "HH:mm" 00:00–23:59
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; // "yyyy-MM-dd"
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // "yyyy-MM"

/** Tolerant number parse: "" / non-numeric -> null, accepts comma decimals. */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Validate the general settings. Returns a list of human messages ([] = ok). */
export function validateSettings(s: Partial<Settings>): string[] {
  const errs: string[] = [];
  if (!s.userName || !s.userName.trim()) errs.push("Name is required.");
  if (s.tipPoolRate == null || !Number.isFinite(s.tipPoolRate) || s.tipPoolRate < 0 || s.tipPoolRate >= 1)
    errs.push("Tip pool rate must be between 0 and 1 (e.g. 0.05 = 5%).");
  if (!s.closingTime || !TIME_RE.test(s.closingTime)) errs.push("Closing time must be HH:mm (e.g. 01:00).");
  if (s.vacationWerktage == null || !Number.isFinite(s.vacationWerktage) || s.vacationWerktage <= 0)
    errs.push("Vacation Werktage must be a positive number.");
  if (s.recencyHalfLifeDays == null || !Number.isFinite(s.recencyHalfLifeDays) || s.recencyHalfLifeDays < 0)
    errs.push("Recency half-life must be 0 or more days (0 = weight all history equally).");
  if (s.vacationPayrollDays == null || !Number.isFinite(s.vacationPayrollDays) || s.vacationPayrollDays <= 0)
    errs.push("Vacation payroll days must be a positive number (the payslip's “Tage LJ alt”).");
  if (s.vacationDayHours == null || !Number.isFinite(s.vacationDayHours) || s.vacationDayHours <= 0)
    errs.push("Vacation day hours must be a positive number of hours (the payslip pays 6,00).");
  if (
    !Array.isArray(s.vacationEligibleWeekdays) ||
    s.vacationEligibleWeekdays.length === 0 ||
    s.vacationEligibleWeekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  )
    errs.push("Pick at least one weekday you could be rostered on.");
  return errs;
}

/** Validate one gross-rate row. */
export function validateRate(r: Partial<GrossRate>): string[] {
  const errs: string[] = [];
  if (!r.effectiveFrom || !DATE_RE.test(r.effectiveFrom)) errs.push("Effective-from must be a yyyy-MM-dd date.");
  if (r.rate == null || !Number.isFinite(r.rate) || r.rate <= 0) errs.push("Rate must be a positive €/h amount.");
  return errs;
}

/** Validate one payslip row. Net above gross is rejected (would push net_factor > 1). */
export function validatePayslip(p: Partial<Payslip>): string[] {
  const errs: string[] = [];
  if (!p.month || !MONTH_RE.test(p.month)) errs.push("Month must be yyyy-MM (e.g. 2026-04).");
  if (p.totalGross == null || !Number.isFinite(p.totalGross) || p.totalGross <= 0)
    errs.push("Total gross must be a positive amount.");
  if (p.totalHours == null || !Number.isFinite(p.totalHours) || p.totalHours <= 0)
    errs.push("Total hours must be a positive number.");
  if (p.totalNet == null || !Number.isFinite(p.totalNet) || p.totalNet < 0)
    errs.push("Total net must be zero or more.");
  if (
    p.totalGross != null && p.totalNet != null &&
    Number.isFinite(p.totalGross) && Number.isFinite(p.totalNet) &&
    p.totalNet > p.totalGross
  )
    errs.push("Net cannot exceed gross (net factor must be ≤ 1).");
  // Vacation figures are optional — undefined means "this slip carries no vacation
  // evidence", which is different from zero and must stay expressible.
  if (p.vacationDays != null && (!Number.isFinite(p.vacationDays) || p.vacationDays < 0))
    errs.push("Vacation days must be zero or more.");
  if (p.vacationHours != null && (!Number.isFinite(p.vacationHours) || p.vacationHours < 0))
    errs.push("Vacation hours must be zero or more.");
  if (p.vacationHours != null && p.vacationHours > 0 && !p.vacationDays)
    errs.push("Vacation hours need the matching “Genommene Urlaubstage” to be usable.");
  return errs;
}

/** Rates sorted oldest-first by effective date (a copy). */
export function sortRates(rates: GrossRate[]): GrossRate[] {
  return [...rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** Payslips sorted oldest-first by month (a copy). */
export function sortPayslips(payslips: Payslip[]): Payslip[] {
  return [...payslips].sort((a, b) => a.month.localeCompare(b.month));
}

/** Derived net factor for a single payslip, or null if gross is non-positive. */
export function payslipNetFactor(p: Payslip): number | null {
  return p.totalGross > 0 ? p.totalNet / p.totalGross : null;
}

/** A month key no payslip can carry, so netFactorForMonth takes its aggregate branch. */
const NO_SUCH_MONTH = "0000-00";

/**
 * The blended net factor across all payslips — the fallback used for any month
 * without its own payslip (mirrors earnings.netFactorForMonth's aggregate branch).
 * Shown in the UI so the user sees the effect of editing payslips.
 */
export function blendedNetFactor(payslips: Payslip[]): number | null {
  return netFactorForMonth(NO_SUCH_MONTH, payslips).factor;
}
