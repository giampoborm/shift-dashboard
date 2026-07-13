import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bucketOf,
  buildBucketStats,
  estimateShift,
  quantile,
  recencyWeight,
  sumEstimates,
  weightedQuantile,
} from "./estimates";
import { importHistoryCsv } from "./importHistory";
import { DEFAULT_PAYSLIPS, DEFAULT_RATES, DEFAULT_SETTINGS } from "./db";
import type { Shift } from "./types";

const settings = DEFAULT_SETTINGS;

function worked(): Shift[] {
  const csv = readFileSync(new URL("../../data/history.csv", import.meta.url), "utf8");
  return importHistoryCsv(csv, DEFAULT_RATES, settings).shifts;
}

describe("quantile", () => {
  it("interpolates", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([10], 0.25)).toBe(10);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe("recencyWeight", () => {
  it("is 1 today, halves each half-life, and disables at half-life <= 0", () => {
    expect(recencyWeight("2026-06-21", "2026-06-21", 30)).toBeCloseTo(1);
    expect(recencyWeight("2026-05-22", "2026-06-21", 30)).toBeCloseTo(0.5); // ~30d old
    expect(recencyWeight("2026-04-22", "2026-06-21", 30)).toBeCloseTo(0.25); // ~60d old
    expect(recencyWeight("2026-01-01", "2026-06-21", 0)).toBe(1); // weighting off
    expect(recencyWeight("2026-07-01", "2026-06-21", 30)).toBe(1); // future => full weight
  });
});

describe("weightedQuantile", () => {
  it("matches the interpolating median when weights are equal", () => {
    const eq = [1, 2, 3, 4].map((v) => ({ value: v, weight: 1 }));
    expect(weightedQuantile(eq, 0.5)).toBeCloseTo(2.5);
  });
  it("slides toward the heavily-weighted values", () => {
    // low values weak, high values strong => median pulled up vs the plain 2.5
    const pairs = [
      { value: 1, weight: 0.1 },
      { value: 2, weight: 0.1 },
      { value: 3, weight: 1 },
      { value: 4, weight: 1 },
    ];
    expect(weightedQuantile(pairs, 0.5)).toBeGreaterThan(2.5);
  });
  it("falls back to unweighted when all weights are zero", () => {
    const z = [10, 20, 30].map((v) => ({ value: v, weight: 0 }));
    expect(weightedQuantile(z, 0.5)).toBeCloseTo(20);
  });
});

describe("bucketOf", () => {
  it("splits mornings by weekday/weekend and evenings by Sunday", () => {
    expect(bucketOf({ shiftType: "opening", date: "2026-06-09" })).toBe("morning-weekday"); // Tue
    expect(bucketOf({ shiftType: "opening", date: "2026-06-12" })).toBe("morning-weekend"); // Fri
    expect(bucketOf({ shiftType: "late-morning", date: "2026-06-14" })).toBe("morning-weekend"); // Sun
    expect(bucketOf({ shiftType: "closing", date: "2026-06-13" })).toBe("evening"); // Sat
    expect(bucketOf({ shiftType: "closing", date: "2026-06-14" })).toBe("evening-sunday"); // Sun
  });
  it("meeting always gets its own trivial bucket, regardless of weekday", () => {
    expect(bucketOf({ shiftType: "meeting", date: "2026-06-09" })).toBe("meeting"); // Tue
    expect(bucketOf({ shiftType: "meeting", date: "2026-06-14" })).toBe("meeting"); // Sun
  });
});

describe("buildBucketStats (real history)", () => {
  it("produces stats for all four buckets with sane ordering", () => {
    const stats = buildBucketStats(worked());
    for (const b of ["morning-weekday", "morning-weekend", "evening", "evening-sunday"] as const) {
      const s = stats.get(b);
      expect(s, `bucket ${b} present`).toBeDefined();
      expect(s!.n).toBeGreaterThan(0);
      expect(s!.tips.p25).toBeLessThanOrEqual(s!.tips.median);
      expect(s!.tips.median).toBeLessThanOrEqual(s!.tips.p75);
    }
  });

  it("Sunday evenings are lower-tipping than other evenings (user's claim)", () => {
    const stats = buildBucketStats(worked());
    const sun = stats.get("evening-sunday")!;
    const eve = stats.get("evening")!;
    expect(sun.tips.median).toBeLessThan(eve.tips.median);
  });

  it("excludes meeting shifts from tip-bucket stats entirely", () => {
    const meeting: Shift = {
      date: "2026-06-09", // Tue
      station: "BAR",
      shiftType: "meeting",
      openEnd: false,
      crossesMidnight: false,
      status: "worked",
      actualHours: 2,
      tips: undefined,
      source: "test",
      createdAt: "now",
    };
    const withMeeting = buildBucketStats([...worked(), meeting]);
    const without = buildBucketStats(worked());
    expect(withMeeting.get("meeting")).toBeUndefined();
    // Doesn't leak into morning-weekday (Tuesday, opening family) either.
    expect(withMeeting.get("morning-weekday")?.n).toBe(without.get("morning-weekday")?.n);
  });
});

describe("estimateShift", () => {
  it("estimates a planned Friday closing shift with an ordered take-home range", () => {
    const w = worked();
    const planned: Shift = {
      date: "2026-07-03", // a future Friday
      station: "BAR",
      shiftType: "closing",
      plannedStart: "18:00",
      plannedEnd: undefined,
      openEnd: true,
      crossesMidnight: true,
      status: "planned",
      grossRate: 15.5,
      source: "test",
      createdAt: "now",
    };
    const e = estimateShift(planned, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, settings);
    expect(e.bucket).toBe("evening");
    expect(e.hours).toBeCloseTo(7); // 18:00 -> 01:00
    expect(e.netWage).toBeCloseTo(7 * 15.5 * e.netFactor);
    expect(e.takeHome.p25).toBeLessThanOrEqual(e.takeHome.median);
    expect(e.takeHome.median).toBeLessThanOrEqual(e.takeHome.p75);
    expect(e.takeHome.p25).toBeGreaterThan(e.netWage); // tips add on top
  });

  it("recency weighting lowers the evening tip estimate when tips have drifted down", () => {
    const w = worked();
    const planned: Shift = {
      date: "2026-07-03", // future Friday evening
      station: "BAR",
      shiftType: "closing",
      plannedStart: "18:00",
      plannedEnd: undefined,
      openEnd: true,
      crossesMidnight: true,
      status: "planned",
      grossRate: 15.5,
      source: "test",
      createdAt: "now",
    };
    const asOf = "2026-06-21";
    const flat = estimateShift(planned, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, { ...settings, recencyHalfLifeDays: 0 }, undefined, asOf);
    const recent = estimateShift(planned, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, { ...settings, recencyHalfLifeDays: 30 }, undefined, asOf);
    expect(recent.usableTips.median).toBeLessThan(flat.usableTips.median);
    expect(recent.usableTips.p25).toBeLessThanOrEqual(recent.usableTips.p75); // still ordered
  });

  it("estimates a meeting shift with zero tips and normal wage, skipping the fallback chain", () => {
    const w = worked();
    const meeting: Shift = {
      date: "2026-07-06", // future Monday
      station: "BAR",
      shiftType: "meeting",
      openEnd: false,
      crossesMidnight: false,
      status: "planned",
      actualHours: 2,
      grossRate: 15.5,
      source: "test",
      createdAt: "now",
    };
    const e = estimateShift(meeting, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, settings);
    expect(e.bucket).toBe("meeting");
    expect(e.hours).toBeCloseTo(2);
    expect(e.usableTips).toEqual({ p25: 0, median: 0, p75: 0 });
    expect(e.takeHome).toEqual({ p25: e.netWage, median: e.netWage, p75: e.netWage });
    expect(e.netWage).toBeCloseTo(2 * 15.5 * e.netFactor);
    expect(e.confident).toBe(true);
  });
});

describe("sumEstimates", () => {
  it("aggregates a week of planned shifts", () => {
    const w = worked();
    const planned = w.slice(0, 3).map((s) => ({ ...s, status: "planned" as const }));
    const t = sumEstimates(planned, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, settings);
    expect(t.shifts).toBe(3);
    expect(t.takeHome.p25).toBeLessThanOrEqual(t.takeHome.p75);
    // take-home = net wage + usable tips, per category, at the median.
    expect(t.takeHome.median).toBeCloseTo(t.netWage + t.usableTips.median, 6);
    expect(t.grossWage).toBeGreaterThan(0);
  });

  it("combines the band in quadrature, not linearly (band grows ~√n, not n)", () => {
    const w = worked();
    const one: Shift = {
      date: "2026-07-03",
      station: "BAR",
      shiftType: "closing",
      plannedStart: "18:00",
      plannedEnd: undefined,
      openEnd: true,
      crossesMidnight: true,
      status: "planned",
      grossRate: 15.5,
      source: "test",
      createdAt: "now",
    };
    const asOf = "2026-06-21";
    const single = estimateShift(one, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, settings, undefined, asOf);
    const perShiftHalfBand = (single.usableTips.p75 - single.usableTips.p25) / 2;

    const n = 9;
    const planned = Array.from({ length: n }, () => ({ ...one }));
    const t = sumEstimates(planned, w, DEFAULT_RATES, DEFAULT_PAYSLIPS, settings, asOf);
    const totalHalfBand = (t.usableTips.p75 - t.usableTips.p25) / 2;

    // Linear (buggy) summing would give n× the per-shift half-band; quadrature gives ~√n×.
    expect(totalHalfBand).toBeLessThan(perShiftHalfBand * n * 0.6); // far below the linear sum
    expect(totalHalfBand).toBeCloseTo(perShiftHalfBand * Math.sqrt(n), 4); // √n scaling
    expect(t.usableTips.p25).toBeGreaterThanOrEqual(0); // tips never negative
  });
});
