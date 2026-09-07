import { describe, expect, it } from "vitest";
import type { Vacation } from "./types";
import {
  allChargedDates,
  paidChargedDates,
  paidChargedDatesInMonth,
  vacationBudgetUse,
} from "./vacationBudget";
import { DEFAULT_CHARGEABLE_WEEKDAYS } from "./vacationPayroll";

const WD = DEFAULT_CHARGEABLE_WEEKDAYS; // Tue–Sat
const ENTITLEMENT = 20; // "Tage LJ alt" on the 8/2026 slip

const vac = (from: string, to: string): Vacation => ({
  from,
  to,
  werktage: 0,
  scheduledCost: 0,
  createdAt: "",
});

// The real August vacation: Mon 3 – Tue 11 Aug 2026, charged 6 days by Tue–Sat.
const AUG = vac("2026-08-03", "2026-08-11");

describe("allChargedDates", () => {
  it("charges the 6 days the payslip shows for the August range", () => {
    expect(allChargedDates([AUG], WD)).toEqual([
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-11",
    ]);
  });

  it("de-duplicates overlapping ranges and returns date order", () => {
    const dates = allChargedDates([vac("2026-08-03", "2026-08-08"), AUG], WD);
    expect(dates).toEqual(allChargedDates([AUG], WD));
  });
});

describe("paidChargedDates — the entitlement is finite", () => {
  it("pays everything while the budget lasts", () => {
    expect(paidChargedDates([AUG], ENTITLEMENT, WD).size).toBe(6);
  });

  it("stops paying once the year's entitlement is used up", () => {
    // Four weeks of Tue–Sat = 20 days, exactly the entitlement. A fifth week is free
    // time but earns nothing.
    const fourWeeks = vac("2026-03-03", "2026-03-28"); // Tue 3 Mar – Sat 28 Mar
    const extra = vac("2026-06-02", "2026-06-06"); // Tue–Sat, 5 more days
    const paid = paidChargedDates([fourWeeks, extra], ENTITLEMENT, WD);
    expect(allChargedDates([fourWeeks, extra], WD)).toHaveLength(25);
    expect(paid.size).toBe(20);
    // The June trip is the one that falls outside the budget.
    expect(paid.has("2026-06-02")).toBe(false);
    expect(paid.has("2026-03-03")).toBe(true);
  });

  it("consumes the budget in DATE order, not the order records were added", () => {
    const later = vac("2026-11-03", "2026-11-28");
    const earlier = vac("2026-02-03", "2026-02-28");
    // `later` is listed first, but February must still be the trip that gets paid.
    const paid = paidChargedDates([later, earlier], ENTITLEMENT, WD);
    expect(paid.has("2026-02-03")).toBe(true);
    expect(paid.has("2026-11-28")).toBe(false);
  });

  it("gives each calendar year its own budget", () => {
    const dec = vac("2026-12-01", "2026-12-26"); // 4 weeks, uses 2026's 20
    const jan = vac("2027-01-05", "2027-01-30"); // 4 weeks, uses 2027's 20
    const paid = paidChargedDates([dec, jan], ENTITLEMENT, WD);
    expect(paid.size).toBe(40);
  });

  it("splits a range that crosses New Year across two budgets", () => {
    // Consume 2026 fully, then a trip spanning the year boundary.
    const filler = vac("2026-01-06", "2026-01-31"); // 20 days, all of 2026
    const crossing = vac("2026-12-29", "2027-01-02");
    const paid = paidChargedDates([filler, crossing], ENTITLEMENT, WD);
    // 2026's part is unpaid (budget gone); 2027's part is paid from a fresh budget.
    expect(paid.has("2026-12-29")).toBe(false);
    expect(paid.has("2027-01-01")).toBe(true);
  });

  it("pays nothing when the entitlement is zero", () => {
    expect(paidChargedDates([AUG], 0, WD).size).toBe(0);
  });
});

describe("vacationBudgetUse — what a planned trip really costs", () => {
  it("reports a fully covered trip", () => {
    const use = vacationBudgetUse("2026-08-03", "2026-08-11", [], ENTITLEMENT, WD);
    expect(use).toMatchObject({ charged: 6, paid: 6, unpaid: 0, availableBefore: 20 });
    expect(use.availableAfter).toBe(14); // exactly the slip's "Tage verfuegbar"
  });

  it("reproduces the payslip's remaining balance after the real August trip", () => {
    // 20 entitlement − 6 taken = 14 available, as printed on the 8/2026 slip.
    const after = vacationBudgetUse("2026-09-01", "2026-09-01", [AUG], ENTITLEMENT, WD);
    expect(after.availableBefore).toBe(14);
  });

  it("splits a trip that runs past the remaining entitlement", () => {
    // Burn 18 days first, then ask for a 6-day trip: 2 paid, 4 unpaid.
    const burn = vac("2026-02-03", "2026-02-26"); // Tue 3 Feb – Thu 26 Feb
    const others = [burn];
    const burned = allChargedDates(others, WD).length;
    expect(burned).toBe(18);
    const use = vacationBudgetUse("2026-08-03", "2026-08-11", others, ENTITLEMENT, WD);
    expect(use).toMatchObject({ charged: 6, paid: 2, unpaid: 4, availableBefore: 2 });
    expect(use.availableAfter).toBe(0);
  });

  it("reports a wholly unpaid trip once the year is spent", () => {
    const spent = vac("2026-01-06", "2026-01-31"); // Tue 6 Jan - Sat 31 Jan = 20 days
    const use = vacationBudgetUse("2026-08-03", "2026-08-11", [spent], ENTITLEMENT, WD);
    expect(use).toMatchObject({ charged: 6, paid: 0, unpaid: 6, availableBefore: 0 });
    expect(use.unpaidDates).toHaveLength(6);
  });

  it("does not let a range consume its own budget", () => {
    // Passing the same range in `others` would halve the answer if double-counted.
    const use = vacationBudgetUse("2026-08-03", "2026-08-11", [], ENTITLEMENT, WD);
    expect(use.paid).toBe(6);
  });

  it("is empty for a reversed range", () => {
    const use = vacationBudgetUse("2026-08-11", "2026-08-03", [], ENTITLEMENT, WD);
    expect(use).toMatchObject({ charged: 0, paid: 0, unpaid: 0 });
  });
});

describe("paidChargedDatesInMonth", () => {
  it("returns only the paid days landing in the month", () => {
    expect(paidChargedDatesInMonth("2026-08", [AUG], ENTITLEMENT, WD)).toHaveLength(6);
  });

  it("drops days the entitlement no longer covers", () => {
    const spent = vac("2026-01-06", "2026-01-31"); // uses all 20
    expect(paidChargedDatesInMonth("2026-08", [spent, AUG], ENTITLEMENT, WD)).toEqual([]);
  });

  it("is empty for a month with no vacation", () => {
    expect(paidChargedDatesInMonth("2026-09", [AUG], ENTITLEMENT, WD)).toEqual([]);
  });
});
