# QA Acceptance Test Report — Phase 1 (`p1-1`)

## Summary

Implemented the Phase 1 acceptance test suite under `tests/` verifying all pure Scrum Poker domain contracts (`src/domain/types.ts`, `src/domain/deck.ts`, `src/domain/scoring.ts`, `src/domain/session-view.ts`, `src/domain/jira-fields.ts`) for requirements **R1**, **R5**, **R7**, **R9**, and **R10**.

All tests compile cleanly (`tsc --noEmit`), pass Biome lint and format gates (`./.lintel/scripts/build.sh` -> `exit 0`), and fail red on behavioral/domain assertions against the Architect's unimplemented stubs (`./.lintel/scripts/test-unit.sh` -> `exit 1`, `417` tests failed out of `417` across `4` test files, with zero false passes on stubs).

---

## Added Test & Support Files

- `tests/helpers/domain-errors.ts` — `expectPokerDomainError(fn, expectedCode)` helper verifying thrown errors are instances of `PokerDomainError` (and `Error`) with `name === 'PokerDomainError'`, exact `code`, and non-empty `message` (preventing false-positive passes against `Error('not implemented')` stubs).
- `tests/domain/deck.test.ts` — `PokerDomainError` invariants, `FIBONACCI_DECK`, `NUMERIC_FIBONACCI_SCORES`, `cardToNumericScore`, `isNumericDeckCard`, `isValidDeckCard`, `validateDeckCard`, `isValidFibonacciScore`, and `validateFibonacciScore` (`R1`).
- `tests/domain/scoring.test.ts` — `calculateScoreSummary`, `snapToNearestFibonacci`, and `formatAverage` (`R7`).
- `tests/domain/session-view.test.ts` — `SESSION_TTL_MS`, `FALLBACK_DISPLAY_NAME`, `normalizeDisplayName`, `isRoundExpired`, `createIdleSessionSnapshot`, and `projectSessionSnapshot` (`R5`, `R7`, `R9`).
- `tests/domain/jira-fields.test.ts` — `detectStoryPointsField` (`R10`).

---

## Coverage Mapping to `## Test outline`

1. **`R1 unit` — `FIBONACCI_DECK`, `NUMERIC_FIBONACCI_SCORES`, and `cardToNumericScore` (`tests/domain/deck.test.ts`)**
   - Verifies `PokerDomainError` subclass invariants across `'validation-error'`, `'invalid-state'`, and `'precondition-failed'`.
   - Verifies `FIBONACCI_DECK` equals `['0', '1', '2', '3', '5', '8', '13', '21', '?']` and `NUMERIC_FIBONACCI_SCORES` equals `[0, 1, 2, 3, 5, 8, 13, 21]`.
   - Verifies `cardToNumericScore` maps `'0'..'21'` to `0..21` (`+0` preserved), maps `'?'` to `null`, and rejects invalid runtime card values with `PokerDomainError` (`code: 'validation-error'`), alongside `isNumericDeckCard` coverage.

2. **`R1 unit` — `validateDeckCard` and `isValidDeckCard` (`tests/domain/deck.test.ts`)**
   - Verifies all 9 canonical deck strings are accepted.
   - Verifies empty strings, whitespace-only strings, leading/trailing/tab-padded strings (`' 5'`, `'5 '`, `' 5 '`, `'\t8'`, `' ? '`), negative strings (`'-1'`, `'-0'`), plus/zero-prefixed strings (`'+5'`, `'05'`), decimals (`'3.5'`, `'5.0'`), non-Fibonacci integers (`'4'`, `'6'`, `'7'`, `'9'`, `'12'`, `'14'`, `'20'`, `'22'`, `'34'`, `'100'`), arbitrary words (`'coffee'`, `'??'`), numbers (`0`, `5`, `21`, `NaN`, `Infinity`), `null`, `undefined`, booleans, arrays, and objects return `false` in `isValidDeckCard` and throw `PokerDomainError` (`code: 'validation-error'`) in `validateDeckCard`.

3. **`R1 unit` — `validateFibonacciScore` and `isValidFibonacciScore` (`tests/domain/deck.test.ts`)**
   - Verifies `0, 1, 2, 3, 5, 8, 13, 21` are accepted (`+0` preserved).
   - Verifies `-0`, `-1`, `-5`, non-Fibonacci integers (`4`, `6`, `7`, `9`, `12`, `14`, `20`, `22`, `34`, `100`), decimals (`0.5`, `4.5`), `NaN`, `Infinity`, `-Infinity`, `'?'`, numeric strings (`'5'`, `'0'`, `''`), `null`, `undefined`, booleans, arrays, and objects return `false` in `isValidFibonacciScore` and throw `PokerDomainError` (`code: 'validation-error'`) in `validateFibonacciScore`.

4. **`R7 unit` — `calculateScoreSummary` `'0'` inclusion, `'?'` exclusion, and empty/all-`'?'` handling (`tests/domain/scoring.test.ts`)**
   - Verifies `['0', '2', '?']` yields `{ numericVoteCount: 2, average: 1, formattedAverage: '1', recommendedScore: 1 }`, `['0']` yields `{ numericVoteCount: 1, average: 0, formattedAverage: '0', recommendedScore: 0 }`, and `['0', '8', '?']` yields `{ numericVoteCount: 2, average: 4, formattedAverage: '4', recommendedScore: 5 }`.
   - Verifies `[]`, `['?']`, and `['?', '?', '?']` return `{ numericVoteCount: 0, average: null, formattedAverage: null, recommendedScore: null }`, and invalid card arrays/elements throw `PokerDomainError` (`code: 'validation-error'`).

5. **`R7 unit` — Upward tie-breaking on all 7 exact Fibonacci midpoints (`tests/domain/scoring.test.ts`)**
   - Verifies both `snapToNearestFibonacci` and `calculateScoreSummary` round upward across all 7 exact midpoints (`0.5 -> 1`, `1.5 -> 2`, `2.5 -> 3`, `4.0 -> 5`, `6.5 -> 8`, `10.5 -> 13`, `17.0 -> 21`), plus `midpoint ± 0.01` boundary checks across every interval.

6. **`R7 unit` — `formatAverage` half-up 1-decimal formatting, unrounded-mean snapping, and invalid mean rejection (`tests/domain/scoring.test.ts`)**
   - Verifies `formatAverage` across integers, repeating decimals, sub-half values, exact `.x5` boundaries, integer carry, and multi-digit values without trailing `'.0'` or grouping separators (`0 -> '0'`, `0.04 -> '0'`, `0.05 -> '0.1'`, `1.5 -> '1.5'`, `2.54 -> '2.5'`, `2.55 -> '2.6'`, `13/3 -> '4.3'`, `14/3 -> '4.7'`, `5 -> '5'`, `5.05 -> '5.1'`, `6.49 -> '6.5'`, `9.94 -> '9.9'`, `9.95 -> '10'`, `10.05 -> '10.1'`, `17.15 -> '17.2'`, `1000 -> '1000'`, `1234.55 -> '1234.6'`).
   - Verifies `calculateScoreSummary` snaps `recommendedScore` from the exact unrounded mean prior to display rounding (`6.49` snaps `recommendedScore: 5` with `formattedAverage: '6.5'`; `1.45` snaps `recommendedScore: 1` with `formattedAverage: '1.5'`; `['3', '5', '5']` yields `formattedAverage: '4.3'` and `recommendedScore: 5`).
   - Verifies `formatAverage` and `snapToNearestFibonacci` reject `-0`, negative values, `NaN`, `±Infinity`, and non-numbers with `PokerDomainError` (`code: 'validation-error'`).

7. **`R5 unit` — `projectSessionSnapshot` vote secrecy during `'voting'` (`tests/domain/session-view.test.ts`)**
   - Verifies non-voting observers are omitted from `participants` and receive `viewerCard: null`, recorded voters all appear with `hasVoted: true` and `card: null` (even for the requesting voter's own row), `viewerCard` exposes only the caller's vote, and `average`, `formattedAverage`, `recommendedScore`, and `targetScore` are all `null`.

8. **`R5 unit` — Deterministic ordering, defensive deduplication, and display-name fallback (`tests/domain/session-view.test.ts`)**
   - Verifies ascending `votedAt` ordering with ascending UTF-16 `accountId` tie-breaking without mutating the input `votes` array.
   - Verifies duplicate `accountId` records retain the highest `votedAt` entry (or later array element on an exact `votedAt` tie).
   - Verifies `normalizeDisplayName` and `projectSessionSnapshot` trim valid display names and normalize empty/whitespace/`null`/`undefined` display names to `FALLBACK_DISPLAY_NAME` (`'Unknown User'`), while trimming or nullifying `avatarUrl`.

9. **`R5 unit` — `projectSessionSnapshot` revealed scores and `targetScore` override resolution (`tests/domain/session-view.test.ts`)**
   - Verifies `'revealed'` snapshots expose every voter's chosen card (including `'0'` and `'?'`), populate `average`, `formattedAverage`, and `recommendedScore` (`null` on all-`'?'` rounds), and resolve `targetScore` to `meta.overrideScore` (explicitly covering `0`, `8`, `21`) when non-null or `recommendedScore` otherwise.

10. **`R9 unit` — 24-hour expiration boundaries (`86_400_000` ms) and idle projections (`tests/domain/session-view.test.ts`)**
    - Verifies `SESSION_TTL_MS === 86_400_000`, `isRoundExpired`, `createIdleSessionSnapshot`, and `projectSessionSnapshot` keep rounds active at `elapsed = 86_399_999` ms, `0` ms, and negative clock-skew deltas (`nowMs < updatedAt`), expire rounds at `elapsed >= 86_400_000` ms, and project `meta === null` or expired `'voting'`/`'revealed'` rounds as clean idle `'voting'` snapshots with `roundId: null`, `0` participants, and `viewerCard: null`.

11. **`R9 unit` — Non-finite timestamp and canonical identifier validation (`tests/domain/session-view.test.ts`)**
    - Verifies `isRoundExpired`, `createIdleSessionSnapshot`, and `projectSessionSnapshot` reject non-finite timestamps (`NaN`, `±Infinity`, non-numbers) and empty, whitespace-only, or leading/trailing whitespace-padded `viewerAccountId`, `roundId`, and `vote.accountId` values (plus malformed `params`, `meta.status`, `meta.overrideScore`, `votes`, and `vote.card`) with `PokerDomainError` (`code: 'validation-error'`).

12. **`R10 unit` — `detectStoryPointsField` matching and canonical `fieldName` normalization (`tests/domain/jira-fields.test.ts`)**
    - Verifies matching for `'Story Points'`, `'  story point estimate '`, and `' \tSTORY POINTS  '` when `schema.type === 'number'` (or `schema`/`schema.type` omitted or `null`) and `operations` includes `'set'` (or `operations` omitted or `null`), returning canonical `'Story Points'` and `'Story point estimate'` labels.

13. **`R10 unit` — `detectStoryPointsField` tier precedence and `fieldId` tie-breaking (`tests/domain/jira-fields.test.ts`)**
    - Verifies `'Story Points'` takes precedence over `'Story point estimate'` regardless of `fieldId` order, breaks same-tier ties by ascending lexicographical `fieldId` (`customfield_10010` before `customfield_10020`), and falls through to `'Story point estimate'` when higher-tier fields are read-only or non-numeric.

14. **`R10 unit` — `detectStoryPointsField` non-matching and malformed `editmeta` resilience (`tests/domain/jira-fields.test.ts`)**
    - Verifies `null` is returned without throwing for `'Story Points Legacy'`, `'Story Point'`, `'Story Points Estimate'`, non-numeric schemas (`'string'`, primitives, arrays), read-only `operations` (`[]`, `['add', 'remove']`, non-arrays), empty `fields` maps, blank/reserved/inherited keys (`__proto__`, `constructor`, `prototype`, `Object.create`), and `null`, `undefined`, primitive, array, or malformed `editmeta` payloads.

15. **Group Exemptions (`integration` & `e2e`)**
    - `integration: none` and `e2e: none` per `shared/phase-1/design.md` (`## Test outline`).

---

## Pre-Lock Verification Results

| Script | Exit Code | Details |
| :--- | :---: | :--- |
| `./.lintel/scripts/build.sh` | `0` | Manifest egress check, Biome lint, Biome format, `tsc --noEmit`, and Vite Custom UI build all passed cleanly. |
| `./.lintel/scripts/test-unit.sh` | `1` | Red-on-Stub verified: `tsc --noEmit` succeeded; Vitest executed `4` test files / `417` tests (`417` failed against unimplemented stubs, `0` false passes). |
