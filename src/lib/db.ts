// Dexie (IndexedDB) data layer. Local-first; the whole DB lives on the device.
// The schema is intentionally thin — derived earnings are computed on read, never stored.

import Dexie, { type Table } from "dexie";
import type { GrossRate, Payslip, Settings, Shift, Vacation } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  id: 1,
  userName: "Gianpaolo",
  tipPoolRate: 0.05,
  closingTime: "01:00",
  vacationWerktage: 24, // contract §8
};

// Effective-dated gross rate table grounded in the payslips:
// €14.50/h through March 2026, raised to €15.50/h from April 2026.
export const DEFAULT_RATES: GrossRate[] = [
  { effectiveFrom: "2026-01-01", rate: 14.5 },
  { effectiveFrom: "2026-04-01", rate: 15.5 },
];

// Real payslips (data/payslips.csv) — seed so net-factor works on first run.
export const DEFAULT_PAYSLIPS: Payslip[] = [
  { month: "2026-02", totalGross: 1931.4, totalHours: 133.2, totalNet: 1437.59 },
  { month: "2026-03", totalGross: 1899.5, totalHours: 131, totalNet: 1418 },
  { month: "2026-04", totalGross: 1371.75, totalHours: 88.5, totalNet: 1074.84 },
  { month: "2026-05", totalGross: 1691.05, totalHours: 109.1, totalNet: 1289.44 },
];

export class ShiftDb extends Dexie {
  shifts!: Table<Shift, number>;
  rates!: Table<GrossRate, number>;
  payslips!: Table<Payslip, number>;
  settings!: Table<Settings, number>;
  vacations!: Table<Vacation, number>;

  constructor() {
    super("shift-dashboard");
    this.version(1).stores({
      shifts: "++id, date, station, shiftType, status",
      rates: "++id, effectiveFrom",
      payslips: "++id, month",
      settings: "++id",
    });
    this.version(2).stores({
      shifts: "++id, date, station, shiftType, status",
      rates: "++id, effectiveFrom",
      payslips: "++id, month",
      settings: "++id",
      vacations: "++id, from",
    });
  }
}

export const db = new ShiftDb();

/** Seed defaults the first time the DB is opened (idempotent). */
export async function ensureSeeded(): Promise<void> {
  await db.transaction("rw", db.settings, db.rates, db.payslips, async () => {
    if ((await db.settings.count()) === 0) await db.settings.add(DEFAULT_SETTINGS);
    if ((await db.rates.count()) === 0) await db.rates.bulkAdd(DEFAULT_RATES);
    if ((await db.payslips.count()) === 0) await db.payslips.bulkAdd(DEFAULT_PAYSLIPS);
  });
}

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get(1)) ?? DEFAULT_SETTINGS;
}
