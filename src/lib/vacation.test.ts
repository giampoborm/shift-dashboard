import { describe, it, expect } from "vitest";
import {
  avgWorkingDaysPerWeek,
  berlinHolidays,
  buildWeekdayProfile,
  calcVacation,
  countWerktage,
  estimateScheduledCost,
  proportionalEntitlement,
} from "./vacation";
import type { Shift } from "./types";

function shift(date: string, crossesMidnight = false): Shift {
  return {
    date,
    station: "BAR",
    shiftType: "closing",
    openEnd: false,
    crossesMidnight,
    status: "worked",
    actualHours: 6,
    tips: 50,
    source: "test",
    createdAt: "now",
  };
}

describe("berlinHolidays", () => {
  it("includes Berlin-specific and national public holidays", () => {
    const dates = berlinHolidays("2026-01-01", "2026-12-31").map((h) => h.date);
    expect(dates).toContain("2026-01-01"); // Neujahr
    expect(dates).toContain("2026-03-08"); // Int. Frauentag (Berlin)
    expect(dates).toContain("2026-10-03"); // Tag der Deutschen Einheit
  });
  it("respects the range bounds", () => {
    const hs = berlinHolidays("2026-06-01", "2026-06-30");
    expect(hs.every((h) => h.date >= "2026-06-01" && h.date <= "2026-06-30")).toBe(true);
  });
});

describe("countWerktage", () => {
  it("counts Mon–Sat, excludes Sundays", () => {
    // 2026-06-22 Mon … 2026-06-28 Sun
    expect(countWerktage("2026-06-22", "2026-06-28", new Set())).toBe(6);
    expect(countWerktage("2026-06-22", "2026-06-28", new Set(), false)).toBe(5); // Arbeitstage
  });
  it("subtracts public holidays", () => {
    // 2026-10-01 Thu … 2026-10-03 Sat, with Oct 3 (Sat) a holiday
    expect(countWerktage("2026-10-01", "2026-10-03", new Set(["2026-10-03"]))).toBe(2);
  });
  it("returns 0 for inverted ranges", () => {
    expect(countWerktage("2026-06-10", "2026-06-01", new Set())).toBe(0);
  });
});

describe("buildWeekdayProfile + estimateScheduledCost", () => {
  it("learns a Friday-only roster and costs ~1 day per Friday", () => {
    const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")]; // 3 Fridays
    const profile = buildWeekdayProfile(worked);
    expect(profile[5].p).toBeCloseTo(1); // Friday
    expect(profile[1].p).toBe(0); // Monday never worked
    const cost = estimateScheduledCost("2026-06-26", "2026-06-26", profile); // one Friday
    expect(cost.expected).toBeCloseTo(1);
    expect(cost.low).toBeCloseTo(1);
    expect(cost.high).toBeCloseTo(1);
  });
  it("counts a night shift as ONE vacation day (not two)", () => {
    const worked = [
      shift("2026-06-05", true),
      shift("2026-06-12", true),
      shift("2026-06-19", true),
    ];
    const profile = buildWeekdayProfile(worked);
    const cost = estimateScheduledCost("2026-06-26", "2026-06-26", profile);
    expect(cost.expected).toBeCloseTo(1); // night shift still = 1 day off
  });
});

describe("proportional basis", () => {
  it("derives avg working-days/week and converts the 24 budget", () => {
    // 3 Fridays across a 15-day span (~2.14 weeks) => ~1.4 days/week
    const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];
    const dpw = avgWorkingDaysPerWeek(worked);
    expect(dpw).toBeGreaterThan(1.3);
    expect(dpw).toBeLessThan(1.5);
    // 4 days/week should convert 24 Werktage -> 16 actual working-days
    expect(proportionalEntitlement(24, 4)).toBeCloseTo(16);
    expect(proportionalEntitlement(24, 6)).toBeCloseTo(24);
  });
});

describe("calcVacation", () => {
  it("produces a coherent summary", () => {
    const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];
    const c = calcVacation("2026-06-22", "2026-06-28", worked);
    expect(c.calendarDays).toBe(7);
    expect(c.werktage).toBe(6);
    expect(c.arbeitstage).toBe(5);
    expect(c.scheduleCost.low).toBeLessThanOrEqual(c.scheduleCost.expected);
    expect(c.scheduleCost.expected).toBeLessThanOrEqual(c.scheduleCost.high);
  });
});
