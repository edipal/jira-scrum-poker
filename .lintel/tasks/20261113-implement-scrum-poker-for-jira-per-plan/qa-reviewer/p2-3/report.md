# QA Review Report — Phase 2 Amend Cycle (`p2-3`)

## Verdict: `approve`

QA cleanly resolved the JSDOM URL collection-time defect reported by `dev/p2-1` (`--cause tests`) in `tests/backend/observability-and-manifest.test.ts` without weakening any contract or requirement assertion:

- **Defect & Root Cause Verified:** Under Vitest's `jsdom` environment, global `URL` is JSDOM's `URL` constructor rather than Node's `node:url` `URL` class, causing `readFileSync(new URL('../../manifest.yml', import.meta.url), 'utf8')` at module evaluation time to throw `TypeError: The URL must be of scheme file` before any of the `38` tests in `tests/backend/observability-and-manifest.test.ts` could run.
- **Amend Fix Verified:** QA updated `tests/backend/observability-and-manifest.test.ts` (`lines 2, 15`) to import `{ fileURLToPath, URL as NodeURL } from 'node:url'` and pass `fileURLToPath(new NodeURL('../../manifest.yml', import.meta.url))` to `readFileSync(..., 'utf8')`.
- **Full Audit of `tests/backend/observability-and-manifest.test.ts` (`38` tests):** Every assertion aligns strictly with `shared/requirements.md` (`R14`), `shared/phase-2/design.md` (`## Test outline`), and Section 1 of `shared/phase-2/contract.md` (`validatePlatformManifest`, `sanitizeLogMetadata` plain-object prototype check, `depth = 0..4` recursive redaction, `depth > 4` `'[TRUNCATED]'` replacement, nested `Error`/`Date`/`BigInt` handling, and `createBackendLogger` structured JSON emission). Against pre-lock stubs (`Error('not implemented')`), all behavioral assertions fail red (`exit 1` via `expectPokerDomainError` / return-value assertions); against the spec-compliant workspace implementation, all `9` suites (`615` tests) execute and pass (`exit 0`).

Zero `open` findings exist; the amended Phase 2 test suite is ready to re-lock via `lintel amend`.

---

## 1. Test Outline Coverage Matrix

| Outline Item (`shared/phase-2/design.md`) | Implementing Suite(s) | Status |
| :--- | :--- | :--- |
| **R1 `unit` (`castVote` deck & payload validation):** accepts all 9 deck cards (`'0'..'21'`, `'?'`) and rejects empty, whitespace-padded, negative, decimal, non-Fibonacci, arbitrary words, `null`, `undefined`, and missing/non-plain-object payloads with `PokerDomainError('validation-error')` before any KVS/Jira calls | `tests/backend/poker-resolvers.test.ts` (`lines 150-217`) | Covered |
| **R1 `unit` (`selectOverrideScore` & `applyStoryPoints` score validation):** accepts all 8 numeric Fibonacci scores (`0..21`) and rejects `-0`, `-1`, `4`, `4.5`, `22`, `NaN`, `Infinity`, `'?'`, numeric strings, `null`, `undefined`, and missing/non-plain payloads with `PokerDomainError('validation-error')` leaving state intact and making zero Jira calls | `tests/backend/poker-resolvers.test.ts` (`lines 219-346`) | Covered |
| **R2 `unit` (Host context isolation & spoofing defense):** all 7 handlers scope KVS keys & Jira calls strictly to `context.extension.issue.id` and `context.accountId` (including colon-delimited IDs), ignore spoofed payload IDs across Issue A vs Issue B, return idle `'voting'` snapshot on uninitialized issues, and reject invalid/missing/overlong/path-separator identifiers with `'validation-error'` and zero KVS/Jira I/O | `tests/backend/session-store.test.ts` (`lines 23-61`), `tests/backend/poker-resolvers.test.ts` (`lines 350-566`), `tests/backend/forge-sdk-wiring.test.ts` (`lines 130-191`) | Covered |
| **R3 `unit` (`castVote` & `withdrawVote` voting lifecycle):** records initial vote (`1` participant, `viewerCard`, 24h TTL), updates `'5' -> '8'`, removes vote via `withdrawVote` and same-card toggle in `castVote` (`0` participants, `viewerCard: null`), treats stored voter record as active iff `!isRoundExpired(vote.votedAt, nowMs)` (overwriting expired same-card in `castVote`, idempotent `withdrawVote` on absent/expired voter record without mutating `meta` or peers), and rejects `castVote`/`withdrawVote` on active `'revealed'` rounds with `'invalid-state'` and zero Jira calls | `tests/backend/poker-resolvers.test.ts` (`lines 570-715`), `tests/backend/session-store.test.ts` (`lines 127-162`) | Covered |
| **R4 `unit` (Concurrency & `>100`-voter pagination):** concurrent `Promise.all` across 5 participants (active `'voting'`, idle `null -> 'round-1'`, expired `'round-4' -> 'round-5'`) and concurrent update + withdrawal + new vote persist with zero lost updates; cursor pagination across 125 voters returns 100% on `getSession`/`revealVotes` and deletes 100% on `resetRound`/`applyStoryPoints` without mid-scan cursor truncation | `tests/backend/session-store.test.ts` (`lines 63-85`, `219-260`), `tests/backend/poker-resolvers.test.ts` (`lines 717-931`) | Covered |
| **R5 `unit` (Voter-only projection, ordering, `'Unknown User'`, redaction):** snapshots include only active voters ordered by ascending `votedAt` then ascending `accountId`, normalize blank/failed `/rest/api/3/myself` to `'Unknown User'`, redact `participants[i].card` to `null` during `'voting'` with caller-only `viewerCard`, and omit cards/PII from `@forge/realtime` `'scrum-poker'` payloads | `tests/backend/poker-resolvers.test.ts` (`lines 933-1021`), `tests/backend/jira-and-realtime.test.ts` (`lines 15-68`, `114-242`) | Covered |
| **R6 `unit` (`revealVotes` democratic transition & idempotency):** any viewer (including non-voting observers) reveals `'voting'` round with `>= 1` active vote, rejects 0-vote/idle/reset/expired-vote rounds with `'precondition-failed'` and zero Jira calls, and handles repeat/concurrent `revealVotes` on active `'revealed'` rounds idempotently preserving `targetScore` override | `tests/backend/poker-resolvers.test.ts` (`lines 1023-1181`) | Covered |
| **R8 `unit` (`selectOverrideScore` post-reveal override):** allows any viewer on active `'revealed'` round to set shared `targetScore` (`0..21`, including `['3', '8']` overridden to `8` with `recommendedScore: 5`, and all-`'?'` rounds keeping `average`/`recommendedScore` `null`) while preserving votes and publishing `SESSION_UPDATED`, and rejects `'voting'`/idle/expired rounds with `'invalid-state'` and zero Jira calls | `tests/backend/poker-resolvers.test.ts` (`lines 1183-1296`) | Covered (`QAR-001` fixed) |
| **R9 `unit` (`resetRound` & exact 24h expiry boundary):** `resetRound` advances to distinct `roundId` in `'voting'` with `0` participants, deletes prior-round votes, and publishes `SESSION_UPDATED`; rounds remain active at `86_399_999` ms and negative clock skew (`nowMs < updatedAt`) and expire at `>= 86_400_000` ms across `getSession`, `castVote`, `revealVotes`, `selectOverrideScore`, `applyStoryPoints`, and per-voter `votedAt` checks | `tests/backend/poker-resolvers.test.ts` (`lines 1298-1450`, `609-672`), `tests/backend/session-store.test.ts` (`lines 164-217`) | Covered |
| **R10 `unit` (`getEditableStoryPointsField` & 6-handler `storyPointsField`):** inspects `GET /rest/api/3/issue/{issueId}/editmeta` via `api.asUser()`, applies `'Story Points'` > `'Story point estimate'` and `fieldId` tie-breaking, populates `snapshot.storyPointsField` once guards pass across all 6 snapshot handlers (zero Jira calls on guard rejection), and returns `null` cleanly on `401`/`403`, `404`/`500`, malformed JSON, transport errors, or non-matching fields | `tests/backend/jira-and-realtime.test.ts` (`lines 244-373`), `tests/backend/poker-resolvers.test.ts` (`lines 1452-1526`), `tests/backend/forge-sdk-wiring.test.ts` (`lines 155-182`) | Covered |
| **R11 `unit` (`applyStoryPoints` write-back & failure atomicity):** rejects `'voting'`/idle/expired rounds with `'invalid-state'` before Jira calls, writes detected field via `PUT /rest/api/3/issue/{issueId}` as acting user (including `0`), clears round, publishes `'points-applied'`, and returns `{ ok: true, appliedScore, fieldName, session }`, while leaving `'revealed'` round/votes/`targetScore` intact on `'missing-field'`, `'forbidden'`, or `'jira-error'`, and degrades gracefully if realtime `publish` rejects after commit | `tests/backend/jira-and-realtime.test.ts` (`lines 375-472`), `tests/backend/poker-resolvers.test.ts` (`lines 1528-1737`), `tests/backend/forge-sdk-wiring.test.ts` (`lines 130-153`) | Covered |
| **R14 `unit` (`validatePlatformManifest`, `sanitizeLogMetadata`, `createBackendLogger`, redaction):** verifies `manifest.yml` declares `jira:issuePanel` (`'Scrum Poker'`, `'index.handler'`, `'nodejs22.x'`), zero external permissions/URLs, and exact 4 scopes; verifies strict plain-object prototype check, depth `0..4` sanitization and depth `> 4` `'[TRUNCATED]'`, and redaction of unrevealed cards, credentials/tokens, and emails across logs and `/rest/api/3/myself` | `tests/backend/observability-and-manifest.test.ts` (`lines 1-385`), `tests/backend/jira-and-realtime.test.ts` (`lines 93-111`, `204-241`, `449-471`), `tests/backend/poker-resolvers.test.ts` (`lines 1710-1736`) | Covered (JSDOM URL loading fixed) |
| **`integration: none` / `e2e: none`** | Exempted per `shared/phase-2/design.md`; zero `integration` or `e2e` test files added | Respected |

---

## 2. Test Script Execution Results

1. **`./.lintel/scripts/build.sh`:**
   - **Exit code:** `0`
   - **Summary:** `manifest.yml` zero-egress check, `biome lint` (26 files), `biome format` (26 files), `tsc --noEmit`, and `vite build` all passed cleanly.
2. **`./.lintel/scripts/test-unit.sh`:**
   - **Exit code:** `0` (executed in the post-lock amend workspace with Dev's implementation present)
   - **Summary:** `tsc --noEmit` succeeded with `0` errors. Vitest collected and executed all `9` test files (`615` tests total, `0` collection errors, `0` failures), including all `38` tests in `tests/backend/observability-and-manifest.test.ts`. Against the pre-lock Phase 2 stubs (`a968193`), `tests/backend/observability-and-manifest.test.ts` now loads cleanly and fails red (`exit 1`) on its behavioral assertions (`validatePlatformManifest`, `sanitizeLogMetadata`, `createBackendLogger`).

---

## 3. Scope & Cleanliness Check

- **QA amend diff relative to lock commit (`d03431b`):**
  - `tests/backend/observability-and-manifest.test.ts` (modified — `unit` test suite; 2-line `node:url` path resolution fix)
- **Full Phase 2 test diff relative to design commit (`a968193`):**
  - `tests/helpers/domain-errors.ts` (modified — test support helper)
  - `tests/helpers/forge-doubles.ts` (added — test support helper)
  - `tests/backend/observability-and-manifest.test.ts` (added — `unit` test suite)
  - `tests/backend/session-store.test.ts` (added — `unit` test suite)
  - `tests/backend/jira-and-realtime.test.ts` (added — `unit` test suite)
  - `tests/backend/poker-resolvers.test.ts` (added — `unit` test suite)
  - `tests/backend/forge-sdk-wiring.test.ts` (added — `unit` test suite)
- Zero `paths.build` files, contract/design files, or config files were modified by QA during the amend cycle.
- Working tree remained free of untracked test artifacts after executing `./.lintel/scripts/build.sh` and `./.lintel/scripts/test-unit.sh`.

---

## 4. Findings Breakdown

### `QAR-001` (`blocker` — `fixed`)
- **Where:** `tests/backend/poker-resolvers.test.ts:1204-1225`
- **Status:** Carried forward as `fixed` from `p2-2` (untouched and passing in `p2-3`).
