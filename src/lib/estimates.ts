// Future-earnings estimates from worked history.
//
// Buckets reflect the user's own read on how tips cluster:
//   morning-weekday : opening family, Mon–Thu
//   morning-weekend : opening family, Fri–Sun
//   evening         : closing family, Mon–Sat
//   evening-sunday  : closing family, Sunday (notably low tips)
//
// Each estimate is a range: p25 / median / p75 of reported tips in the bucket.
// Thin buckets fall back to the family-wide pool, then to all worked shifts.

import type { GrossRate, Payslip, Settings, Shift } from "./types";
import { familyOf, weekdayIndexOf } from "./shiftTime";
import { netFactorForMonth, rateForDate } from "./earnings";
import { plannedHours } from "./importPlan";

export type EstimateBucket =
  | "morning-weekday"
  | "morning-weekend"
  | "evening"
  | "evening-sunday";

export const BUCKET_LABELS: Record<EstimateBucket, string> = {
  "morning-weekday": "Morning (Tue–Thu)",
  "morning-weekend": "Morning (Fri–Sun)",
  evening: "Evening",
  "evening-sunday": "Evening (Sun)",
};

/** Which bucket a shift belongs to, from its type + weekday. */
export function bucketOf(shift: Pick<Shift, "shiftType" | "date">): EstimateBucket {
  const family = familyOf(shift.shiftType);
  const wd = weekdayIndexOf(shift.date); // 0=Sun … 6=Sat
  if (family === "opening") {
    const weekend = wd === 5 || wd === 6 || wd === 0; // Fri, Sat, Sun
    return weekend ? "morning-weekend" : "morning-weekday";
  }
  return wd === 0 ? "evening-sunday" : "evening";
}

export interface Range {
  p25: number;
  median: number;
  p75: number;
}

/** Linear-interpolated quantile of a numeric sample. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function rangeOf(values: number[]): Range {
  const s = [...values].sort((a, b) => a - b);
  return { p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75) };
}

export interface BucketStats {
  bucket: EstimateBucket;
  n: number;
  tips: Range; // reported tips (before pool cut)
  medianHours: number;
}

/** Build per-bucket tip stats from worked shifts (only those with tips + hours). */
export function buildBucketStats(worked: Shift[]): Map<EstimateBucket, BucketStats> {
  const groups = new Map<EstimateBucket, Shift[]>();
  for (const s of worked) {
    if (s.status !== "worked") continue;
    const b = bucketOf(s);
    (groups.get(b) ?? groups.set(b, []).get(b)!).push(s);
  }
  const out = new Map<EstimateBucket, BucketStats>();
  for (const [bucket, rows] of groups) {
    const tips = rows.map((r) => r.tips ?? 0);
    const hours = rows.map((r) => r.actualHours ?? 0).filter((h) => h > 0);
    out.set(bucket, {
      bucket,
      n: rows.length,
      tips: rangeOf(tips),
      medianHours: hours.length ? quantile([...hours].sort((a, b) => a - b), 0.5) : 0,
    });
  }
  return out;
}

const MIN_BUCKET_N = 4; // below this we widen to a fallback pool

export interface ShiftEstimate {
  bucket: EstimateBucket;
  basis: "bucket" | "family" | "all"; // where the tip range came from
  n: number; // sample size of the basis used
  hours: number; // planned hours
  rate: number;
  netFactor: number;
  netWage: number; // hours * rate * netFactor (deterministic)
  usableTips: Range; // tip range after the pool cut
  takeHome: Range; // netWage + usableTips range
  confident: boolean; // n >= MIN_BUCKET_N
}

/**
 * Estimate earnings for a single (planned) shift.
 * `worked` is the full worked-history sample; `stats` may be precomputed for speed.
 */
export function estimateShift(
  shift: Shift,
  worked: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate" | "closingTime">,
  stats?: Map<EstimateBucket, BucketStats>,
): ShiftEstimate {
  const bucketStats = stats ?? buildBucketStats(worked);
  const bucket = bucketOf(shift);

  // Tip range with fallback chain: bucket -> same family -> all worked.
  let basis: ShiftEstimate["basis"] = "bucket";
  let sample = worked.filter((s) => s.status === "worked" && bucketOf(s) === bucket);
  if (sample.length < MIN_BUCKET_N) {
    const fam = familyOf(shift.shiftType);
    const famSample = worked.filter((s) => s.status === "worked" && familyOf(s.shiftType) === fam);
    if (famSample.length > sample.length) {
      sample = famSample;
      basis = "family";
    }
  }
  if (sample.length < MIN_BUCKET_N) {
    const all = worked.filter((s) => s.status === "worked");
    if (all.length > sample.length) {
      sample = all;
      basis = "all";
    }
  }
  const tipRange = rangeOf(sample.map((s) => s.tips ?? 0));

  const hours =
    shift.actualHours ??
    plannedHours(shift.plannedStart, shift.plannedEnd, shift.openEnd, settings.closingTime) ??
    bucketStats.get(bucket)?.medianHours ??
    0;
  const rate = shift.grossRate ?? rateForDate(shift.date, rates) ?? 0;
  const { factor } = netFactorForMonth(shift.date.slice(0, 7), payslips);
  const netFactor = factor ?? 1;
  const netWage = hours * rate * netFactor;

  const cut = 1 - settings.tipPoolRate;
  const usableTips: Range = {
    p25: tipRange.p25 * cut,
    median: tipRange.median * cut,
    p75: tipRange.p75 * cut,
  };
  const takeHome: Range = {
    p25: netWage + usableTips.p25,
    median: netWage + usableTips.median,
    p75: netWage + usableTips.p75,
  };

  return {
    bucket,
    basis,
    n: sample.length,
    hours,
    rate,
    netFactor,
    netWage,
    usableTips,
    takeHome,
    confident: sample.length >= MIN_BUCKET_N,
  };
}

export interface EstimateTotals {
  shifts: number;
  hours: number;
  netWage: number;
  takeHome: Range;
}

/** Sum estimates across a set of planned shifts. */
export function sumEstimates(
  planned: Shift[],
  worked: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate" | "closingTime">,
): EstimateTotals {
  const stats = buildBucketStats(worked);
  const t: EstimateTotals = {
    shifts: 0,
    hours: 0,
    netWage: 0,
    takeHome: { p25: 0, median: 0, p75: 0 },
  };
  for (const s of planned) {
    const e = estimateShift(s, worked, rates, payslips, settings, stats);
    t.shifts += 1;
    t.hours += e.hours;
    t.netWage += e.netWage;
    t.takeHome.p25 += e.takeHome.p25;
    t.takeHome.median += e.takeHome.median;
    t.takeHome.p75 += e.takeHome.p75;
  }
  return t;
}
