# Architect Report (`r0-1`)

## Summary

Translated the approved requirements (`R1`–`R14` in `shared/requirements.md`) into a three-phase delivery plan (`shared/plan.md`) and authored the detailed Phase 1 architectural design (`shared/phase-1/design.md`), technical contract (`shared/phase-1/contract.md`), and compilable TypeScript stubs under `src/domain/`.

## Phase Breakdown (`shared/plan.md`)

1. **Phase 1 — Scrum Poker Domain Rules, Fibonacci Scoring, Expiry, and Jira Field Matching (`R1, R5, R7, R9, R10`):**
   - Pure, stateless, framework-free domain layer in `src/domain/` with zero `@forge/*`, React, or browser DOM dependencies.
   - Covers canonical 9-card Fibonacci deck membership and strict allowlist card/score validation (`R1`), arithmetic mean, half-up 1-decimal display formatting, and exact unrounded nearest-Fibonacci snapping with upward midpoint tie-breaking (`R7`), 24-hour inactivity expiry (`86_400_000` ms) with injectable reference clock (`R9`), voter-only participant projection with deterministic ordering, display-name fallback, and pre-reveal card redaction (`R5`), and zero-config Jira `editmeta` Story Points field detection (`R10`).
2. **Phase 2 — Forge Backend Resolvers, Per-Voter KVS Storage, Realtime Sync, and Jira Write-Back (`R1, R2, R3, R4, R5, R6, R8, R9, R10, R11, R14`):**
   - Atlassian Forge backend (`src/storage/`, `src/jira/`, `src/realtime/`, `src/resolvers/`, `src/index.ts`, `manifest.yml`) enforcing authenticated host context scoping, per-voter KVS key isolation, full cursor-paginated reads/cleanup across `>100` voters, democratic reveal/override/reset state transitions, `@forge/realtime` live notifications without unrevealed card leakage, user-attributed `api.asUser()` Jira Story Points write-back with failure atomicity, and `Runs on Atlassian` zero-egress compliance.
3. **Phase 3 — Custom UI Jira Issue Panel, Live Synchronization, Score Override, and Clipboard Fallback (`R12, R13, R14`):**
   - React 19 Custom UI issue panel (`static/panel/src/`) with `view.theme.enable()` Light/Dark token styling, `realtime.subscribe` live updates and `unsubscribe` cleanup, `view.refresh()` on Story Points application, accessible `aria-pressed` deck buttons, post-reveal numeric consensus override, and missing-field inline warning with clipboard **Copy Score** fallback.

## Phase 1 Contract Surface & Architectural Decisions

- **Strict Acyclic Module Graph:** `src/domain/types.ts` <- `src/domain/deck.ts` <- `src/domain/scoring.ts` <- `src/domain/session-view.ts`, and `src/domain/types.ts` <- `src/domain/jira-fields.ts`.
- **Typed Domain Error Carrier (`PokerDomainError`):** Distinguishes domain rejections (`code: 'validation-error' | 'invalid-state' | 'precondition-failed'`) from stub `Error('not implemented')` exceptions so negative QA tests fail red (`exit 1`) during `lintel lock` and pass green (`exit 0`) once implemented.
- **Deterministic Clock & Locale-Independent Ordering:** `isRoundExpired` and `projectSessionSnapshot` require explicit `nowMs: number` inputs, and tie-breakers use UTF-16 code-unit comparison (`<` / `>`) rather than locale-dependent `localeCompare`.
- **Canonical Story Points Field Labels:** `detectStoryPointsField` normalizes matched labels to `'Story Points'` (tier `0`) or `'Story point estimate'` (tier `1`), prioritizes `'Story Points'` over `'Story point estimate'`, breaks same-tier ties by ascending `fieldId`, and returns `null` safely on malformed or non-matching payloads.

## Stub Files Created

- `src/domain/types.ts`
- `src/domain/deck.ts`
- `src/domain/scoring.ts`
- `src/domain/session-view.ts`
- `src/domain/jira-fields.ts`

## Verification

- Executed `./.lintel/scripts/build.sh` (`manifest.yml` zero-egress check, `biome lint`, `biome format`, `tsc --noEmit`, and `vite build`): exited `0` with zero warnings or errors.
