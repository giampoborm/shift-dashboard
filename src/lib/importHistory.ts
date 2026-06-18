// Importer for history.csv — past worked shifts, one row each.
// Columns: "Giorno settimana", "Date", "mancia" (tips), "numero ore" (hours),
//          "stipendio nuovo" (gross estimate — VALIDATION ONLY, not authoritative).
//
// Design rules grounded in the real data:
//  - Weekday is DERIVED from the parsed date; the weekday column is dirty
//    (Italian/English, typos like "thrusday", "wednseday") and ignored for truth.
//  - The decimal "numero ore" column is the authoritative hours worked.
//  - Gross rate is snapshotted from the effective-dated rate table at the shift date.
//  - We FLAG anomalies (unparseable dates, duplicate dates, day-number mismatch,
//    gross-estimate disagreement) rather than silently fixing them.

import Papa from "papaparse";
import { parse, isValid, getDate } from "date-fns";
import type { GrossRate, Settings, Shift } from "./types";
import { rateForDate } from "./earnings";
import { classifyShiftType, parseTimeSlot, parseTimeToken, toIso } from "./shiftTime";

/**
 * "warn" = a genuine anomaly worth acting on (duplicate date, mis-dated row,
 * missing hours, no rate, unparseable date).
 * "info" = an expected cross-check drift, notably the CSV's "stipendio nuovo"
 * estimate being computed at the pre-April €14.50 rate. Not an error.
 */
export type WarningSeverity = "warn" | "info";

export interface ImportWarning {
  row: number; // 1-based data row (excludes header)
  date?: string;
  severity: WarningSeverity;
  message: string;
  raw: string;
}

export interface ImportResult {
  shifts: Shift[];
  warnings: ImportWarning[];
  skipped: number;
}

/** Parse a money string like "€38.00", "1.931,40", "47" to a number, or null. */
export function parseMoney(raw: string): number | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[^0-9.,-]/g, "").trim();
  if (s === "") return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Assume the last separator is the decimal one.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// A "start-end" time range like "11-18", "18-01:40", "18-Ende". Shared by the
// slot extractor and the day-number guard so they agree on what a time looks like.
// (No `g` flag: replace/match operate on the first range only.)
const TIME_RANGE =
  /(\d{1,2}(?::\d{2})?(?:\.\d+)?)\s*-\s*(\d{1,2}(?::\d{2})?(?:\.\d+)?|[Ee]nde)/;

/** Extract a "start-end" time slot from a free-text cell, or "" if none found. */
export function extractTimeSlot(cell: string): string {
  const norm = cell.replace(/[‒–—―−]/g, "-");
  const m = norm.match(TIME_RANGE);
  return m ? `${m[1]}-${m[2]}` : "";
}

/**
 * Leading day-of-month integer in the weekday cell, e.g. "dom 29 18-00" -> 29.
 * The time slot is stripped FIRST so a slot start like the "11" in "sab 11-18"
 * (a row with no day number at all) isn't mistaken for the 11th and falsely
 * flagged as mis-dated.
 */
function leadingDayNumber(cell: string): number | null {
  const norm = cell.replace(/[‒–—―−]/g, "-").replace(TIME_RANGE, " ");
  const m = norm.trim().match(/^[^\d]*(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}

const GROSS_ESTIMATE_TOLERANCE = 0.5; // EUR

export function importHistoryCsv(
  csvText: string,
  rates: GrossRate[],
  settings: Pick<Settings, "tipPoolRate" | "closingTime">,
): ImportResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const closingMinutes = parseTimeToken(settings.closingTime) ?? 60;
  const shifts: Shift[] = [];
  const warnings: ImportWarning[] = [];
  const seenDates = new Map<string, number>(); // date -> first row
  let skipped = 0;
  const now = new Date().toISOString();

  parsed.data.forEach((rowObj, i) => {
    const row = i + 1;
    const cols = Object.values(rowObj);
    const weekdayCell = (rowObj["Giorno settimana"] ?? cols[0] ?? "").toString();
    const dateCell = (rowObj["Date"] ?? cols[1] ?? "").toString().trim();
    const tipsCell = (rowObj["mancia"] ?? cols[2] ?? "").toString();
    const hoursCell = (rowObj["numero ore"] ?? cols[3] ?? "").toString();
    const grossCell = (rowObj["stipendio nuovo"] ?? cols[4] ?? "").toString();

    const raw = cols.join(" | ");

    // --- Date (the spine; skip the row if we can't trust it) ---
    const d = parse(dateCell, "MMMM d, yyyy", new Date());
    if (!dateCell || !isValid(d)) {
      warnings.push({
        row,
        severity: "warn",
        message: `Unparseable date "${dateCell}" — row skipped`,
        raw,
      });
      skipped += 1;
      return;
    }
    const isoDate = toIso(d);

    // --- Hours (authoritative) ---
    const hours = parseMoney(hoursCell);
    if (hours == null) {
      warnings.push({
        row,
        date: isoDate,
        severity: "warn",
        message: `Missing/invalid hours "${hoursCell}"`,
        raw,
      });
    }

    const tips = parseMoney(tipsCell) ?? 0;

    // --- Time slot -> shiftType / crossesMidnight ---
    const slotStr = extractTimeSlot(weekdayCell);
    const slot = parseTimeSlot(slotStr, closingMinutes);
    const shiftType = classifyShiftType(slot);

    // --- Gross rate snapshot + validation against the CSV estimate ---
    const rate = rateForDate(isoDate, rates);
    if (rate == null) {
      warnings.push({
        row,
        date: isoDate,
        severity: "warn",
        message: `No gross rate defined for ${isoDate}`,
        raw,
      });
    }
    const estimate = parseMoney(grossCell);
    if (rate != null && hours != null && estimate != null) {
      const computed = hours * rate;
      if (Math.abs(computed - estimate) > GROSS_ESTIMATE_TOLERANCE) {
        warnings.push({
          row,
          date: isoDate,
          severity: "info",
          message: `CSV estimate €${estimate.toFixed(2)} ≠ computed €${computed.toFixed(2)} (hours×rate) — CSV likely used the pre-raise €14.50`,
          raw,
        });
      }
    }

    // --- Anomaly checks (flag, don't fix) ---
    const dayNum = leadingDayNumber(weekdayCell);
    if (dayNum != null && dayNum !== getDate(d)) {
      warnings.push({
        row,
        date: isoDate,
        severity: "warn",
        message: `Weekday-column day "${dayNum}" ≠ date day "${getDate(d)}" — possible mis-dated row`,
        raw,
      });
    }
    if (seenDates.has(isoDate)) {
      warnings.push({
        row,
        date: isoDate,
        severity: "warn",
        message: `Duplicate date — also on row ${seenDates.get(isoDate)}`,
        raw,
      });
    } else {
      seenDates.set(isoDate, row);
    }

    shifts.push({
      date: isoDate,
      station: "BAR", // history CSV has no station column; default, editable later
      shiftType,
      plannedStart: slot.start,
      plannedEnd: slot.end,
      openEnd: slot.openEnd,
      crossesMidnight: slot.crossesMidnight,
      status: "worked",
      actualHours: hours ?? undefined,
      tips,
      grossRate: rate,
      source: "history.csv",
      createdAt: now,
    });
  });

  return { shifts, warnings, skipped };
}
