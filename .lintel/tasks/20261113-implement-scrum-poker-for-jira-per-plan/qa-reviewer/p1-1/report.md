# QA Review Report — Phase 1 (`p1-1`)

**Verdict:** `approve`  
**Open Findings:** `0` (`0` blocker, `0` major, `0` minor)

---

## Summary

Audited the Phase 1 acceptance test suite (`tests/domain/*.test.ts` and `tests/helpers/domain-errors.ts`) against `shared/requirements.md`, `shared/phase-1/design.md` (`## Test outline`), `shared/phase-1/contract.md`, and the Phase 1 stubs (`src/domain/*.ts`).

Every `## Test outline` item is covered with strong, deterministic assertions in the `unit` test group. All `417` test cases across `4` test files compile cleanly (`tsc --noEmit`), pass Biome lint and formatting checks (`./.lintel/scripts/build.sh` -> `exit 0`), and fail red on behavioral/domain assertions against the unimplemented stubs (`./.lintel/scripts/test-unit.sh` -> `exit 1`, `417` failed / `0` passed).

---

## Test Outline Coverage Matrix

| # | `## Test outline` Entry | Implementing Test Cases | Status |
| :---: | :--- | :--- | :---: |
| 1 | `R1 unit`: `FIBONACCI_DECK` exact 9 cards in canonical order, `NUMERIC_FIBONACCI_SCORES` `[0, 1, 2, 3, 5, 8, 13, 21]`, and `cardToNumericScore` mapping `'0'..'21'` -> `0..21` and `'?'` -> `null` | `tests/domain/deck.test.ts:86-160` (`PokerDomainError` invariants, `FIBONACCI_DECK`, `NUMERIC_FIBONACCI_SCORES`, `cardToNumericScore` valid + runtime invalid, `isNumericDeckCard`) | Covered |
| 2 | `R1 unit`: `validateDeckCard` and `isValidDeckCard` accept 9 canonical deck strings and reject empty, whitespace-padded, negative, decimal, non-Fibonacci integers, arbitrary words, numbers, `null`, and `undefined` with `PokerDomainError` `'validation-error'` | `tests/domain/deck.test.ts:162-181` (`9` valid cards + `35` invalid input partitions) | Covered |
| 3 | `R1 unit`: `validateFibonacciScore` and `isValidFibonacciScore` accept `0, 1, 2, 3, 5, 8, 13, 21` and reject `-0`, `-1`, `4`, `4.5`, `22`, `100`, `NaN`, `±Infinity`, `'?'`, numeric strings, `null`, and `undefined` with `PokerDomainError` `'validation-error'` | `tests/domain/deck.test.ts:183-206` (`8` valid scores with `+0` check + `27` invalid input partitions) | Covered |
| 4 | `R7 unit`: `calculateScoreSummary` includes `'0'` in numeric mean sum and divisor while excluding `'?'` votes and returns all-null score metrics for empty or all-`'?'` card lists | `tests/domain/scoring.test.ts:19-81` (`['0', '2', '?']`, `['0']`, `['0', '8', '?']`, `[]`, `['?']`, `['?', '?', '?']`, plus invalid array/card rejection) | Covered |
| 5 | `R7 unit`: `snapToNearestFibonacci` and `calculateScoreSummary` round upward on all 7 exact Fibonacci midpoints (`0.5 -> 1`, `1.5 -> 2`, `2.5 -> 3`, `4.0 -> 5`, `6.5 -> 8`, `10.5 -> 13`, `17.0 -> 21`) | `tests/domain/scoring.test.ts:83-152` (all 7 exact midpoints in both functions plus `midpoint ± 0.01` neighbors across every interval) | Covered |
| 6 | `R7 unit`: `formatAverage` half-up 1-decimal rounding against canonical decimal representation omitting trailing `'.0'` and grouping separators, `calculateScoreSummary` unrounded-mean snapping before display rounding (`6.49`, `['3', '5', '5']`), and invalid mean rejection (`-0`, negative, non-finite) | `tests/domain/scoring.test.ts:154-228` (`0.04 -> '0'`, `0.05 -> '0.1'`, `2.55 -> '2.6'`, `5.05 -> '5.1'`, `9.95 -> '10'`, `10.05 -> '10.1'`, `17.15 -> '17.2'`, `1234.55 -> '1234.6'`, `6.49` -> `5` / `'6.5'`, `1.45` -> `1` / `'1.5'`, `['3', '5', '5']` -> `'4.3'` / `5`, and `INVALID_MEAN_INPUTS`) | Covered |
| 7 | `R5 unit`: `projectSessionSnapshot` during `'voting'` includes only recorded voters, redacts every participant `card` to `null` with `hasVoted: true`, exposes `viewerCard` solely for `viewerAccountId`, and omits score summary values | `tests/domain/session-view.test.ts:77-181` (observer view + voter view + serialized payload secrecy check) | Covered |
| 8 | `R5 unit`: `projectSessionSnapshot` orders participants by ascending `votedAt` with ascending lexicographical `accountId` tie-breaking, deduplicates repeated `accountId` entries defensively, and normalizes blank/whitespace display names to `FALLBACK_DISPLAY_NAME` (`'Unknown User'`) | `tests/domain/session-view.test.ts:55-75`, `183-330` (UTF-16 `'acc-B' < 'acc-a' < 'acc-z'` tie-break, input immutability, highest-`votedAt` and same-`votedAt` deduplication, `normalizeDisplayName`, `avatarUrl` trimming/nullification) | Covered |
| 9 | `R5 unit`: `projectSessionSnapshot` during `'revealed'` exposes each voter's chosen card (including `'?'`), populates `average`, `formattedAverage`, and `recommendedScore`, and resolves `targetScore` to `meta.overrideScore` (including `0`) or `recommendedScore` | `tests/domain/session-view.test.ts:332-425` (default `recommendedScore`, overrides `0`/`8`/`21`, all-`'?'` null default and `0` override) | Covered |
| 10 | `R9 unit`: `isRoundExpired` and `projectSessionSnapshot` keep rounds active at `86_399_999` ms and negative clock-skew deltas (`nowMs < updatedAt`), expire rounds at `>= 86_400_000` ms, and project `null` or expired rounds as clean idle `'voting'` snapshots | `tests/domain/session-view.test.ts:427-539` (`SESSION_TTL_MS`, `-500 ms`, `0 ms`, `86_399_999 ms`, `86_400_000 ms`, `86_400_001 ms`, `createIdleSessionSnapshot`, `meta === null`, expired `'voting'`/`'revealed'`) | Covered |
| 11 | `R9 unit`: `isRoundExpired`, `createIdleSessionSnapshot`, and `projectSessionSnapshot` reject non-finite timestamps and empty, whitespace-only, or leading/trailing whitespace-padded `viewerAccountId`, `roundId`, or `vote.accountId` values with `PokerDomainError` `'validation-error'` | `tests/domain/session-view.test.ts:541-710` (`NON_FINITE_NUMBERS`, `INVALID_CANONICAL_IDS`, plus malformed `params`, `meta.status`, `meta.overrideScore`, `votes`, and `vote.card`) | Covered |
| 12 | `R10 unit`: `detectStoryPointsField` matches `'Story Points'` and `'  story point estimate '` when `schema.type` is `'number'` (or omitted) and `operations` includes `'set'` (or omitted), returning canonical `fieldName` values | `tests/domain/jira-fields.test.ts:4-98` | Covered |
| 13 | `R10 unit`: `detectStoryPointsField` prioritizes `'Story Points'` over `'Story point estimate'` on the same screen and breaks same-tier ties by ascending lexicographical `fieldId` | `tests/domain/jira-fields.test.ts:100-193` | Covered |
| 14 | `R10 unit`: `detectStoryPointsField` returns `null` without throwing for non-matching names, non-numeric schemas, read-only fields, empty `fields` maps, and `null`, primitive, array, or malformed `editmeta` inputs | `tests/domain/jira-fields.test.ts:195-388` (including `__proto__`/`constructor`/`prototype` and inherited prototype properties) | Covered |
| 15 | `integration: none` | Zero integration test files added | Verified |
| 16 | `e2e: none` | Zero E2E test files added | Verified |

---

## Test Script Execution Results

| Script | Exit Code | Summary |
| :--- | :---: | :--- |
| `./.lintel/scripts/build.sh` | `0` | Manifest zero-egress check, Biome lint (`15` files), Biome format (`15` files), `tsc --noEmit`, and Vite Custom UI production bundle all succeeded cleanly. |
| `./.lintel/scripts/test-unit.sh` | `1` | `tsc --noEmit` succeeded; Vitest collected `4` test files (`417` tests) and failed `417 / 417` on behavioral assertions and `PokerDomainError` checks against the unimplemented stubs (`0` vacuous passes). |
| `./.lintel/scripts/test-integration.sh` | `3` | No integration tests present, matching `integration: none` (`required: false`). |
| `./.lintel/scripts/test-e2e.sh` | `3` | No E2E tests present, matching `e2e: none` (`required: false`). |

---

## Deep Audit & Red-to-Green Gate Checks

- **Zero Stub-Placeholder Assertions:** Negative tests delegate to `expectPokerDomainError(fn, expectedCode)` (`tests/helpers/domain-errors.ts`), verifying `caught instanceof PokerDomainError`, `name === 'PokerDomainError'`, `code === expectedCode`, and a non-empty `message`, ensuring `Error('not implemented')` stubs always fail red (`exit 1`) and compliant domain implementations pass green (`exit 0`).
- **Zero Mocking of Units Under Test:** All suites import and invoke the real contract exports directly from `src/domain/{types,deck,scoring,session-view,jira-fields}.ts`.
- **Post-Lock Execution Safety:** Parametrized cases use isolated `it.each(...)` blocks with fresh immutable fixtures, pure injected `nowMs` timestamps, and zero post-stub dead side-effect calls or state bleed across iterations.
- **Contract Fidelity:** IEEE-754 decimal edge cases (`649 / 100 === 6.49`, `29 / 20 === 1.45`, `10.05` canonical base-10 rounding), UTF-16 code-unit sorting (`'acc-B' < 'acc-a' < 'acc-z'`), `+0` vs `-0` checks, and `projectSessionSnapshot` validation order match `shared/phase-1/contract.md` verbatim.

---

## Scope & Cleanliness Check

- **Added Files (all within `paths.tests.unit`):**
  - `tests/helpers/domain-errors.ts`
  - `tests/domain/deck.test.ts`
  - `tests/domain/scoring.test.ts`
  - `tests/domain/session-view.test.ts`
  - `tests/domain/jira-fields.test.ts`
- **Tracked File Diff (`git diff --name-only`):** Empty (`0` modified production, stub, build, or contract files).
- **Post-Run Working Tree Cleanliness:** Verified via `git status -uall` after executing `build.sh` and `test-*.sh`; zero untracked test artifacts were left in the repository.

---

## Findings Breakdown

No `open`, `fixed`, or `withdrawn` findings (`findings.json` is `[]`).
