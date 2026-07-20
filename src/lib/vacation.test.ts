import { describe, it, expect } from "vitest";
import {
  avgGrossPerWorkedDay,
  avgWorkingDaysPerWeek,
  berlinHolidays,
  buildWeekdayProfile,
  calcVacation,
  countWerktage,
  estimateScheduledCost,
  estimateVacationPay,
  estimateVacationPayDays,
  proportionalEntitlement,
} from "./vacation";
import type { GrossRate, Payslip, Shift } from "./types";

function shift(date: string, crossesMidnight = false, status: Shift["status"] = "worked"): Shift {
  return {
    date,
    station: "BAR",
    shiftType: "closing",
    openEnd: false,
    crossesMidnight,
    status,
    actualHours: 6,
    tips: 50,
    grossRate: 15,
    source: "test",
    createdAt: "now",
  };
}

function meetingShift(date: string): Shift {
  return {
    date,
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

  it("excludes meeting shifts from the roster-frequency profile", () => {
    // Same 3 Fridays as the real roster, plus a bunch of Monday meetings that
    // should NOT make Monday look like a normal working day.
    const worked = [
      shift("2026-06-05"),
      shift("2026-06-12"),
      shift("2026-06-19"),
      meetingShift("2026-06-08"),
      meetingShift("2026-06-15"),
      meetingShift("2026-06-22"),
    ];
    const profile = buildWeekdayProfile(worked);
    expect(profile[5].p).toBeCloseTo(1); // Friday, unaffected
    expect(profile[1].p).toBe(0); // Monday still 0 despite the meeting shifts
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

  it("meeting shifts don't inflate the average working-days/week", () => {
    const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];
    const withMeetings = [
      ...worked,
      meetingShift("2026-06-08"),
      meetingShift("2026-06-15"),
    ];
    expect(avgWorkingDaysPerWeek(withMeetings)).toBeCloseTo(avgWorkingDaysPerWeek(worked));
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

describe("avgGrossPerWorkedDay", () => {
  const rates: GrossRate[] = [{ effectiveFrom: "2026-01-01", rate: 15 }];

  it("averages recent worked shifts within the trailing window", () => {
    const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")]; // 6h * 15 = 90 each
    expect(avgGrossPerWorkedDay(worked, rates, "2026-06-26")).toBeCloseTo(90);
  });

  it("falls back to all history when the trailing window is empty", () => {
    const worked = [shift("2020-01-03")]; // long before the window
    expect(avgGrossPerWorkedDay(worked, rates, "2026-06-26")).toBeCloseTo(90);
  });

  it("returns 0 with no worked history", () => {
    expect(avgGrossPerWorkedDay([], rates, "2026-06-26")).toBe(0);
  });
});

describe("estimateVacationPay", () => {
  const rates: GrossRate[] = [{ effectiveFrom: "2026-01-01", rate: 15 }];
  const payslips: Payslip[] = [{ month: "2026-08", totalGross: 1000, totalHours: 100, totalNet: 800 }];
  // Friday-only roster, 3 samples.
  const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];

  it("with no plan yet, costs the full profile-expected days", () => {
    // A single Friday away, nothing on the roster for it.
    const est = estimateVacationPay("2026-08-07", "2026-08-07", worked, [], rates, payslips);
    expect(est.days).toBeCloseTo(1);
    expect(est.avgDayGross).toBeCloseTo(90);
    expect(est.gross).toBeCloseTo(90);
    expect(est.net).toBeCloseTo(90 * 0.8); // payslip net factor
  });

  it("a shift still on the roster in the range offsets the estimate", () => {
    // Away Mon–Sun, but a Friday shift is already planned within it => not vacation.
    const stillRostered = [shift("2026-08-07", false, "planned")]; // Friday
    const est = estimateVacationPay("2026-08-03", "2026-08-09", worked, stillRostered, rates, payslips);
    expect(est.days).toBeCloseTo(0);
    expect(est.gross).toBe(0);
  });

  it("swapped-out shifts in range don't count as still-rostered", () => {
    const swappedOut = [shift("2026-08-07", false, "swapped-out")];
    const est = estimateVacationPay("2026-08-07", "2026-08-07", worked, swappedOut, rates, payslips);
    expect(est.days).toBeCloseTo(1);
  });

  it("returns zero for an inverted range", () => {
    expect(estimateVacationPay("2026-08-10", "2026-08-01", worked, [], rates, payslips).days).toBe(0);
  });
});

describe("estimateVacationPayDays", () => {
  // Friday-only roster, 3 samples.
  const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];

  it("names the specific missing-Friday date, not the whole week", () => {
    const days = estimateVacationPayDays("2026-08-03", "2026-08-09", worked, []);
    expect(days.map((d) => d.date)).toEqual(["2026-08-07"]); // the Friday
  });

  it("excludes a date that's still on the roster", () => {
    const stillRostered = [shift("2026-08-07", false, "planned")];
    const days = estimateVacationPayDays("2026-08-03", "2026-08-09", worked, stillRostered);
    expect(days).toEqual([]);
  });

  it("a swapped-out date on the Friday still counts as paid vacation", () => {
    const swappedOut = [shift("2026-08-07", false, "swapped-out")];
    const days = estimateVacationPayDays("2026-08-03", "2026-08-09", worked, swappedOut);
    expect(days.map((d) => d.date)).toEqual(["2026-08-07"]);
  });

  it("doesn't flag every weekday that individually clears 50% — caps at the real weekly average", () => {
    // Mon/Tue/Wed each worked exactly half their occurrences (p = 0.5 apiece) —
    // an independent per-day >=50% cutoff would flag all 3; the true combined
    // expectation is 1.5 => rounds to 2, so only the top 2 (tie-broken by date)
    // should come back.
    const mixed = [
      shift("2026-06-01"), // Mon
      shift("2026-06-08"), // Mon
      shift("2026-06-09"), // Tue
      shift("2026-06-16"), // Tue
      shift("2026-06-17"), // Wed
      shift("2026-06-24"), // Wed
    ];
    const days = estimateVacationPayDays("2026-06-29", "2026-07-01", mixed, []); // Mon, Tue, Wed
    expect(days.map((d) => d.date)).toEqual(["2026-06-29", "2026-06-30"]); // Mon + Tue, not Wed
  });
});
