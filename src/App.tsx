import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { addMonths, format, startOfMonth, subMonths } from "date-fns";
import { db, ensureSeeded, getSettings } from "./lib/db";
import { importHistoryCsv, type ImportWarning } from "./lib/importHistory";
import { importPlanCsv, plannedHours } from "./lib/importPlan";
import { computeShiftEarnings, sumEarnings } from "./lib/earnings";
import { weekdayOf } from "./lib/shiftTime";
import { formatDate, formatDateShort } from "./lib/format";
import { shiftsToCsv, downloadText } from "./lib/exportCsv";
import { estimateShift, sumEstimates, type Range } from "./lib/estimates";
import { nextShiftFrom, shiftsInMonth } from "./lib/period";
import { reconcileMonth } from "./lib/reconcile";
import { consumeAuthRedirect, isConfigured, sync, syncOnOpen } from "./lib/driveSync";
import { ShiftEditor, type EditorPrefill } from "./components/ShiftEditor";
import { ReconcilePopup } from "./components/ReconcilePopup";
import { Calendar } from "./components/Calendar";
import { Settings as SettingsPanel } from "./components/Settings";
import type { GrossRate, Payslip, Settings, Shift, ShiftType, Vacation } from "./lib/types";

// Code-split: pulls in date-holidays (heavy) only when the Vacation tool is opened.
const VacationPlanner = lazy(() =>
  import("./components/VacationPlanner").then((m) => ({ default: m.VacationPlanner })),
);
// Code-split: recharts is heavy — load it only when Analysis graphs render.
const Charts = lazy(() => import("./components/Charts").then((m) => ({ default: m.Charts })));

const eur = (n: number) => `€${n.toFixed(2)}`;
const eur0 = (n: number) => `€${Math.round(n)}`;
const eurRange = (r: Range) => `€${Math.round(r.p25)}–${Math.round(r.p75)}`;

// Banked-vs-projected breakdown as a bare "1304 + 433" (no € — the figure above
// already carries it). Single-sided when only one part is present.
function breakdownText(m: { banked: number; projected: number }): string {
  const b = m.banked > 0.5;
  const p = m.projected > 0.5;
  const r = (n: number) => `${Math.round(n)}`;
  if (b && p) return `${r(m.banked)} + ${r(m.projected)}`;
  if (p) return `${r(m.projected)}`;
  return `${r(m.banked)}`;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHIFT_TYPES: ShiftType[] = [
  "opening",
  "late-morning",
  "mid-day",
  "early-closing",
  "closing",
  "meeting",
];

// The three "rooms" of the redesigned IA (+ Settings reachable via the gear).
type Room = "home" | "analysis" | "tools" | "settings";
const ROOMS: { id: Room; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "analysis", label: "Analysis" },
  { id: "tools", label: "Tools" },
];
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
  // Restored from sessionStorage when set: survives the full-page redirect round
  // trip to Google's consent screen (Drive Connect), which otherwise drops back
  // onto Home instead of the Settings panel the user was just on.
  const [room, setRoom] = useState<Room>(
    () => (sessionStorage.getItem("ui.room") as Room | null) ?? "home",
  );
  useEffect(() => {
    sessionStorage.setItem("ui.room", room);
  }, [room]);
  const [editor, setEditor] = useState<{ shift: Shift | null; prefill?: EditorPrefill } | null>(null);
  const historyRef = useRef<HTMLInputElement>(null);
  const planRef = useRef<HTMLInputElement>(null);

  const [syncMsg, setSyncMsg] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);

  function refreshSettings() {
    getSettings().then(setSettings);
  }

  // Manual sync from Home's ⟳ — interactive, so a lapsed Google grant can pop the
  // consent dialog right there instead of sending the user to Settings.
  async function syncNow() {
    if (syncBusy) return;
    setSyncBusy(true);
    try {
      const r = await sync(true);
      if (r.status === "conflict")
        setSyncMsg("Sync conflict — open ⚙ Settings to choose which copy to keep.");
      else if (r.status === "pulled") {
        refreshSettings();
        setSyncMsg("Pulled latest from Google Drive ✓");
      } else if (r.status === "pushed") setSyncMsg("Pushed to Google Drive ✓");
      else setSyncMsg("Already in sync ✓");
    } catch (err) {
      setSyncMsg(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncBusy(false);
    }
  }

  useEffect(() => {
    // Ask the browser never to evict our IndexedDB under storage pressure — on a
    // device that hasn't connected Drive sync this is the only copy of the data.
    navigator.storage?.persist?.().catch(() => {});
    ensureSeeded()
      .then(getSettings)
      .then(setSettings)
      // Finish the Drive OAuth redirect round trip (no-op unless the URL just
      // carried a `?code=…` back from Google) before syncing, so a fresh
      // connection is picked up immediately instead of on the next open.
      .then(() => consumeAuthRedirect())
      .then(() =>
        syncOnOpen().then((r) => {
          if (!r) return;
          if (r.status === "pulled") {
            refreshSettings();
            setSyncMsg("Synced latest from Google Drive ✓");
          } else if (r.status === "conflict") {
            setSyncMsg("Sync conflict — open ⚙ Settings to choose which copy to keep.");
          }
        }),
      )
      .catch(() => {});
  }, []);

  const allShifts = useLiveQuery(() => db.shifts.orderBy("date").toArray(), []);
  const rates = useLiveQuery(() => db.rates.toArray(), []);
  const payslips = useLiveQuery(() => db.payslips.toArray(), []);
  const vacations = useLiveQuery(() => db.vacations.toArray(), []);

  const ready = settings && rates && payslips && allShifts;

  const workedHistory = useMemo(
    () => (allShifts ?? []).filter((s) => s.status === "worked"),
    [allShifts],
  );

  const stations = useMemo(
    () => Array.from(new Set((allShifts ?? []).map((s) => s.station))).sort(),
    [allShifts],
  );

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>, kind: ImportKind) {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    if (!files.length || !settings || !rates) return;
    try {
      if (kind === "history") {
        const file = files[0];
        const result = importHistoryCsv(await file.text(), rates, settings);
        await replaceSource("history.csv", result.shifts);
        setWarnings(result.warnings);
        setLastImport(`Imported ${result.shifts.length} worked shifts from ${file.name}`);
      } else {
        let totalShifts = 0;
        let totalMatched = 0;
        const allWarnings: ImportWarning[] = [];
        for (const file of files) {
          const source = `plan:${file.name}`;
          const result = importPlanCsv(await file.text(), source, rates, settings);
          await replaceSource(source, result.shifts);
          totalShifts += result.shifts.length;
          totalMatched += result.matched;
          allWarnings.push(...result.warnings);
        }
        setWarnings(allWarnings);
        const fileLabel = files.length === 1 ? files[0].name : `${files.length} files`;
        setLastImport(
          `Imported ${totalShifts} planned shifts (${totalMatched} cells matched ${settings.userName}) from ${fileLabel}`,
        );
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

  return (
    <div className="app">
      <header className="topbar">
        <h1>Shift Dashboard</h1>
        <nav className="rooms">
          {ROOMS.map((r) => (
            <button
              key={r.id}
              className={`tab ${room === r.id ? "active" : ""}`}
              onClick={() => setRoom(r.id)}
            >
              {r.label}
            </button>
          ))}
        </nav>
      </header>

      {syncMsg && (
        <p className="muted" style={{ fontSize: "0.82rem" }}>
          {syncMsg}{" "}
          <button className="linklike" onClick={() => setSyncMsg("")} title="Dismiss">✕</button>
        </p>
      )}

      {!ready ? (
        <div className="empty">Loading…</div>
      ) : room === "home" ? (
        <Home
          allShifts={allShifts!}
          worked={workedHistory}
          settings={settings!}
          rates={rates!}
          payslips={payslips!}
          vacations={vacations ?? []}
          onEditShift={(s) => setEditor({ shift: s })}
          onAddShift={(date) => setEditor({ shift: null, prefill: { date } })}
          onNewShift={() => setEditor({ shift: null })}
          onOpenSettings={() => setRoom("settings")}
          onSync={isConfigured() ? syncNow : undefined}
          syncBusy={syncBusy}
        />
      ) : room === "analysis" ? (
        <Analysis
          allShifts={allShifts!}
          worked={workedHistory}
          settings={settings!}
          rates={rates!}
          payslips={payslips!}
          stations={stations}
          onEditShift={(s) => setEditor({ shift: s })}
        />
      ) : room === "tools" ? (
        <Tools
          worked={workedHistory}
          settings={settings!}
          lastImport={lastImport}
          warnings={warnings}
          hasShifts={allShifts!.length > 0}
          onImportHistory={() => historyRef.current?.click()}
          onImportPlan={() => planRef.current?.click()}
          onClear={clearAll}
        />
      ) : (
        <SettingsPanel
          settings={settings!}
          rates={rates!}
          payslips={payslips!}
          onSettingsSaved={setSettings}
          onDataReplaced={refreshSettings}
        />
      )}

      {/* Hidden file inputs — bulk capture, triggered from the Tools room. */}
      <input ref={historyRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
        onChange={(e) => handleFile(e, "history")} />
      <input ref={planRef} type="file" accept=".csv,text/csv" multiple style={{ display: "none" }}
        onChange={(e) => handleFile(e, "plan")} />

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

// ─────────────────────────────────────────────────────────────────────────────
// HOME — one month at a time. The calendar IS the time filter. Money for the month
// falls out of shift status automatically: worked → actual, planned → estimate.
// A today-anchored next-shift card sits on top and never moves with the viewed month.
// ─────────────────────────────────────────────────────────────────────────────
function Home(props: {
  allShifts: Shift[];
  worked: Shift[];
  settings: Settings;
  rates: GrossRate[];
  payslips: Payslip[];
  vacations: Vacation[];
  onEditShift: (s: Shift) => void;
  onAddShift: (dateIso: string) => void;
  onNewShift: () => void;
  onOpenSettings: () => void;
  onSync?: () => void;
  syncBusy?: boolean;
}) {
  const { allShifts, worked, settings, rates, payslips, vacations, onEditShift, onAddShift,
    onNewShift, onOpenSettings, onSync, syncBusy } = props;
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  // brutto/netto share one card; tapping it toggles which is shown.
  const [sideView, setSideView] = useState<"brutto" | "netto">("brutto");
  const [showRecon, setShowRecon] = useState(false);

  const next = useMemo(() => nextShiftFrom(allShifts, new Date()), [allShifts]);

  // Money for the next shift — always an estimate range (nextShiftFrom never
  // returns a worked shift: once logged, the card advances to the following one).
  const nextMoney = useMemo(() => {
    if (!next) return null;
    const est = estimateShift(next, worked, rates, payslips, settings);
    return {
      takeHome: eurRange(est.takeHome),
      tips: eurRange(est.usableTips),
      estimated: true,
      confident: est.confident,
    };
  }, [next, worked, rates, payslips, settings]);

  // Logged-vs-payslip check for the viewed month; drives the "!" on the salary card.
  const recon = useMemo(
    () => reconcileMonth(format(cursor, "yyyy-MM"), allShifts, rates, payslips),
    [allShifts, cursor, rates, payslips],
  );

  const month = useMemo(() => {
    const inMonth = shiftsInMonth(allShifts, cursor);
    const workedM = inMonth.filter((s) => s.status === "worked");
    const plannedM = inMonth.filter((s) => s.status === "planned" || s.status === "swapped-in");
    const banked = sumEarnings(workedM, rates, payslips, settings);
    const projected = sumEstimates(plannedM, worked, rates, payslips, settings);
    // When the user resolved a payslip discrepancy in favour of the slip, the
    // banked wage part (brutto/netto, and netto's share of take-home) comes from
    // the payslip instead of the logged hours. Tips are untouched — not on the slip.
    const slip = recon?.slip.useSlipTotals ? recon.slip : null;
    const bankedGross = slip ? slip.totalGross : banked.grossPay;
    const bankedNet = slip ? slip.totalNet : banked.netPay;
    // One row per money category, each split into what's banked (worked actuals) vs
    // projected (planned estimates) — the actual-vs-estimate blend, made visible.
    return {
      workedCount: workedM.length,
      plannedCount: plannedM.length,
      takeHome: { banked: bankedNet + banked.usableTips, projected: projected.takeHome.median },
      gross: { banked: bankedGross, projected: projected.grossWage },
      net: { banked: bankedNet, projected: projected.netWage },
      tips: { banked: banked.usableTips, projected: projected.usableTips.median },
    };
  }, [allShifts, cursor, worked, rates, payslips, settings, recon]);

  return (
    <div className="room home">
      {/* Hero: next-shift arrow → red log dot → this month's take-home. */}
      <div className="home-hero">
        {next ? (
          <>
            <div className="next-arrow" onClick={() => onEditShift(next)} role="button"
              title="View this shift">
              <div className="inner">
                <div className="na-line">
                  Next: {weekdayOf(next.date).slice(0, 3)} {formatDateShort(next.date)}
                  {next.plannedStart ? ` ${next.plannedStart}–${next.openEnd ? "Ende" : next.plannedEnd ?? "?"}` : ""}
                </div>
                <div className="na-sub">
                  {next.station} · {next.shiftType}
                  {next.status !== "planned" ? ` · ${next.status}` : ""}
                </div>
                {nextMoney && (
                  <div className="na-money">
                    <span><span className="k">take home </span>
                      <span className="v">{nextMoney.estimated ? "~" : ""}{nextMoney.takeHome}</span></span>
                    <span><span className="k">tips </span>
                      <span className="v">{nextMoney.estimated ? "~" : ""}{nextMoney.tips}</span></span>
                  </div>
                )}
              </div>
            </div>
            <button className="log-dot" onClick={() => onEditShift(next)}
              title={`Log this shift (${formatDate(next.date)})`} aria-label="Log next shift">
              done
            </button>
          </>
        ) : (
          <button className="log-dot" onClick={() => onAddShift(format(new Date(), "yyyy-MM-dd"))}
            title="Log a shift" aria-label="Log a shift">
            log
          </button>
        )}
      </div>

      <div className="month-nav">
        <button onClick={() => setCursor(addMonths(cursor, -1))}>‹</button>
        <strong>{format(cursor, "MMMM yyyy")}</strong>
        <button onClick={() => setCursor(addMonths(cursor, 1))}>›</button>
        <button onClick={() => setCursor(startOfMonth(new Date()))}>Current</button>
      </div>

      {/* Typographic money grid: total sits alone on top (mobile spans the full
          width); tips + the brutto/netto toggle share the row underneath it.
          Desktop collapses back to one simple horizontal row (see CSS). */}
      <div className="money-grid">
        <div className="mg-total">
          <MiniStat label="total" money={month.takeHome} variant="hero" />
        </div>
        <div className="mg-row">
          <MiniStat label="tips" money={month.tips} variant="mid" />
          <div className="ms-wrap">
            <MiniStat
              label={sideView}
              money={sideView === "brutto" ? month.gross : month.net}
              variant="minor"
              onClick={() => setSideView(sideView === "brutto" ? "netto" : "brutto")}
              title="Tap to switch brutto / netto"
            />
            {recon && (recon.discrepant || recon.slip.useSlipTotals) && (
              <button
                className={`recon-badge ${recon.slip.useSlipTotals ? "resolved" : ""}`}
                onClick={() => setShowRecon(true)}
                title="Logged shifts and this month's payslip disagree — tap for details"
                aria-label="Payslip discrepancy details"
              >
                !
              </button>
            )}
          </div>
        </div>
      </div>

      {showRecon && recon && (
        <ReconcilePopup recon={recon} onClose={() => setShowRecon(false)} />
      )}

      <Calendar
        shifts={allShifts}
        worked={worked}
        settings={settings}
        rates={rates}
        payslips={payslips}
        vacations={vacations}
        cursor={cursor}
        onCursorChange={setCursor}
        hideNav
        onEditShift={onEditShift}
        onAddShift={onAddShift}
      />

      {/* Quiet utilities live at the very bottom, out of the glance path. */}
      <div className="home-footer-actions">
        <button className="icon-btn" onClick={onNewShift}
          title="Log a new shift" aria-label="Log a new shift">+</button>
        {onSync && (
          <button className={`icon-btn ${syncBusy ? "spin" : ""}`} onClick={onSync}
            disabled={syncBusy} title="Sync with Google Drive"
            aria-label="Sync with Google Drive">⟳</button>
        )}
        <button className="icon-btn" onClick={onOpenSettings}
          title="Settings" aria-label="Settings">⚙</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYSIS — a range of months, two altitudes of the SAME data: graphs lead,
// the shift table is the drill-down substrate beneath them.
// ─────────────────────────────────────────────────────────────────────────────
const RANGES = [3, 6, 12] as const;
function Analysis(props: {
  allShifts: Shift[];
  worked: Shift[];
  settings: Settings;
  rates: GrossRate[];
  payslips: Payslip[];
  stations: string[];
  onEditShift: (s: Shift) => void;
}) {
  const { allShifts, worked, settings, rates, payslips, stations, onEditShift } = props;
  const [rangeMonths, setRangeMonths] = useState<number | "all">(6);
  const [filters, setFilters] = useState<ColumnFilters>(EMPTY_FILTERS);

  const fromDate = useMemo(
    () => (rangeMonths === "all" ? "" : format(subMonths(startOfMonth(new Date()), rangeMonths - 1), "yyyy-MM-dd")),
    [rangeMonths],
  );

  const inRange = useMemo(() => {
    return allShifts.filter((s) => {
      if (fromDate && s.date < fromDate) return false;
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
  }, [allShifts, fromDate, filters]);

  const workedInRange = useMemo(() => inRange.filter((s) => s.status === "worked"), [inRange]);

  function exportCsv() {
    const csv = shiftsToCsv(inRange, rates, payslips, settings);
    downloadText(`shifts-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  return (
    <div className="room analysis">
      <div className="range-nav">
        {RANGES.map((n) => (
          <button key={n} className={`tab ${rangeMonths === n ? "active" : ""}`} onClick={() => setRangeMonths(n)}>
            {n}M
          </button>
        ))}
        <button className={`tab ${rangeMonths === "all" ? "active" : ""}`} onClick={() => setRangeMonths("all")}>
          All
        </button>
        <button style={{ marginLeft: "auto" }} onClick={exportCsv} disabled={!inRange.length}>
          Export CSV
        </button>
      </div>

      {/* Altitude 1 — graphs (the patterns / insight). */}
      <Suspense fallback={<div className="empty">Loading charts…</div>}>
        <Charts worked={workedInRange} rates={rates} payslips={payslips} settings={settings} />
      </Suspense>

      {/* Altitude 2 — the substrate: the underlying rows, filterable. */}
      <FilterBar filters={filters} stations={stations} shown={inRange.length} onChange={setFilters} />
      {inRange.length > 0 ? (
        <ShiftTable
          shifts={inRange}
          settings={settings}
          rates={rates}
          payslips={payslips}
          worked={worked}
          onEdit={onEditShift}
        />
      ) : (
        <div className="empty">No shifts in this range/filter.</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS — power-tools tucked away: bulk CSV import, vacation calculator, and (soon)
// the shift optimizer. Plus import warnings, which belong with the import action.
// ─────────────────────────────────────────────────────────────────────────────
function Tools(props: {
  worked: Shift[];
  settings: Settings;
  lastImport: string;
  warnings: ImportWarning[];
  hasShifts: boolean;
  onImportHistory: () => void;
  onImportPlan: () => void;
  onClear: () => void;
}) {
  const { worked, settings, lastImport, warnings, hasShifts, onImportHistory, onImportPlan, onClear } = props;
  const warns = warnings.filter((w) => w.severity === "warn");
  const infos = warnings.filter((w) => w.severity === "info");

  return (
    <div className="room tools">
      <div className="card">
        <div className="label">Bulk import</div>
        <div className="toolbar" style={{ marginTop: "0.5rem" }}>
          <button className="primary" onClick={onImportHistory}>Import history.csv</button>
          <button onClick={onImportPlan}>Import plan.csv</button>
          <button onClick={onClear} disabled={!hasShifts}>Clear all</button>
        </div>
        {lastImport && <p className="muted" style={{ fontSize: "0.82rem" }}>{lastImport}</p>}
      </div>

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

      <Suspense fallback={<div className="empty">Loading…</div>}>
        <VacationPlanner worked={worked} settings={settings} />
      </Suspense>

      <div className="card">
        <div className="label">Shift optimizer</div>
        <div className="sub">
          Coming soon — "I want ~7 days off in August → which window costs the fewest scheduled
          shifts and bridges the most public holidays?"
        </div>
      </div>
    </div>
  );
}

// A compact month money figure: label + total. A "~" prefix marks a figure that is
// still partly/fully projected (planned shifts not yet worked) — the verbose
// banked/projected breakdown is dropped in favour of glance-ability.
function MiniStat(props: {
  label: string;
  money: { banked: number; projected: number };
  /** hero = the headline figure, mid = secondary big, minor = de-emphasised. */
  variant?: "hero" | "mid" | "minor";
  /** stack = number with label + breakdown beneath it (total/tips); vert = vertical card (toggle). */
  layout?: "stack" | "vert";
  /** when set, the card becomes a button (e.g. the brutto/netto toggle). */
  onClick?: () => void;
  title?: string;
  /** hide the banked + projected breakdown line. */
  showSub?: boolean;
}) {
  const { banked, projected } = props.money;
  const total = banked + projected;
  // "~" only when the figure is entirely an estimate (nothing banked yet).
  const approx = banked <= 0.5 && projected > 0.5;
  const variant = props.variant ?? "mid";
  const layout = props.layout ?? "stack";
  const showSub = props.showSub ?? true;
  const cls = `ms ms-${variant} ms-${layout}`;
  // Label and breakdown ride together beneath the figure, left-aligned with each other.
  const inner = (
    <div className="ms-body">
      <span className="v">
        {approx && <span className="approx">~</span>}
        {eur0(total)}
      </span>
      <div className="ms-foot">
        <span className="k">{props.label}</span>
        {showSub && <span className="sub">{breakdownText(props.money)}</span>}
      </div>
    </div>
  );
  return props.onClick ? (
    <button className={cls} onClick={props.onClick} title={props.title}
      aria-label={`${props.label} — ${eur0(total)}; tap to switch`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function FilterBar(props: {
  filters: ColumnFilters;
  stations: string[];
  shown: number;
  onChange: (f: ColumnFilters) => void;
}) {
  const { filters, stations, shown, onChange } = props;
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
      <span className="muted" style={{ marginLeft: "auto", fontSize: "0.78rem" }}>{shown} shifts</span>
    </div>
  );
}

// Shift table — the substrate beneath Analysis graphs. Worked rows show actuals;
// planned/swapped-in rows show the median estimate so the table reads as one body.
function ShiftTable(props: {
  shifts: Shift[];
  settings: Settings;
  rates: GrossRate[];
  payslips: Payslip[];
  worked: Shift[];
  onEdit: (s: Shift) => void;
}) {
  const { shifts, settings, rates, payslips, worked, onEdit } = props;
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
            const planned = s.status === "planned" || s.status === "swapped-in";
            const e = computeShiftEarnings(s, rates, payslips, settings);
            if (planned) {
              const est = estimateShift(s, worked, rates, payslips, settings);
              const ph = plannedHours(s.plannedStart, s.plannedEnd, s.openEnd, settings.closingTime);
              const slot = s.plannedStart
                ? `${s.plannedStart}–${s.openEnd ? "Ende" : s.plannedEnd ?? "?"}`
                : "—";
              return (
                <tr key={s.id} className={`clickable ${s.status.startsWith("swapped") ? "dim" : ""}`} onClick={() => onEdit(s)}>
                  <td className="l">{formatDate(s.date)}</td>
                  <td className="l">{weekdayOf(s.date).slice(0, 3)}</td>
                  <td className="l"><span className="tag planned">{s.status}</span></td>
                  <td className="l"><span className={`tag ${s.shiftType}`}>{s.shiftType}</span></td>
                  <td className="l muted">{s.station}</td>
                  <td className="l muted">{slot}</td>
                  <td className="muted">{ph != null ? `~${ph.toFixed(1)}` : "—"}</td>
                  <td className="muted">{est.rate ? eur(est.rate) : "—"}</td>
                  <td className="muted">{ph != null && est.rate ? `~${eur(ph * est.rate)}` : "—"}</td>
                  <td className="muted">~{eur(est.netWage)}</td>
                  <td className="muted">—</td>
                  <td className="muted">{eurRange(est.usableTips)}</td>
                  <td className="pos">{eurRange(est.takeHome)}</td>
                  <td className="muted">—</td>
                  <td>{e.workingDays}</td>
                </tr>
              );
            }
            const slot = s.plannedStart
              ? `${s.plannedStart}–${s.openEnd ? "Ende" : s.plannedEnd ?? "?"}`
              : "—";
            return (
              <tr key={s.id} className={`clickable ${s.status.startsWith("swapped") ? "dim" : ""}`} onClick={() => onEdit(s)}>
                <td className="l">{formatDate(s.date)}</td>
                <td className="l">{weekdayOf(s.date).slice(0, 3)}</td>
                <td className="l"><span className="tag worked">{s.status}</span></td>
                <td className="l"><span className={`tag ${s.shiftType}`}>{s.shiftType}</span></td>
                <td className="l muted">{s.station}</td>
                <td className="l muted">{slot}</td>
                <td>{s.actualHours?.toFixed(1) ?? "—"}</td>
                <td className="muted">{s.grossRate ? eur(s.grossRate) : "—"}</td>
                <td>{eur(e.grossPay)}</td>
                <td>{eur(e.netPay)}</td>
                <td className="muted">{eur(s.tips ?? 0)}</td>
                <td>{eur(e.usableTips)}</td>
                <td className="pos">{eur(e.takeHome)}</td>
                <td className="muted">{e.tipsPerHour == null ? "—" : eur(e.tipsPerHour)}</td>
                <td>{e.workingDays}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
