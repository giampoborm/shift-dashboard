// How many vacation days a range costs — the HOURS model.
//
// WHAT CHANGED, AND WHY (2026-09-07)
// ----------------------------------
// The first model counted CALENDAR WEEKDAYS: "payroll charges a day for every
// Tue–Sat in the range." It reproduced the one payslip we had, but by coincidence
// of arithmetic rather than by mechanism, and it was wrong in two visible ways:
//
//   * It claimed Mondays and Sundays are never charged. They aren't special —
//     they're just days he rarely works. Ticking "Sunday" in Settings to reflect
//     that he *is* available then invented an extra paid vacation day out of thin
//     air, which is nonsense: being Sunday-available doesn't lengthen a holiday.
//   * It could only ever reproduce the day count. The paid HOURS came out right
//     only because 6 days x 6 h happened to equal the slip's 36,00 STD.
//
// The real mechanism, which the user confirmed with his manager, is:
//
//     hours you would have worked  ÷  6 h (the flat vacation day)  →  round up
//
// A vacation day is worth 6 h, but his shifts run ~7 h and he works ~4 a week.
// So a week away is ~28 h = 4.67 vacation days, NOT 4 — which is exactly why a
// Mon-to-next-Tuesday trip lands on the payslip as 6 days / 36,00 h rather than
// as "5 shifts missed". Roster-shaped input, payroll-shaped output.
//
// It reproduces BOTH numbers on the 8/2026 slip from one quantity:
//     3–11 Aug = 9 calendar days ~ 28 h/wk x 9/7 ~ 36 h  ->  36 / 6 = 6,00 days
// and it explains why the plan for 3–9 Aug rostered him on ZERO days: payroll
// charges a TYPICAL week, not the (deliberately emptied) actual roster. That is
// also why the estimate is built from historical weekday hours and never from the
// planned shifts sitting inside the range.
//
// ROUNDING is ceil, per the user: the manager rounds any part-day up to a whole
// one (5.2 -> 6). It happens ONCE PER MONTH SEGMENT, because the payslip is
// monthly — a range crossing a month boundary is charged, and rounded, on each
// slip separately.
//
// Every downstream number — the month projection, the yearly balance, the planner
// card, the paid/unpaid split — is derived from `allocateVacations` below, so they
// cannot drift apart from each other.
//
// Dep-free (no date-holidays), so callers outside VacationPlanner's lazy boundary
// can use it.

import { format, parseISO } from "date-fns";
import type { Payslip, Vacation } from "./types";
import { avgWeeklyHours, expectedHoursInRange, type WeekdayHours } from "./vacationPay";

/** Flat hours one vacation day is paid at ("Urlaub" STD ÷ "Genommene Urlaubstage"). */
export const DEFAULT_VACATION_DAY_HOURS = 6;
/** Annual entitlement in payroll days ("Tage LJ alt"). */
export const DEFAULT_VACATION_PAYROLL_DAYS = 20;

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((parseISO(toIso).getTime() - parseISO(fromIso).getTime()) / 86_400_000) + 1;

/** The part of a vacation that falls in one calendar month, and what it costs. */
export interface MonthSegment {
  /** Which vacation it came from, when built from a saved one. */
  vacationId?: number;
  month: string; // "yyyy-MM" — the payslip this lands on
  from: string; // ISO, first day of the segment
  to: string; // ISO, last day
  calendarDays: number;
  /** Hours you'd have been rostered for — the quantity payroll actually charges. */
  missedHours: number;
  /** missedHours ÷ dayHours, before rounding. Shown so the number stays checkable. */
  rawDays: number;
  /** What the slip charges: rawDays rounded up. */
  days: number;
  /** True when `days` is the count saved with a finished vacation rather than the
   *  model's own estimate — so the UI can say which it is showing. */
  fromSnapshot?: boolean;
}

/** Split [fromIso, toIso] at month boundaries. */
function monthSpans(fromIso: string, toIso: string): { month: string; from: string; to: string }[] {
  if (!fromIso || !toIso || toIso < fromIso) return [];
  const out: { month: string; from: string; to: string }[] = [];
  let cursor = fromIso;
  while (cursor <= toIso) {
    const d = parseISO(cursor);
    const lastOfMonth = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const end = lastOfMonth < toIso ? lastOfMonth : toIso;
    out.push({ month: cursor.slice(0, 7), from: cursor, to: end });
    cursor = iso(new Date(parseISO(end).getTime() + 86_400_000));
  }
  return out;
}

/**
 * What a range costs, month by month. Rounding up happens per segment, because
 * each segment is charged on its own payslip.
 */
export function chargeSegments(
  fromIso: string,
  toIso: string,
  profile: WeekdayHours[],
  dayHours: number,
): MonthSegment[] {
  if (!(dayHours > 0)) return [];
  return monthSpans(fromIso, toIso).map(({ month, from, to }) => {
    const missedHours = expectedHoursInRange(from, to, profile);
    const rawDays = missedHours / dayHours;
    return {
      month,
      from,
      to,
      calendarDays: daysBetween(from, to),
      missedHours,
      rawDays,
      // max(0, …) also normalises ceil's -0 for a zero-hour segment.
      days: Math.max(0, Math.ceil(rawDays - 1e-9)),
    };
  });
}

export interface VacationCharge {
  segments: MonthSegment[];
  /** Hours you'd have worked across the whole range. */
  missedHours: number;
  /** missedHours ÷ dayHours — the unrounded cost, so near-misses are visible. */
  rawDays: number;
  /** Days charged: the per-month rounded-up figures added together. */
  days: number;
  /** days x dayHours — what the "Urlaub" line on the slip will read. */
  paidHours: number;
  dayHours: number;
}

/** One-shot cost of a range. */
export function chargeVacation(
  fromIso: string,
  toIso: string,
  profile: WeekdayHours[],
  dayHours: number,
): VacationCharge {
  const segments = chargeSegments(fromIso, toIso, profile, dayHours);
  const missedHours = segments.reduce((s, x) => s + x.missedHours, 0);
  const days = segments.reduce((s, x) => s + x.days, 0);
  return {
    segments,
    missedHours,
    rawDays: dayHours > 0 ? missedHours / dayHours : 0,
    days,
    paidHours: days * dayHours,
    dayHours,
  };
}

// ---------------------------------------------------------------------------
// The finite entitlement
// ---------------------------------------------------------------------------

export interface AllocatedSegment extends MonthSegment {
  /** Days the year's entitlement covers — the only ones that pay. */
  paidDays: number;
  /** Days beyond it: still time off, but 0 EUR (unbezahlter Urlaub). */
  unpaidDays: number;
}

/**
 * Spread a finished vacation's SAVED day count across its month segments.
 *
 * The snapshot is one number for the whole trip, but the entitlement and the
 * monthly projection work per segment, so it has to be apportioned — by the
 * modelled days, largest remainder first, so the parts always add back up to the
 * snapshot exactly. A trip whose model says zero days everywhere (its weekdays
 * are ones he never works) still has to put the snapshot somewhere: the first
 * segment takes it.
 */
function applySnapshot(segments: MonthSegment[], snapshotDays: number): MonthSegment[] {
  if (segments.length === 0) return segments;
  segments = segments.map((s) => ({ ...s, fromSnapshot: true }));
  const modelled = segments.reduce((n, s) => n + s.days, 0);
  if (modelled === snapshotDays) return segments;
  if (modelled === 0) {
    return segments.map((s, i) => ({ ...s, days: i === 0 ? snapshotDays : s.days }));
  }
  const exact = segments.map((s) => (s.days / modelled) * snapshotDays);
  const out = segments.map((s, i) => ({ ...s, days: Math.floor(exact[i]) }));
  let left = snapshotDays - out.reduce((n, s) => n + s.days, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i].days += 1;
    left -= 1;
  }
  return out;
}

/**
 * Every recorded vacation, split by month and charged against the entitlement.
 *
 * The budget is PER CALENDAR YEAR and is consumed in DATE order — an earlier trip
 * eats it first, whichever you happened to type in first. This is the single
 * primitive every other vacation figure in the app derives from.
 *
 * OBSERVE BACKWARD, ESTIMATE FORWARD. With `todayIso`, a vacation that has already
 * ended reports the day count it was SAVED with — what payroll actually charged —
 * instead of being re-derived. Refining the model, or logging a few more shifts,
 * must never rewrite a month you have already been paid for. A trip still ahead of
 * you is an estimate by definition, so it is recomputed every time: booking
 * something months out and then learning more about your roster should update what
 * it's going to cost.
 *
 * Doing this HERE, rather than in each caller, is deliberate. The Home month line
 * used to re-estimate a past vacation while the planner table, the yearly balance
 * and the calendar tooltip all showed its snapshot — so August read as 5 days /
 * 30 h in one place and 6 / 36 in three others. One primitive, one answer.
 */
export function allocateVacations(
  vacations: Vacation[],
  profile: WeekdayHours[],
  dayHours: number,
  entitlement: number,
  todayIso?: string,
): AllocatedSegment[] {
  const segments = vacations
    .flatMap((v) => {
      const mine = chargeSegments(v.from, v.to, profile, dayHours);
      // Without a `todayIso` we can't tell what has already been paid, so a
      // snapshot — where one exists — always wins: the history-preserving answer
      // is the safe default for a caller that can't say when "now" is.
      const finished = v.payrollDays != null && (todayIso == null || v.to < todayIso);
      const withSnapshot = finished ? applySnapshot(mine, v.payrollDays as number) : mine;
      return withSnapshot.map((s) => ({ ...s, vacationId: v.id }));
    })
    .sort((a, b) => a.from.localeCompare(b.from));

  const usedByYear = new Map<string, number>();
  return segments.map((s) => {
    const year = s.month.slice(0, 4);
    const used = usedByYear.get(year) ?? 0;
    const paidDays = Math.max(0, Math.min(s.days, entitlement - used));
    usedByYear.set(year, used + paidDays);
    return { ...s, paidDays, unpaidDays: s.days - paidDays };
  });
}

/** What a CANDIDATE range costs against the budget, given everything recorded. */
export interface BudgetUse {
  charged: number;
  paid: number;
  unpaid: number;
  availableBefore: number;
  availableAfter: number;
}

/** `others` must exclude the range itself, or it consumes its own budget. */
export function vacationBudgetUse(
  fromIso: string,
  toIso: string,
  others: Vacation[],
  profile: WeekdayHours[],
  dayHours: number,
  entitlement: number,
): BudgetUse {
  const year = fromIso.slice(0, 4);
  const candidate: Vacation = {
    id: -1,
    from: fromIso,
    to: toIso,
    werktage: 0,
    scheduledCost: 0,
    createdAt: "",
  };
  const all = allocateVacations([...others, candidate], profile, dayHours, entitlement);
  const mine = all.filter((s) => s.vacationId === -1);

  const consumedBefore = all
    .filter((s) => s.vacationId !== -1 && s.month.slice(0, 4) === year && s.from < fromIso)
    .reduce((n, s) => n + s.paidDays, 0);
  const availableBefore = Math.max(0, entitlement - consumedBefore);
  const paidHere = mine
    .filter((s) => s.month.slice(0, 4) === year)
    .reduce((n, s) => n + s.paidDays, 0);

  return {
    charged: mine.reduce((n, s) => n + s.days, 0),
    paid: mine.reduce((n, s) => n + s.paidDays, 0),
    unpaid: mine.reduce((n, s) => n + s.unpaidDays, 0),
    availableBefore,
    availableAfter: Math.max(0, availableBefore - paidHere),
  };
}

/**
 * Payroll days used in a calendar year — finished trips at what they were charged,
 * upcoming ones at what they're currently estimated to cost. `allocateVacations`
 * already encodes that rule, so this is just a sum.
 */
export function payrollDaysTakenInYear(
  vacations: Vacation[],
  year: number,
  profile: WeekdayHours[],
  dayHours: number,
  todayIso?: string,
): number {
  return allocateVacations(vacations, profile, dayHours, Number.POSITIVE_INFINITY, todayIso)
    .filter((s) => s.month.slice(0, 4) === String(year))
    .reduce((n, s) => n + s.days, 0);
}

// ---------------------------------------------------------------------------
// Checking the model against reality
// ---------------------------------------------------------------------------
//
// The weekday-set fitter this replaces searched a hypothesis space of ten
// counting rules and pruned it with payslips. There is no space to search any
// more — the mechanism is known — so the honest job left is CALIBRATION: does
// hours ÷ 6 reproduce what the slips actually charged, and if not, what weekly
// hours would have?
//
// A slip prints "Genommene Urlaubstage" and "Urlaub ... STD" for a range the
// `vacations` table already holds, so every slip is still a labelled example.

export interface MonthCheck {
  month: string;
  observedDays: number;
  observedHours: number;
  predictedDays: number;
  predictedHours: number;
  /** Calendar days of vacation the month contained. Zero = nothing to check against. */
  calendarDays: number;
  /** Weekly hours that would have produced the slip's hours exactly. */
  impliedWeeklyHours: number | null;
}

export interface Calibration {
  checks: MonthCheck[];
  /** Checks with a recorded vacation behind them — the ones that mean anything. */
  usable: number;
  /** True when the model reproduces every usable slip's day count. */
  matches: boolean;
  /** Flat hours per vacation day the slips imply (hours ÷ days), if consistent. */
  dayHours: number | null;
  dayHoursConflict: boolean;
  /** Weekly hours the model is currently using, from the roster. */
  weeklyHours: number;
  /** Weekly hours the slips imply, averaged. Null when no slip can pin it down. */
  impliedWeeklyHours: number | null;
}

const HOURS_EPSILON = 0.01;

/** Vacation calendar days falling inside a "yyyy-MM" month, across all vacations. */
function vacationDaysInMonth(month: string, vacations: Vacation[]): number {
  let n = 0;
  for (const v of vacations) {
    for (const s of monthSpans(v.from, v.to)) {
      if (s.month === month) n += daysBetween(s.from, s.to);
    }
  }
  return n;
}

export function calibrateCharge(
  payslips: Payslip[],
  vacations: Vacation[],
  profile: WeekdayHours[],
  dayHours: number,
): Calibration {
  const slips = payslips
    .filter((p) => p.vacationDays != null)
    .sort((a, b) => a.month.localeCompare(b.month));

  const checks: MonthCheck[] = slips.map((p) => {
    const calendarDays = vacationDaysInMonth(p.month, vacations);
    const observedHours = p.vacationHours ?? 0;
    const predictedDays = vacations
      .flatMap((v) => chargeSegments(v.from, v.to, profile, dayHours))
      .filter((s) => s.month === p.month)
      .reduce((n, s) => n + s.days, 0);
    return {
      month: p.month,
      observedDays: p.vacationDays as number,
      observedHours,
      predictedDays,
      predictedHours: predictedDays * dayHours,
      calendarDays,
      impliedWeeklyHours:
        observedHours > 0 && calendarDays > 0 ? (observedHours * 7) / calendarDays : null,
    };
  });

  const perDay = slips
    .filter((p) => p.vacationHours != null && (p.vacationDays as number) > 0)
    .map((p) => (p.vacationHours as number) / (p.vacationDays as number));
  const dayHoursConflict =
    perDay.length > 0 && perDay.some((h) => Math.abs(h - perDay[0]) > HOURS_EPSILON);

  const usableChecks = checks.filter((c) => c.calendarDays > 0);
  const implied = usableChecks
    .map((c) => c.impliedWeeklyHours)
    .filter((h): h is number => h != null);

  return {
    checks,
    // Only a slip whose vacation we actually recorded can confirm anything: a
    // month with a vacation line but no saved range says nothing about the model.
    usable: usableChecks.length,
    matches: usableChecks.every((c) => c.predictedDays === c.observedDays),
    dayHours: perDay.length === 0 || dayHoursConflict ? null : perDay[0],
    dayHoursConflict,
    weeklyHours: avgWeeklyHours(profile),
    impliedWeeklyHours:
      implied.length > 0 ? implied.reduce((a, b) => a + b, 0) / implied.length : null,
  };
}

/** Where the model stands, in words a person would use. */
export function describeCalibration(cal: Calibration): string {
  if (cal.usable === 0) return "Not checked against a payslip yet.";
  const slips = `${cal.usable} payslip${cal.usable === 1 ? "" : "s"}`;
  if (!cal.matches) {
    const c = cal.checks.find((x) => x.calendarDays > 0 && x.predictedDays !== x.observedDays);
    return c
      ? `Your ${c.month} payslip charged ${c.observedDays} days; this estimate says ${c.predictedDays} — your typical hours have probably shifted since.`
      : `Doesn't match your ${slips}.`;
  }
  return `Matches ${slips}.`;
}
