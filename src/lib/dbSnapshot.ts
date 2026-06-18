// Whole-database snapshot: serialize every Dexie table into one JSON blob, and the
// pure merge logic that decides what a sync should do. This is the data half of
// Google Drive sync ([[sync-approach]]) — the Drive/OAuth side lives in driveSync.ts.
//
// Strategy (chosen with the user): WHOLE-FILE, newer-wins, with a guard. We never
// merge record-by-record; the device that's ahead overwrites the single Drive file.
// If BOTH sides changed since the last sync we refuse to guess and ask the user.
// Lineage is tracked with a content HASH stored per-device in localStorage, so we
// don't need updatedAt columns on every row.

import { db } from "./db";
import type { GrossRate, Payslip, Settings, Shift, Vacation } from "./types";

// Bump in lockstep with the Dexie schema version in db.ts. A remote snapshot with a
// higher schema was written by a newer app build → we refuse to apply it (would drop
// tables we don't know about).
export const SNAPSHOT_SCHEMA = 2;

export interface SnapshotData {
  shifts: Shift[];
  rates: GrossRate[];
  payslips: Payslip[];
  settings: Settings[];
  vacations: Vacation[];
}

export interface Snapshot {
  schema: number;
  savedAt: string; // ISO timestamp this snapshot was produced
  device: string; // human label of the producing device, for the conflict prompt
  data: SnapshotData;
}

export interface SnapshotMeta {
  savedAt: string;
  device: string;
  counts: { shifts: number; rates: number; payslips: number; vacations: number };
}

const TABLES = ["shifts", "rates", "payslips", "settings", "vacations"] as const;

/** Read every table into a snapshot. (Side-effectful: touches Dexie.) */
export async function buildSnapshot(device: string): Promise<Snapshot> {
  const [shifts, rates, payslips, settings, vacations] = await db.transaction(
    "r",
    db.shifts,
    db.rates,
    db.payslips,
    db.settings,
    db.vacations,
    async () =>
      Promise.all([
        db.shifts.toArray(),
        db.rates.toArray(),
        db.payslips.toArray(),
        db.settings.toArray(),
        db.vacations.toArray(),
      ]),
  );
  return {
    schema: SNAPSHOT_SCHEMA,
    savedAt: new Date().toISOString(),
    device,
    data: { shifts, rates, payslips, settings, vacations },
  };
}

/** Replace the entire local DB with a snapshot's contents (transactional). */
export async function applySnapshot(snap: Snapshot): Promise<void> {
  if (snap.schema > SNAPSHOT_SCHEMA)
    throw new Error(
      `This Drive backup was written by a newer version of the app (schema ${snap.schema}). Update this device before syncing.`,
    );
  const d = snap.data;
  await db.transaction("rw", db.shifts, db.rates, db.payslips, db.settings, db.vacations, async () => {
    await Promise.all(TABLES.map((t) => db.table(t).clear()));
    await db.shifts.bulkAdd(d.shifts ?? []);
    await db.rates.bulkAdd(d.rates ?? []);
    await db.payslips.bulkAdd(d.payslips ?? []);
    await db.settings.bulkAdd(d.settings ?? []);
    await db.vacations.bulkAdd(d.vacations ?? []);
  });
}

export function summarize(snap: Snapshot): SnapshotMeta {
  const d = snap.data;
  return {
    savedAt: snap.savedAt,
    device: snap.device,
    counts: {
      shifts: d.shifts?.length ?? 0,
      rates: d.rates?.length ?? 0,
      payslips: d.payslips?.length ?? 0,
      vacations: d.vacations?.length ?? 0,
    },
  };
}

// --- Pure content hashing -------------------------------------------------
// A stable hash of the DATA only (never savedAt/device) so two devices holding the
// same rows produce the same hash regardless of row order or key order.

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Order-independent canonical form: each table sorted by id. */
function canonical(data: SnapshotData): string {
  const byId = <T extends { id?: number }>(rows: T[]) =>
    [...(rows ?? [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return stableStringify({
    shifts: byId(data.shifts),
    rates: byId(data.rates),
    payslips: byId(data.payslips),
    settings: byId(data.settings),
    vacations: byId(data.vacations),
  });
}

/** djb2 → base36. Not cryptographic; only needs to detect "did the data change". */
export function hashData(data: SnapshotData): string {
  const s = canonical(data);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// --- Pure sync decision ---------------------------------------------------

export type SyncAction = "first-push" | "in-sync" | "push" | "pull" | "conflict";

/**
 * Decide what to do, given the local hash, the remote hash, and the hash both
 * sides agreed on at the last successful sync (null = this device has never synced).
 *
 *   no remote file           -> first-push
 *   hashes equal             -> in-sync
 *   only local changed       -> push   (local is ahead)
 *   only remote changed      -> pull   (remote is ahead)
 *   both changed / unknown   -> conflict (let the user pick — the guard)
 */
export function resolveSync(input: {
  localHash: string;
  remoteExists: boolean;
  remoteHash: string | null;
  lastSyncedHash: string | null;
}): SyncAction {
  const { localHash, remoteExists, remoteHash, lastSyncedHash } = input;
  if (!remoteExists || remoteHash == null) return "first-push";
  if (remoteHash === localHash) return "in-sync";
  // Differ, but we've never recorded a common ancestor → can't prove lineage.
  if (lastSyncedHash == null) return "conflict";
  const localChanged = localHash !== lastSyncedHash;
  const remoteChanged = remoteHash !== lastSyncedHash;
  if (localChanged && !remoteChanged) return "push";
  if (!localChanged && remoteChanged) return "pull";
  return "conflict";
}
