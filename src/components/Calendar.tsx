// Lightweight month-grid calendar (Monday-start, European). No external calendar
// library — reuses the shift data, tag colours, and the existing ShiftEditor.
// Click a day to add a shift there; click a chip to edit that shift.

import { useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { computeShiftEarnings } from "../lib/earnings";
import { estimateShift } from "../lib/estimates";
import type { GrossRate, Payslip, Settings, Shift, Vacation } from "../lib/types";

const WEEK_HEADERS = ["M", "T", "W", "T", "F", "S", "S"];
const TYPE_SHORT: Record<string, string> = {
  opening: "open",
  "late-morning": "l.morn",
  "mid-day": "mid",
  "early-closing": "e.close",
  closing: "close",
};

export function Calendar(props: {
  shifts: Shift[];
  worked: Shift[];
  settings: Settings;
  rates: GrossRate[];
  payslips: Payslip[];
  vacations?: Vacation[];
  onEditShift: (s: Shift) => void;
  onAddShift: (dateIso: string) => void;
  /** Controlled month cursor — when supplied (Home owns the period), the calendar
   *  reflects it and reports changes via onCursorChange instead of local state. */
  cursor?: Date;
  onCursorChange?: (d: Date) => void;
  /** Hide the calendar's own ‹ › nav when an outer stepper already owns the month. */
  hideNav?: boolean;
}) {
  const { shifts, worked, settings, rates, payslips, vacations, onEditShift, onAddShift } = props;
  const [localCursor, setLocalCursor] = useState(() => startOfMonth(new Date()));
  const cursor = props.cursor ?? localCursor;
  const setCursor = (d: Date) =>
    props.onCursorChange ? props.onCursorChange(d) : setLocalCursor(d);

  const byDate = useMemo(() => {
    const m = new Map<string, Shift[]>();
    for (const s of shifts) (m.get(s.date) ?? m.set(s.date, []).get(s.date)!).push(s);
    return m;
  }, [shifts]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [cursor]);

  function vacationOn(iso: string): Vacation | undefined {
    return vacations?.find((v) => iso >= v.from && iso <= v.to);
  }

  // Per-day take-home and the tip slice of it (worked actuals, else estimated median).
  function dayMoney(list: Shift[]): { takeHome: number; tips: number } {
    let takeHome = 0;
    let tips = 0;
    for (const s of list) {
      if (s.status === "worked") {
        const e = computeShiftEarnings(s, rates, payslips, settings);
        takeHome += e.takeHome;
        tips += e.usableTips;
      } else if (s.status === "planned" || s.status === "swapped-in") {
        const est = estimateShift(s, worked, rates, payslips, settings);
        takeHome += est.takeHome.median;
        tips += est.usableTips.median;
      }
    }
    return { takeHome, tips };
  }

  return (
    <div className="calendar">
      {!props.hideNav && (
        <div className="cal-nav">
          <button onClick={() => setCursor(addMonths(cursor, -1))}>‹</button>
          <strong>{format(cursor, "MMMM yyyy")}</strong>
          <button onClick={() => setCursor(addMonths(cursor, 1))}>›</button>
          <button onClick={() => setCursor(startOfMonth(new Date()))}>Today</button>
        </div>
      )}

      <div className="cal-grid">
        {WEEK_HEADERS.map((d, i) => (
          <div key={i} className="cal-head">{d}</div>
        ))}
        {days.map((d) => {
          const iso = format(d, "yyyy-MM-dd");
          const list = byDate.get(iso) ?? [];
          const money = dayMoney(list);
          const out = !isSameMonth(d, cursor);
          const vac = vacationOn(iso);
          return (
            <div
              key={iso}
              className={`cal-cell${out ? " out" : ""}${isToday(d) ? " today" : ""}${vac ? " vacation" : ""}`}
              onClick={() => onAddShift(iso)}
              title="Add a shift on this day"
            >
              <div className="cal-daynum">{format(d, "d")}</div>
              {vac && (
                <div className="cal-vacation" title={vac.note ?? "vacation"}>
                  vacation{vac.note ? `: ${vac.note}` : ""}
                </div>
              )}
              {list.map((s) => (
                <button
                  key={s.id}
                  className={`cal-chip ${s.shiftType} st-${s.status}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditShift(s);
                  }}
                  title={`${s.station} · ${s.shiftType} · ${s.status}`}
                >
                  {s.plannedStart ?? "?"} {TYPE_SHORT[s.shiftType] ?? s.shiftType}
                </button>
              ))}
              {money.takeHome > 0 && (
                <div className="cal-total">€{Math.round(money.takeHome)}</div>
              )}
              {money.tips > 0 && (
                <div className="cal-tip">tips €{Math.round(money.tips)}</div>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: "0.76rem" }}>
        Solid chip = worked · outlined = planned · struck = swapped. Day total = take-home (worked actuals, else estimated median); <em>tips</em> is the tip slice of it.
      </p>
    </div>
  );
}
