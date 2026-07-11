import { describe, it, expect } from "vitest";
import { isInMonth, shiftsInMonth, nextShiftFrom } from "./period";
import type { Shift } from "./types";

function mk(date: string, status: Shift["status"] = "planned"): Shift {
  return {
    date,
    station: "BAR",
    shiftType: "closing",
    openEnd: false,
    crossesMidnight: false,
    status,
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("isInMonth / shiftsInMonth", () => {
  const cursor = new Date("2026-06-15T00:00");

  it("includes shifts in the same month, excludes others", () => {
    expect(isInMonth(mk("2026-06-01"), cursor)).toBe(true);
    expect(isInMonth(mk("2026-06-30"), cursor)).toBe(true);
    expect(isInMonth(mk("2026-05-31"), cursor)).toBe(false);
    expect(isInMonth(mk("2026-07-01"), cursor)).toBe(false);
  });

  it("filters a list down to the cursor month", () => {
    const list = [mk("2026-05-30"), mk("2026-06-02"), mk("2026-06-20"), mk("2026-07-01")];
    expect(shiftsInMonth(list, cursor).map((s) => s.date)).toEqual([
      "2026-06-02",
      "2026-06-20",
    ]);
  });
});

describe("nextShiftFrom", () => {
  const today = new Date("2026-06-19T12:00"); // afternoon — today still counts

  it("returns the earliest unlogged shift", () => {
    const list = [mk("2026-06-10"), mk("2026-06-25"), mk("2026-06-21")];
    expect(nextShiftFrom(list, today)?.date).toBe("2026-06-10");
  });

  it("counts a planned shift dated today", () => {
    const list = [mk("2026-06-19"), mk("2026-06-30")];
    expect(nextShiftFrom(list, today)?.date).toBe("2026-06-19");
  });

  it("advances past today's shift once it is logged as worked", () => {
    const list = [mk("2026-06-19", "worked"), mk("2026-06-21"), mk("2026-06-30")];
    expect(nextShiftFrom(list, today)?.date).toBe("2026-06-21");
  });

  it("keeps an overdue unlogged shift as next past its own midnight", () => {
    // 2026-06-19 was yesterday relative to `today`-plus-one-day, but it's still
    // unlogged (still "planned") — it must stay "next" instead of being skipped.
    const dayAfter = new Date("2026-06-20T00:05");
    const list = [mk("2026-06-19"), mk("2026-06-25")];
    expect(nextShiftFrom(list, dayAfter)?.date).toBe("2026-06-19");
  });

  it("ignores swapped-out shifts (you gave it away)", () => {
    const list = [mk("2026-06-20", "swapped-out"), mk("2026-06-22", "planned")];
    expect(nextShiftFrom(list, today)?.date).toBe("2026-06-22");
  });

  it("counts swapped-in shifts as upcoming", () => {
    const list = [mk("2026-06-19", "worked"), mk("2026-06-20", "swapped-in")];
    expect(nextShiftFrom(list, today)?.date).toBe("2026-06-20");
  });

  it("returns null when nothing is unlogged", () => {
    expect(nextShiftFrom([mk("2026-06-01", "worked"), mk("2026-05-01", "swapped-out")], today)).toBeNull();
  });
});
