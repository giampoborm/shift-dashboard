// Core domain types for Shift Dashboard.
// Money is stored as plain numbers in EUR. Dates are ISO "yyyy-MM-dd" strings;
// times are "HH:mm" strings. Weekday is always DERIVED from the date, never trusted
// from source data (the history CSV's weekday column is unreliable).

export type ShiftStatus = "planned" | "worked" | "swapped-out" | "swapped-in";

/**
 * Named shift types. Five are classified from start time + open-end + past-midnight
 * (floor work, derived from CSV import or a typed time slot); "meeting" is a sixth,
 * manually-entered type (2h, ~once a month) that pays normal wage but has
 * structurally no tips — it is never derived from time-slot parsing.
 */
export type ShiftType =
  | "opening" // start <= 11:00, ends ~18:00 (10:30 on Sat)
  | "late-morning" // 12:00-18:00
  | "mid-day" // 16:00-23:00
  | "early-closing" // 17-23, or Fri/Sat 18-00 (fixed end)
  | "closing" // 18/17-Ende, or worked past midnight
  | "meeting"; // manual, paid, no tips — excluded from tip/roster stats

/** Coarse grouping: opening (morning) vs closing (evening) family; meeting is its own family. */
export type ShiftFamily = "opening" | "closing" | "meeting";

export interface Shift {
  id?: number;
  date: string; // ISO yyyy-MM-dd (the calendar date the shift STARTS on)
  station: string; // BAR, RUNNERS, ... — affects tips
  shiftType: ShiftType;
  plannedStart?: string; // "HH:mm"
  plannedEnd?: string; // "HH:mm"; undefined when the source said "Ende" (open close)
  openEnd: boolean; // true when end was "Ende" / open close
  crossesMidnight: boolean; // night shift -> counts as 2 working days
  status: ShiftStatus;

  // Entered/known after the shift:
  actualHours?: number; // authoritative hours worked (decimal)
  tips?: number; // reported tips in EUR (before pool cut)
  grossRate?: number; // €/h snapshot from the rate table at `date`

  notes?: string;
  source: string; // "history.csv" | "plan:<file>" | "manual"
  createdAt: string; // ISO timestamp
}

/** Effective-dated gross hourly rate. Handles raises retroactively-correctly. */
export interface GrossRate {
  id?: number;
  effectiveFrom: string; // ISO yyyy-MM-dd — rate applies on/after this date
  rate: number; // €/h
}

/** One monthly payslip. netFactor is derived = totalNet / totalGross. */
export interface Payslip {
  id?: number;
  month: string; // "yyyy-MM"
  totalGross: number; // wage only, excludes tips
  totalHours: number;
  totalNet: number;
  /** When true, Home shows this slip's brutto/netto for the month instead of the
      figures derived from logged shifts (the user resolved a discrepancy). */
  useSlipTotals?: boolean;
}

/** A recorded vacation period, with its Werktage cost snapshotted at save time. */
export interface Vacation {
  id?: number;
  from: string; // ISO yyyy-MM-dd
  to: string; // ISO yyyy-MM-dd
  werktage: number; // Werktage-basis cost (Mon–Sat minus holidays) vs the 24 budget
  scheduledCost: number; // proportional basis: expected scheduled shifts in the range
  note?: string;
  createdAt: string;
}

export interface Settings {
  id?: number;
  userName: string; // identity in plan files, e.g. "Gianpaolo"
  tipPoolRate: number; // fraction cut for the prep shift, default 0.05
  closingTime: string; // "HH:mm" used when a slot ends in "Ende"
  vacationWerktage: number; // annual entitlement in Werktage (contract §8 = 24)
  recencyHalfLifeDays: number; // tip-estimate recency half-life in days (0 = weight all history equally)
}

/** Earnings derived for a single shift. Never persisted — computed on demand. */
export interface ShiftEarnings {
  grossPay: number;
  netPay: number;
  usableTips: number;
  takeHome: number; // netPay + usableTips
  tipsPerHour: number | null;
  netPerHour: number | null;
  workingDays: number; // 1, or 2 if it crosses midnight
  netFactorUsed: number;
  netFactorEstimated: boolean; // true if we fell back to an average
}
