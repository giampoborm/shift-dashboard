import { describe, expect, it } from "vitest";
import { hashData, resolveSync, summarize, type SnapshotData, type Snapshot } from "./dbSnapshot";
import type { Shift } from "./types";

function shift(id: number, tips: number): Shift {
  return {
    id,
    date: "2026-06-01",
    station: "BAR",
    shiftType: "closing",
    openEnd: false,
    crossesMidnight: false,
    status: "worked",
    tips,
    source: "manual",
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

const data = (shifts: Shift[]): SnapshotData => ({
  shifts,
  rates: [{ id: 1, effectiveFrom: "2026-01-01", rate: 14.5 }],
  payslips: [],
  settings: [{ id: 1, userName: "G", tipPoolRate: 0.05, closingTime: "01:00", vacationWerktage: 24, recencyHalfLifeDays: 45 }],
  vacations: [],
});

describe("hashData", () => {
  it("is stable across row order and key order", () => {
    const a = data([shift(1, 10), shift(2, 20)]);
    const b = data([shift(2, 20), shift(1, 10)]); // reversed
    expect(hashData(a)).toBe(hashData(b));
  });

  it("changes when any value changes", () => {
    const a = data([shift(1, 10)]);
    const b = data([shift(1, 11)]); // one tip differs
    expect(hashData(a)).not.toBe(hashData(b));
  });

  it("ignores nothing structural — adding a row changes the hash", () => {
    const a = data([shift(1, 10)]);
    const b = data([shift(1, 10), shift(2, 20)]);
    expect(hashData(a)).not.toBe(hashData(b));
  });
});

describe("resolveSync", () => {
  const base = { localHash: "L", remoteExists: true, remoteHash: "R", lastSyncedHash: "S" };

  it("first-push when no remote file exists", () => {
    expect(resolveSync({ ...base, remoteExists: false, remoteHash: null })).toBe("first-push");
  });

  it("in-sync when hashes match", () => {
    expect(resolveSync({ ...base, localHash: "X", remoteHash: "X" })).toBe("in-sync");
  });

  it("push when only local moved past the last-synced hash", () => {
    expect(resolveSync({ localHash: "L", remoteExists: true, remoteHash: "S", lastSyncedHash: "S" })).toBe("push");
  });

  it("pull when only remote moved past the last-synced hash", () => {
    expect(resolveSync({ localHash: "S", remoteExists: true, remoteHash: "R", lastSyncedHash: "S" })).toBe("pull");
  });

  it("conflict when both sides moved (the guard)", () => {
    expect(resolveSync({ localHash: "L", remoteExists: true, remoteHash: "R", lastSyncedHash: "S" })).toBe("conflict");
  });

  it("conflict on first contact when local and remote differ with no known ancestor", () => {
    expect(resolveSync({ localHash: "L", remoteExists: true, remoteHash: "R", lastSyncedHash: null })).toBe("conflict");
  });

  it("first-push wins even with no prior sync when remote is empty", () => {
    expect(resolveSync({ localHash: "L", remoteExists: false, remoteHash: null, lastSyncedHash: null })).toBe("first-push");
  });
});

describe("summarize", () => {
  it("counts rows per table", () => {
    const snap: Snapshot = { schema: 2, savedAt: "2026-06-18T10:00:00Z", device: "PC", data: data([shift(1, 10), shift(2, 20)]) };
    const m = summarize(snap);
    expect(m.counts.shifts).toBe(2);
    expect(m.counts.rates).toBe(1);
    expect(m.device).toBe("PC");
  });
});
