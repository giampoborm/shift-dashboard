import { describe, it, expect } from "vitest";
import {
  importHistoryCsv,
  parseMoney,
  extractTimeSlot,
} from "./importHistory";
import { parseTimeSlot } from "./shiftTime";
import type { GrossRate } from "./types";

const rates: GrossRate[] = [
  { effectiveFrom: "2026-01-01", rate: 14.5 },
  { effectiveFrom: "2026-04-01", rate: 15.5 },
];
const settings = {
  tipPoolRate: 0.05,
  closingTime: "01:00",
};

describe("parseMoney", () => {
  it("strips euro signs", () => {
    expect(parseMoney("€38.00")).toBe(38);
    expect(parseMoney("€0.00")).toBe(0);
  });
  it("handles european thousands/decimal", () => {
    expect(parseMoney("1.931,40")).toBeCloseTo(1931.4);
    expect(parseMoney("47")).toBe(47);
  });
  it("returns null for empty", () => {
    expect(parseMoney("")).toBeNull();
  });
});

describe("extractTimeSlot", () => {
  it("pulls the slot out of messy weekday cells", () => {
    expect(extractTimeSlot("dom 1 11-18")).toBe("11-18");
    expect(extractTimeSlot("ven 13 18-01:40")).toBe("18-01:40");
    expect(extractTimeSlot("saturday 10:30-18")).toBe("10:30-18");
    expect(extractTimeSlot("tuesday 18—0")).toBe("18-0");
    expect(extractTimeSlot("wednesday 17-23")).toBe("17-23");
  });
});

describe("parseTimeSlot crossesMidnight", () => {
  it("detects past-midnight ends", () => {
    expect(parseTimeSlot("18-00").crossesMidnight).toBe(true);
    expect(parseTimeSlot("18-01:40").crossesMidnight).toBe(true);
    expect(parseTimeSlot("11-18").crossesMidnight).toBe(false);
    expect(parseTimeSlot("17-23").crossesMidnight).toBe(false);
  });
  it("treats Ende using the closing time", () => {
    expect(parseTimeSlot("18:00-Ende", 60).crossesMidnight).toBe(true); // closes 01:00
    expect(parseTimeSlot("11:00-Ende", 18 * 60).crossesMidnight).toBe(false);
  });
});

describe("importHistoryCsv", () => {
  const csv = `Giorno settimana,Date,mancia,numero ore,stipendio nuovo
dom 1 11-18,"February 1, 2026",€38.00,7,€101.50
ven 13 18-01:40,"February 13, 2026",€75.00,7.7,€111.65
sab 28 17-23,"March 28, 2026",€0.00,6,€87.00
dom 29 18-00,"March 28, 2026",€39.00,5.5,€79.75`;

  it("imports rows and derives fields", () => {
    const { shifts, skipped } = importHistoryCsv(csv, rates, settings);
    expect(shifts).toHaveLength(4);
    expect(skipped).toBe(0);
    const feb1 = shifts[0];
    expect(feb1.date).toBe("2026-02-01");
    expect(feb1.actualHours).toBe(7);
    expect(feb1.tips).toBe(38);
    expect(feb1.grossRate).toBe(14.5);
    expect(feb1.crossesMidnight).toBe(false);
    // the 18-01:40 shift crosses midnight -> closing
    expect(shifts[1].crossesMidnight).toBe(true);
    expect(shifts[1].shiftType).toBe("closing");
  });

  it("flags the duplicate / mis-dated March 28 rows", () => {
    const { warnings } = importHistoryCsv(csv, rates, settings);
    expect(warnings.some((w) => w.message.includes("Duplicate date"))).toBe(true);
    expect(warnings.some((w) => w.message.includes("≠ date day"))).toBe(true);
  });

  it("does NOT flag a row whose only number is the shift time (no day number)", () => {
    const noDayNum = `Giorno settimana,Date,mancia,numero ore,stipendio nuovo
sab 11-18,"June 13, 2026",€20.00,7,€108.50`;
    const { shifts, warnings } = importHistoryCsv(noDayNum, rates, settings);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].plannedStart).toBe("11:00"); // 11 is the slot start, not a day
    expect(warnings.some((w) => w.message.includes("≠ date day"))).toBe(false);
  });

  it("flags unparseable dates and skips them", () => {
    const bad = `Giorno settimana,Date,mancia,numero ore,stipendio nuovo
junk,"not a date",€10.00,5,€72.50`;
    const { shifts, skipped, warnings } = importHistoryCsv(bad, rates, settings);
    expect(shifts).toHaveLength(0);
    expect(skipped).toBe(1);
    expect(warnings[0].message).toContain("Unparseable date");
  });
});
