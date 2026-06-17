import { describe, it, expect } from "vitest";
import { classifyShiftType, familyOf, parseTimeSlot, weekdayIndexOf } from "./shiftTime";

function classify(slot: string, closing = 60) {
  return classifyShiftType(parseTimeSlot(slot, closing));
}

describe("classifyShiftType", () => {
  it("openings (incl. Saturday 10:30 start)", () => {
    expect(classify("11-18")).toBe("opening");
    expect(classify("10:30-18")).toBe("opening");
  });
  it("late-morning", () => {
    expect(classify("12-18")).toBe("late-morning");
  });
  it("mid-day", () => {
    expect(classify("16-23")).toBe("mid-day");
    expect(classify("16-00")).toBe("mid-day"); // ends at midnight exactly
  });
  it("early-closing: fixed ends, even at 00:00", () => {
    expect(classify("17-23")).toBe("early-closing");
    expect(classify("18-00")).toBe("early-closing"); // Fri/Sat pattern
  });
  it("closing: open-ended or worked past midnight", () => {
    expect(classify("18-Ende")).toBe("closing");
    expect(classify("17-Ende")).toBe("closing");
    expect(classify("18-01:40")).toBe("closing");
    expect(classify("18-02")).toBe("closing");
  });
});

describe("familyOf", () => {
  it("groups morning vs evening", () => {
    expect(familyOf("opening")).toBe("opening");
    expect(familyOf("late-morning")).toBe("opening");
    expect(familyOf("mid-day")).toBe("closing");
    expect(familyOf("early-closing")).toBe("closing");
    expect(familyOf("closing")).toBe("closing");
  });
});

describe("weekdayIndexOf", () => {
  it("0=Sunday … 6=Saturday", () => {
    expect(weekdayIndexOf("2026-06-14")).toBe(0); // Sunday
    expect(weekdayIndexOf("2026-06-19")).toBe(5); // Friday
  });
});
