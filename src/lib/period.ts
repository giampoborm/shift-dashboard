// Period helpers for the redesigned IA. The viewed time-period is the app's master
// control: Home looks at one MONTH (a Date cursor), Analysis looks at a RANGE.
// These are pure so they can be tested and reused by both rooms + the next-shift card.

import { startOfMonth, endOfMonth, isWithinInterval } from "date-fns";
import type { Shift } from "./types";

/** A shift's ISO date (yyyy-MM-dd) as a local Date at midnight. */
function shiftDate(iso: string): Date {
  return new Date(iso + "T00:00");
}

/** True when a shift falls inside the calendar month of `cursor`. */
export function isInMonth(shift: Shift, cursor: Date): boolean {
  return isWithinInterval(shiftDate(shift.date), {
    start: startOfMonth(cursor),
    end: endOfMonth(cursor),
  });
}

/** All shifts whose date is in the cursor's month. */
export function shiftsInMonth(shifts: Shift[], cursor: Date): Shift[] {
  return shifts.filter((s) => isInMonth(s, cursor));
}

/**
 * The genuine next real shift — the earliest still-unlogged obligation (planned /
 * swapped-in), NOT tied to the viewed month. Ignores swapped-out (you gave it away)
 * and worked (already logged). Deliberately NOT filtered to "on or after today": a
 * shift stays "next" past its own midnight — even overdue — until it's logged as
 * worked, so the card doesn't silently jump to the following shift before you've
 * had a chance to log the one that just happened. `today` is unused but kept so
 * callers read as today-anchored and the signature can grow a real use later.
 */
export function nextShiftFrom(shifts: Shift[], _today: Date): Shift | null {
  let best: Shift | null = null;
  for (const s of shifts) {
    if (s.status === "swapped-out" || s.status === "worked") continue;
    if (!best || shiftDate(s.date) < shiftDate(best.date)) best = s;
  }
  return best;
}
