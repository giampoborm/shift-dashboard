// Importer for the weekly plan CSV — a pivot grid with stacked station blocks.
//
// Layout (see data/plan-3rdjune.csv):
//   - A block starts with a header row whose 3rd column ends in ":" (e.g. "BAR:",
//     "RUNNERS:", "WORLD CUP:"). That same row carries the dates (dd.MM.yyyy) in
//     columns 4..N.
//   - The next row is weekday names — ignored (weekday is derived from the date).
//   - Following rows: column 3 = time slot, columns 4..N = the person rostered in
//     that (slot × date) cell.
//
// We scan EVERY block for the user's name and emit a "planned" shift per hit.
// Non-roster blocks (WORLD CUP, CHANNELS) naturally produce nothing: their cells
// hold team/channel names, never the user, and their "slots" don't parse as times.

import Papa from "papaparse";
import { parse, isValid } from "date-fns";
import type { GrossRate, Settings, Shift } from "./types";
import type { ImportWarning } from "./importHistory";
import { rateForDate } from "./earnings";
import { classifyShiftType, parseTimeSlot, parseTimeToken, toIso } from "./shiftTime";

export interface PlanImportResult {
  shifts: Shift[];
  warnings: ImportWarning[];
  matched: number; // number of cells matching the user
}

const HEADER_COL = 2; // 0-based: the "BAR:" / time-slot column
const FIRST_DATE_COL = 3; // 0-based: dates / names start here

function parseGermanDate(cell: string): string | null {
  const t = (cell ?? "").trim();
  if (!t) return null;
  const d = parse(t, "dd.MM.yyyy", new Date());
  return isValid(d) ? toIso(d) : null;
}

export function importPlanCsv(
  csvText: string,
  sourceLabel: string,
  rates: GrossRate[],
  settings: Pick<Settings, "userName" | "closingTime">,
): PlanImportResult {
  const grid = Papa.parse<string[]>(csvText, { skipEmptyLines: false }).data;
  const closingMinutes = parseTimeToken(settings.closingTime) ?? 60;
  const userName = settings.userName.trim().toLowerCase();

  const shifts: Shift[] = [];
  const warnings: ImportWarning[] = [];
  let matched = 0;
  const now = new Date().toISOString();

  let station = "";
  let dates: (string | null)[] = [];

  grid.forEach((row, idx) => {
    const headerCell = (row[HEADER_COL] ?? "").trim();

    // Block header: "BAR:", "RUNNERS:", ...
    if (headerCell.endsWith(":")) {
      station = headerCell.slice(0, -1).trim();
      dates = row.slice(FIRST_DATE_COL).map(parseGermanDate);
      return;
    }

    if (!station || headerCell === "") return;

    // Treat as a slot row only if the header column parses as a real time range.
    const slot = parseTimeSlot(headerCell, closingMinutes);
    if (!slot.start) return;

    const shiftType = classifyShiftType(slot);

    for (let k = 0; k < dates.length; k++) {
      const name = (row[FIRST_DATE_COL + k] ?? "").trim();
      if (name.toLowerCase() !== userName) continue;
      matched += 1;

      const date = dates[k];
      if (!date) {
        warnings.push({
          row: idx + 1,
          severity: "warn",
          message: `Found ${settings.userName} in ${station} slot ${headerCell} but the column has no valid date`,
          raw: row.join(" | "),
        });
        continue;
      }

      shifts.push({
        date,
        station,
        shiftType,
        plannedStart: slot.start,
        plannedEnd: slot.end,
        openEnd: slot.openEnd,
        crossesMidnight: slot.crossesMidnight,
        status: "planned",
        grossRate: rateForDate(date, rates),
        source: sourceLabel,
        createdAt: now,
      });
    }
  });

  return { shifts, warnings, matched };
}

/** Planned duration in hours from a slot, using the closing time for "Ende". */
export function plannedHours(
  start: string | undefined,
  end: string | undefined,
  openEnd: boolean,
  closingTime: string,
): number | null {
  const s = start ? parseTimeToken(start) : null;
  if (s == null) return null;
  let e: number | null;
  if (openEnd) e = parseTimeToken(closingTime);
  else e = end ? parseTimeToken(end) : null;
  if (e == null) return null;
  let diff = e - s;
  if (diff <= 0) diff += 24 * 60; // crosses midnight
  return Math.round((diff / 60) * 100) / 100;
}
