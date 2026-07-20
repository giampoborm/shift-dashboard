// Vacation planner. Shows TWO consistent accountings of the same 4-weeks-off budget:
//  1. Werktage basis (contract/paperwork): Mon–Sat minus Berlin public holidays, vs 24.
//  2. Proportional basis (your reality): budget = 24 × your avg days/week ÷ 6 (~16),
//     cost = estimated scheduled shifts in the range. A night shift = 1 day.
// See lib/vacation.ts for the model.

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { calcVacation, estimateVacationPay, proportionalEntitlement } from "../lib/vacation";
import { formatDate } from "../lib/format";
import type { GrossRate, Payslip, Settings, Shift } from "../lib/types";

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const rng = (a: number, b: number) =>
  Math.round(a) === Math.round(b) ? `${Math.round(a)}` : `${Math.round(a)}–${Math.round(b)}`;

export function VacationPlanner(props: {
  worked: Shift[];
  allShifts: Shift[];
  rates: GrossRate[];
  payslips: Payslip[];
  settings: Settings;
}) {
  const { worked, allShifts, rates, payslips, settings } = props;
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDaysIso(today, 13));
  const [note, setNote] = useState("");

  const calc = useMemo(() => calcVacation(from, to, worked), [from, to, worked]);

  // Shifts still on the roster within the draft range — an already-imported plan
  // (e.g. a partial week) offsets how many days count as paid vacation.
  const payEst = useMemo(() => {
    if (to < from) return null;
    const inRange = allShifts.filter((s) => s.date >= from && s.date <= to);
    return estimateVacationPay(from, to, worked, inRange, rates, payslips);
  }, [from, to, worked, allShifts, rates, payslips]);

  const vacations = useLiveQuery(() => db.vacations.orderBy("from").toArray(), []) ?? [];
  const year = new Date().getFullYear();
  const thisYear = vacations.filter((v) => v.from.slice(0, 4) === String(year));
  const takenWerktage = thisYear.reduce((s, v) => s + v.werktage, 0);
  const takenScheduled = thisYear.reduce((s, v) => s + (v.scheduledCost ?? 0), 0);

  const werktageBudget = settings.vacationWerktage;
  const propBudget = proportionalEntitlement(werktageBudget, calc.daysPerWeek);

  const valid = to >= from;

  async function saveVacation() {
    if (!valid) return;
    await db.vacations.add({
      from,
      to,
      werktage: calc.werktage,
      scheduledCost: r1(calc.scheduleCost.expected),
      note: note.trim() || undefined,
      createdAt: new Date().toISOString(),
    });
    setNote("");
  }

  return (
    <div className="vacation">
      <div className="vac-budgets">
        <Budget
          title="Proportional basis (your shifts)"
          taken={r1(takenScheduled)}
          budget={Math.round(propBudget)}
          unit={`shifts · ~${r1(calc.daysPerWeek)} days/week`}
          highlight
        />
        <Budget
          title="Werktage basis (paperwork)"
          taken={takenWerktage}
          budget={werktageBudget}
          unit="Werktage (Mon–Sat)"
        />
      </div>
      <p className="muted" style={{ fontSize: "0.78rem" }}>
        Both describe the same ~4 weeks off — just different units. The proportional basis
        only counts days you'd actually have worked; don't mix it with the 24 budget.
      </p>

      <div className="vac-inputs">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Note <input value={note} placeholder="optional" onChange={(e) => setNote(e.target.value)} /></label>
        <button className="primary" disabled={!valid} onClick={saveVacation}>Record vacation</button>
      </div>

      {!valid ? (
        <p className="err">End date is before start date.</p>
      ) : (
        <>
          <div className="cards">
            <Card label="Calendar days" value={String(calc.calendarDays)} />
            <Card
              label="Shifts you'd miss"
              value={rng(calc.scheduleCost.low, calc.scheduleCost.high)}
              sub={`≈ ${r1(calc.scheduleCost.expected)} (proportional cost)`}
              accent
            />
            <Card label="Werktage" value={String(calc.werktage)} sub="vs your 24" />
            <Card label="Arbeitstage" value={String(calc.arbeitstage)} sub="Mon–Fri basis" />
            {payEst && payEst.days > 0 && (
              <Card
                label="Est. paid vacation"
                value={`${r1(payEst.days)} d`}
                sub={`~€${Math.round(payEst.net)} net`}
                accent
              />
            )}
          </div>

          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Counting rule is an assumption from your contract (§8) — confirm the basis your
            employer actually uses. A midnight-crossing shift counts as one vacation day.
          </p>
          {payEst && payEst.days > 0 && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Paid-vacation estimate: days your usual roster minus what's still actually
              scheduled in this range (from any imported plan), × your recent average day's
              gross (€{r1(payEst.avgDayGross)}). A light forward guess — the payslip settles it
              for real once it arrives.
            </p>
          )}

          {calc.holidays.length > 0 && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Public holidays in range (free, not counted):{" "}
              {calc.holidays.map((h) => `${formatDate(h.date)} ${h.name}`).join(" · ")}
            </p>
          )}
        </>
      )}

      {vacations.length > 0 && (
        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table>
            <thead>
              <tr>
                <th className="l">From</th><th className="l">To</th>
                <th>Shifts</th><th>Werktage</th><th className="l">Note</th><th></th>
              </tr>
            </thead>
            <tbody>
              {vacations.map((v) => (
                <tr key={v.id}>
                  <td className="l">{formatDate(v.from)}</td>
                  <td className="l">{formatDate(v.to)}</td>
                  <td>{r1(v.scheduledCost ?? 0)}</td>
                  <td>{v.werktage}</td>
                  <td className="l muted">{v.note ?? ""}</td>
                  <td>
                    <button className="danger" onClick={() => v.id != null && db.vacations.delete(v.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Budget(props: {
  title: string;
  taken: number;
  budget: number;
  unit: string;
  highlight?: boolean;
}) {
  const { title, taken, budget, unit, highlight } = props;
  const remaining = Math.round((budget - taken) * 10) / 10;
  const pct = budget > 0 ? Math.min(100, (taken / budget) * 100) : 0;
  return (
    <div className={`vac-budget${highlight ? " hl" : ""}`}>
      <div className="vac-budget-title">{title}</div>
      <div className="vac-bar"><div className="vac-bar-fill" style={{ width: `${pct}%` }} /></div>
      <div className="vac-budget-nums">
        <span><strong>{taken}</strong> taken</span>
        <span className={remaining < 0 ? "over" : "pos"}><strong>{remaining}</strong> left</span>
        <span className="muted">of {budget} {unit}</span>
      </div>
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
