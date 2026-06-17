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
import type { GrossRate, Payslip, Settings as SettingsT } from "../lib/types";

export function Settings(props: {
  settings: SettingsT;
  rates: GrossRate[];
  payslips: Payslip[];
  onSettingsSaved: (s: SettingsT) => void;
}) {
  return (
    <div className="settings">
      <GeneralSection settings={props.settings} onSaved={props.onSettingsSaved} />
      <RatesSection rates={props.rates} />
      <PayslipsSection payslips={props.payslips} />
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

function GeneralSection(props: { settings: SettingsT; onSaved: (s: SettingsT) => void }) {
  const s = props.settings;
  const [userName, setUserName] = useState(s.userName);
  const [tipPct, setTipPct] = useState(String(Math.round(s.tipPoolRate * 1000) / 10)); // % form
  const [closingTime, setClosingTime] = useState(s.closingTime);
  const [werktage, setWerktage] = useState(String(s.vacationWerktage));
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    const pct = parseNum(tipPct);
    const wt = parseNum(werktage);
    const next: SettingsT = {
      ...s,
      userName: userName.trim(),
      tipPoolRate: pct == null ? NaN : pct / 100,
      closingTime: closingTime,
      vacationWerktage: wt == null ? NaN : wt,
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
      <p className="hint">Identity, the tip-pool cut, the closing time used when a slot says “Ende”, and the annual vacation entitlement.</p>
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
      </div>
      <div className="row-actions" style={{ marginTop: "0.75rem" }}>
        <button className="primary" onClick={save}>Save general</button>
      </div>
      <Feedback errors={errors} saved={saved} />
    </section>
  );
}

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
  const [errors, setErrors] = useState<string[]>([]);

  async function add() {
    const rec: Partial<Payslip> = {
      month,
      totalGross: parseNum(gross) ?? NaN,
      totalHours: parseNum(hours) ?? NaN,
      totalNet: parseNum(net) ?? NaN,
    };
    const errs = validatePayslip(rec);
    setErrors(errs);
    if (errs.length) return;
    await db.payslips.add(rec as Payslip);
    setMonth(""); setGross(""); setHours(""); setNet("");
  }

  return (
    <section>
      <h3>Payslips</h3>
      <p className="hint">
        Each payslip derives that month’s <strong>net factor</strong> = net ÷ gross. Gross is wage only (tips excluded — tips are tax-free).
        Months without a payslip fall back to the blended factor{blended != null ? ` (${(blended * 100).toFixed(1)}%)` : ""}.
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
      <span className="muted unit">{factor != null ? `${(factor * 100).toFixed(1)}%` : "—"}</span>
      <button onClick={save}>Save</button>
      <button className="danger" onClick={remove}>Delete</button>
      {saved && <span className="saved">✓</span>}
      {errors.length > 0 && <span className="err">{errors[0]}</span>}
    </div>
  );
}
