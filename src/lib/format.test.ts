import { describe, expect, it } from "vitest";
import { formatDate } from "./format";

describe("formatDate", () => {
  it("formats ISO dates as dd.MM.yyyy", () => {
    expect(formatDate("2026-04-01")).toBe("01.04.2026");
    expect(formatDate("2026-12-25")).toBe("25.12.2026");
  });
  it("leaves non-ISO or empty input untouched", () => {
    expect(formatDate("2026-04")).toBe("2026-04"); // month, not a full date
    expect(formatDate("")).toBe("");
    expect(formatDate("not a date")).toBe("not a date");
  });
});
