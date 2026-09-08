// The vacation model's self-check, shown ONLY when it has something to say.
//
// It used to render a permanent read-out — a ✓/? badge, the current hours, a
// verdict line, a cross-check line — on every visit. That is noise: when the
// estimate agrees with the payslips there is nothing to do, and a banner you
// can't act on trains you to ignore banners you can. So:
//
//   * agrees, or no payslip records a vacation yet  -> render nothing at all
//   * disagrees                                     -> one line, dismissible
//
// Dismissal is keyed to the SPECIFIC disagreement, not to the component, so
// hiding "8/2026 charged 6, we say 5" stays hidden while that stays true and
// reappears if the numbers move (a new slip, a corrected log, a settings change).
// Per-viewer convenience only — localStorage, wrapped, and the warning renders
// correctly if storage is unavailable.

import { useState } from "react";
import type { Calibration } from "../lib/vacationCharge";

const KEY = "shift-dashboard:calibration-dismissed";
const r1 = (n: number) => Math.round(n * 10) / 10;

/** What is currently wrong, so a dismissal expires when the situation changes. */
function signature(cal: Calibration, dayHours: number): string | null {
  const miss = cal.checks.find((c) => c.eligibleDays > 0 && c.predictedDays !== c.observedDays);
  const hoursDiffer = cal.dayHours != null && Math.abs(cal.dayHours - dayHours) > 0.01;
  if (!miss && !hoursDiffer && !cal.dayHoursConflict) return null;
  return [
    miss ? `${miss.month}:${miss.observedDays}:${miss.predictedDays}` : "",
    hoursDiffer ? `h:${r1(cal.dayHours as number)}` : "",
    cal.dayHoursConflict ? "conflict" : "",
    `w:${r1(cal.weeklyHours)}`,
  ].join("|");
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function CalibrationWarning(props: {
  cal: Calibration;
  dayHours: number;
  /** Offered when the payslips imply a different flat day than the one saved. */
  onApplyDayHours?: (hours: number) => void;
}) {
  const { cal, dayHours } = props;
  const sig = signature(cal, dayHours);
  const [dismissed, setDismissed] = useState(() => read());

  if (sig == null || dismissed === sig) return null;

  const miss = cal.checks.find((c) => c.eligibleDays > 0 && c.predictedDays !== c.observedDays);
  const hoursDiffer = cal.dayHours != null && Math.abs(cal.dayHours - dayHours) > 0.01;

  function hide() {
    try {
      localStorage.setItem(KEY, sig as string);
    } catch {
      /* private window, blocked storage — hiding for this render is enough */
    }
    setDismissed(sig);
  }

  return (
    <div className="hint rule-fit err">
      <button className="rule-fit-close" onClick={hide} title="Dismiss" aria-label="Dismiss">
        ✕
      </button>
      {miss && (
        <span>
          <strong>{miss.month}</strong> charged {miss.observedDays} days, this estimate says{" "}
          {miss.predictedDays}
          {miss.impliedWeeklyHours != null && (
            <>
              {" "}
              — your log averages {r1(cal.weeklyHours)} h/week, the payslip implies{" "}
              {r1(miss.impliedWeeklyHours)}
            </>
          )}
          .
        </span>
      )}
      {cal.dayHoursConflict && <span>Your payslips disagree on the hours a vacation day pays.</span>}
      {hoursDiffer && props.onApplyDayHours && (
        <div className="row-actions">
          <button onClick={() => props.onApplyDayHours?.(cal.dayHours as number)}>
            Pay a day at {r1(cal.dayHours as number)} h
          </button>
        </div>
      )}
    </div>
  );
}
