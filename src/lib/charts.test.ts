import { describe, it, expect } from "vitest";
import { byMonth, byType, monthLabel, takeHomeComposition, type VacationPayContext } from "./charts";
import { chargeModel } from "./vacationCharge";
import type { GrossRate, Payslip, Settings, Shift, Vacation } from "./types";

const rates: GrossRate[] = [
  { effectiveFrom: "2026-01-01", rate: 14.5 },
  { effectiveFrom: "2026-04-01", rate: 15.5 },
];
const payslips: Payslip[] = [
  { month: "2026-02", totalGross: 1931.4, totalHours: 133.2, totalNet: 1437.59 },
];
const settings = { tipPoolRate: 0.05 };

// Payroll vacation basis, same shape Settings carries: 20 days a year, a flat 6 h
// day, Tue–Sun eligible (the venue is shut Mondays).
const payrollSettings: Pick<Settings, "vacationPayrollDays" | "vacationDayHours" | "vacationEligibleWeekdays"> = {
  vacationPayrollDays: 20,
  vacationDayHours: 6,
  vacationEligibleWeekdays: [2, 3, 4, 5, 6, 0],
};

/** A vacation context priced off a fixed 28 h week — 4.67 h per eligible day. */
function vacationCtx(vacations: Vacation[], todayIso = "2026-12-31"): VacationPayContext {
  const model = chargeModel(payrollSettings, { weeklyHours: 28, hours: 224, weeks: 8, days: 32 });
  return { vacations, model, settings: payrollSettings, todayIso };
}

function vacation(from: string, to: string, extra: Partial<Vacation> = {}): Vacation {
  return { from, to, werktage: 0, scheduledCost: 0, createdAt: "now", ...extra };
}

function shift(partial: Partial<Shift>): Shift {
  return {
    date: "2026-02-01",
    station: "BAR",
    shiftType: "opening",
    openEnd: false,
    crossesMidnight: false,
    status: "worked",
    source: "test",
    createdAt: "now",
    ...partial,
  };
}

describe("monthLabel", () => {
  it("formats yyyy-MM", () => {
    expect(monthLabel("2026-04")).toBe("Apr '26");
    expect(monthLabel("2026-12")).toBe("Dec '26");
  });
  it("passes through bad input", () => {
    expect(monthLabel("nope")).toBe("nope");
  });
});

describe("byMonth", () => {
  it("groups worked shifts per month, sorted, with tips/hour", () => {
    const shifts = [
      shift({ date: "2026-03-10", actualHours: 5, tips: 20, grossRate: 14.5 }),
      shift({ date: "2026-02-01", actualHours: 7, tips: 38, grossRate: 14.5 }),
      shift({ date: "2026-02-05", actualHours: 3, tips: 12, grossRate: 14.5 }),
    ];
    const rows = byMonth(shifts, rates, payslips, settings);
    expect(rows.map((r) => r.month)).toEqual(["2026-02", "2026-03"]);
    const feb = rows[0];
    expect(feb.shifts).toBe(2);
    expect(feb.hours).toBeCloseTo(10);
    expect(feb.reportedTips).toBe(50);
    expect(feb.usableTips).toBeCloseTo(50 * 0.95);
    expect(feb.tipsPerHour).toBeCloseTo(50 / 10);
    expect(feb.label).toBe("Feb '26");
  });
  it("counts a sick day's wage but keeps it out of tips/hour", () => {
    // Entgeltfortzahlung: the wage runs, the tips do not — and the hours never
    // stood must not dilute the tips/hour line.
    const rows = byMonth(
      [
        shift({ date: "2026-02-01", actualHours: 10, tips: 50, grossRate: 14.5 }),
        shift({ date: "2026-02-02", status: "sick", actualHours: 6, tips: 99, grossRate: 14.5 }),
      ],
      rates,
      payslips,
      settings,
    );
    const feb = rows[0];
    expect(feb.shifts).toBe(2);
    expect(feb.sickShifts).toBe(1);
    expect(feb.hours).toBeCloseTo(16);
    expect(feb.workedHours).toBeCloseTo(10);
    expect(feb.netWage).toBeGreaterThan(0);
    // The sick day's stale tips are dropped outright, not just from the earnings.
    expect(feb.reportedTips).toBe(50);
    expect(feb.tipsPerHour).toBeCloseTo(50 / 10);
  });

  it("adds paid vacation to a month that has no shift rows for it", () => {
    // Mon 3 – Tue 11 Aug: 7 eligible days x 4.67 h = 32.7 h -> 6 days x 6 h = 36 h,
    // the grounding case from vacationCharge.ts. Wage only — vacation earns no tips.
    const shifts = [
      shift({ date: "2026-07-10", actualHours: 7, tips: 40, grossRate: 15.5 }),
      shift({ date: "2026-09-10", actualHours: 7, tips: 40, grossRate: 15.5 }),
    ];
    const rows = byMonth(shifts, rates, payslips, settings, vacationCtx([vacation("2026-08-03", "2026-08-11")]));
    const aug = rows.find((r) => r.month === "2026-08");
    expect(aug).toBeDefined();
    expect(aug!.shifts).toBe(0);
    expect(aug!.usableTips).toBe(0);
    expect(aug!.vacationPay).toBeGreaterThan(0);
    expect(aug!.takeHome).toBeCloseTo(aug!.vacationPay);
    // 36 h x 15.50, netted by the aggregate payslip factor (no Aug slip here).
    const factor = 1437.59 / 1931.4;
    expect(aug!.vacationPay).toBeCloseTo(36 * 15.5 * factor, 1);
  });

  it("keeps vacation outside the charted span off the chart", () => {
    // The range tabs hand byMonth a window of shifts; a trip from before it must
    // not sprout a bar and stretch the axis back.
    const rows = byMonth(
      [shift({ date: "2026-09-10", actualHours: 7, tips: 40, grossRate: 15.5 })],
      rates,
      payslips,
      settings,
      vacationCtx([vacation("2026-08-03", "2026-08-11")]),
    );
    expect(rows.map((r) => r.month)).toEqual(["2026-09"]);
  });

  it("charts a window that is ENTIRELY vacation, with no shift rows at all", () => {
    // The case the feature most exists for: a stretch away with nothing worked in
    // it. With no shift span to clamp to, the caller's own window has to carry it,
    // or the month reads as €0 earned.
    const rows = byMonth([], rates, payslips, settings, {
      ...vacationCtx([vacation("2026-08-03", "2026-08-11")]),
      from: "2026-08",
      to: "2026-08",
    });
    expect(rows.map((r) => r.month)).toEqual(["2026-08"]);
    expect(rows[0].shifts).toBe(0);
    expect(rows[0].vacationPay).toBeGreaterThan(0);
    expect(rows[0].takeHome).toBeCloseTo(rows[0].vacationPay);
  });

  it("honours explicit window bounds over the shift span", () => {
    const ctx = vacationCtx([vacation("2026-08-03", "2026-08-11")]);
    const shifts = [
      shift({ date: "2026-07-10", actualHours: 7, tips: 40, grossRate: 15.5 }),
      shift({ date: "2026-09-10", actualHours: 7, tips: 40, grossRate: 15.5 }),
    ];
    // August sits inside the shift span, but the caller's window excludes it.
    const rows = byMonth(shifts, rates, payslips, settings, { ...ctx, from: "2026-09" });
    expect(rows.find((r) => r.month === "2026-08")).toBeUndefined();
    // ...and the far side: a window wider than the shifts still picks it up.
    const wide = byMonth([shifts[1]], rates, payslips, settings, { ...ctx, from: "2026-01", to: "2026-12" });
    expect(wide.find((r) => r.month === "2026-08")?.vacationPay).toBeGreaterThan(0);
  });

  it("ignores planned shifts", () => {
    const rows = byMonth([shift({ status: "planned", actualHours: undefined })], rates, payslips, settings);
    expect(rows).toEqual([]);
  });
});

describe("byType", () => {
  it("aggregates per type in canonical order with tips/hour", () => {
    const shifts = [
      shift({ shiftType: "closing", date: "2026-02-02", actualHours: 8, tips: 80, grossRate: 14.5 }),
      shift({ shiftType: "opening", date: "2026-02-01", actualHours: 5, tips: 10, grossRate: 14.5 }),
      shift({ shiftType: "opening", date: "2026-02-03", actualHours: 5, tips: 30, grossRate: 14.5 }),
    ];
    const rows = byType(shifts, rates, payslips, settings);
    expect(rows.map((r) => r.type)).toEqual(["opening", "closing"]);
    const opening = rows[0];
    expect(opening.shifts).toBe(2);
    expect(opening.tipsPerHour).toBeCloseTo(40 / 10);
    const closing = rows[1];
    expect(closing.tipsPerHour).toBeCloseTo(80 / 8);
  });
});

describe("takeHomeComposition", () => {
  it("splits take-home into net wage and usable tips", () => {
    const slices = takeHomeComposition(
      [shift({ date: "2026-02-01", actualHours: 7, tips: 38, grossRate: 14.5 })],
      rates,
      payslips,
      settings,
    );
    expect(slices.map((s) => s.name)).toEqual(["Net wage", "Usable tips"]);
    expect(slices[1].value).toBeCloseTo(38 * 0.95);
  });
  it("adds a vacation slice when a month off is in range", () => {
    const shifts = [
      shift({ date: "2026-07-10", actualHours: 7, tips: 40, grossRate: 15.5 }),
      shift({ date: "2026-09-10", actualHours: 7, tips: 40, grossRate: 15.5 }),
    ];
    const slices = takeHomeComposition(
      shifts,
      rates,
      payslips,
      settings,
      vacationCtx([vacation("2026-08-03", "2026-08-11")]),
    );
    expect(slices.map((s) => s.name)).toEqual(["Net wage", "Vacation pay", "Usable tips"]);
  });

  it("omits zero slices", () => {
    const slices = takeHomeComposition(
      [shift({ actualHours: 7, tips: 0, grossRate: 14.5 })],
      rates,
      payslips,
      settings,
    );
    expect(slices.map((s) => s.name)).toEqual(["Net wage"]);
  });
});
