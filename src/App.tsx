import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, ensureSeeded, getSettings } from "./lib/db";
import { importHistoryCsv, type ImportWarning } from "./lib/importHistory";
import { importPlanCsv, plannedHours } from "./lib/importPlan";
import { computeShiftEarnings, sumEarnings } from "./lib/earnings";
import { weekdayOf } from "./lib/shiftTime";
import { formatDate } from "./lib/format";
import { shiftsToCsv, downloadText } from "./lib/exportCsv";
import {
  BUCKET_LABELS,
  estimateShift,
  sumEstimates,
  type Range,
} from "./lib/estimates";
import { ShiftEditor, type EditorPrefill } from "./components/ShiftEditor";
import { Calendar } from "./components/Calendar";
import { Settings as SettingsPanel } from "./components/Settings";
import type { GrossRate, Payslip, Settings, Shift, ShiftType } from "./lib/types";

// Code-split: pulls in date-holidays (heavy) only when the Vacation tab is opened.
const VacationPlanner = lazy(() =>
  import("./components/VacationPlanner").then((m) => ({ default: m.VacationPlanner })),
);

const eur = (n: number) => `€${n.toFixed(2)}`;
const eurRange = (r: Range) => `€${Math.round(r.p25)}–${Math.round(r.p75)}`;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHIFT_TYPES: ShiftType[] = ["opening", "late-morning", "mid-day", "early-closing", "closing"];

type Filter = "worked" | "planned" | "all" | "calendar" | "vacation" | "settings";
type ImportKind = "history" | "plan";

interface ColumnFilters {
  q: string;
  type: ShiftType | "all";
  weekday: number | "all";
  station: string | "all";
  from: string;
  to: string;
}
const EMPTY_FILTERS: ColumnFilters = { q: "", type: "all", weekday: "all", station: "all", from: "", to: "" };

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [lastImport, setLastImport] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("worked");
  const [filters, setFilters] = useState<ColumnFilters>(EMPTY_FILTERS);
  const [editor, setEditor] = useState<{ shift: Shift | null; prefill?: EditorPrefill } | null>(null);
  const historyRef = useRef<HTMLInputElement>(null);
  const planRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureSeeded().then(getSettings).then(setSettings);
  }, []);

  const allShifts = useLiveQuery(() => db.shifts.orderBy("date").toArray(), []);
  const rates = useLiveQuery(() => db.rates.toArray(), []);
  const payslips = useLiveQuery(() => db.payslips.toArray(), []);

  const ready = settings && rates && payslips && allShifts;

  const tabShifts = useMemo(() => {
    if (!allShifts) return [];
    if (filter === "all") return allShifts;
    if (filter === "planned")
      return allShifts.filter((s) => s.status === "planned" || s.status === "swapped-in");
    return allShifts.filter((s) => s.status === "worked");
  }, [allShifts, filter]);

  const shifts = useMemo(() => {
    return tabShifts.filter((s) => {
      if (filters.type !== "all" && s.shiftType !== filters.type) return false;
      if (filters.station !== "all" && s.station !== filters.station) return false;
      if (filters.from && s.date < filters.from) return false;
      if (filters.to && s.date > filters.to) return false;
      if (filters.weekday !== "all" && new Date(s.date + "T00:00").getDay() !== filters.weekday)
        return false;
      if (filters.q) {
        const hay = `${s.date} ${s.station} ${s.shiftType} ${s.plannedStart ?? ""} ${weekdayOf(s.date)}`.toLowerCase();
        if (!hay.includes(filters.q.toLowerCase())) return false;
      }
      return true;
    });
  }, [tabShifts, filters]);

  const workedHistory = useMemo(
    () => (allShifts ?? []).filter((s) => s.status === "worked"),
    [allShifts],
  );

  const stations = useMemo(
    () => Array.from(new Set((allShifts ?? []).map((s) => s.station))).sort(),
    [allShifts],
  );

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>, kind: ImportKind) {
    const file = e.target.files?.[0];
    const input = e.target;
    if (!file || !settings || !rates) return;
    const text = await file.text();
    try {
      if (kind === "history") {
        const result = importHistoryCsv(text, rates, settings);
        await replaceSource("history.csv", result.shifts);
        setWarnings(result.warnings);
        setLastImport(`Imported ${result.shifts.length} worked shifts from ${file.name}`);
        setFilter("worked");
      } else {
        const source = `plan:${file.name}`;
        const result = importPlanCsv(text, source, rates, settings);
        await replaceSource(source, result.shifts);
        setWarnings(result.warnings);
        setLastImport(
          `Imported ${result.shifts.length} planned shifts (${result.matched} cells matched ${settings.userName}) from ${file.name}`,
        );
        setFilter("planned");
      }
    } catch (err) {
      console.error("Import failed:", err);
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      input.value = "";
    }
  }

  async function replaceSource(source: string, rows: Shift[]) {
    await db.transaction("rw", db.shifts, async () => {
      await db.shifts.filter((s) => s.source === source).delete();
      await db.shifts.bulkAdd(rows);
    });
  }

  async function clearAll() {
    if (!confirm("Delete all imported shifts?")) return;
    await db.shifts.clear();
    setWarnings([]);
    setLastImport("");
  }

  function exportCsv() {
    if (!shifts.length || !rates || !payslips || !settings) return;
    const csv = shiftsToCsv(shifts, rates, payslips, settings);
    downloadText(`shifts-${filter}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  const workedInView = shifts.filter((s) => s.status === "worked");
  const totals =
    ready && workedInView.length
      ? sumEarnings(workedInView, rates!, payslips!, settings!)
      : null;

  const warns = warnings.filter((w) => w.severity === "warn");
  const infos = warnings.filter((w) => w.severity === "info");

  const counts = {
    worked: allShifts?.filter((s) => s.status === "worked").length ?? 0,
    planned: allShifts?.filter((s) => s.status === "planned" || s.status === "swapped-in").length ?? 0,
    all: allShifts?.length ?? 0,
  };

  const isPlannedView = filter === "planned";
  const isCalendar = filter === "calendar";
  const isVacation = filter === "vacation";
  const isSettings = filter === "settings";
  const isTool = isCalendar || isVacation || isSettings; // non-table full-width views
  const estTotals =
    ready && isPlannedView && shifts.length
      ? sumEstimates(shifts, workedHistory, rates!, payslips!, settings!)
      : null;

  return (
    <div className="app">
      <h1>Shift Dashboard</h1>
      <p className="subtitle">Local-first shift, tip &amp; earnings tracker — Phase 1</p>

      <div className="toolbar">
        <button className="primary" onClick={() => historyRef.current?.click()}>
          Import history.csv
        </button>
        <button onClick={() => planRef.current?.click()}>Import plan.csv</button>
        <input ref={historyRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
          onChange={(e) => handleFile(e, "history")} />
        <input ref={planRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
          onChange={(e) => handleFile(e, "plan")} />
        <button onClick={() => setEditor({ shift: null })}>+ Add shift</button>
        <button onClick={exportCsv} disabled={!shifts.length}>Export CSV</button>
        <button onClick={clearAll} disabled={!counts.all}>Clear</button>
        <button
          className={`tab ${filter === "settings" ? "active" : ""}`}
          style={{ marginLeft: "auto" }}
          onClick={() => setFilter("settings")}
        >
          ⚙ Settings
        </button>
        {settings && filter !== "settings" && (
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {settings.userName} · tip pool {Math.round(settings.tipPoolRate * 100)}% · close {settings.closingTime}
          </span>
        )}
      </div>

      {lastImport && <p className="muted" style={{ fontSize: "0.82rem", marginTop: "-0.5rem" }}>{lastImport}</p>}

      {counts.all > 0 && (
        <div className="tabs">
          {(["worked", "planned", "all", "calendar", "vacation"] as Filter[]).map((f) => (
            <button key={f} className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
              {f !== "calendar" && f !== "vacation" && (
                <span className="muted"> ({counts[f as keyof typeof counts]})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {counts.all > 0 && !isTool && (
        <FilterBar
          filters={filters}
          stations={stations}
          shown={shifts.length}
          total={tabShifts.length}
          onChange={setFilters}
        />
      )}

      {estTotals && (
        <div className="cards">
          <Card label="Planned shifts" value={String(estTotals.shifts)} />
          <Card label="Est. hours" value={`~${estTotals.hours.toFixed(1)}`} />
          <Card label="Est. net wage" value={`~${eur(estTotals.netWage)}`} sub="hours × rate × net factor" />
          <Card label="Est. take-home" value={eurRange(estTotals.takeHome)} sub={`median ${eur(estTotals.takeHome.median)}`} accent />
        </div>
      )}

      {!isPlannedView && !isTool && totals && (
        <div className="cards">
          <Card label="Worked shifts" value={String(totals.shifts)} sub={`${totals.workingDays} working days`} />
          <Card label="Hours" value={totals.hours.toFixed(1)} />
          <Card label="Gross pay" value={eur(totals.grossPay)} sub="wage only" />
          <Card label="Net pay" value={eur(totals.netPay)} />
          <Card label="Usable tips" value={eur(totals.usableTips)} sub={`of ${eur(totals.reportedTips)} reported`} />
          <Card label="Take-home" value={eur(totals.takeHome)} accent />
        </div>
      )}

      {warns.length > 0 && (
        <details className="warnings" open>
          <summary>{warns.length} anomaly warning(s) — review, nothing was auto-fixed</summary>
          <ul>
            {warns.map((w, i) => (
              <li key={i}>
                <span className="row-no">row {w.row}</span>{w.date ? ` (${formatDate(w.date)})` : ""}: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {infos.length > 0 && (
        <details className="warnings info">
          <summary>{infos.length} info note(s) — expected CSV cross-check drift (the pre-April €14.50 estimates)</summary>
          <ul>
            {infos.slice(0, 100).map((w, i) => (
              <li key={i}><span className="row-no">row {w.row}</span>{w.date ? ` (${formatDate(w.date)})` : ""}: {w.message}</li>
            ))}
          </ul>
        </details>
      )}

      {ready && isSettings ? (
        <SettingsPanel
          settings={settings!}
          rates={rates!}
          payslips={payslips!}
          onSettingsSaved={setSettings}
        />
      ) : ready && isVacation ? (
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <VacationPlanner worked={workedHistory} settings={settings!} />
        </Suspense>
      ) : ready && isCalendar ? (
        <Calendar
          shifts={allShifts!}
          worked={workedHistory}
          settings={settings!}
          rates={rates!}
          payslips={payslips!}
          onEditShift={(s) => setEditor({ shift: s })}
          onAddShift={(date) => setEditor({ shift: null, prefill: { date } })}
        />
      ) : ready && shifts.length > 0 ? (
        isPlannedView ? (
          <EstimateTable
            shifts={shifts}
            worked={workedHistory}
            settings={settings!}
            rates={rates!}
            payslips={payslips!}
            onEdit={(s) => setEditor({ shift: s })}
          />
        ) : (
          <ShiftTable
            shifts={shifts}
            settings={settings!}
            rates={rates!}
            payslips={payslips!}
            onEdit={(s) => setEditor({ shift: s })}
          />
        )
      ) : (
        <div className="empty">
          {isPlannedView
            ? "No planned shifts. Import a plan CSV, or + Add shift manually."
            : "No shifts in this view. Import data/history.csv (worked) or data/plan-*.csv (planned). You can also + Add shift manually."}
        </div>
      )}

      {editor && settings && rates && (
        <ShiftEditor
          shift={editor.shift}
          prefill={editor.prefill}
          rates={rates}
          settings={settings}
          stations={stations.length ? stations : ["BAR", "RUNNERS"]}
          onClose={() => setEditor(null)}
          onRequestNew={(prefill) => setEditor({ shift: null, prefill })}
        />
      )}
    </div>
  );
}

function Card(props: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card">
      <div className="label">{props.label}</div>
      <div className="value" style={props.accent ? { color: "var(--good)" } : undefined}>{props.value}</div>
      {props.sub && <div className="sub">{props.sub}</div>}
    </div>
  );
}

function FilterBar(props: {
  filters: ColumnFilters;
  stations: string[];
  shown: number;
  total: number;
  onChange: (f: ColumnFilters) => void;
}) {
  const { filters, stations, shown, total, onChange } = props;
  const set = (patch: Partial<ColumnFilters>) => onChange({ ...filters, ...patch });
  const active =
    filters.q || filters.type !== "all" || filters.weekday !== "all" ||
    filters.station !== "all" || filters.from || filters.to;
  return (
    <div className="filterbar">
      <input className="search" placeholder="Search…" value={filters.q}
        onChange={(e) => set({ q: e.target.value })} />
      <select value={filters.type} onChange={(e) => set({ type: e.target.value as ShiftType | "all" })}>
        <option value="all">Any type</option>
        {SHIFT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={filters.weekday}
        onChange={(e) => set({ weekday: e.target.value === "all" ? "all" : Number(e.target.value) })}>
        <option value="all">Any day</option>
        {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
      </select>
      <select value={filters.station} onChange={(e) => set({ station: e.target.value })}>
        <option value="all">Any station</option>
        {stations.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <input type="date" title="From" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
      <input type="date" title="To" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      {active && <button onClick={() => onChange(EMPTY_FILTERS)}>Reset</button>}
      <span className="muted" style={{ marginLeft: "auto", fontSize: "0.78rem" }}>{shown}/{total}</span>
    </div>
  );
}

function EstimateTable(props: {
  shifts: Shift[];
  worked: Shift[];
  settings: Settings;
  rates: GrossRate[];
  payslips: Payslip[];
  onEdit: (s: Shift) => void;
}) {
  const { shifts, worked, settings, rates, payslips, onEdit } = props;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="l">Date</th><th className="l">Day</th><th className="l">Type</th>
            <th className="l">Station</th><th className="l">Slot</th><th className="l">Bucket</th>
            <th>Est. h</th><th>Rate</th><th>Net wage</th>
            <th>Est. tips</th><th>Est. take-home</th>
            <th className="l" title="How much history backs the estimate: bucket > family > all (⚠ = thin sample)">Est. from</th>
          </tr>
        </thead>
        <tbody>
          {shifts.map((s) => {
            const e = estimateShift(s, worked, rates, payslips, settings);
            const slot = s.plannedStart
              ? `${s.plannedStart}–${s.openEnd ? "Ende" : s.plannedEnd ?? "?"}`
              : "—";
            return (
              <tr key={s.id} className="clickable" onClick={() => onEdit(s)}>
                <td className="l">{formatDate(s.date)}</td>
                <td className="l">{weekdayOf(s.date).slice(0, 3)}</td>
                <td className="l"><span className={`tag ${s.shiftType}`}>{s.shiftType}</span></td>
                <td className="l muted">{s.station}</td>
                <td className="l muted">{slot}</td>
                <td className="l muted">{BUCKET_LABELS[e.bucket]}</td>
                <td className="muted">~{e.hours.toFixed(1)}</td>
                <td className="muted">{e.rate ? eur(e.rate) : "—"}</td>
                <td>{eur(e.netWage)}</td>
                <td className="muted">{eurRange(e.usableTips)}</td>
                <td className="pos">{eurRange(e.takeHome)}</td>
                <td className="l muted" title={`${e.n} past shifts`}>
                  {e.basis}{e.confident ? "" : " ⚠"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ShiftTable(props: {
  shifts: Shift[];
  settings: Settings;
  rates: Parameters<typeof computeShiftEarnings>[1];
  payslips: Parameters<typeof computeShiftEarnings>[2];
  onEdit: (s: Shift) => void;
}) {
  const { shifts, settings, rates, payslips, onEdit } = props;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="l">Date</th><th className="l">Day</th><th className="l">Status</th>
            <th className="l">Type</th><th className="l">Station</th><th className="l">Slot</th>
            <th>Hours</th><th>Rate</th><th>Gross</th><th>Net</th><th>Tips</th>
            <th>Usable</th><th>Take-home</th><th>Tips/h</th>
            <th title="Working days for vacation counting — a midnight-crossing shift counts as 2">Days</th>
          </tr>
        </thead>
        <tbody>
          {shifts.map((s) => {
            const planned = s.status === "planned";
            const e = computeShiftEarnings(s, rates, payslips, settings);
            const ph = plannedHours(s.plannedStart, s.plannedEnd, s.openEnd, settings.closingTime);
            const slot = s.plannedStart
              ? `${s.plannedStart}–${s.openEnd ? "Ende" : s.plannedEnd ?? "?"}`
              : "—";
            return (
              <tr key={s.id} className={`clickable ${s.status.startsWith("swapped") ? "dim" : ""}`} onClick={() => onEdit(s)}>
                <td className="l">{formatDate(s.date)}</td>
                <td className="l">{weekdayOf(s.date).slice(0, 3)}</td>
                <td className="l"><span className={`tag ${planned ? "planned" : "worked"}`}>{s.status}</span></td>
                <td className="l"><span className={`tag ${s.shiftType}`}>{s.shiftType}</span></td>
                <td className="l muted">{s.station}</td>
                <td className="l muted">{slot}</td>
                {planned ? (
                  <>
                    <td className="muted">{ph != null ? `~${ph.toFixed(1)}` : "—"}</td>
                    <td className="muted">{s.grossRate ? eur(s.grossRate) : "—"}</td>
                    <td className="muted">{ph != null && s.grossRate ? `~${eur(ph * s.grossRate)}` : "—"}</td>
                    <td className="muted">—</td><td className="muted">—</td><td className="muted">—</td>
                    <td className="muted">—</td><td className="muted">—</td>
                    <td>{e.workingDays}</td>
                  </>
                ) : (
                  <>
                    <td>{s.actualHours?.toFixed(1) ?? "—"}</td>
                    <td className="muted">{s.grossRate ? eur(s.grossRate) : "—"}</td>
                    <td>{eur(e.grossPay)}</td>
                    <td>{eur(e.netPay)}</td>
                    <td className="muted">{eur(s.tips ?? 0)}</td>
                    <td>{eur(e.usableTips)}</td>
                    <td className="pos">{eur(e.takeHome)}</td>
                    <td className="muted">{e.tipsPerHour == null ? "—" : eur(e.tipsPerHour)}</td>
                    <td>{e.workingDays}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
