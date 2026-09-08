// Settings panel — makes the seeded financial data editable in-app instead of
// living hardcoded in db.ts. Three sections: general settings, the effective-dated
// gross-rate table, and the payslips that derive the net factor.
// Pure validation lives in lib/settingsStore.ts; this component owns the Dexie
// writes (same pattern as ShiftEditor). Live-query data flows in via props, so
// rate/payslip lists refresh themselves after a write.

import { useState } from "react";
import { db } from "../lib/db";
import { formatDate } from "../lib/format";
import {
  blendedNetFactor,
  parseNum,
  payslipNetFactor,
  sortPayslips,
  sortRates,
  validatePayslip,
  validateRate,
  validateSettings,
} from "../lib/settingsStore";
import type { GrossRate, Payslip, Settings as SettingsT, Shift, Vacation } from "../lib/types";
// Dep-free vacation modules, not the lib/vacation barrel — that pulls date-holidays
// into the main bundle (it belongs behind VacationPlanner's lazy load).
import { buildRosterHours } from "../lib/vacationPay";
import { calibrateCharge, chargeModel, hoursPerEligibleDay } from "../lib/vacationCharge";
import { vacationCalendarDates } from "../lib/vacationPayroll";
import { CalibrationWarning } from "./CalibrationWarning";
import { SyncPanel } from "./SyncPanel";

export function Settings(props: {
  settings: SettingsT;
  rates: GrossRate[];
  payslips: Payslip[];
  vacations: Vacation[];
  allShifts: Shift[];
  onSettingsSaved: (s: SettingsT) => void;
  onDataReplaced: () => void;
}) {
  return (
    <div className="settings">
      <GeneralSection
        settings={props.settings}
        payslips={props.payslips}
        vacations={props.vacations}
        allShifts={props.allShifts}
        onSaved={props.onSettingsSaved}
      />
      <RatesSection rates={props.rates} />
      <PayslipsSection payslips={props.payslips} />
      <SyncPanel onDataReplaced={props.onDataReplaced} />
    </div>
  );
}

function Feedback(props: { errors: string[]; saved: boolean }) {
  if (props.errors.length)
    return (
      <ul className="err" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
        {props.errors.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    );
  if (props.saved) return <p className="saved">Saved ✓</p>;
  return null;
}

function GeneralSection(props: {
  settings: SettingsT;
  payslips: Payslip[];
  vacations: Vacation[];
  allShifts: Shift[];
  onSaved: (s: SettingsT) => void;
}) {
  const s = props.settings;
  const [userName, setUserName] = useState(s.userName);
  const [tipPct, setTipPct] = useState(String(Math.round(s.tipPoolRate * 1000) / 10)); // % form
  const [closingTime, setClosingTime] = useState(s.closingTime);
  const [werktage, setWerktage] = useState(String(s.vacationWerktage));
  const [halfLife, setHalfLife] = useState(String(s.recencyHalfLifeDays));
  const [payrollDays, setPayrollDays] = useState(String(s.vacationPayrollDays));
  const [dayHours, setDayHours] = useState(String(s.vacationDayHours));
  const [eligible, setEligible] = useState<number[]>(s.vacationEligibleWeekdays);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  // Live read-out of the charge model, using the weekdays currently TICKED rather
  // than the saved ones — the caption has to move as you tick, or it isn't a
  // read-out of the control it sits under.
  const model = chargeModel(
    { ...s, vacationEligibleWeekdays: eligible },
    buildRosterHours(props.allShifts, vacationCalendarDates(props.vacations)),
  );
  const cal = calibrateCharge(props.payslips, props.vacations, model, s);

  /** "Payroll got this month wrong" — kept on the payslip, so it syncs and so the
   *  figures themselves stay untouched (he really was charged and paid them). */
  async function disputeMonth(month: string) {
    const slip = props.payslips.find((p) => p.month === month);
    if (slip?.id != null) await db.payslips.update(slip.id, { vacationDisputed: true });
  }

  async function save() {
    setSaved(false);
    const pct = parseNum(tipPct);
    const wt = parseNum(werktage);
    const hl = parseNum(halfLife);
    const pd = parseNum(payrollDays);
    const dh = parseNum(dayHours);
    const next: SettingsT = {
      ...s,
      userName: userName.trim(),
      tipPoolRate: pct == null ? NaN : pct / 100,
      closingTime: closingTime,
      vacationWerktage: wt == null ? NaN : wt,
      recencyHalfLifeDays: hl == null ? NaN : hl,
      vacationPayrollDays: pd == null ? NaN : pd,
      vacationDayHours: dh == null ? NaN : dh,
      vacationEligibleWeekdays: [...eligible].sort((a, b) => a - b),
    };
    const errs = validateSettings(next);
    setErrors(errs);
    if (errs.length) return;
    const { id: _id, ...payload } = next; // don't write the primary key back as a field
    await db.settings.update(s.id ?? 1, payload);
    props.onSaved(next);
    setSaved(true);
  }

  return (
    <section>
      <h3>General</h3>
      <p className="hint">Identity, the tip-pool cut, the closing time used when a slot says “Ende”, the contract’s vacation entitlement, and how fast old tips fade from estimates.</p>
      <div className="grid">
        <label>Name (in plan files)
          <input value={userName} onChange={(e) => setUserName(e.target.value)} />
        </label>
        <label>Tip pool cut (%)
          <input value={tipPct} onChange={(e) => setTipPct(e.target.value)} inputMode="decimal" placeholder="5" />
        </label>
        <label>Closing time
          <input type="time" value={closingTime} onChange={(e) => setClosingTime(e.target.value)} />
        </label>
        <label>Vacation Werktage / year
          <input value={werktage} onChange={(e) => setWerktage(e.target.value)} inputMode="numeric" placeholder="24" />
        </label>
        <label>Tip recency half-life (days)
          <input value={halfLife} onChange={(e) => setHalfLife(e.target.value)} inputMode="numeric" placeholder="45" title="Lower = recent shifts dominate tip estimates. 0 = weight all history equally." />
        </label>
      </div>

      <h4 style={{ margin: "1rem 0 0.2rem" }}>Payroll vacation rule</h4>
      <p className="hint">
        Payroll spreads your weekly hours across the days you <em>could</em> be rostered, then
        charges the eligible days you were away ÷ the flat hours a vacation day is paid at,
        rounded up — not one day per day off. Enter a slip’s vacation figures below and the app
        checks itself against it.
      </p>
      <div className="grid">
        <label>Entitlement (days / year)
          <input value={payrollDays} onChange={(e) => setPayrollDays(e.target.value)} inputMode="decimal" placeholder="20" title={'The payslip’s “Tage LJ alt”.'} />
        </label>
        <label>Hours paid per vacation day
          <input value={dayHours} onChange={(e) => setDayHours(e.target.value)} inputMode="decimal" placeholder="6" title={'The payslip’s Urlaub hours ÷ Genommene Urlaubstage.'} />
        </label>
      </div>
      <fieldset className="weekday-set">
        <legend>Days you could be rostered</legend>
        {WEEKDAY_LABELS.map((label, wd) => (
          <label key={wd} className="checkbox-row">
            <input
              type="checkbox"
              checked={eligible.includes(wd)}
              onChange={(e) =>
                setEligible((prev) =>
                  e.target.checked ? [...prev, wd] : prev.filter((d) => d !== wd),
                )
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="hint">
        <strong>
          ~{r1(model.weeklyHours)} h/week ÷ {new Set(eligible).size} days ={" "}
          {r1(hoursPerEligibleDay(model))} h per day away.
        </strong>{" "}
        Ticking one more day <em>doesn’t</em> make a holiday cost more — it lowers the hours each
        day carries by the same proportion. It only changes how a vacation that starts or ends
        mid-week is counted.
      </p>
      <CalibrationWarning
        cal={cal}
        dayHours={s.vacationDayHours}
        onApplyDayHours={(hours) => setDayHours(String(hours))}
        onDispute={disputeMonth}
      />

      <div className="row-actions" style={{ marginTop: "0.75rem" }}>
        <button className="primary" onClick={save}>Save general</button>
      </div>
      <Feedback errors={errors} saved={saved} />
    </section>
  );
}

// getDay() order, so the index IS the weekday number stored in settings.
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const r1 = (n: number) => Math.round(n * 10) / 10;

function RatesSection(props: { rates: GrossRate[] }) {
  const sorted = sortRates(props.rates);
  const [newFrom, setNewFrom] = useState("");
  const [newRate, setNewRate] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  async function add() {
    const rec: Partial<GrossRate> = { effectiveFrom: newFrom, rate: parseNum(newRate) ?? NaN };
    const errs = validateRate(rec);
    if (!errs.length && props.rates.some((r) => r.effectiveFrom === newFrom))
      errs.push(`A rate effective ${newFrom} already exists — edit that row instead.`);
    setErrors(errs);
    if (errs.length) return;
    await db.rates.add(rec as GrossRate);
    setNewFrom("");
    setNewRate("");
  }

  return (
    <section>
      <h3>Gross rate table</h3>
      <p className="hint">Authoritative €/h for gross pay. Each rate applies on and after its date — add a new row when you get a raise (the old rows stay, so past shifts stay correct).</p>
      <div className="editrows">
        {sorted.map((r) => (
          <RateRow key={r.id} rate={r} canDelete={sorted.length > 1} />
        ))}
      </div>
      <div className="addrow">
        <input type="date" value={newFrom} onChange={(e) => setNewFrom(e.target.value)} title="Effective from" />
        <input value={newRate} onChange={(e) => setNewRate(e.target.value)} inputMode="decimal" placeholder="€/h e.g. 15.50" />
        <button onClick={add}>+ Add rate</button>
      </div>
      <Feedback errors={errors} saved={false} />
    </section>
  );
}

function RateRow(props: { rate: GrossRate; canDelete: boolean }) {
  const [from, setFrom] = useState(props.rate.effectiveFrom);
  const [rate, setRate] = useState(String(props.rate.rate));
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    const rec: Partial<GrossRate> = { effectiveFrom: from, rate: parseNum(rate) ?? NaN };
    const errs = validateRate(rec);
    setErrors(errs);
    if (errs.length) return;
    await db.rates.update(props.rate.id!, rec);
    setSaved(true);
  }
  async function remove() {
    if (confirm(`Delete the rate effective ${formatDate(props.rate.effectiveFrom)}?`)) await db.rates.delete(props.rate.id!);
  }

  return (
    <div className="editrow">
      <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setSaved(false); }} />
      <input value={rate} onChange={(e) => { setRate(e.target.value); setSaved(false); }} inputMode="decimal" />
      <span className="muted unit">€/h</span>
      <button onClick={save}>Save</button>
      <button className="danger" onClick={remove} disabled={!props.canDelete} title={props.canDelete ? "" : "Keep at least one rate"}>Delete</button>
      {saved && <span className="saved">✓</span>}
      {errors.length > 0 && <span className="err">{errors[0]}</span>}
    </div>
  );
}

function PayslipsSection(props: { payslips: Payslip[] }) {
  const sorted = sortPayslips(props.payslips);
  const blended = blendedNetFactor(props.payslips);
  const [month, setMonth] = useState("");
  const [gross, setGross] = useState("");
  const [hours, setHours] = useState("");
  const [net, setNet] = useState("");
  const [vacDays, setVacDays] = useState("");
  const [vacHours, setVacHours] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  async function add() {
    const rec: Partial<Payslip> = {
      month,
      totalGross: parseNum(gross) ?? NaN,
      totalHours: parseNum(hours) ?? NaN,
      totalNet: parseNum(net) ?? NaN,
      vacationDays: parseNum(vacDays) ?? undefined,
      vacationHours: parseNum(vacHours) ?? undefined,
    };
    const errs = validatePayslip(rec);
    setErrors(errs);
    if (errs.length) return;
    await db.payslips.add(rec as Payslip);
    setMonth(""); setGross(""); setHours(""); setNet(""); setVacDays(""); setVacHours("");
  }

  return (
    <section>
      <h3>Payslips</h3>
      <p className="hint">
        Each payslip derives that month’s <strong>net factor</strong> = net ÷ gross. Gross is wage only (tips excluded — tips are tax-free).
        Months without a payslip fall back to the blended factor{blended != null ? ` (${(blended * 100).toFixed(1)}%)` : ""}.
      </p>
      <p className="hint">
        The last two boxes are the slip’s <em>vacation</em> lines — leave them blank on a month you
        took none. <strong>Urlaubstage</strong> is what payroll deducted; <strong>Urlaub h</strong> is
        what it paid for them. The hours look redundant but aren’t: dividing them by the days is how
        the app works out the flat hours a vacation day is paid, instead of assuming them — and they’re
        the figure the month’s vacation pay is taken from once the slip exists.
      </p>
      <div className="editrows">
        {sorted.map((p) => (
          <PayslipRow key={p.id} slip={p} />
        ))}
      </div>
      <div className="addrow payslip">
        <input value={month} onChange={(e) => setMonth(e.target.value)} placeholder="2026-04" />
        <input value={gross} onChange={(e) => setGross(e.target.value)} inputMode="decimal" placeholder="gross €" />
        <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" placeholder="hours" />
        <input value={net} onChange={(e) => setNet(e.target.value)} inputMode="decimal" placeholder="net €" />
        <input value={vacDays} onChange={(e) => setVacDays(e.target.value)} inputMode="decimal" placeholder="Urlaubstage" title={'The slip’s “Genommene Urlaubstage” (Lohnart 620). Leave blank if the slip has no vacation line.'} />
        <input value={vacHours} onChange={(e) => setVacHours(e.target.value)} inputMode="decimal" placeholder="Urlaub h" title={'The slip’s “Urlaub” hours (Lohnart 171).'} />
        <button onClick={add}>+ Add payslip</button>
      </div>
      <Feedback errors={errors} saved={false} />
    </section>
  );
}

function PayslipRow(props: { slip: Payslip }) {
  const [month, setMonth] = useState(props.slip.month);
  const [gross, setGross] = useState(String(props.slip.totalGross));
  const [hours, setHours] = useState(String(props.slip.totalHours));
  const [net, setNet] = useState(String(props.slip.totalNet));
  const [vacDays, setVacDays] = useState(props.slip.vacationDays?.toString() ?? "");
  const [vacHours, setVacHours] = useState(props.slip.vacationHours?.toString() ?? "");
  const [disputed, setDisputed] = useState(!!props.slip.vacationDisputed);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const g = parseNum(gross);
  const n = parseNum(net);
  const factor = g != null && n != null && g > 0 ? n / g : payslipNetFactor(props.slip);

  function touched() { setSaved(false); }
  async function save() {
    setSaved(false);
    const rec: Partial<Payslip> = {
      month,
      totalGross: g ?? NaN,
      totalHours: parseNum(hours) ?? NaN,
      totalNet: n ?? NaN,
      // Blank clears the figure back to "no vacation evidence" rather than to zero.
      vacationDays: parseNum(vacDays) ?? undefined,
      vacationHours: parseNum(vacHours) ?? undefined,
      vacationDisputed: disputed || undefined,
    };
    const errs = validatePayslip(rec);
    setErrors(errs);
    if (errs.length) return;
    await db.payslips.update(props.slip.id!, rec);
    setSaved(true);
  }
  async function remove() {
    if (confirm(`Delete the payslip for ${props.slip.month}?`)) await db.payslips.delete(props.slip.id!);
  }

  return (
    <div className="editrow payslip">
      <input value={month} onChange={(e) => { setMonth(e.target.value); touched(); }} />
      <input value={gross} onChange={(e) => { setGross(e.target.value); touched(); }} inputMode="decimal" />
      <input value={hours} onChange={(e) => { setHours(e.target.value); touched(); }} inputMode="decimal" />
      <input value={net} onChange={(e) => { setNet(e.target.value); touched(); }} inputMode="decimal" />
      <input value={vacDays} onChange={(e) => { setVacDays(e.target.value); touched(); }} inputMode="decimal" placeholder="–" title={'Genommene Urlaubstage (Lohnart 620). Blank = this slip carries no vacation evidence.'} />
      <input value={vacHours} onChange={(e) => { setVacHours(e.target.value); touched(); }} inputMode="decimal" placeholder="–" title={'Urlaub hours (Lohnart 171).'} />
      <label
        className="checkbox-row dispute"
        title="Payroll's own vacation count is wrong for this month. The days and pay stay as shown — you were charged them — but the app stops checking its estimate against them."
      >
        <input
          type="checkbox"
          checked={disputed}
          onChange={(e) => { setDisputed(e.target.checked); touched(); }}
        />
        wrong
      </label>
      <span className="muted unit">{factor != null ? `${(factor * 100).toFixed(1)}%` : "—"}</span>
      <button onClick={save}>Save</button>
      <button className="danger" onClick={remove}>Delete</button>
      {saved && <span className="saved">✓</span>}
      {errors.length > 0 && <span className="err">{errors[0]}</span>}
    </div>
  );
}
