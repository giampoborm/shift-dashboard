import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { importPlanCsv, plannedHours } from "./importPlan";
import { DEFAULT_RATES, DEFAULT_SETTINGS } from "./db";

const settings = DEFAULT_SETTINGS;

function realPlanCsv(): string {
  return readFileSync(new URL("../../data/plan-3rdjune.csv", import.meta.url), "utf8");
}

describe("importPlanCsv (real plan-3rdjune.csv)", () => {
  it("finds Gianpaolo's BAR shifts with correct dates/stations", () => {
    const { shifts, matched } = importPlanCsv(
      realPlanCsv(),
      "plan:plan-3rdjune.csv",
      DEFAULT_RATES,
      settings,
    );
    expect(matched).toBeGreaterThan(0);
    expect(shifts.every((s) => s.status === "planned")).toBe(true);
    expect(shifts.every((s) => s.station === "BAR")).toBe(true); // user only in BAR this week

    const byDate = shifts.map((s) => s.date).sort();
    // From the grid: Tue 23 (18-Ende), Wed 24 & Sat 27 (17-23), Fri 26 (11-18)
    expect(byDate).toEqual(["2026-06-23", "2026-06-24", "2026-06-26", "2026-06-27"]);
  });

  it("derives shiftType and midnight-crossing for the 18:00-Ende slot", () => {
    const { shifts } = importPlanCsv(realPlanCsv(), "plan:x", DEFAULT_RATES, settings);
    const tue = shifts.find((s) => s.date === "2026-06-23" && s.plannedStart === "18:00");
    expect(tue).toBeDefined();
    expect(tue!.openEnd).toBe(true);
    expect(tue!.crossesMidnight).toBe(true); // closes 01:00
    expect(tue!.shiftType).toBe("closing"); // open-ended => closing
    expect(tue!.grossRate).toBe(15.5); // June rate
  });

  it("ignores WORLD CUP / CHANNELS blocks", () => {
    const { shifts } = importPlanCsv(realPlanCsv(), "plan:x", DEFAULT_RATES, settings);
    expect(shifts.every((s) => s.station === "BAR" || s.station === "RUNNERS")).toBe(true);
  });

  it("matches a different user name", () => {
    const { matched } = importPlanCsv(realPlanCsv(), "plan:x", DEFAULT_RATES, {
      ...settings,
      userName: "Federico",
    });
    expect(matched).toBeGreaterThan(0);
  });
});

describe("plannedHours", () => {
  it("computes fixed slots", () => {
    expect(plannedHours("11:00", "18:00", false, "01:00")).toBe(7);
  });
  it("uses closing time for open-ended slots", () => {
    expect(plannedHours("18:00", undefined, true, "01:00")).toBe(7); // 18:00 -> 01:00
  });
  it("handles midnight crossing", () => {
    expect(plannedHours("18:00", "00:00", false, "01:00")).toBe(6);
  });
});
