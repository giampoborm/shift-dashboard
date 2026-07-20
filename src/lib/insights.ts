// Worker-facing insights derived from the same shift history the rest of the app
// uses. Pure functions, no DB/React — each takes the shared
// (shifts, rates, payslips, settings) and returns plain rows the UI maps over.
//
// Two lenses, neither of which the raw tables make obvious:
//   1. effectiveHourlyByBucket — the TRUE €/hour of your life per shift kind
//      (net wage + usable tips, blended over real hours). Reveals that some
//      shifts pay near the wage floor and others double it — the signal you use
//      to decide which shifts to ask to work more of.
//   6. tipTrend — recent-vs-prior tips/hour per bucket, to catch slow income
//      erosion (a bigger pool cut, a policy change, seasonality) before it has
//      quietly cost you months.
//
// Invariants honoured: usable tips only ever = tips × (1 − tipPoolRate); gross
// comes from the authoritative rate snapshot via computeShiftEarnings; meetings
// (structurally tip-free) are excluded from every tip comparison here. Buckets are
// the app's canonical tip buckets (morning-weekday/weekend, evening, evening-Sun) —
// the same taxonomy the estimate engine trusts, so the two never disagree.

import type { GrossRate, Payslip, Settings, Shift } from "./types";
import { computeShiftEarnings } from "./earnings";
import { bucketOf, BUCKET_LABELS, type EstimateBucket } from "./estimates";

const DAY_MS = 86_400_000;
const todayISO = (): string => new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// 1. True effective €/hour, per tip bucket.
// ─────────────────────────────────────────────────────────────────────────────
export interface HourlyRow {
  bucket: EstimateBucket;
  label: string;
  n: number; // worked shifts in the bucket (with real hours)
  hours: number; // total hours worked in the bucket
  wagePerHour: number; // net wage ÷ hours (blended)
  tipsPerHour: number; // usable tips ÷ hours (blended)
  perHour: number; // take-home ÷ hours — the headline "€/hour of your life"
}

/**
 * Blended take-home per hour for each tip bucket, ranked best-first. Uses a proper
 * weighted average (Σ take-home ÷ Σ hours), not a mean of per-shift rates, so it
 * answers "over all my morning-weekend shifts, what did an hour actually pay?".
 * Meetings and hour-less rows are excluded.
 */
export function effectiveHourlyByBucket(
  worked: Shift[],
  rates: GrossRate[],
  payslips: Payslip[],
  settings: Pick<Settings, "tipPoolRate">,
): HourlyRow[] {
  const agg = new Map<EstimateBucket, { n: number; hours: number; net: number; tips: number }>();
  for (const s of worked) {
    if (s.status !== "worked" || s.shiftType === "meeting") continue;
    const h = s.actualHours ?? 0;
    if (h <= 0) continue;
    const e = computeShiftEarnings(s, rates, payslips, settings);
    const b = bucketOf(s);
    const a = agg.get(b) ?? { n: 0, hours: 0, net: 0, tips: 0 };
    a.n += 1;
    a.hours += h;
    a.net += e.netPay;
    a.tips += e.usableTips;
    agg.set(b, a);
  }
  const rows: HourlyRow[] = [];
  for (const [bucket, a] of agg) {
    rows.push({
      bucket,
      label: BUCKET_LABELS[bucket],
      n: a.n,
      hours: a.hours,
      wagePerHour: a.net / a.hours,
      tipsPerHour: a.tips / a.hours,
      perHour: (a.net + a.tips) / a.hours,
    });
  }
  rows.sort((x, y) => y.perHour - x.perHour);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tip-erosion early warning: recent window vs the prior window of equal length.
// ─────────────────────────────────────────────────────────────────────────────
export interface TrendRow {
  scope: "all" | EstimateBucket;
  label: string;
  recentN: number;
  priorN: number;
  recentTph: number; // reported tips ÷ hours in the recent window
  priorTph: number;
  deltaTph: number; // recentTph − priorTph
  pct: number | null; // deltaTph ÷ priorTph, null when there is no prior baseline
  direction: "up" | "down" | "flat";
  comparable: boolean; // both windows have >= minN shifts, so the delta is meaningful
  significant: boolean; // comparable AND |pct| >= threshold
}

interface Acc {
  tips: number;
  hours: number;
  n: number;
}

export interface TrendOptions {
  asOf?: string;
  windowDays?: number; // length of each comparison window (default 8 weeks)
  minN?: number; // min shifts per window to call a comparison meaningful
  threshold?: number; // relative change flagged as significant (default 15%)
}

/**
 * Reported tips/hour in the last `windowDays` vs the `windowDays` before that, for
 * every tip bucket plus an "all" roll-up. A bucket appears as soon as it has data
 * in EITHER window — so a bucket with only recent shifts still surfaces (its
 * baseline "builds" as older data ages in), rather than vanishing until both
 * windows are full. Flags buckets whose rate moved by more than `threshold`. Uses
 * reported tips (matching the Tips/h chart); the pool cut is constant so the
 * percentage change is identical to the usable-tip change.
 */
export function tipTrend(worked: Shift[], opts: TrendOptions = {}): TrendRow[] {
  const asOf = opts.asOf ?? todayISO();
  const windowDays = opts.windowDays ?? 56;
  const minN = opts.minN ?? 3;
  const threshold = opts.threshold ?? 0.15;

  const asOfMs = Date.parse(asOf);
  const recentLo = asOfMs - windowDays * DAY_MS;
  const priorLo = asOfMs - 2 * windowDays * DAY_MS;

  const recent = new Map<string, Acc>();
  const prior = new Map<string, Acc>();
  const add = (m: Map<string, Acc>, key: string, tips: number, hours: number) => {
    const a = m.get(key) ?? { tips: 0, hours: 0, n: 0 };
    a.tips += tips;
    a.hours += hours;
    a.n += 1;
    m.set(key, a);
  };

  for (const s of worked) {
    if (s.status !== "worked" || s.shiftType === "meeting") continue;
    const h = s.actualHours ?? 0;
    if (h <= 0) continue;
    const t = Date.parse(s.date);
    const target = t > recentLo && t <= asOfMs ? recent : t > priorLo && t <= recentLo ? prior : null;
    if (!target) continue;
    const tips = s.tips ?? 0;
    const bucket = bucketOf(s);
    add(target, "all", tips, h);
    add(target, bucket, tips, h);
  }

  const scopes: ("all" | EstimateBucket)[] = ["all"];
  for (const m of [recent, prior])
    for (const b of m.keys())
      if (b !== "all" && !scopes.includes(b as EstimateBucket)) scopes.push(b as EstimateBucket);

  const empty: Acc = { tips: 0, hours: 0, n: 0 };
  const rows: TrendRow[] = [];
  for (const scope of scopes) {
    const r = recent.get(scope) ?? empty;
    const p = prior.get(scope) ?? empty;
    if (r.n === 0 && p.n === 0) continue;
    const recentTph = r.hours > 0 ? r.tips / r.hours : 0;
    const priorTph = p.hours > 0 ? p.tips / p.hours : 0;
    const deltaTph = recentTph - priorTph;
    const pct = p.n > 0 && priorTph > 0 ? deltaTph / priorTph : null;
    const comparable = r.n >= minN && p.n >= minN;
    const significant = comparable && pct !== null && Math.abs(pct) >= threshold;
    const direction: TrendRow["direction"] = significant ? (deltaTph < 0 ? "down" : "up") : "flat";
    rows.push({
      scope,
      label: scope === "all" ? "All shifts" : BUCKET_LABELS[scope],
      recentN: r.n,
      priorN: p.n,
      recentTph,
      priorTph,
      deltaTph,
      pct,
      direction,
      comparable,
      significant,
    });
  }

  // "all" pinned first; the rest most-negative change first so erosion leads,
  // with no-baseline-yet rows (null pct) sorted to the end.
  rows.sort((a, b) => {
    if (a.scope === "all") return -1;
    if (b.scope === "all") return 1;
    return (a.pct ?? Infinity) - (b.pct ?? Infinity);
  });
  return rows;
}
