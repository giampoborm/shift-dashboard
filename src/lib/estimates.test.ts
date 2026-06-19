import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bucketOf,
  buildBucketStats,
  estimateShift,
  quantile,
  sumEstimates,
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

describe("bucketOf", () => {
  it("splits mornings by weekday/weekend and evenings by Sunday", () => {
    expect(bucketOf({ shiftType: "opening", date: "2026-06-09" })).toBe("morning-weekday"); // Tue
    expect(bucketOf({ shiftType: "opening", date: "2026-06-12" })).toBe("morning-weekend"); // Fri
    expect(bucketOf({ shiftType: "late-morning", date: "2026-06-14" })).toBe("morning-weekend"); // Sun
    expect(bucketOf({ shiftType: "closing", date: "2026-06-13" })).toBe("evening"); // Sat
    expect(bucketOf({ shiftType: "closing", date: "2026-06-14" })).toBe("evening-sunday"); // Sun
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
});
