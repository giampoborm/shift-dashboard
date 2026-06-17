---
description: Run the full verification pipeline (tests → typecheck/build → smoke) and report pass/fail
---

Verify the current state of the Shift Dashboard. Run these in order and report a concise PASS/FAIL summary for each — do not stop at the first failure unless it blocks the next step.

1. **Tests** — `npm test` (Vitest, `vitest run`). All tests must pass. If any fail, show the failing test names and the assertion, then diagnose.
2. **Typecheck + build** — `npm run build` (this runs `tsc -b` then `vite build`). Must exit 0. After it succeeds, note the **main bundle gzip size** and flag any chunk that ballooned — heavy deps (e.g. `date-holidays`) must stay in their own lazy-loaded chunk, not the main bundle.
3. **Smoke test** — start the dev server in the background (`npm run dev`), find the port it chose (Vite increments from 5173 if taken), `curl` it expecting HTTP 200, then stop the server. Skip this only if step 2 failed.

Report format: one line per step (✅/❌ + the key number — test count, gzip KB, HTTP code). If everything passes, say so plainly. If something failed, lead with what broke and the likely cause — don't bury it.

$ARGUMENTS
