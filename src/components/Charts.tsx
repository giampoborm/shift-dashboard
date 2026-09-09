// Charts tab — reads the pure aggregations in lib/charts.ts and maps them onto
// recharts. Lazy-loaded from App (recharts is ~heavy) like VacationPlanner.
// Colours are pulled by hand from the styles.css palette so the dark theme holds.

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { byMonth, byType, takeHomeComposition, type VacationPayContext } from "../lib/charts";
import type { GrossRate, Payslip, Settings, Shift, ShiftType } from "../lib/types";

// Mirrors the tokens in styles.css — Recharts wants literal colours, not
// var(). Wage is black and tips are green, exactly as the Home rank bars.
const ACCENT = "#0a0a0a"; // net wage
const GOOD = "#17803d"; // usable tips / tips-per-hour
const VACATION = "#6b2fbf"; // paid vacation — wage-like, but visibly not worked
const GRID = "#e6e6e6";
const MUTED = "#8a8a8e";

/* The sun arc: yellow morning → red midday → blue night. */
const TYPE_COLOR: Record<ShiftType, string> = {
  opening: "#f5c518",
  "late-morning": "#e36414",
  "mid-day": "#d62518",
  "early-closing": "#6b2fbf",
  closing: "#1b4fd8",
  meeting: "#8a8a8e",
};

const SLICE_COLOR: Record<string, string> = {
  "Net wage": ACCENT,
  "Vacation pay": VACATION,
  "Usable tips": GOOD,
};

const eur = (n: number) => `€${n.toFixed(2)}`;
const eur0 = (n: number) => `€${Math.round(n)}`;

const axis = { stroke: MUTED, fontSize: 12 };
const tooltipStyle = {
  background: "#fff",
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  color: "#0a0a0a",
  fontSize: 12,
};
// Pie slice colours live on <Cell>, so the tooltip item's own colour resolves
// to undefined; pin it to the body text colour.
const tooltipItemStyle = { color: "#0a0a0a" };

export function Charts(props: {
  /** PAID shifts in range (worked + sick) — the month aggregations need both; the
   *  per-shift lenses re-filter to strictly worked themselves. */
  shifts: Shift[];
  rates: GrossRate[];
  payslips: Payslip[];
  settings: Settings;
  /** Paid vacation, so a month off doesn't read as a month unpaid. */
  vacation?: VacationPayContext;
}) {
  const { shifts, rates, payslips, settings, vacation } = props;

  const months = useMemo(
    () => byMonth(shifts, rates, payslips, settings, vacation),
    [shifts, rates, payslips, settings, vacation],
  );
  const types = useMemo(
    () => byType(shifts, rates, payslips, settings),
    [shifts, rates, payslips, settings],
  );
  const composition = useMemo(
    () => takeHomeComposition(shifts, rates, payslips, settings, vacation),
    [shifts, rates, payslips, settings, vacation],
  );

  if (!months.length) {
    return <div className="empty">No worked shifts yet — import history.csv to see charts.</div>;
  }

  return (
    <div className="charts">
      <ChartPanel title="Take-home by month" sub="net wage + paid vacation + usable tips, stacked">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={months} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={axis} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={eur0} width={52} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "rgba(148,163,184,0.08)" }}
              formatter={(v: number, n) => [eur(v), n]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="netWage" name="Net wage" stackId="a" fill={ACCENT} radius={[0, 0, 0, 0]} />
            <Bar dataKey="vacationPay" name="Vacation pay" stackId="a" fill={VACATION} radius={[0, 0, 0, 0]} />
            <Bar dataKey="usableTips" name="Usable tips" stackId="a" fill={GOOD} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Tips per hour over time" sub="reported tips ÷ hours worked, per month">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={months} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={axis} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={eur0} width={52} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ stroke: GRID }}
              formatter={(v: number) => [`${eur(v)}/h`, "Tips/h"]}
            />
            <Line
              type="monotone"
              dataKey="tipsPerHour"
              name="Tips/h"
              stroke={GOOD}
              strokeWidth={2}
              dot={{ r: 3, fill: GOOD }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Tips per hour by shift type" sub="which shifts tip best">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={types} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="type" tick={axis} tickLine={false} axisLine={{ stroke: GRID }} interval={0} />
            <YAxis tick={axis} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={eur0} width={52} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "rgba(148,163,184,0.08)" }}
              formatter={(v: number, _n, p) => [`${eur(v)}/h · ${p.payload.shifts} shifts`, "Tips/h"]}
            />
            <Bar dataKey="tipsPerHour" name="Tips/h" radius={[3, 3, 0, 0]}>
              {types.map((t) => (
                <Cell key={t.type} fill={TYPE_COLOR[t.type]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Take-home composition" sub="where the money comes from">
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie
              data={composition}
              dataKey="value"
              nameKey="name"
              innerRadius={55}
              outerRadius={90}
              paddingAngle={2}
              label={(e: { name: string; percent?: number }) =>
                `${e.name} ${Math.round((e.percent ?? 0) * 100)}%`
              }
              labelLine={false}
              stroke="#fff"
            >
              {composition.map((slice) => (
                <Cell key={slice.name} fill={SLICE_COLOR[slice.name] ?? ACCENT} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              itemStyle={tooltipItemStyle}
              formatter={(v: number, n) => [eur(v), n]}
            />
          </PieChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  );
}

function ChartPanel(props: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="chart-panel">
      <div className="chart-head">
        <span className="chart-title">{props.title}</span>
        {props.sub && <span className="chart-sub">{props.sub}</span>}
      </div>
      {props.children}
    </div>
  );
}
