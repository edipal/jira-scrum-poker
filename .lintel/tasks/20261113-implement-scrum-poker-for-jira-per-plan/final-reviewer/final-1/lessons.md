# Lessons Learned — Scrum Poker for Jira (`20261113-implement-scrum-poker-for-jira-per-plan`)

## 1. Recommendations for Living Specifications (`.lintel/specs/`)

- **Bootstrap Living Domain Specs via `lintel-specs`:**
  - `.lintel/specs/index.md` currently holds its initial pre-implementation placeholder ("No behavioral specs have been populated yet...").
  - Now that `R1`–`R14` are delivered and verified, run `lintel-specs` to populate `.lintel/specs/index.md` and create the three domain capability specs envisioned in `.lintel/steering/structure.md`:
    1. `.lintel/specs/estimation-rules.md` — Modified Fibonacci deck (`0..21, ?`), exact rational mean vs. half-up 1-decimal display formatting, upward-midpoint Fibonacci snapping from the unrounded mean, 24-hour (`86,400,000` ms) inactivity expiration, and two-tier Story Points field matching (`'Story Points'` then `'Story point estimate'`).
    2. `.lintel/specs/estimation-session.md` — Host-derived `(issueId, accountId)` isolation, per-voter KVS key layout (`poker:${issueId}:${roundId}:vote:${accountId}`), deterministic `roundId` progression, >100-voter cursor pagination, vote-secrecy redaction, open democratic reveal, post-reveal target score override, and atomic `api.asUser()` Jira write-back.
    3. `.lintel/specs/issue-panel.md` — Custom UI issue panel states (`voting`, `revealed`, post-save banner, missing-field fallback), `@forge/bridge` `realtime.subscribe('scrum-poker')` synchronization with mutation-epoch staleness guards and per-round `view.refresh()` deduplication, Light/Dark ADS CSS tokens, ARIA semantics, and clipboard fallback behavior.

---

## 2. Recommendations for Project Steering (`.lintel/steering/`)

- **Update `.lintel/steering/product.md` ("Current Scope"):**
  - Move the Scrum Poker issue panel, Forge backend resolvers, KVS storage, Jira REST v3 Story Points detection/write-back, and realtime synchronization from the **Planned** section into **Implemented today** so future tasks do not treat the core product as unbuilt.
- **Update `.lintel/steering/structure.md` ("Current Source Layout"):**
  - Promote the delivered module layout (`src/domain/`, `src/observability/`, `src/storage/`, `src/realtime/`, `src/jira/`, `src/resolvers/`, `src/index.ts`, `static/panel/src/bridge/`, `static/panel/src/clipboard/`, `static/panel/src/App.tsx`, `static/panel/src/main.tsx`, `static/panel/src/styles.css`, and `static/assets/icon.svg`) from "Planned Source Layout" to the authoritative current layout.

---

## 3. Recommendations for Reusable Skills (`.agents/skills/forge-testing/SKILL.md`)

Two QA lock/amend cycles occurred across Phases 2 and 3 (`29e7bc47` in Phase 2 and `f4ed477a` in Phase 3). Adding the following four concrete guardrails to `.agents/skills/forge-testing/SKILL.md` will prevent identical amend cycles in future Forge + Vitest `jsdom` tasks:

1. **Node `fs` + `import.meta.url` under Vitest `jsdom`:**
   - In Vitest's `jsdom` environment, global `URL` is provided by `jsdom`/`whatwg-url` rather than Node's native `node:url` `URL`, causing `readFileSync(new URL('...', import.meta.url), 'utf8')` to throw `ERR_INVALID_ARG_TYPE`. Always convert module-relative paths via `fileURLToPath(new NodeURL('...', import.meta.url))` imported explicitly from `node:url`.
2. **Asserting "No Client Polling" alongside `@testing-library/dom` (`findBy*` / `waitFor`):**
   - `@testing-library/dom`'s `waitFor` (and every `findBy*` query) internally calls `setInterval(checkRealTimersCallback, ...)` to probe whether fake timers are active. Instead of asserting `expect(setIntervalSpy).not.toHaveBeenCalled()`, filter out calls where `typeof handler === 'function' && handler.name === 'checkRealTimersCallback'` so assertions strictly check application timers.
3. **Global Stubs & Red-Phase Lock Invariants (`vi.unstubAllGlobals()`):**
   - Never place `vi.unstubAllGlobals()` at the bottom of an individual case. During Lintel's lock gate (when production stubs throw before the end of the case), trailing cleanup lines do not run, leaking stubbed globals (such as `navigator`) into subsequent cases in the same file. Always register `vi.unstubAllGlobals()` inside `afterEach`.
4. **Lazy `@forge/bridge` Dynamic Imports & Static Source Scans:**
   - When production adapters load `@forge/bridge` via lazy dynamic `import('@forge/bridge')`, await subscription readiness with `vi.waitFor(...)` rather than a single `await Promise.resolve()` microtask tick, and stub `window.__bridge` before evaluating `main.tsx` if exercising unmocked bridge code paths in `jsdom`.
   - When regex-scanning source files to enforce `import type` boundaries, strip block and line comments (`/* ... */` and `// ...`) and anchor at line start (`^\s*(?:import|export)`) so JSDoc examples mentioning `import ... from` do not trigger false positives.

---

## 4. Patterns That Worked Well

- **Three-Phase Hexagonal Split (Domain $\rightarrow$ Backend Ports/Resolvers $\rightarrow$ Custom UI Panel):**
  - Isolating pure math, session projection, TTL boundaries, and Jira field matching in Phase 1 (`src/domain/`) allowed Phase 1 to pass QA and DEV on the first round with zero amendments, and kept Phase 2 resolvers thin and declarative.
- **Deterministic Round Advancement (`nextRoundId`):**
  - Computing the next round ID deterministically (`1` when uninitialized, `meta.roundId + 1` when expired) instead of generating random UUIDs eliminated split-brain round creation when multiple voters simultaneously cast the first vote on an idle or expired issue.
- **Exact Base-10 `BigInt` Display Formatting Paired with Unrounded Snapping:**
  - Separating `formatAverage` (exact integer scaling `sum * 20 >= divisor` for half-up tenths) from `snapToNearestFibonacci` (exact `2 * sum` vs `(low + high) * count` midpoint comparisons) avoided IEEE-754 binary rounding drift on edge cases like `[5, 5, 5, 8, 8, 8, 13, ?]` (`6.49` mean $\rightarrow$ `'6.5'` display, `5` snapped recommendation).
- **Dual UI Concurrency Guards (`mutationEpochRef` + `handledPointsAppliedRoundIdsRef`):**
  - Combining a monotonically increasing mutation epoch with fetch sequence tracking and bounded round-ID deduplication cleanly prevented both stale `getSession` race overwrites and duplicate `view.refresh()` calls when RPC responses raced against `@forge/realtime` events.
