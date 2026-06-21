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
//
// Recency: tips drift over time (the user's evening median fell month-on-month),
// so each historical shift is weighted by exponential decay on its age — a
// configurable half-life (Settings.recencyHalfLifeDays). Recent shifts dominate
// the quantiles; old ones fade but are never deleted. Half-life 0 = equal weights
// (the original behaviour), which keeps every existing call/test unchanged.

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

/** Today as "yyyy-MM-dd" — the default reference point for recency. */
const todayISO = (): string => new Date().toISOString().slice(0, 10);

/**
 * Exponential recency weight: 1.0 for a shift on `asOf`, halving every
 * `halfLifeDays`. halfLifeDays <= 0 disables weighting (returns 1). Shifts dated
 * on/after `asOf` get full weight (no up-weighting of the future).
 */
export function recencyWeight(shiftDate: string, asOf: string, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  const ageDays = (Date.parse(asOf) - Date.parse(shiftDate)) / 86_400_000;
  if (!(ageDays > 0)) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Weighted, linearly-interpolated quantile (midpoint plotting position). With
 * equal weights this matches the median of `quantile`; with decaying weights the
 * quantile slides toward the more recent values. Degenerate weights (all ≤ 0)
 * fall back to the unweighted quantile so we never return 0 spuriously.
 */
export function weightedQuantile(pairs: { value: number; weight: number }[], q: number): number {
  const s = pairs.filter((p) => p.weight > 0).sort((a, b) => a.value - b.value);
  if (s.length === 0) return quantile([...pairs.map((p) => p.value)].sort((a, b) => a - b), q);
  if (s.length === 1) return s[0].value;
  const total = s.reduce((acc, p) => acc + p.weight, 0);
  const pos: number[] = [];
  let cum = 0;
  for (const p of s) {
    pos.push((cum + p.weight / 2) / total); // midpoint of this sample's weight mass
    cum += p.weight;
  }
  if (q <= pos[0]) return s[0].value;
  if (q >= pos[pos.length - 1]) return s[s.length - 1].value;
  let k = 0;
  while (k < pos.length - 1 && pos[k + 1] < q) k++;
  const t = (q - pos[k]) / (pos[k + 1] - pos[k]);
  return s[k].value + (s[k + 1].value - s[k].value) * t;
}

/** Tip range for a sample, recency-weighted when halfLifeDays > 0. */
function tipRangeFor(sample: Shift[], asOf: string, halfLifeDays: number): Range {
  if (!(halfLifeDays > 0)) return rangeOf(sample.map((s) => s.tips ?? 0));
  const pairs = sample.map((s) => ({
    value: s.tips ?? 0,
    weight: recencyWeight(s.date, asOf, halfLifeDays),
  }));
  return {
    p25: weightedQuantile(pairs, 0.25),
    median: weightedQuantile(pairs, 0.5),
    p75: weightedQuantile(pairs, 0.75),
  };
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
  settings: Pick<Settings, "tipPoolRate" | "closingTime"> & { recencyHalfLifeDays?: number },
  stats?: Map<EstimateBucket, BucketStats>,
  asOf: string = todayISO(),
): ShiftEstimate {
  const bucketStats = stats ?? buildBucketStats(worked);
  const bucket = bucketOf(shift);
  // Fall back to 0 (= equal weights) only if the field is genuinely absent. The
  // real default (45) lives in DEFAULT_SETTINGS and is back-filled by getSettings,
  // which every in-app read goes through — so this branch is the conservative
  // "off" path for ad-hoc callers, never the live app's normal case.
  const halfLife = settings.recencyHalfLifeDays ?? 0;

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
  const tipRange = tipRangeFor(sample, asOf, halfLife);

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
  grossWage: number; // Σ hours × rate (deterministic, like the worked gross)
  netWage: number;
  usableTips: Range; // monthly tip band: Σ medians ± quadrature spread
  takeHome: Range;
}

/**
 * Sum estimates across a set of planned shifts.
 *
 * The centre (median) is the sum of per-shift medians. The p25/p75 band, though,
 * is NOT the sum of per-shift p25s/p75s — that would assume every shift lands at
 * its 25th (or 75th) percentile on the same night, hugely overstating the spread
 * of a monthly total. Tip nights are roughly independent, so their variances add
 * and the band grows like √n, not n. We combine the half-widths in quadrature
 * (upper and lower separately, to keep each shift's skew), which is the standard
 * error-propagation result and cancels any normal-distribution constant.
 */
export function sumEstimates(
  planned: Shift[],
  worked: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate" | "closingTime"> & { recencyHalfLifeDays?: number },
  asOf: string = todayISO(),
): EstimateTotals {
  const stats = buildBucketStats(worked);
  let shifts = 0;
  let hours = 0;
  let grossWage = 0;
  let netWage = 0;
  let tipMedian = 0;
  let lowerVar = 0; // Σ (median − p25)²  — squared lower half-widths
  let upperVar = 0; // Σ (p75 − median)²  — squared upper half-widths
  for (const s of planned) {
    const e = estimateShift(s, worked, rates, payslips, settings, stats, asOf);
    shifts += 1;
    hours += e.hours;
    grossWage += e.hours * e.rate;
    netWage += e.netWage;
    tipMedian += e.usableTips.median;
    lowerVar += (e.usableTips.median - e.usableTips.p25) ** 2;
    upperVar += (e.usableTips.p75 - e.usableTips.median) ** 2;
  }
  const tipLow = Math.max(0, tipMedian - Math.sqrt(lowerVar)); // tips never go negative
  const tipHigh = tipMedian + Math.sqrt(upperVar);
  const usableTips: Range = { p25: tipLow, median: tipMedian, p75: tipHigh };
  const takeHome: Range = {
    p25: netWage + tipLow,
    median: netWage + tipMedian,
    p75: netWage + tipHigh,
  };
  return { shifts, hours, grossWage, netWage, usableTips, takeHome };
}
