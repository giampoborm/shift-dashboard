// The vacation model's self-check, shown ONLY when it has something to say.
//
// It used to render a permanent read-out — a ✓/? badge, the current hours, a
// verdict line, a cross-check line — on every visit. That is noise: when the
// estimate agrees with the payslips there is nothing to do, and a banner you
// can't act on trains you to ignore banners you can. So:
//
//   * agrees, or no payslip records a vacation yet  -> render nothing at all
//   * disagrees                                     -> two lines, dismissible
//
// It does NOT blame the shift log. Either side can be off — the log, or payroll's
// own arithmetic — so the box states both figures and offers the two real
// resolutions rather than picking one:
//
//   ✕                     hide it; I'll look when the next slip lands
//   "Payroll miscounted"  record that THIS slip is the wrong one
//
// The second is the one that actually happened first time out: for 8/2026 the
// manager's own message counted 9 days away for an 8-day trip. Marking it stops
// the app grading itself against a wrong answer key, and is stored on the payslip
// (so it syncs across devices) rather than in localStorage.
//
// When the slips instead look like they use the CONTRACT week rather than the real
// one (see `impliedIsContractual`) the box says so, because that is a different
// explanation with a different fix — and one no single payslip can confirm.
//
// Dismissal is keyed to the SPECIFIC disagreement, not to the component, so hiding
// "8/2026 charged 6, we say 5" stays hidden while that stays true and reappears if
// the numbers move. That is also what makes "we'll check again with the next
// payslip" work by itself: a new slip is a new signature, so the box comes back
// with the new evidence in it instead of waiting to be remembered.
// Per-viewer convenience only — localStorage, wrapped, and the warning renders
// correctly if storage is unavailable.

import { useState } from "react";
import type { Calibration } from "../lib/vacationCharge";

const KEY = "shift-dashboard:calibration-dismissed";
const r1 = (n: number) => Math.round(n * 10) / 10;

/** What is currently wrong, so a dismissal expires when the situation changes. */
function signature(cal: Calibration, dayHours: number): string | null {
  const hoursDiffer = cal.dayHours != null && Math.abs(cal.dayHours - dayHours) > 0.01;
  if (cal.misses.length === 0 && !hoursDiffer && !cal.dayHoursConflict) return null;
  return [
    ...cal.misses.map((c) => `${c.month}:${c.observedDays}:${c.predictedDays}`),
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
  /** Mark a month's slip as payroll's own miscount, so it stops being evidence. */
  onDispute?: (month: string) => void;
}) {
  const { cal, dayHours } = props;
  const sig = signature(cal, dayHours);
  const [dismissed, setDismissed] = useState(() => read());

  if (sig == null || dismissed === sig) return null;

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
    <div className="rule-fit err">
      <button className="rule-fit-close" onClick={hide} title="Dismiss" aria-label="Dismiss">
        ✕
      </button>

      {cal.misses.map((c) => (
        <span key={c.month} className="rule-fit-miss">
          <span>
            <strong>{c.month}</strong>: payroll charged {c.observedDays} days, this estimate says{" "}
            {c.predictedDays}.
          </span>
          {props.onDispute && (
            <button
              onClick={() => props.onDispute?.(c.month)}
              title="Record that payroll's own count was wrong for this month, so the app stops checking itself against it. The days and pay stay as the slip shows — you were charged them."
            >
              Payroll miscounted
            </button>
          )}
        </span>
      ))}

      {cal.misses.length > 0 && cal.impliedWeeklyHours != null && (
        <span className="rule-fit-body">
          {cal.impliedIsContractual ? (
            <>
              Your slips price a vacation at ~{r1(cal.impliedWeeklyHours)} h/week — that's your{" "}
              <strong>contract week</strong> ({r1(cal.entitlementWeeklyHours ?? 0)} h), not the{" "}
              {r1(cal.weeklyHours)} h you actually average. Payroll may simply cost time off at
              the contract rate.
            </>
          ) : (
            <>
              Your slips price a vacation at ~{r1(cal.impliedWeeklyHours)} h/week; your log
              averages {r1(cal.weeklyHours)}. One of the two is off and one payslip can't say
              which.
            </>
          )}{" "}
          Open until your next payslip with vacation figures — this re-checks itself then.
        </span>
      )}

      {cal.dayHoursConflict && (
        <span className="rule-fit-body">
          Your payslips disagree on the hours a vacation day pays.
        </span>
      )}

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
