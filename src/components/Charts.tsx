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
import { byMonth, byType, takeHomeComposition } from "../lib/charts";
import type { GrossRate, Payslip, Settings, Shift, ShiftType } from "../lib/types";

const ACCENT = "#38bdf8"; // net wage
const GOOD = "#4ade80"; // usable tips / tips-per-hour
const GRID = "#334155";
const MUTED = "#94a3b8";

const TYPE_COLOR: Record<ShiftType, string> = {
  opening: "#7dd3fc",
  "late-morning": "#38bdf8",
  "mid-day": "#fcd34d",
  "early-closing": "#fb923c",
  closing: "#c4b5fd",
};

const eur = (n: number) => `€${n.toFixed(2)}`;
const eur0 = (n: number) => `€${Math.round(n)}`;

const axis = { stroke: MUTED, fontSize: 12 };
const tooltipStyle = {
  background: "#0f172a",
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  color: "#e2e8f0",
  fontSize: 12,
};
// Pie slice colours live on <Cell>, so the tooltip item's own colour resolves to
// undefined and the text renders near-black (invisible on the dark panel). Force it.
const tooltipItemStyle = { color: "#e2e8f0" };

export function Charts(props: {
  worked: Shift[];
  rates: GrossRate[];
  payslips: Payslip[];
  settings: Settings;
}) {
  const { worked, rates, payslips, settings } = props;

  const months = useMemo(
    () => byMonth(worked, rates, payslips, settings),
    [worked, rates, payslips, settings],
  );
  const types = useMemo(
    () => byType(worked, rates, payslips, settings),
    [worked, rates, payslips, settings],
  );
  const composition = useMemo(
    () => takeHomeComposition(worked, rates, payslips, settings),
    [worked, rates, payslips, settings],
  );

  if (!worked.length) {
    return <div className="empty">No worked shifts yet — import history.csv to see charts.</div>;
  }

  return (
    <div className="charts">
      <ChartPanel title="Take-home by month" sub="net wage + usable tips, stacked">
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
            <Bar dataKey="usableTips" name="Usable tips" stackId="a" fill={GOOD} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel title="Tips per hour over time" sub="reported tips ÷ hours, per month">
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

      <ChartPanel title="Take-home composition" sub="wage vs tips, all worked shifts">
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
              stroke="#0f172a"
            >
              {composition.map((s) => (
                <Cell key={s.name} fill={s.name === "Usable tips" ? GOOD : ACCENT} />
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
