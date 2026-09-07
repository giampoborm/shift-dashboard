// Vacation planner. Shows THREE accountings of the same time off — same weeks,
// different units, never to be mixed:
//  0. Payroll basis (the headline, and the only auditable one): chargeable weekdays
//     in the range vs a 20-day entitlement, paid a flat 6 h each. Reverse-engineered
//     from the 8/2026 payslip — see lib/vacationPayroll.ts for the evidence AND for
//     what that evidence does not settle (which five weekdays).
//  1. Werktage basis (contract paperwork): Mon–Sat minus Berlin public holidays, vs 24.
//  2. Proportional basis (your roster): budget = 24 × your avg days/week ÷ 6 (~16),
//     cost = estimated scheduled shifts in the range. A night shift = 1 day.
//
// Scope note: this is a CALCULATOR and a LOG, not an optimizer. It answers "what will
// this range cost and pay me" and "what have I already spent". Advice about placing a
// vacation well needs the chargeable-weekday rule confirmed by payroll first — until
// then it would be confident guessing. See lib/vacation.ts for the model.

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import {
  calcVacation,
  countChargeableVacationDays,
  describeChargeableWeekdays,
  payrollDaysTakenInYear,
  proportionalEntitlement,
  vacationCalendarDates,
  vacationPayrollPay,
} from "../lib/vacation";
import {
  describeFit,
  fitChargeRules,
  impliedPerWeek,
  predictChargedDays,
} from "../lib/vacationRuleFit";
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
  /** Full shift list — the vacation math picks out rostered days (worked + sick) itself. */
  allShifts: Shift[];
  rates: GrossRate[];
  payslips: Payslip[];
  settings: Settings;
}) {
  const { allShifts, rates, payslips, settings } = props;
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDaysIso(today, 13));
  const [note, setNote] = useState("");

  const vacations = useLiveQuery(() => db.vacations.orderBy("from").toArray(), []) ?? [];
  const chargeable = settings.vacationChargeableWeekdays;

  // Every day already spent on vacation — erased from the roster observation window
  // so past time off can't read as "he isn't scheduled much" and shrink the
  // proportional entitlement. The whole range, not just the charged days: you were
  // away on the uncharged Sundays too.
  const pastVacationDates = useMemo(() => vacationCalendarDates(vacations), [vacations]);

  const calc = useMemo(
    () =>
      calcVacation(from, to, allShifts, {
        chargeableWeekdays: chargeable,
        vacationDates: pastVacationDates,
      }),
    [from, to, allShifts, chargeable, pastVacationDates],
  );

  // What payroll will actually pay for this range — arithmetic, not a guess.
  const pay = useMemo(
    () => vacationPayrollPay(from, to, settings, rates, payslips),
    [from, to, settings, rates, payslips],
  );

  // The counting rule fitted to the payslips, and what THIS range costs under every
  // rule still standing. When they agree the app can speak plainly; when they don't,
  // the spread is shown rather than a confident number picked arbitrarily.
  const fit = useMemo(
    () => fitChargeRules(payslips, vacations, { perWeek: impliedPerWeek(settings) }),
    [payslips, vacations, settings],
  );
  const predicted = useMemo(
    () => predictChargedDays(from, to, fit.rules),
    [from, to, fit],
  );

  const year = new Date().getFullYear();
  const thisYear = vacations.filter((v) => v.from.slice(0, 4) === String(year));
  const takenWerktage = thisYear.reduce((s, v) => s + v.werktage, 0);
  const takenScheduled = thisYear.reduce((s, v) => s + (v.scheduledCost ?? 0), 0);
  const takenPayroll = payrollDaysTakenInYear(vacations, year, chargeable);

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
      payrollDays: calc.payrollDays,
      note: note.trim() || undefined,
      createdAt: new Date().toISOString(),
    });
    setNote("");
  }

  return (
    <div className="vacation">
      <div className="vac-budgets">
        <Budget
          title="Payroll basis (what HR deducts)"
          taken={takenPayroll}
          budget={settings.vacationPayrollDays}
          unit={`days (${describeChargeableWeekdays(chargeable)})`}
          highlight
        />
        <Budget
          title="Proportional basis (your shifts)"
          taken={r1(takenScheduled)}
          budget={Math.round(propBudget)}
          unit={`shifts · ~${r1(calc.daysPerWeek)} days/week`}
        />
        <Budget
          title="Werktage basis (contract §8)"
          taken={takenWerktage}
          budget={werktageBudget}
          unit="Werktage (Mon–Sat)"
        />
      </div>
      <p className="muted" style={{ fontSize: "0.78rem" }}>
        All three describe the same ~4 weeks off — just different units, so never mix
        consumption from one with the budget of another. The payroll basis is the one
        your payslip shows (“Genommene Urlaubstage”), so it's the balance that's real.
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
            <Card
              label="Days charged"
              value={predicted.agree ? String(calc.payrollDays) : `${predicted.min}–${predicted.max}`}
              sub={
                predicted.agree
                  ? `of your ${settings.vacationPayrollDays} · payroll basis`
                  : `of your ${settings.vacationPayrollDays} · depends on the counting rule`
              }
              accent
            />
            <Card
              label="Shifts you'd miss"
              value={rng(calc.scheduleCost.low, calc.scheduleCost.high)}
              sub={`≈ ${r1(calc.scheduleCost.expected)} from your roster`}
            />
            <Card
              label="Vacation pay"
              value={`~€${Math.round(pay.net)}`}
              sub={`${calc.payrollDays} × ${r1(pay.dayHours)} h = ${r1(pay.hours)} h net`}
            />
            <Card label="Calendar days" value={String(calc.calendarDays)} />
            <Card label="Werktage" value={String(calc.werktage)} sub={`vs your ${werktageBudget}`} />
            <Card label="Arbeitstage" value={String(calc.arbeitstage)} sub="Mon–Fri basis" />
          </div>

          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Payroll charges <strong>{describeChargeableWeekdays(chargeable)}</strong> off your{" "}
            {settings.vacationPayrollDays} and pays each one a flat{" "}
            <strong>{r1(settings.vacationDayHours)} h</strong> — not your real shift length.{" "}
            {describeFit(fit)}
            {!predicted.agree && (
              <>
                {" "}
                That is why this range shows a spread: depending on which is right it costs{" "}
                {predicted.min} or {predicted.max} days. Add another payslip’s vacation figures in
                Settings to settle it.
              </>
            )}{" "}
            A midnight-crossing shift counts as one vacation day.
          </p>
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Vacation pay is Urlaubsentgelt — it replaces the <em>wage</em> only, so the tips of a
            missed shift are simply gone and show on no payslip line.
          </p>

          {calc.holidays.length > 0 && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Public holidays in range (free under the Werktage basis, still charged by payroll):{" "}
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
                <th>Charged</th><th>Shifts</th><th>Werktage</th><th className="l">Note</th><th></th>
              </tr>
            </thead>
            <tbody>
              {vacations.map((v) => (
                <tr key={v.id}>
                  <td className="l">{formatDate(v.from)}</td>
                  <td className="l">{formatDate(v.to)}</td>
                  <td>{v.payrollDays ?? countChargeableVacationDays(v.from, v.to, chargeable)}</td>
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

function Card(props: { label: string; value: string; sub?: string; accent?: boolean; bad?: boolean }) {
  const color = props.bad ? "var(--bad)" : props.accent ? "var(--good)" : undefined;
  return (
    <div className="card">
      <div className="label">{props.label}</div>
      <div className="value" style={color ? { color } : undefined}>{props.value}</div>
      {props.sub && <div className="sub">{props.sub}</div>}
    </div>
  );
}
