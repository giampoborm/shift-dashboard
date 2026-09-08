// How many vacation days a range costs — the model, and the evidence for it.
//
// THE RULE (confirmed by the user with his manager, 2026-09-07)
// ------------------------------------------------------------
//     hours per eligible day = weekly hours / eligible days per week
//     missed hours           = eligible days inside the range x hours per eligible day
//     days charged           = ceil( missed hours / 6 h )        # per MONTH segment
//
// A vacation day is worth a flat 6 h. But he works ~28 h a week, so a week away is
// ~28 h = 4.67 vacation days, NOT 4 and NOT "one per day off". Mon 3 – Tue 11 Aug,
// at 6 eligible days a week (the venue is shut Mondays):
//     28 / 6      = 4.67 h per eligible day
//     eligible days away: Tue4 Wed5 Thu6 Fri7 Sat8 Sun9 Tue11 = 7   (Mondays skipped)
//     7 x 4.67    = 32.7 h  ->  32.7 / 6 = 5.44  ->  6 days, 36,00 h
// which is exactly the 8/2026 payslip, both numbers, out of one quantity.
//
// WHY "ELIGIBLE DAYS" AND NOT THE ACTUAL ROSTER
// ---------------------------------------------
// Payroll charges a TYPICAL week, not the roster inside the range — it rosters him
// off precisely because he booked time off (the 3–9 Aug plan lists him on zero
// days). So his weekly hours are spread evenly across the days he COULD be
// rostered, and every eligible day away carries its share.
//
// This module has now had three models, and the first two failed instructively:
//
//  1. One day charged per Tue–Sat CALENDAR WEEKDAY in the range. Matched the August
//     slip by coincidence of arithmetic, and treated availability as cost: ticking
//     "Sunday" to say he IS Sunday-available invented an extra PAID vacation day.
//  2. Hours from a PER-WEEKDAY historical profile. Right mechanism, wrong input: on
//     an irregular roster a weekday he is only sometimes on scores near zero, so the
//     Tuesday he came back on contributed almost nothing and the same range came out
//     at 30 h / 5 days instead of 36 h / 6.
//
// The eligible-day count appears in the numerator AND the denominator, so widening
// eligibility barely moves the total — it only handles partial weeks properly:
//     5 eligible/wk -> 5.60 h/day x 6 days = 33.6 h -> 6 days
//     6 eligible/wk -> 4.67 h/day x 7 days = 32.7 h -> 6 days
//     7 eligible/wk -> 4.00 h/day x 9 days = 36.0 h -> 6 days
// That self-correction is the property both earlier models lacked, and it is why
// the eligible-weekday setting is safe to expose. Note what it means: NOT "which
// weekdays payroll charges" (model 1's mistake) but "which days could you have been
// rostered, to spread your hours over".
//
// ROUNDING is ceil — the manager rounds any part-day up. It happens ONCE PER MONTH
// SEGMENT, because the payslip is monthly.
//
// Every downstream number — the month projection, the yearly balance, the planner
// card, the paid/unpaid split — derives from `allocateVacations` below, so they
// cannot drift apart from each other.
//
// Dep-free (no date-holidays), so callers outside VacationPlanner's lazy boundary
// can use it.

import { eachDayOfInterval, format, getDay, parseISO } from "date-fns";
import type { Payslip, Settings, Vacation } from "./types";
import type { RosterHours } from "./vacationPay";

/** Flat hours one vacation day is paid at ("Urlaub" STD ÷ "Genommene Urlaubstage"). */
export const DEFAULT_VACATION_DAY_HOURS = 6;
/** Annual entitlement in payroll days ("Tage LJ alt"). */
export const DEFAULT_VACATION_PAYROLL_DAYS = 20;
/** Days he could be rostered, getDay() numbering. Tue–Sun: the venue is shut
 *  Mondays, and no plan CSV has ever placed him on one. */
export const DEFAULT_ELIGIBLE_WEEKDAYS = [0, 2, 3, 4, 5, 6];

/**
 * Everything the charge depends on, bundled — it travels together through every
 * function here, and passing the parts separately is how call sites drift.
 */
export interface ChargeModel {
  /** Average hours rostered per week (lib/vacationPay's buildRosterHours). */
  weeklyHours: number;
  /** Days you could be rostered, getDay() numbering — your hours spread over these. */
  eligibleWeekdays: number[];
  /** Flat hours one vacation day is paid at. */
  dayHours: number;
}

type ChargeSettings = Pick<Settings, "vacationDayHours" | "vacationEligibleWeekdays">;

/** Build the model from saved settings plus the observed roster. */
export function chargeModel(settings: ChargeSettings, roster: RosterHours): ChargeModel {
  return {
    weeklyHours: roster.weeklyHours,
    eligibleWeekdays: settings.vacationEligibleWeekdays,
    dayHours: settings.vacationDayHours,
  };
}

/** Hours one eligible day away costs: a week's hours split across the eligible days. */
export function hoursPerEligibleDay(model: ChargeModel): number {
  const n = new Set(model.eligibleWeekdays).size;
  return n > 0 ? model.weeklyHours / n : 0;
}

/** Days in [from, to] you could have been rostered on. */
export function eligibleDaysInRange(
  fromIso: string,
  toIso: string,
  eligibleWeekdays: number[],
): number {
  if (!fromIso || !toIso || toIso < fromIso) return 0;
  const set = new Set(eligibleWeekdays);
  return eachDayOfInterval({ start: parseISO(fromIso), end: parseISO(toIso) }).filter((d) =>
    set.has(getDay(d)),
  ).length;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** getDay() numbers in the order a week is actually read: Monday first. */
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** Human label for an eligible-weekday set, e.g. [0,2,3,4,5,6] -> "Tue–Sun". */
export function describeEligibleWeekdays(weekdays: number[]): string {
  const set = new Set(weekdays.filter((d) => d >= 0 && d <= 6));
  if (set.size === 0) return "no days";
  if (set.size === 7) return "every day";
  const inOrder = MON_FIRST.filter((d) => set.has(d));
  const idx = inOrder.map((d) => MON_FIRST.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && inOrder.length > 2) {
    return WEEKDAY_SHORT[inOrder[0]] + "\u2013" + WEEKDAY_SHORT[inOrder[inOrder.length - 1]];
  }
  return inOrder.map((d) => WEEKDAY_SHORT[d]).join(", ");
}

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
  /** Days in the segment you could have been rostered on. */
  eligibleDays: number;
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
  model: ChargeModel,
): MonthSegment[] {
  if (!(model.dayHours > 0)) return [];
  const perDay = hoursPerEligibleDay(model);
  return monthSpans(fromIso, toIso).map(({ month, from, to }) => {
    const eligibleDays = eligibleDaysInRange(from, to, model.eligibleWeekdays);
    const missedHours = eligibleDays * perDay;
    const rawDays = missedHours / model.dayHours;
    return {
      month,
      from,
      to,
      calendarDays: daysBetween(from, to),
      eligibleDays,
      missedHours,
      rawDays,
      // max(0, …) also normalises ceil's -0 for a zero-hour segment.
      days: Math.max(0, Math.ceil(rawDays - 1e-9)),
    };
  });
}

export interface VacationCharge {
  segments: MonthSegment[];
  /** Days across the whole range you could have been rostered on. */
  eligibleDays: number;
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
  model: ChargeModel,
): VacationCharge {
  const segments = chargeSegments(fromIso, toIso, model);
  const missedHours = segments.reduce((s, x) => s + x.missedHours, 0);
  const days = segments.reduce((s, x) => s + x.days, 0);
  return {
    segments,
    eligibleDays: segments.reduce((s, x) => s + x.eligibleDays, 0),
    missedHours,
    rawDays: model.dayHours > 0 ? missedHours / model.dayHours : 0,
    days,
    paidHours: days * model.dayHours,
    dayHours: model.dayHours,
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
  model: ChargeModel,
  entitlement: number,
  todayIso?: string,
): AllocatedSegment[] {
  const segments = vacations
    .flatMap((v) => {
      const mine = chargeSegments(v.from, v.to, model);
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
  model: ChargeModel,
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
  const all = allocateVacations([...others, candidate], model, entitlement);
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
  model: ChargeModel,
  todayIso?: string,
): number {
  return allocateVacations(vacations, model, Number.POSITIVE_INFINITY, todayIso)
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
  /** Eligible days of vacation the month contained. Zero = nothing to check against. */
  eligibleDays: number;
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

/** Eligible vacation days falling inside a "yyyy-MM" month, across all vacations. */
function eligibleVacationDaysInMonth(
  month: string,
  vacations: Vacation[],
  eligibleWeekdays: number[],
): number {
  let n = 0;
  for (const v of vacations) {
    for (const s of monthSpans(v.from, v.to)) {
      if (s.month === month) n += eligibleDaysInRange(s.from, s.to, eligibleWeekdays);
    }
  }
  return n;
}

/**
 * Check the model against the payslips.
 *
 * There is no hypothesis space to search — the mechanism is known — so the job is
 * CALIBRATION: does the rule reproduce the day counts the slips charged, and if
 * not, what weekly hours would have? That second number is the useful one, because
 * it inverts the rule against reality:
 *
 *     observed hours = eligible days away x (weekly hours / eligible per week)
 *  => weekly hours   = observed hours x eligible per week / eligible days away
 *
 * For August: 36 h x 6 / 7 = 30.9 h/week. Set beside what the shift log actually
 * averages, that says whether the log is complete and current — which is the only
 * input the estimate has.
 */
export function calibrateCharge(
  payslips: Payslip[],
  vacations: Vacation[],
  model: ChargeModel,
): Calibration {
  const slips = payslips
    .filter((p) => p.vacationDays != null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const perWeek = new Set(model.eligibleWeekdays).size;

  const checks: MonthCheck[] = slips.map((p) => {
    const eligibleDays = eligibleVacationDaysInMonth(p.month, vacations, model.eligibleWeekdays);
    const observedHours = p.vacationHours ?? 0;
    const predictedDays = vacations
      .flatMap((v) => chargeSegments(v.from, v.to, model))
      .filter((s) => s.month === p.month)
      .reduce((n, s) => n + s.days, 0);
    return {
      month: p.month,
      observedDays: p.vacationDays as number,
      observedHours,
      predictedDays,
      predictedHours: predictedDays * model.dayHours,
      eligibleDays,
      impliedWeeklyHours:
        observedHours > 0 && eligibleDays > 0 && perWeek > 0
          ? (observedHours * perWeek) / eligibleDays
          : null,
    };
  });

  const perDay = slips
    .filter((p) => p.vacationHours != null && (p.vacationDays as number) > 0)
    .map((p) => (p.vacationHours as number) / (p.vacationDays as number));
  const dayHoursConflict =
    perDay.length > 0 && perDay.some((h) => Math.abs(h - perDay[0]) > HOURS_EPSILON);

  const usableChecks = checks.filter((c) => c.eligibleDays > 0);
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
    weeklyHours: model.weeklyHours,
    impliedWeeklyHours:
      implied.length > 0 ? implied.reduce((a, b) => a + b, 0) / implied.length : null,
  };
}

/** Where the model stands, in words a person would use. */
export function describeCalibration(cal: Calibration): string {
  if (cal.usable === 0) return "Not checked against a payslip yet.";
  const slips = cal.usable + " payslip" + (cal.usable === 1 ? "" : "s");
  if (!cal.matches) {
    const c = cal.checks.find((x) => x.eligibleDays > 0 && x.predictedDays !== x.observedDays);
    return c
      ? "Your " + c.month + " payslip charged " + c.observedDays + " days; this estimate says " +
        c.predictedDays + " — your logged hours per week are probably off."
      : "Doesn't match your " + slips + ".";
  }
  return "Matches " + slips + ".";
}
