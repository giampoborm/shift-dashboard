import { describe, it, expect } from "vitest";
import {
  avgWorkingDaysPerWeek,
  berlinHolidays,
  buildWeekdayProfile,
  calcVacation,
  countWerktage,
  estimateScheduledCost,
  vacationCalendarDates,
} from "./vacation";
import type { Shift } from "./types";

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

describe("roster frequency", () => {
  it("derives avg working-days/week", () => {
    // 3 Fridays across a 15-day span (~2.14 weeks) => ~1.4 days/week
    const worked = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];
    const dpw = avgWorkingDaysPerWeek(worked);
    expect(dpw).toBeGreaterThan(1.3);
    expect(dpw).toBeLessThan(1.5);
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
    const c = calcVacation("2026-06-22", "2026-06-28", worked, { dayHours: 6 });
    expect(c.calendarDays).toBe(7);
    expect(c.werktage).toBe(6);
    expect(c.arbeitstage).toBe(5);
    expect(c.scheduleCost.low).toBeLessThanOrEqual(c.scheduleCost.expected);
    expect(c.scheduleCost.expected).toBeLessThanOrEqual(c.scheduleCost.high);
  });
});

describe("sick days in the roster math", () => {
  // Being ill doesn't make you a less-scheduled employee: the day still counts
  // as one you were rostered for, so it must not shrink the vacation budget.
  const fridays = [shift("2026-06-05"), shift("2026-06-12"), shift("2026-06-19")];

  it("keeps a weekday's roster probability when one of those days was sick", () => {
    const withSick = [shift("2026-06-05"), shift("2026-06-12", false, "sick"), shift("2026-06-19")];
    expect(buildWeekdayProfile(withSick)[5].p).toBeCloseTo(1); // still a Friday job
    expect(buildWeekdayProfile(withSick)[5].n).toBe(3);
  });

  it("keeps avg working-days/week unchanged when a day was sick", () => {
    const withSick = [shift("2026-06-05"), shift("2026-06-12", false, "sick"), shift("2026-06-19")];
    expect(avgWorkingDaysPerWeek(withSick)).toBeCloseTo(avgWorkingDaysPerWeek(fridays));
  });

  it("still ignores planned and swapped-out days", () => {
    const noisy = [...fridays, shift("2026-06-08", false, "planned"), shift("2026-06-15", false, "swapped-out")];
    expect(buildWeekdayProfile(noisy)[1].p).toBe(0); // Mondays never rostered-and-paid
  });

});

describe("vacation days are erased from the roster observation window", () => {
  // He works Thu/Fri/Sat every week. A two-week gap for a holiday must not read as
  // "he wasn't scheduled those Thursdays" and shrink the entitlement he's owed.
  const weeks = ["2026-07-02", "2026-07-09", "2026-07-16", "2026-08-13", "2026-08-20"];
  const history: Shift[] = weeks.flatMap((thu) => [
    shift(thu),
    shift(addDays(thu, 1)),
    shift(addDays(thu, 2)),
  ]);
  // Away 20 Jul – 9 Aug — the whole range leaves the window, not just the days
  // payroll charged: he was unavailable on the uncharged Sundays too.
  const away = vacationCalendarDates([
    { from: "2026-07-20", to: "2026-08-09", werktage: 0, scheduledCost: 0, createdAt: "now" },
  ]);

  // UTC arithmetic on purpose: a local-midnight Date + toISOString() rolls back a
  // day east of Greenwich, which silently collapsed this fixture's weeks.
  function addDays(iso: string, n: number): string {
    const d = new Date(iso + "T00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  it("under-counts days/week when the holiday is left in the window", () => {
    expect(avgWorkingDaysPerWeek(history)).toBeLessThan(2.6);
  });

  it("recovers the true ~3 days/week once the holiday is excluded", () => {
    expect(avgWorkingDaysPerWeek(history, away)).toBeGreaterThan(2.9);
    expect(avgWorkingDaysPerWeek(history, away)).toBeLessThan(3.6);
  });

  it("keeps the Thursday roster probability at ~1 instead of diluting it", () => {
    const diluted = buildWeekdayProfile(history)[4].p;
    const honest = buildWeekdayProfile(history, away)[4].p;
    expect(honest).toBeGreaterThan(diluted);
    expect(honest).toBeCloseTo(1, 1);
  });

  it("leaves history untouched when no vacation is passed", () => {
    expect(buildWeekdayProfile(history, new Set())).toEqual(buildWeekdayProfile(history));
  });
});

describe("calcVacation — payroll basis", () => {
  // 4 shifts of 7 h a week (Tue/Wed/Fri/Sat) = 28 h/week — the user's real shape.
  const weeks = ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23", "2026-06-30"];
  const history: Shift[] = weeks.flatMap((tue) => [
    hoursShift(tue, 7), // Tue
    hoursShift(addDaysUtc(tue, 1), 7), // Wed
    hoursShift(addDaysUtc(tue, 3), 7), // Fri
    hoursShift(addDaysUtc(tue, 4), 7), // Sat
  ]);

  function hoursShift(date: string, hours: number): Shift {
    return { ...shift(date), actualHours: hours };
  }
  function addDaysUtc(iso: string, n: number): string {
    const d = new Date(iso + "T00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  it("reproduces the August payslip: 3–11 Aug = 6 days = 36 h", () => {
    const calc = calcVacation("2026-08-03", "2026-08-11", history, { dayHours: 6 });
    expect(calc.weeklyHours).toBeCloseTo(28, 5);
    // A full week (28 h) plus the trailing Mon (0 h) and Tue (7 h) = 35 h. Note the
    // per-weekday weighting: a flat 28 x 9/7 would say 36. The extra Monday is free
    // because he is never rostered then — which is the whole point of charging by
    // hours rather than by calendar weekdays.
    expect(calc.charge.missedHours).toBeCloseTo(35, 5);
    expect(calc.charge.rawDays).toBeCloseTo(35 / 6, 5); // 5.83
    expect(calc.charge.days).toBe(6); // rounded up, as the manager does
    expect(calc.charge.paidHours).toBeCloseTo(36, 5); // 6 x 6 — the slip's Urlaub STD
    // The other basis is unchanged — same weeks, different unit.
    expect(calc.werktage).toBe(8);
    expect(calc.arbeitstage).toBe(7);
    expect(calc.calendarDays).toBe(9);
  });

  it("costs more days than shifts missed, because a 7 h shift > a 6 h vacation day", () => {
    const calc = calcVacation("2026-08-03", "2026-08-09", history, { dayHours: 6 });
    expect(calc.scheduleCost.expected).toBeCloseTo(4, 5); // 4 shifts in the week
    expect(calc.charge.days).toBe(5); // but 28 h / 6 = 4.67 -> 5 days charged
  });
});
