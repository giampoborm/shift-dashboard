// Vacation planner.
//
// The headline is the PAYROLL cost, and it is worked out the way payroll actually
// works it out: the hours you'd have been rostered for during the range, divided
// by the flat 6 h a vacation day is paid at, rounded up. Because his shifts run
// ~7 h, a week away costs ~4.7 days rather than 4 — which is the whole reason a
// Mon-to-next-Tuesday trip shows up on the slip as 6 days / 36 h. See
// lib/vacationCharge.ts for the mechanism and the payslip it's grounded in.
//
// Beside it, the Werktage basis (Mon–Sat minus Berlin public holidays, vs the 24
// of contract §8) is kept as the paperwork cross-check — same ~4 weeks, different
// unit, never to be mixed with the payroll balance.
//
// "Shifts you'd miss" is deliberately NOT a third budget: it's opportunity cost.
// Those shifts' tips are gone and no payslip line replaces them.
//
// Scope note: this is a CALCULATOR and a LOG, not an optimizer.

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import {
  buildWeekdayHoursProfile,
  calcVacation,
  calibrateCharge,
  chargeVacation,
  describeCalibration,
  payrollDaysTakenInYear,
  vacationBudgetUse,
  vacationCalendarDates,
  vacationPayrollPay,
} from "../lib/vacation";
import { formatDate, formatDateShort } from "../lib/format";
import type { GrossRate, Payslip, Settings, Shift } from "../lib/types";

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const rng = (a: number, b: number) =>
  Math.round(a) === Math.round(b) ? `${Math.round(a)}` : `${Math.round(a)}–${Math.round(b)}`;
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00`).toLocaleDateString(undefined, { month: "long" });

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
  const dayHours = settings.vacationDayHours;

  // Every day already spent on vacation — erased from the roster observation
  // window so past time off can't read as "he works fewer hours" and shrink what
  // the next holiday is estimated to cost.
  const pastVacationDates = useMemo(() => vacationCalendarDates(vacations), [vacations]);

  const hoursProfile = useMemo(
    () => buildWeekdayHoursProfile(allShifts, pastVacationDates),
    [allShifts, pastVacationDates],
  );

  const calc = useMemo(
    () => calcVacation(from, to, allShifts, { dayHours, vacationDates: pastVacationDates }),
    [from, to, allShifts, dayHours, pastVacationDates],
  );
  const charge = calc.charge;

  const pay = useMemo(
    () => vacationPayrollPay(from, to, hoursProfile, settings, rates, payslips),
    [from, to, hoursProfile, settings, rates, payslips],
  );

  // How much of the finite entitlement this range uses. Days beyond the year's
  // budget are still time off, but payroll pays nothing for them.
  const budget = useMemo(
    () =>
      vacationBudgetUse(
        from,
        to,
        vacations,
        hoursProfile,
        dayHours,
        settings.vacationPayrollDays,
      ),
    [from, to, vacations, hoursProfile, dayHours, settings.vacationPayrollDays],
  );
  const paidShare = budget.charged > 0 ? budget.paid / budget.charged : 0;

  // Does hours ÷ 6 reproduce what the payslips actually charged?
  const cal = useMemo(
    () => calibrateCharge(payslips, vacations, hoursProfile, dayHours),
    [payslips, vacations, hoursProfile, dayHours],
  );

  const year = new Date().getFullYear();
  const thisYear = vacations.filter((v) => v.from.slice(0, 4) === String(year));
  const takenWerktage = thisYear.reduce((s, v) => s + v.werktage, 0);
  const takenPayroll = payrollDaysTakenInYear(vacations, year, hoursProfile, dayHours, today);

  const werktageBudget = settings.vacationWerktage;
  const valid = to >= from;
  const noHistory = calc.weeklyHours <= 0;

  async function saveVacation() {
    if (!valid) return;
    await db.vacations.add({
      from,
      to,
      werktage: calc.werktage,
      scheduledCost: r1(calc.scheduleCost.expected),
      payrollDays: charge.days,
      payrollHours: charge.paidHours,
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
          unit={`days · your hours ÷ ${r1(dayHours)} h`}
          highlight
        />
        <Budget
          title="Werktage basis (contract §8)"
          taken={takenWerktage}
          budget={werktageBudget}
          unit="Werktage (Mon–Sat)"
        />
      </div>
      <p className="muted" style={{ fontSize: "0.78rem" }}>
        Both describe the same ~4 weeks off, in different units — never mix consumption from
        one with the budget of the other. The payroll basis is the one your payslip shows
        (“Genommene Urlaubstage”), so it's the balance that's real.
      </p>

      <div className="vac-inputs">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Note <input value={note} placeholder="optional" onChange={(e) => setNote(e.target.value)} /></label>
        <button className="primary" disabled={!valid} onClick={saveVacation}>Record vacation</button>
      </div>

      {!valid ? (
        <p className="err">End date is before start date.</p>
      ) : noHistory ? (
        <p className="err">
          No rostered hours logged yet, so there's nothing to work the vacation cost out
          from. Import or log some shifts first.
        </p>
      ) : (
        <>
          <div className="cards">
            <Card
              label="Days charged"
              value={String(charge.days)}
              sub={`${r1(charge.rawDays)} rounded up · ${budget.availableBefore} left before, ${budget.availableAfter} after`}
              accent
            />
            <Card
              label="Hours you'd miss"
              value={`${r1(charge.missedHours)} h`}
              sub={`~${r1(calc.weeklyHours)} h in a typical week`}
            />
            <Card
              label="Vacation pay"
              value={`~€${Math.round(pay.net * paidShare)}`}
              sub={
                budget.unpaid > 0
                  ? `only ${budget.paid} of ${budget.charged} days still covered`
                  : `${charge.days} × ${r1(dayHours)} h = ${r1(charge.paidHours)} h net`
              }
            />
            <Card
              label="Shifts you'd miss"
              value={rng(calc.scheduleCost.low, calc.scheduleCost.high)}
              sub={`≈ ${r1(calc.scheduleCost.expected)} from your roster · their tips are gone`}
            />
            <Card label="Calendar days" value={String(calc.calendarDays)} />
            <Card label="Werktage" value={String(calc.werktage)} sub={`vs your ${werktageBudget}`} />
          </div>

          {/* The derivation, spelled out — "6 days" means nothing on its own. */}
          <p className="week-split">
            <strong>{r1(charge.missedHours)} h</strong> you'd have worked
            <span className="plus"> ÷ </span>
            <strong>{r1(dayHours)} h</strong> a vacation day
            <span className="plus"> = </span>
            <strong>{r1(charge.rawDays)}</strong>
            <span className="plus"> → </span>
            <strong>{charge.days}</strong> day{charge.days === 1 ? "" : "s"} charged
          </p>
          {charge.segments.length > 1 && (
            <p className="week-split">
              {charge.segments.map((s, i) => (
                <span key={s.month}>
                  {i > 0 && <span className="plus"> + </span>}
                  <strong>{s.days}</strong> in {monthLabel(s.month)} ({r1(s.missedHours)} h)
                </span>
              ))}
              <span className="muted">
                {"  — each month's payslip rounds up on its own"}
              </span>
            </p>
          )}

          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Payroll doesn't count the days you're away — it counts the <strong>hours you'd
            have worked</strong> and pays them out in flat <strong>{r1(dayHours)} h</strong>{" "}
            days, rounding any part-day up. That's why your ~{r1(calc.weeklyHours)} h week
            costs about {r1(calc.weeklyHours / dayHours)} vacation days rather than the{" "}
            {r1(calc.daysPerWeek)} shifts you actually work: a {r1(calc.weeklyHours / Math.max(1, calc.daysPerWeek))} h
            shift is longer than one {r1(dayHours)} h vacation day. Which weekdays you're
            available on makes no difference to the total — only how many hours you'd have
            worked does. {describeCalibration(cal)}
          </p>

          {cal.impliedWeeklyHours != null && (
            <p className="muted" style={{ fontSize: "0.78rem" }}>
              Cross-check: your payslips' vacation hours imply payroll costed you at{" "}
              <strong>~{r1(cal.impliedWeeklyHours)} h/week</strong>; your logged roster
              averages <strong>~{r1(cal.weeklyHours)} h/week</strong>.
              {Math.abs(cal.impliedWeeklyHours - cal.weeklyHours) > 2 &&
                " That gap is big enough to shift a day either way on a long range."}
            </p>
          )}

          {budget.unpaid > 0 && (
            <p className="err" style={{ fontSize: "0.82rem" }}>
              <strong>
                {budget.unpaid} of these {budget.charged} days would be unpaid leave.
              </strong>{" "}
              You have {budget.availableBefore} day{budget.availableBefore === 1 ? "" : "s"} left of
              this year's {settings.vacationPayrollDays}, so payroll pays{" "}
              {budget.paid === 0 ? "none of this range" : `only the first ${budget.paid}`}. The rest
              is still time off — it just earns nothing, and the vacation pay above reflects that.
            </p>
          )}
          <p className="muted" style={{ fontSize: "0.8rem" }}>
            Vacation pay is Urlaubsentgelt — it replaces the <em>wage</em> only, so the tips of a
            missed shift are simply gone and show on no payslip line.
          </p>

          {calc.holidays.length > 0 && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Public holidays in range (free under the Werktage basis; under the payroll basis
              they only help if you'd have been rostered then):{" "}
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
                <th>Charged</th><th>Hours</th><th>Shifts</th><th>Werktage</th>
                <th className="l">Note</th><th></th>
              </tr>
            </thead>
            <tbody>
              {vacations.map((v) => {
                const c =
                  v.payrollDays != null
                    ? { days: v.payrollDays, paidHours: v.payrollHours ?? v.payrollDays * dayHours }
                    : chargeVacation(v.from, v.to, hoursProfile, dayHours);
                return (
                  <tr key={v.id}>
                    <td className="l">{formatDate(v.from)}</td>
                    <td className="l">{formatDate(v.to)}</td>
                    <td>{c.days}</td>
                    <td>{r1(c.paidHours)}</td>
                    <td>{r1(v.scheduledCost ?? 0)}</td>
                    <td>{v.werktage}</td>
                    <td className="l muted">{v.note ?? ""}</td>
                    <td>
                      <button className="danger" onClick={() => v.id != null && db.vacations.delete(v.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {vacations.length > 0 && (
        <p className="muted" style={{ fontSize: "0.78rem" }}>
          Recorded vacations keep the day count they were saved with once they're over —
          that's what payroll charged, and refining the estimate later shouldn't rewrite a
          month you've already been paid for. Upcoming ones are re-estimated as your roster
          changes. {formatDateShort(today)} is “today”.
        </p>
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
