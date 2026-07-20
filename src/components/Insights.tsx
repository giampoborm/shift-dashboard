// Insights — worker-facing readouts of the shift history that the raw tables and
// charts don't make obvious. Two cards, each backed by a pure function in
// lib/insights.ts:
//   • True €/hour by shift kind (which shifts are actually worth wanting — the
//     signal behind the preferences you get to express before a roster is set)
//   • Tip-drift watch (recent vs prior tips/hour, to catch a quiet decline)
// These stand on full history, independent of the range tabs above the charts.

import { useMemo } from "react";
import { effectiveHourlyByBucket, tipTrend } from "../lib/insights";
import type { GrossRate, Payslip, Settings, Shift } from "../lib/types";

const eur = (n: number) => `€${n.toFixed(2)}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;

export function Insights(props: {
  worked: Shift[];
  rates: GrossRate[];
  payslips: Payslip[];
  settings: Settings;
}) {
  const { worked, rates, payslips, settings } = props;

  const hourly = useMemo(
    () => effectiveHourlyByBucket(worked, rates, payslips, settings),
    [worked, rates, payslips, settings],
  );
  const trend = useMemo(() => tipTrend(worked), [worked]);

  const maxPerHour = hourly.length ? Math.max(...hourly.map((r) => r.perHour)) : 0;
  const comparable = trend.filter((t) => t.comparable);
  const flagged = comparable.filter((t) => t.significant);

  return (
    <div className="insights">
      {/* 1 — True €/hour of your life, per shift kind. */}
      <div className="card insight">
        <div className="label">True €/hour by shift</div>
        <div className="sub">Net wage + usable tips, blended over hours actually worked.</div>
        {hourly.length === 0 ? (
          <p className="muted">No worked shifts with hours yet.</p>
        ) : (
          <div className="rank">
            {hourly.map((r) => (
              <div className="rank-row" key={r.bucket}>
                <div className="rank-head">
                  <span className="rank-name">{r.label}</span>
                  <span className="rank-val">{eur(r.perHour)}<span className="per">/h</span></span>
                </div>
                <div className="rank-bar" style={{ width: `${(r.perHour / maxPerHour) * 100}%` }}>
                  <span
                    className="seg wage"
                    style={{ flexGrow: r.wagePerHour, flexBasis: 0 }}
                    title={`wage ${eur(r.wagePerHour)}/h`}
                  />
                  <span
                    className="seg tips"
                    style={{ flexGrow: r.tipsPerHour, flexBasis: 0 }}
                    title={`tips ${eur(r.tipsPerHour)}/h`}
                  />
                </div>
                <div className="rank-foot muted">
                  wage {eur(r.wagePerHour)} + tips {eur(r.tipsPerHour)} · {r.n} shifts
                </div>
              </div>
            ))}
            <div className="rank-legend muted">
              <span><span className="dot wage" /> wage</span>
              <span><span className="dot tips" /> tips</span>
            </div>
          </div>
        )}
      </div>

      {/* 6 — Tip-drift watch, per bucket. */}
      <div className="card insight">
        <div className="label">Tip drift watch</div>
        <div className="sub">Reported tips/hour — last 8 weeks vs the 8 before, by bucket.</div>
        {trend.length === 0 ? (
          <p className="muted">No worked shifts with tips yet.</p>
        ) : (
          <>
            {comparable.length > 0 && flagged.length === 0 && (
              <p className="muted" style={{ marginTop: 0 }}>No significant drift — your tip rate is holding.</p>
            )}
            {comparable.length === 0 && (
              <p className="muted" style={{ marginTop: 0 }}>Baselines still building — comparisons appear once a bucket has 8 weeks on both sides.</p>
            )}
            <div className="drift">
              {trend.map((t) => (
                <div className={`drift-row ${t.significant ? t.direction : "flat"}`} key={t.scope}>
                  <span className="drift-name">{t.label}</span>
                  <span className="drift-nums muted">
                    {t.priorN > 0 ? `${eur(t.priorTph)} → ` : ""}{eur(t.recentTph)}/h
                  </span>
                  {t.comparable && t.pct !== null ? (
                    <span className={`drift-delta ${t.significant ? t.direction : ""}`}>
                      {pct(t.pct)}
                      {t.significant && t.direction === "down" ? " ⚠" : ""}
                    </span>
                  ) : (
                    <span className="drift-note">{t.priorN < 3 ? "baseline building" : "sparse"}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
