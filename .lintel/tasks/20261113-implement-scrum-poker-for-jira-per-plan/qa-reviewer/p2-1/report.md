# QA Review Report — Phase 2 (`p2-1`)

## Verdict: `changes`

QA's Phase 2 acceptance suite (`tests/backend/*.test.ts` and `tests/helpers/*`) is comprehensive, well-structured, deterministic, and cleanly exercises all 12 `unit` outline requirements against the Phase 2 stubs (`exit 1` on `./.lintel/scripts/test-unit.sh` and `exit 0` on `./.lintel/scripts/build.sh`).

However, auditing post-stub dead code revealed **one `blocker` defect (`QAR-001`)** in `tests/backend/poker-resolvers.test.ts:1204-1223`: an `R8` `selectOverrideScore` test seeds votes `['3', '8']` (mean `5.5`, which snaps to `recommendedScore: 5`, not `8`) and asserts `expect(updatedNumeric.recommendedScore).toBe(8)`. Once Dev implements Phase 2 on top of Phase 1's locked `snapToNearestFibonacci(5.5) === 5`, this assertion will fail and block Dev. Fixing `QAR-001` will make the suite ready to lock.

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
| **R8 `unit` (`selectOverrideScore` post-reveal override):** allows any viewer on active `'revealed'` round to set shared `targetScore` (`0..21`, including all-`'?'` rounds keeping `average`/`recommendedScore` `null`) while preserving votes and publishing `SESSION_UPDATED`, and rejects `'voting'`/idle/expired rounds with `'invalid-state'` and zero Jira calls | `tests/backend/poker-resolvers.test.ts` (`lines 1183-1294`) | **Defect (`QAR-001`)** at `lines 1204-1223` |
| **R9 `unit` (`resetRound` & exact 24h expiry boundary):** `resetRound` advances to distinct `roundId` in `'voting'` with `0` participants, deletes prior-round votes, and publishes `SESSION_UPDATED`; rounds remain active at `86_399_999` ms and negative clock skew (`nowMs < updatedAt`) and expire at `>= 86_400_000` ms across `getSession`, `castVote`, `revealVotes`, `selectOverrideScore`, `applyStoryPoints`, and per-voter `votedAt` checks | `tests/backend/poker-resolvers.test.ts` (`lines 1296-1448`, `609-672`), `tests/backend/session-store.test.ts` (`lines 164-217`) | Covered |
| **R10 `unit` (`getEditableStoryPointsField` & 6-handler `storyPointsField`):** inspects `GET /rest/api/3/issue/{issueId}/editmeta` via `api.asUser()`, applies `'Story Points'` > `'Story point estimate'` and `fieldId` tie-breaking, populates `snapshot.storyPointsField` once guards pass across all 6 snapshot handlers (zero Jira calls on guard rejection), and returns `null` cleanly on `401`/`403`, `404`/`500`, malformed JSON, transport errors, or non-matching fields | `tests/backend/jira-and-realtime.test.ts` (`lines 244-373`), `tests/backend/poker-resolvers.test.ts` (`lines 1450-1524`), `tests/backend/forge-sdk-wiring.test.ts` (`lines 155-182`) | Covered |
| **R11 `unit` (`applyStoryPoints` write-back & failure atomicity):** rejects `'voting'`/idle/expired rounds with `'invalid-state'` before Jira calls, writes detected field via `PUT /rest/api/3/issue/{issueId}` as acting user (including `0`), clears round, publishes `'points-applied'`, and returns `{ ok: true, appliedScore, fieldName, session }`, while leaving `'revealed'` round/votes/`targetScore` intact on `'missing-field'`, `'forbidden'`, or `'jira-error'`, and degrades gracefully if realtime `publish` rejects after commit | `tests/backend/jira-and-realtime.test.ts` (`lines 375-472`), `tests/backend/poker-resolvers.test.ts` (`lines 1526-1735`), `tests/backend/forge-sdk-wiring.test.ts` (`lines 130-153`) | Covered |
| **R14 `unit` (`validatePlatformManifest`, `sanitizeLogMetadata`, `createBackendLogger`, redaction):** verifies `manifest.yml` declares `jira:issuePanel` (`'Scrum Poker'`, `'index.handler'`, `'nodejs22.x'`), zero external permissions/URLs, and exact 4 scopes; verifies strict plain-object prototype check, depth `0..4` sanitization and depth `> 4` `'[TRUNCATED]'`, and redaction of unrevealed cards, credentials/tokens, and emails across logs and `/rest/api/3/myself` | `tests/backend/observability-and-manifest.test.ts` (`lines 1-384`), `tests/backend/jira-and-realtime.test.ts` (`lines 93-111`, `204-241`, `449-471`), `tests/backend/poker-resolvers.test.ts` (`lines 1708-1734`) | Covered |
| **`integration: none` / `e2e: none`** | Exempted per `shared/phase-2/design.md`; zero `integration` or `e2e` test files added | Respected |

---

## 2. Test Script Execution Results

1. **`./.lintel/scripts/build.sh`:**
   - **Exit code:** `0`
   - **Summary:** `manifest.yml` zero-egress check, `biome lint`, `biome format`, `tsc --noEmit`, and `vite build` all passed cleanly.
2. **`./.lintel/scripts/test-unit.sh`:**
   - **Exit code:** `1` (Red-on-Stub verified)
   - **Summary:** `tsc --noEmit` succeeded (`0` compile errors). Vitest ran `9` test files (`577` tests): all `4` Phase 1 domain suites passed (`417` tests), and all `5` Phase 2 backend suites failed against unimplemented stubs (`159` failed behavioral tests, `0` import/syntax errors, `0` assertions matching stub `'not implemented'` messages).

---

## 3. Scope & Cleanliness Check

- **Changed/added files relative to `HEAD` (`a968193`):**
  - `tests/helpers/domain-errors.ts` (modified — test helper)
  - `tests/helpers/forge-doubles.ts` (untracked — test helper)
  - `tests/backend/observability-and-manifest.test.ts` (untracked — unit test)
  - `tests/backend/session-store.test.ts` (untracked — unit test)
  - `tests/backend/jira-and-realtime.test.ts` (untracked — unit test)
  - `tests/backend/poker-resolvers.test.ts` (untracked — unit test)
  - `tests/backend/forge-sdk-wiring.test.ts` (untracked — unit test)
- Zero production files (`src/**`), stub files, contract/design files, or build configs were modified.
- Working tree remained completely clean of stray build or test artifacts after running `./.lintel/scripts/build.sh` and `./.lintel/scripts/test-unit.sh`.

---

## 4. Findings Breakdown

### `QAR-001` (`blocker` — `open`)
- **Where:** `tests/backend/poker-resolvers.test.ts:1204-1223` (and comment at `line 1185`)
- **Context:** In `describe('R8: Post-reveal consensus override via selectOverrideScore')` -> `it('allows any viewer to override targetScore on numeric and all-"?" revealed rounds while preserving votes and recommendedScore')`, the test seeds two votes `'3'` and `'8'`.
  - Arithmetic mean: `(3 + 8) / 2 = 5.5`.
  - Per `src/domain/scoring.ts` (`snapToNearestFibonacci`) and `shared/requirements.md` R7/R8 AC1, the midpoint between `5` and `8` is `6.5`; because `|5.5 - 5| = 0.5 < |5.5 - 8| = 2.5`, `snapToNearestFibonacci(5.5)` evaluates to **`5`**, not **`8`**.
  - `shared/requirements.md` R8 AC1 states: *"Given a `'revealed'` round with votes `['3', '8']` (`recommendedScore: 5`, `targetScore: 5`), When any viewer selects override score `8`, Then `targetScore` becomes `8` for all viewers while `recommendedScore` remains `5` and recorded votes remain `['3', '8']`."*
  - Currently, lines 1204–1223 pass `payload: { score: 5 }` and assert `expect(updatedNumeric.recommendedScore).toBe(8)` (which is masked during `test-unit.sh` because `createBackendTestHarness()` throws `'not implemented'` earlier on line 70).
- **Required Change:** Update the override call to `payload: { score: 8 }` and assert `expect(updatedNumeric.targetScore).toBe(8)`, `expect(updatedNumeric.recommendedScore).toBe(5)`, `expect(updatedNumeric.average).toBe(5.5)`, and `expect(peerView.targetScore).toBe(8)` (updating the comment on line 1185 accordingly).
