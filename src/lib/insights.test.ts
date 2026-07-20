import { describe, it, expect } from "vitest";
import { effectiveHourlyByBucket, tipTrend } from "./insights";
import type { GrossRate, Payslip, Settings, Shift } from "./types";

// Minimal shift factory. Weekdays in July 2026: 20th is a Monday, so 21=Tue,
// 22=Wed, 25=Sat, 26=Sun. "closing" on a weekday → evening bucket; "opening" on
// Sat → morning-weekend; "opening" on a weekday → morning-weekday.
function shift(p: Partial<Shift> & { date: string }): Shift {
  return {
    station: "BAR",
    shiftType: p.shiftType ?? "closing",
    openEnd: false,
    crossesMidnight: false,
    status: p.status ?? "worked",
    source: "test",
    createdAt: "2026-01-01T00:00:00Z",
    ...p,
  };
}

const rates: GrossRate[] = [{ effectiveFrom: "2026-01-01", rate: 15 }];
const noPayslips: Payslip[] = []; // no payslips → net factor 1 → net wage = gross
const settings: Pick<Settings, "tipPoolRate"> = { tipPoolRate: 0 };

describe("effectiveHourlyByBucket", () => {
  it("blends wage + usable tips per hour and ranks best-first", () => {
    const worked = [
      // morning-weekend: 5h @ €15 = €75 wage + €100 tips → €35/h
      shift({ date: "2026-07-25", shiftType: "opening", actualHours: 5, tips: 100, grossRate: 15 }),
      // evening: 5h @ €15 = €75 wage + €25 tips → €20/h
      shift({ date: "2026-07-22", shiftType: "closing", actualHours: 5, tips: 25, grossRate: 15 }),
    ];
    const rows = effectiveHourlyByBucket(worked, rates, noPayslips, settings);
    expect(rows.map((r) => r.bucket)).toEqual(["morning-weekend", "evening"]);
    expect(rows[0].perHour).toBeCloseTo(35);
    expect(rows[0].wagePerHour).toBeCloseTo(15);
    expect(rows[0].tipsPerHour).toBeCloseTo(20);
    expect(rows[1].perHour).toBeCloseTo(20);
  });

  it("applies the tip pool cut and ignores meetings and hour-less rows", () => {
    const worked = [
      shift({ date: "2026-07-22", shiftType: "closing", actualHours: 4, tips: 100, grossRate: 15 }),
      shift({ date: "2026-07-23", shiftType: "meeting", actualHours: 2, tips: 0, grossRate: 15 }),
      shift({ date: "2026-07-24", shiftType: "closing", actualHours: 0, tips: 50, grossRate: 15 }),
    ];
    const rows = effectiveHourlyByBucket(worked, rates, noPayslips, { tipPoolRate: 0.5 });
    expect(rows).toHaveLength(1); // meeting + hour-less excluded
    // wage €15/h + usable tips (100 × 0.5)/4 = €12.5/h → €27.5/h
    expect(rows[0].tipsPerHour).toBeCloseTo(12.5);
    expect(rows[0].perHour).toBeCloseTo(27.5);
  });
});

describe("tipTrend", () => {
  // Prior window (June): 3 evenings at €100/5h = €20/h. Recent (July): 3 at €50/5h
  // = €10/h → a 50% drop.
  const worked = [
    shift({ date: "2026-06-03", actualHours: 5, tips: 100 }),
    shift({ date: "2026-06-10", actualHours: 5, tips: 100 }),
    shift({ date: "2026-06-17", actualHours: 5, tips: 100 }),
    shift({ date: "2026-07-01", actualHours: 5, tips: 50 }),
    shift({ date: "2026-07-08", actualHours: 5, tips: 50 }),
    shift({ date: "2026-07-15", actualHours: 5, tips: 50 }),
  ];

  it("flags a significant recent drop in tips/hour", () => {
    const rows = tipTrend(worked, { asOf: "2026-07-20", windowDays: 28, minN: 2 });
    const all = rows.find((r) => r.scope === "all")!;
    expect(all.recentTph).toBeCloseTo(10);
    expect(all.priorTph).toBeCloseTo(20);
    expect(all.pct).toBeCloseTo(-0.5);
    expect(all.direction).toBe("down");
    expect(all.significant).toBe(true);
    expect(rows[0].scope).toBe("all"); // "all" pinned first
  });

  it("marks a comparison non-significant when a window is too thin", () => {
    const rows = tipTrend(worked, { asOf: "2026-07-20", windowDays: 28, minN: 5 });
    const all = rows.find((r) => r.scope === "all")!;
    expect(all.comparable).toBe(false);
    expect(all.significant).toBe(false);
  });

  it("surfaces a bucket that only has recent data, without a baseline", () => {
    const w = [
      // 2026-07-11 is a Saturday → opening → morning-weekend; recent window only.
      shift({ date: "2026-07-11", shiftType: "opening", actualHours: 5, tips: 60 }),
      shift({ date: "2026-07-15", actualHours: 5, tips: 50 }), // evening, recent
      shift({ date: "2026-06-10", actualHours: 5, tips: 100 }), // evening, prior
    ];
    const rows = tipTrend(w, { asOf: "2026-07-20", windowDays: 28, minN: 2 });
    const mw = rows.find((r) => r.scope === "morning-weekend")!;
    expect(mw).toBeDefined();
    expect(mw.recentN).toBe(1);
    expect(mw.priorN).toBe(0);
    expect(mw.pct).toBeNull();
    expect(mw.comparable).toBe(false);
    // No-baseline rows sort after the comparable ones.
    expect(rows[rows.length - 1].scope).toBe("morning-weekend");
  });
});
