// The payslip-check popup behind Home's red "!" badge: what the logged shifts say
// the month's wage should be, side by side with the real payslip, plus the switch
// that makes the month card show the slip's brutto/netto instead. Deliberately NOT
// the standard modal — no dimmed backdrop, thick black frame (see .recon-pop).

import { format } from "date-fns";
import { db } from "../lib/db";
import type { Reconciliation } from "../lib/reconcile";

const eur = (n: number) => `€${n.toFixed(2)}`;
const signedEur = (n: number) => `${n < 0 ? "−" : "+"}€${Math.abs(n).toFixed(2)}`;
const signedH = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)}h`;

export function ReconcilePopup(props: { recon: Reconciliation; onClose: () => void }) {
  const { recon, onClose } = props;
  const slip = recon.slip;
  const monthLabel = format(new Date(slip.month + "-01T00:00"), "MMMM yyyy");

  async function setUseSlip(v: boolean) {
    if (slip.id != null) await db.payslips.update(slip.id, { useSlipTotals: v });
    onClose();
  }

  const off = recon.discrepant;
  const hoursOff = Math.abs(recon.deltaHours) > 0.25;

  return (
    <div className="recon-pop-wrap" onClick={onClose}>
      <div className="recon-pop" role="dialog" aria-label={`Payslip check ${monthLabel}`}
        onClick={(e) => e.stopPropagation()}>
        <h2>Payslip check — {monthLabel}</h2>

        <div className="recon-grid">
          <span />
          <span className="h">logged</span>
          <span className="h">payslip</span>
          <span className="h">Δ</span>

          <span className="k">hours</span>
          <span className="num">{recon.loggedHours.toFixed(1)}</span>
          <span className="num">{slip.totalHours.toFixed(1)}</span>
          <span className={`delta ${hoursOff ? "off" : ""}`}>{signedH(recon.deltaHours)}</span>

          <span className="k">brutto</span>
          <span className="num">{eur(recon.derivedGross)}</span>
          <span className="num">{eur(slip.totalGross)}</span>
          <span className={`delta ${off ? "off" : ""}`}>{signedEur(recon.deltaGross)}</span>

          <span className="k">netto</span>
          <span className="num">{eur(recon.derivedNet)}</span>
          <span className="num">{eur(slip.totalNet)}</span>
          <span className={`delta ${off ? "off" : ""}`}>{signedEur(recon.deltaNet)}</span>
        </div>

        <p className="recon-note">
          "Logged" is your {recon.loggedShifts} worked shift{recon.loggedShifts === 1 ? "" : "s"} ×
          the rate table; netto uses this slip's own net factor. A gap means the hours disagree —
          a missed shift, payroll counting differently, or a correction/bonus on the slip.
        </p>

        {slip.useSlipTotals ? (
          <>
            <p className="recon-note"><strong>This month currently shows the payslip amounts.</strong></p>
            <div className="recon-actions">
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={() => setUseSlip(false)}>Use logged amounts</button>
            </div>
          </>
        ) : (
          <div className="recon-actions">
            <button onClick={onClose}>Keep logged</button>
            <button className="primary" onClick={() => setUseSlip(true)}
              title="Home shows this slip's brutto/netto for the month">
              Use payslip amounts
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
