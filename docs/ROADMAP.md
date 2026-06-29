# Shift Dashboard — Roadmap & Status

**This file is the single source of truth for project status.** What's done, what's
in progress, what's next, and why. The `project-manager` subagent maintains it;
humans and other agents read it. `CLAUDE.md` holds *how the code works* (architecture,
invariants, conventions) and points here for *what's happening*.

Convention: dates are absolute (YYYY-MM-DD). When something ships, move it from
**Doing** → **Done** with the date. Log non-obvious choices in **Decisions**.

Last reconciled with git: 2026-06-21 (HEAD `171613f`).

---

## 🔵 Now / Doing — UI/UX redesign

The app works and is in daily use. Goal: rebalance toward effortless capture, a glance-first
present, and stronger foresight — plus a deliberately **unusual, cooler visual identity**.

Status: **conceptual model locked (2026-06-19); structural skeleton shipped (2026-06-19,
commit `23bde81`) — the old 6 flat tabs are gone, replaced by 3 rooms (Home / Analysis /
Tools) + an ever-present **+ Log** + a ⚙ Settings gear. **Home is functionally done** (see
Done section). **Analysis and Tools exist as working scaffolds, not finished rooms** — their
per-room internals still need to be planned. Aesthetic pass not started.

### The grammar (v1) — agreed redesign foundation

**Thesis.** The dashboard exists to **convert scattered shift-and-tip reality into financial
clarity and foresight — so an irregular, tip-driven income feels controllable.** Loop:
**CAPTURE → CLARITY → FORESIGHT → OPTIMIZE.** Today the app is ~80% "Clarity" shown flat; the
redesign rebalances toward capture + a glance-first present + foresight/optimize.

**One master control: the period you're looking at.** Everything is a view of a chosen slice of
time. "Time filtering" and "the calendar" are the *same mechanism* — the month-stepper IS the filter.

**One automatic rule for money:** worked shift → *actual* take-home; planned shift → *estimate*.
Past/present/future are **not modes you detect** — the actual-vs-estimate blend falls out of shift
status by itself. Past month = all-worked (pure actuals); future = all-planned (pure estimate);
current = mixed (banked + projected = total). One rule, all three cases.

**Three rooms + one ever-present action** (replacing today's six flat equal tabs):
1. **Home** — a month at a time (steppable ‹ ›): the calendar grid + that month's money summary
   (actual / banked+projected / estimate, automatically per the rule above). Above it, a
   **today-anchored next-shift card** that always shows the genuine next real shift from *today*
   and never changes when you step the viewed month. Charts deliberately do **not** live here
   (one month is too sparse for trends).
2. **Analysis** — a **range** (3/6/12/custom), one room, two altitudes of the *same* data:
   **Graphs** (primary — patterns + the "non-obvious insight" that's the real differentiator:
   misallocation, pace vs last month, pay/fatigue tradeoff if ratings added, hidden patterns)
   over **Table** (the substrate — the existing shift rows; "show me the underlying numbers").
   Graphs lead, table is the drill-down — *not peers.* Filterable by type/station/etc. The
   existing ShiftTable + summary cards get **rescoped into this room, not discarded.**
3. **Tools** — vacation calculator + shift optimizer (tucked away; the optimizer is "the only part
   that makes you money, not just reports it").
- **+ Log** — capture, reachable from anywhere, **instantly updates Home**. Capture is the
  *enabler, never a destination*; design law: near-zero friction AND immediately rewarding
  (log → watch the month number tick up on the same surface). The glance and the log surface
  should be the same place, closing the loop.

**The spine: the prediction engine.** Powers three things at once — current-month projection (Home),
next-month planning (Foresight), and the optimizer ("is this shift worth grabbing?" = the engine
asked about one shift). Invest once, pays off three times. It already does the honest thing — ranges
(p25/median/p75) + a ⚠ on thin samples — the right foundation given limited history; "make it quite
fine" is a goal.

**Priority hierarchy (most → least important to the core need):**
1. **Frictionless capture** — foundational; currently the weakest link relative to its importance.
2. **The glance** — this month's take-home (banked + projected); the emotional core = the home screen.
3. **Foresight you can act on** — "can I afford it / what's coming / next-month plan."
4. **Optimize** — which shifts to grab + when to vacation (biggest untapped value).
5. **Supporting cast / power-tools** — tables, filters, CSV export, raw charts, dual-basis vacation
   math: keep, but demote from front-and-center.

**Consistent grain ("zoom" metaphor):** Home = life at month-altitude; Analysis graphs = data at
high altitude (patterns); Analysis table = same data on the ground (rows). One body of data viewed
at different altitudes recurs throughout.

### Still open (next planning steps)
- **Analysis room internals** — currently a scaffold (range selector 3/6/12/All + graphs-over-table,
  reusing existing Charts/ShiftTable). The "non-obvious insight" surface — misallocation, pace vs
  last month, hidden patterns — is **not yet designed**, only the container exists.
- **Tools room internals** — currently a scaffold (bulk CSV import + warnings, vacation calculator,
  an **optimizer placeholder card** with no logic). Needs real design, and the optimizer itself
  needs implementing (see Tier 2 below).
- **Aesthetic north star** — unusual/cooler visual identity. Candidates floated: receipt/bar-tab
  monospace · big-number/calm · neo-brutalist/editorial · keep current dark theme. **Not yet chosen.**
  Deliberately deferred — structure shipped first, skin comes after.

---

## 🟡 Up next (Tier 2 — make the data talk)

- **Vacation optimizer** — inverse of the calculator: "I want ~7 days off in August → which
  window costs the fewest scheduled shifts and bridges the most public holidays?" Slide a
  window across the calendar, rank by calendar-days-off ÷ scheduled-shifts-spent, snap to holidays.
- **Station (BAR vs runner) as a tip signal** — candidate new bucket dimension for the estimate
  engine; needs a data check first to confirm station actually moves tips before building it.

## ⚪ Backlog (Tier 3 — nice-to-have)

- **`.ics` export** (one-way calendar feed). Then, much later, deferred Google Calendar two-way sync.
- **PWA icon PNGs** — still placeholders. User supplies `public/icon-source.png` →
  `npm run generate-pwa-assets` → push.
- **Per-night event-foresight flag** (e.g. tag the first-Thursday music night, World Cup match
  nights) to anticipate an *unusually busy single night*. Deliberately deferred 2026-06-21 —
  not worth it for monthly accuracy (see Decisions log), only useful later for per-night foresight.

---

## 🟢 Done

- **Prediction engine: recency weighting + fixed monthly band aggregation** (2026-06-21,
  commit `171613f`, pushed, LIVE; 95 tests pass, `shift-reviewer` → ship) — real history showed
  evening tip medians drifting down (Feb €67.5 → May €50) while the engine pooled all history
  equally and over-estimated (~€57 vs recent ~€50–53). Added exponential age-decay weighting:
  `recencyWeight(date, asOf, halfLifeDays)` + `weightedQuantile()` in `src/lib/estimates.ts`;
  new `Settings.recencyHalfLifeDays` (default 45, 0 = old equal-weight behavior) with UI control +
  validation; `getSettings()` now merges over `DEFAULT_SETTINGS` so the live install back-fills the
  field with no Dexie migration. Applies to the tip range only — wage math untouched. Also fixed a
  `sumEstimates` bug: monthly p25/p75 was summing per-shift bands linearly (overstates spread);
  now centre = Σ medians, band half-widths combine in quadrature (~√n, not n), tips clamped ≥ 0.
- **Redesign: Home room + structural skeleton** (2026-06-19, commit `23bde81`, LIVE) — the locked
  grammar v1 IA is implemented structurally (aesthetics deliberately deferred). 6 flat tabs →
  3 rooms (Home / Analysis / Tools) + ever-present **+ Log** + ⚙ Settings gear. **Home is real and
  working**: single month stepper owns the period (Calendar nav suppressed in this view),
  today-anchored next-shift card (independent of the viewed month), and month money cards
  (take-home hero + gross/net/tips) each with an automatic banked-vs-projected split that adapts
  to past/current/future months per the one-rule model. New `src/lib/period.ts` (isInMonth /
  shiftsInMonth / nextShiftFrom), `sumEstimates` extended to aggregate gross + usable tips,
  `Calendar` takes optional controlled cursor + `hideNav`. 88 tests pass.
- **Tier 2 — Charts** (2026, commit `e874394`) — monthly take-home, tips/h trend, tips by type,
  composition pie. recharts lazy-loaded. `src/components/Charts.tsx`.
- **Tier 1.5 — Google Drive sync** (2026-06-18, LIVE on PC + phone) — cross-device sync via the
  user's own Drive `appDataFolder`; whole-file newer-wins + conflict guard; silent pull/push on open
  + manual "Sync now". `dbSnapshot.ts` (pure, tested) + `driveSync.ts` (GIS token client, no backend)
  + `SyncPanel.tsx`. See [[sync-approach]].
- **Tier 1 — PWA + Settings + Deploy** (LIVE) —
  installable/offline PWA (`vite-plugin-pwa`); editable Settings (rates/payslips/general,
  Dexie-backed); deployed on **Cloudflare Workers Static Assets**, auto-deploys from GitHub `main`.
  See [[deployment]].
- **Phases 1–5** — data model; history + plan CSV importers; shift table + rich filtering;
  CSV export; earnings/stats; 5-type taxonomy + families; estimate engine (p25/median/p75 buckets) +
  Planned tab; shift editor (post-shift entry / add / edit / delete) + swap; custom calendar month
  view; vacation calculator (dual-basis); dd.MM.yyyy dates. 47 passing tests.

---

## 📋 Decisions log

- **2026-06-21** — **Deferred the exceptional-night flag idea** (tag event nights like the
  first-Thursday music night / World Cup matches to down-weight them). Data check: dropping the
  top 3 outlier nights moved the evening median by only ~€2 — the median is already robust to
  outliers, so it's not worth building for *monthly* accuracy. Re-surface later only if the goal
  becomes *per-night foresight* ("next Thursday is the music night, expect more").
- **2026-06-19** — **Redesign structural skeleton shipped** (commit `23bde81`, pushed, LIVE) —
  implemented the locked grammar v1 structurally: 6 flat tabs collapsed into 3 rooms
  (Home / Analysis / Tools) + ever-present **+ Log** + ⚙ Settings. **Home is functionally
  complete** (month stepper, today-anchored next-shift card, automatic banked/projected money
  cards) — treated as done, not just scaffolding. **Analysis and Tools are working scaffolds
  only** — containers exist (range selector + graphs/table; bulk import + vacation + optimizer
  placeholder) but their per-room internals were deliberately left unplanned for a follow-up
  pass. Aesthetic skin intentionally not started.
- **2026-06-19** — **Redesign conceptual model ("grammar v1") locked** — see *Now / Doing*. Key
  calls: (a) start from structure/IA, skin later; (b) **time-period is the app's master control**,
  the calendar = the time filter; (c) **actual-vs-estimate money falls out of shift status
  automatically** — no past/present/future modes; (d) collapse 6 flat tabs into **3 rooms
  (Home / Analysis / Tools) + an ever-present Log**; (e) **next-shift card is today-anchored**,
  not tied to the viewed month; (f) Analysis = one room, **graphs over table** (table is the
  substrate, not a peer), existing table/cards rescoped not discarded; (g) the **prediction
  engine is the shared spine** (powers current-month projection, next-month plan, optimizer).
  *Still open:* aesthetic north star + per-room internals.
- **2026-06-19** — Adopted this file as single source of project status, owned by a new
  `project-manager` subagent (can read everything + update this tracker; never edits app source).
  Roadmap migrated out of `CLAUDE.md` to here.
- **2026-06-19** — Decided the next major effort is a **UI/UX redesign** (glance-first + bold
  visual identity), prioritized over the remaining Tier 2/3 features.
- **2026** — Charts tab shipped (Tier 2 item 1 of 2).
- **2026-06-18** — Drive sync confirmed working on both devices. Mobile gotcha: GIS popup blanks in
  the standalone PWA / with iOS cross-site-tracking blocking — connect from a normal browser tab.
- **2026-06-17** — Cross-device sync via user's **own Google Drive appdata** (not Supabase): data
  stays in his account, no new login, no free-tier pause. See [[sync-approach]].
- **(locked)** Local-first, no backend · no German payroll engine (earnings derived from real data) ·
  Google Calendar two-way sync deferred · estimates are ranges not point values. See `CLAUDE.md`.

## ❓ Open questions

- Redesign **aesthetic north star** + **Analysis/Tools room internals** (see
  **Now / Doing → Still open**). Structure/IA is resolved and shipped; Home is done.
- Vacation entitlement counting basis still TBC with employer — see [[vacation-entitlement]].
