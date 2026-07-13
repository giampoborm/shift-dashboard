// Add / edit / delete a shift, and drive post-shift entry + swaps.
// Re-uses the slot parser so a typed "18:00-Ende" classifies just like an import.

import { useState } from "react";
import { db } from "../lib/db";
import { classifyShiftType, parseTimeSlot, parseTimeToken } from "../lib/shiftTime";
import { rateForDate } from "../lib/earnings";
import type { GrossRate, Settings, Shift, ShiftStatus } from "../lib/types";

const STATUSES: ShiftStatus[] = ["planned", "worked", "swapped-out", "swapped-in"];

export interface EditorPrefill {
  date?: string;
  station?: string;
  slot?: string;
  status?: ShiftStatus;
}

export function ShiftEditor(props: {
  shift: Shift | null; // null => creating a new shift
  prefill?: EditorPrefill;
  rates: GrossRate[];
  settings: Settings;
  stations: string[];
  onClose: () => void;
  onRequestNew: (prefill: EditorPrefill) => void; // chain a replacement after swap-out
}) {
  const { shift, prefill, rates, settings, stations, onClose, onRequestNew } = props;
  const editing = !!shift;

  const initialSlot = shift?.plannedStart
    ? `${shift.plannedStart}-${shift.openEnd ? "Ende" : shift.plannedEnd ?? ""}`
    : prefill?.slot ?? "";

  const [date, setDate] = useState(shift?.date ?? prefill?.date ?? new Date().toISOString().slice(0, 10));
  const [station, setStation] = useState(shift?.station ?? prefill?.station ?? stations[0] ?? "BAR");
  const [slot, setSlot] = useState(initialSlot);
  const [status, setStatus] = useState<ShiftStatus>(shift?.status ?? prefill?.status ?? "planned");
  const [hours, setHours] = useState(
    shift?.actualHours != null ? String(shift.actualHours) : shift?.shiftType === "meeting" ? "2" : "",
  );
  const [tips, setTips] = useState(shift?.tips != null ? String(shift.tips) : "");
  const [notes, setNotes] = useState(shift?.notes ?? "");
  const [isMeeting, setIsMeeting] = useState(shift?.shiftType === "meeting");
  const [error, setError] = useState("");

  function buildRecord(): Omit<Shift, "id"> | null {
    if (!date) {
      setError("Date is required.");
      return null;
    }
    const h = hours.trim() === "" ? undefined : Number(hours);
    if (h != null && !Number.isFinite(h)) {
      setError("Hours must be a number.");
      return null;
    }

    const closingMinutes = parseTimeToken(settings.closingTime) ?? 60;

    // Meeting: logs a real start/end time like any shift, but always classifies as
    // "meeting" (never reclassified from the time slot) and never has tips —
    // obviously, it's a meeting, not floor work.
    if (isMeeting) {
      const parsed = slot.trim() ? parseTimeSlot(slot.trim(), closingMinutes) : null;
      return {
        date,
        station: station.trim() || "BAR",
        shiftType: "meeting",
        plannedStart: parsed?.start ?? shift?.plannedStart,
        plannedEnd: parsed?.openEnd ? undefined : parsed?.end ?? shift?.plannedEnd,
        openEnd: parsed?.openEnd ?? shift?.openEnd ?? false,
        crossesMidnight: parsed?.crossesMidnight ?? shift?.crossesMidnight ?? false,
        status,
        actualHours: h ?? 2,
        tips: undefined,
        grossRate: rateForDate(date, rates) ?? shift?.grossRate,
        notes: notes.trim() || undefined,
        source: shift?.source ?? "manual",
        createdAt: shift?.createdAt ?? new Date().toISOString(),
      };
    }

    const parsed = slot.trim() ? parseTimeSlot(slot.trim(), closingMinutes) : null;
    const shiftType = parsed ? classifyShiftType(parsed) : shift?.shiftType ?? "closing";
    const t = tips.trim() === "" ? undefined : Number(tips);
    if (t != null && !Number.isFinite(t)) {
      setError("Tips must be a number.");
      return null;
    }
    return {
      date,
      station: station.trim() || "BAR",
      shiftType,
      plannedStart: parsed?.start ?? shift?.plannedStart,
      plannedEnd: parsed?.openEnd ? undefined : parsed?.end ?? shift?.plannedEnd,
      openEnd: parsed?.openEnd ?? shift?.openEnd ?? false,
      crossesMidnight: parsed?.crossesMidnight ?? shift?.crossesMidnight ?? false,
      status,
      actualHours: h,
      tips: t,
      grossRate: rateForDate(date, rates) ?? shift?.grossRate,
      notes: notes.trim() || undefined,
      source: shift?.source ?? "manual",
      createdAt: shift?.createdAt ?? new Date().toISOString(),
    };
  }

  async function save(overrideStatus?: ShiftStatus) {
    const rec = buildRecord();
    if (!rec) return;
    if (overrideStatus) rec.status = overrideStatus;
    if (editing && shift!.id != null) await db.shifts.update(shift!.id, rec);
    else await db.shifts.add(rec as Shift);
    onClose();
  }

  async function remove() {
    if (editing && shift!.id != null && confirm("Delete this shift?")) {
      await db.shifts.delete(shift!.id);
      onClose();
    }
  }

  // Mark this shift as given away, then open a blank form for the shift picked up.
  async function swap() {
    if (editing && shift!.id != null) {
      await db.shifts.update(shift!.id, { status: "swapped-out" });
    }
    onRequestNew({ status: "swapped-in", station, date });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{editing ? "Edit shift" : "Add shift"}</h2>

        <label>Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>Station
          <input list="stations" value={station} onChange={(e) => setStation(e.target.value)} />
          <datalist id="stations">{stations.map((s) => <option key={s} value={s} />)}</datalist>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={isMeeting}
            onChange={(e) => {
              const checked = e.target.checked;
              setIsMeeting(checked);
              if (checked) {
                setHours((h) => (h.trim() === "" ? "2" : h));
                setSlot((s) => (s.trim() === "" ? "13:00-15:00" : s));
                setTips("");
              }
            }}
          />
          Meeting <span className="muted">(no tips — paid, not floor work)</span>
        </label>
        <label>Slot <span className="muted">(e.g. 18:00-Ende, 11-18)</span>
          <input value={slot} onChange={(e) => setSlot(e.target.value)} placeholder="18:00-Ende" />
        </label>
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ShiftStatus)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <div className="row2">
          <label>Hours worked
            <input value={hours} onChange={(e) => setHours(e.target.value)} placeholder="6.5" inputMode="decimal" />
          </label>
          {!isMeeting && (
            <label>Tips (€)
              <input value={tips} onChange={(e) => setTips(e.target.value)} placeholder="60" inputMode="decimal" />
            </label>
          )}
        </div>
        <label>Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {error && <p className="err">{error}</p>}

        <div className="modal-actions">
          {editing && status !== "worked" && (
            <button onClick={() => save("worked")} title="Mark worked with the hours/tips above">
              Mark worked
            </button>
          )}
          {editing && <button onClick={swap} title="Give this shift away and add the one you picked up">Swap…</button>}
          {editing && <button className="danger" onClick={remove}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
