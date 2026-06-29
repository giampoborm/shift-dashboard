# Shift Dashboard

## Goal
A local-first personal dashboard for a bar worker to track shifts, tips, and earnings; estimate future income; rate shifts; and optimize vacation timing under German law.

## Stack
- React + Vite + TypeScript, built as a **PWA** (installable on phone for post-shift entry)
- **Dexie** (IndexedDB) for local storage — no backend in v1
- **papaparse** (CSV import/export), **date-fns** (dates), **date-holidays** (German public holidays), **Recharts** (charts, in deps — not yet wired up). Calendar is a **custom Monday-start month grid**, not FullCalendar.

## Status
In progress, **LIVE** at https://shift-dashboard.giampobo.workers.dev/ (Cloudflare Workers Static Assets — see [[deployment]]). Phases 1–5 + Tier 1 + Drive sync + Charts shipped; 47 passing tests.

📋 **Status, roadmap, and decisions live in [`docs/ROADMAP.md`](docs/ROADMAP.md)** — the single source of truth, maintained by the `project-manager` subagent. This `CLAUDE.md` covers *how the code works* (architecture, invariants, conventions); the roadmap covers *what's done / next / why*. Current focus: a **UI/UX redesign** (glance-first + bold visual identity).

## ⚠ This app is LIVE — push, don't just commit
The dashboard is deployed and in **daily real use on the user's PC and phone**. Cloudflare Workers **auto-deploys from GitHub `main`** ([[deployment]]), and cross-device data sync runs through the user's own Google Drive ([[sync-approach]]). Consequences for how to work here:
- **A change is not "done" until it's pushed.** A local commit is invisible to the user — the live site keeps serving the old build until `git push` reaches `main`. So the finish line for any code change is: `/verify` (green) → commit → **push**. Don't leave verified work merely committed.
- This is durable authorization to push on this project (it overrides the global "push only when asked" default) — but only *after* verification passes. Never push a red build or half-finished work to a live, in-use app.
- The OAuth **client ID is not a secret** (ships in JS, gated by authorized JS origins) — fine to commit. But `data/` (real financial CSVs) is gitignored and **never** committed/published.

## ▶ Start here next
See **[`docs/ROADMAP.md`](docs/ROADMAP.md)** for the current focus, what's next, and the decisions log. Ask the `project-manager` subagent for an up-to-date status read.

**Working agreement:** deliver verified work in substantial chunks, not step-by-step approval ([[autonomous-momentum]]); still surface real decisions. Run `/verify` after a chunk; consider the `shift-reviewer` subagent before declaring a feature done.

### Implemented so far
- `src/lib/types.ts` — domain types (Shift, GrossRate, Payslip, Settings, ShiftEarnings).
- `src/lib/earnings.ts` — pure earnings math (rateForDate, netFactorForMonth, computeShiftEarnings, sumEarnings).
- `src/lib/shiftTime.ts` — tolerant time-slot parser + weekday/shiftType derivation.
- `src/lib/importHistory.ts` — history.csv importer; warnings split into `warn` (anomalies) vs `info` (expected CSV cross-check drift).
- `src/lib/importPlan.ts` — plan pivot-grid importer (scans station blocks for userName → planned shifts).
- `src/lib/db.ts` — Dexie schema + seeded defaults (rate table €14.50→€15.50 Apr, 4 real payslips, settings). NOTE: `source` is **not** indexed — filter, don't `.where()`.
- `src/lib/estimates.ts` — future-earnings estimate engine; buckets (morning-weekday/weekend, evening, evening-sunday), p25/median/p75 with bucket→family→all fallback.
- `src/lib/exportCsv.ts` — derived-earnings CSV export + download helper.
- `src/lib/dbSnapshot.ts` — whole-DB snapshot (serialize/apply all 5 tables) + pure content-`hashData` + `resolveSync` merge decision (first-push/in-sync/push/pull/conflict). Tested. `SNAPSHOT_SCHEMA` bumps with the Dexie version.
- `src/lib/driveSync.ts` — Google Drive sync plumbing: lazy GIS script load, in-browser token client (no refresh token), Drive REST against `appDataFolder`, sync metadata in localStorage, `sync()`/`resolveConflict()`/`syncOnOpen()`.
- `src/components/SyncPanel.tsx` — Drive sync section in Settings (client-ID entry, Connect/Sync/Disconnect, conflict guard prompt). Wired into `App.tsx` (silent `syncOnOpen` on mount + status banner; `refreshSettings` after a pull replaces the DB).
- `src/components/ShiftEditor.tsx` — add/edit/delete modal, post-shift entry (planned→worked), swap-out + swapped-in chaining.
- `src/components/Calendar.tsx` — custom Monday-start month grid; type-coloured chips (worked=filled, planned=outline, swapped=struck); click day→add, click chip→edit.
- `src/components/VacationPlanner.tsx` — dual-basis budget bars + range cards; lazy-loaded (isolates heavy `date-holidays`). `src/lib/vacation.ts` — pure vacation math.
- `src/App.tsx` — import buttons, Worked/Planned/All/Calendar/Vacation tabs (Planned+Upcoming were merged), filter bar (type/day/station/date/search), summary + estimate cards, warnings panels, shift + estimate tables.
- Tests: `*.test.ts` next to each lib (run `npm test` or `/verify`).
- Shift types live in [[shift-type-taxonomy]]; estimate buckets in [[tip-estimate-buckets]]; vacation basis in [[vacation-entitlement]] (memory).

### Known data findings
- The history CSV's "stipendio nuovo" estimates were all computed at the **pre-raise €14.50/h**, so April–June rows legitimately differ from hours×actual-rate (surfaced as `info` notes, not errors).
- Rows 33–34 of history.csv: `dom 29` is mis-dated as `March 28` (dup of `sab 28`) — flagged, not auto-fixed.

## Architecture decisions (locked)
- **Local-first, no backend.** Personal financial data stays on device. Manual JSON backup/restore for now; cross-device sync will go through the user's **own Google Drive `appdata` folder** (chosen 2026-06-17 over Supabase — data stays in his account, no new login, no free-tier pause), added later without changing the data layer. See [[sync-approach]]. Free static hosting (Netlify/Vercel/GH Pages) is needed for phone use — a new Tier-1 step.
- **No German payroll engine.** Earnings derived from real data (see model below).
- **Google Calendar sync deferred.** In-app calendar + one-way `.ics` export first; OAuth two-way sync later.
- **Estimates are ranges, not point values** — median + p25/p75 per (shiftType, weekday), because tip variance is high.

## Data model
One **Shift** entity with a lifecycle: `planned → worked (confirmed) → [swapped]`.
```
Shift {
  id, date, weekday(derived)
  station            # BAR, runner, etc. — from the plan block header; affects tips
  shiftType          # derived from time slot (early/late/night)
  plannedStart/End
  status             # planned | worked | swapped-out | swapped-in
  actualHours, tips  # entered after the shift
  grossRate          # snapshot from rate table at shift date
  // derived: grossPay, netPay, usableTips, tipsPerHour, netPerHour, workingDays (1 or 2 if crosses midnight)
}
```
A "shift swap" is `swapped-out` on the old + a new `swapped-in` record — never a delete, so history/ratings stay honest.

## Earnings model
```
GROSS       = hours × grossRate(shift date)            # rate table is authoritative; CSV "salary estimate" = validation only
net_factor(month) = payslip total_net ÷ total_gross    # derived per month from payslips, effective-dated
NET wage    = GROSS × net_factor(period)
usable_tips = reported_tips × (1 − tip_pool_rate)      # tip_pool_rate default 5% (prep-shift cut), configurable
TAKE-HOME   = NET wage (monthly) + usable_tips (paid weekly)
```
- **Tips are tax/SV-free** (§3 Nr. 51 EStG) — never run them through the tax math.
- **Effective-dated gross rate table** handles raises (e.g. rate rose in April 2026) retroactively-correctly.
- Payslip gross is **wage only** (excludes tips); confirmed by user.

## CSV formats
- **Plan CSV**: one file per week, a pivot grid. Row1 = dates, Row2 = weekdays, Col1 = time slot, cells = names. Multiple stacked station blocks (BAR, runners, ...). Import scans all blocks for the user's name ("Gianpaolo"), reading row→time, column→date, block header→station.
  - Tokens: `Ende` = open close (map to configurable closing time for planned estimate); `00:00`/past-midnight = night shift, **2 working days**; `x` / blank = skip.
- **History CSV**: clean, row-per-shift — weekday, date, hours worked, tips, salary estimate (BRUTTO/gross).

## German vacation rule (implemented + for the optimizer)
Contract §8 = **24 Werktage (= 20 Arbeitstage) / year**, pro-rata; basis still TBC with employer ([[vacation-entitlement]]). The calculator shows **two consistent currencies of the same ~4 weeks off — never mix consumption from one with the budget of the other**:
- **Proportional basis (the headline, his reality):** budget = `24 × avgDaysPerWeek / 6` (~16 at his ~3.9 days/week); a vacation costs the *estimated scheduled shifts* in the range (±1σ Bernoulli spread from historical weekday frequency). 16 ÷ 4 = 4 weeks.
- **Werktage basis (paperwork):** Mon–Sat in range minus Berlin public holidays, vs 24. 24 ÷ 6 = 4 weeks.
- ⚠ **For vacation, a midnight-crossing night shift = ONE day, not two** (corrected — you're rostered once). The `workingDays` 1-or-2 rule in the *shift/pay* model is a separate concern; don't carry it into vacation math.

**Optimizer (Tier 2, pending):** slide a window across the calendar, rank by calendar-days-off ÷ scheduled-shifts-spent, snap to bridge public holidays.

## How to add a feature here (conventions)
Follow the grain of the existing code:
1. **Logic before UI.** Put pure, testable logic in `src/lib/<name>.ts` with a co-located `src/lib/<name>.test.ts` (Vitest). Components stay thin and read from those functions.
2. **Heavy deps get lazy-loaded.** Anything large (like `date-holidays`, or future chart/PDF libs) goes behind `React.lazy` + `Suspense` so it stays out of the main bundle — see `VacationPlanner`. Check `npm run build` chunk sizes after adding a dep.
3. **Dexie:** schema in `src/lib/db.ts`. Bump `.version()` and add a migration for new tables/indexes. ⚠ **`source` is NOT indexed — use `.filter()`, never `.where("source")`** (this silently threw and cost us a debugging session). Only `.where()` on declared indexes.
4. **Wire into `App.tsx`** as a tab/panel; reuse `Card`, `.cards`, `.table-wrap`, tag classes from `src/styles.css` (dark theme, CSS-var palette) rather than inventing styles.
5. **Verify** with `/verify` (tests + typecheck/build + dev-server smoke). For anything touching money, the data model, or Dexie, run the `shift-reviewer` subagent before calling it done.

## Invariants — do not break (a reviewer checks these)
- **Tips are tax/SV-free** (§3 Nr. 51 EStG) — never run `tips` through net/tax math; only `usable_tips = tips × (1 − tipPoolRate)`.
- **Rate table is authoritative** for gross; the CSV "salary estimate" is validation only (and was computed at the pre-raise €14.50).
- **Swaps never delete** — `swapped-out` + new `swapped-in`, so history/ratings stay honest.
- **Vacation night shift = 1 day** (see vacation rule above).
- Dexie `.where()` only on indexed fields.

## Notes
- Sample CSVs live in `data/` (gitignored — personal financial data, never publish/commit). Not a git repo yet.
- User identity in plan files: name = "Gianpaolo". Berlin; today's defaults assume 2026.
