// Tolerant parsing of the messy time-slot strings found in real plan/history CSVs.
// Examples seen in the wild: "11-18", "18-00", "18-01:40", "17-22.2", "18—0" (em-dash),
// "10:30-18", "17:00-23:00", "18:00-Ende", "18:00-00:00", "18—0".
//
// We do NOT rely on this for hours worked (the history CSV gives decimal hours
// directly). It exists to derive: start time -> shiftType, and whether the slot
// crosses midnight (-> 2 working days).

import { parse, format, getDay } from "date-fns";
import type { ShiftFamily, ShiftType } from "./types";

const OPEN_END_TOKENS = new Set(["ende", "close", "open"]);

/** Normalize en/em dashes and stray spaces to a plain ASCII hyphen. */
function normalizeDashes(s: string): string {
  return s.replace(/[‒–—―−]/g, "-");
}

/**
 * Parse a single time token to minutes-since-midnight, or null if unparseable.
 * Accepts "18", "0", "00", "10:30", "01:40", and best-effort "22.2" (decimal hour).
 */
export function parseTimeToken(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === "") return null;
  if (OPEN_END_TOKENS.has(t)) return null;

  if (t.includes(":")) {
    const [h, m] = t.split(":");
    const hh = Number(h);
    const mm = Number(m);
    if (Number.isFinite(hh) && Number.isFinite(mm)) return hh * 60 + mm;
    return null;
  }
  if (t.includes(".")) {
    // decimal hour like "22.2" -> 22h + 0.2*60
    const v = Number(t);
    if (Number.isFinite(v)) return Math.round(v * 60);
    return null;
  }
  const hh = Number(t);
  if (Number.isFinite(hh)) return hh * 60;
  return null;
}

function minutesToHHmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export interface ParsedSlot {
  start?: string; // "HH:mm"
  end?: string; // "HH:mm"; undefined when open-ended
  openEnd: boolean;
  /** True if the shift runs past midnight (end <= start, or open close past midnight). */
  crossesMidnight: boolean;
}

/**
 * Parse a "start-end" slot string.
 * @param closingMinutes minutes-since-midnight used to resolve "Ende" (open close).
 */
export function parseTimeSlot(raw: string, closingMinutes = 60): ParsedSlot {
  const norm = normalizeDashes(raw).trim();
  const dashIdx = norm.indexOf("-");
  const startRaw = dashIdx >= 0 ? norm.slice(0, dashIdx) : norm;
  const endRaw = dashIdx >= 0 ? norm.slice(dashIdx + 1) : "";

  const startMin = parseTimeToken(startRaw);
  const endTrim = endRaw.trim().toLowerCase();
  const openEnd = OPEN_END_TOKENS.has(endTrim);
  const endMin = openEnd ? closingMinutes : parseTimeToken(endRaw);

  let crossesMidnight = false;
  if (startMin !== null && endMin !== null) {
    // 00:00 as an end reads as 0 -> always <= a positive start => crosses.
    crossesMidnight = endMin <= startMin;
  }

  return {
    start: startMin !== null ? minutesToHHmm(startMin) : undefined,
    end: endMin !== null && !openEnd ? minutesToHHmm(endMin) : undefined,
    openEnd,
    crossesMidnight,
  };
}

/**
 * Classify a slot into one of the five named shift types.
 * Rule: open-ended ("Ende") => closing; a fixed end after 00:00 => closing;
 * an end exactly at 00:00 stays early-closing; otherwise bucket by start hour.
 * See the shift-type taxonomy for the grounding.
 */
export function classifyShiftType(slot: ParsedSlot): ShiftType {
  const s = slot.start ? parseTimeToken(slot.start) ?? 0 : 0;
  if (slot.openEnd) return "closing";
  if (slot.crossesMidnight) {
    const e = slot.end ? parseTimeToken(slot.end) ?? 0 : 0;
    if (e > 0) return "closing"; // genuinely worked past midnight (e.g. 18-01:40)
  }
  if (s < 12 * 60) return "opening"; // 10:30, 11:00
  if (s < 15 * 60) return "late-morning"; // 12:00
  if (s < 17 * 60) return "mid-day"; // 16:00
  return "early-closing"; // 17:00, 18:00 with fixed end at/before midnight
}

/** Opening (morning) vs closing (evening) family. */
export function familyOf(type: ShiftType): ShiftFamily {
  return type === "opening" || type === "late-morning" ? "opening" : "closing";
}

/** Numeric weekday, 0=Sunday … 6=Saturday (date-fns getDay convention). */
export function weekdayIndexOf(isoDate: string): number {
  return getDay(parse(isoDate, "yyyy-MM-dd", new Date()));
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Weekday name derived from an ISO date — the only trustworthy source. */
export function weekdayOf(isoDate: string): string {
  const d = parse(isoDate, "yyyy-MM-dd", new Date());
  return WEEKDAYS[getDay(d)] ?? "";
}

/** Re-export a stable ISO formatter for callers. */
export function toIso(date: Date): string {
  return format(date, "yyyy-MM-dd");
}
