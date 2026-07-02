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
 * The genuine next real shift from `today` — today-anchored, NOT tied to the viewed
 * month. Counts planned / swapped-in (an upcoming obligation); ignores swapped-out
 * (you gave it away) and worked (already logged — once today's shift is entered,
 * "next" advances to the following one). Returns the earliest such shift on or
 * after today, or null if none upcoming.
 */
export function nextShiftFrom(shifts: Shift[], today: Date): Shift | null {
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  let best: Shift | null = null;
  for (const s of shifts) {
    if (s.status === "swapped-out" || s.status === "worked") continue;
    const d = shiftDate(s.date);
    if (d < todayMidnight) continue;
    if (!best || d < shiftDate(best.date)) best = s;
  }
  return best;
}
