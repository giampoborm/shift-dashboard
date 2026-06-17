// CSV export of shifts with their derived earnings (one clean row per shift).
import Papa from "papaparse";
import type { GrossRate, Payslip, Settings, Shift } from "./types";
import { computeShiftEarnings } from "./earnings";
import { weekdayOf } from "./shiftTime";

export function shiftsToCsv(
  shifts: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): string {
  const rows = shifts.map((s) => {
    const e = computeShiftEarnings(s, rates, payslips, settings);
    return {
      date: s.date,
      weekday: weekdayOf(s.date),
      station: s.station,
      shiftType: s.shiftType,
      start: s.plannedStart ?? "",
      end: s.openEnd ? "Ende" : s.plannedEnd ?? "",
      status: s.status,
      hours: s.actualHours ?? "",
      grossRate: s.grossRate ?? "",
      grossPay: round2(e.grossPay),
      netPay: round2(e.netPay),
      reportedTips: s.tips ?? 0,
      usableTips: round2(e.usableTips),
      takeHome: round2(e.takeHome),
      tipsPerHour: e.tipsPerHour == null ? "" : round2(e.tipsPerHour),
      netPerHour: e.netPerHour == null ? "" : round2(e.netPerHour),
      workingDays: e.workingDays,
    };
  });
  return Papa.unparse(rows);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadText(filename: string, content: string, mime = "text/csv"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
