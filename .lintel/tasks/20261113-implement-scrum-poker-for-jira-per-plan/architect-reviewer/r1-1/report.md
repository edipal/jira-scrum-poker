# Architect Review Report — Phase 2 (`r1-1`)

## Verdict: `changes`

Phase 2's decomposition, module boundaries, structural dependency-injection seams, per-voter `@forge/kvs` isolation, deterministic `nextRoundId` progression, test outline coverage, and TypeScript stub files are clean and well-structured. One `major` contract gap (`ARC-01`) and one `minor` boundary clarification (`ARC-02`) were identified in `shared/phase-2/contract.md`.

---

## Checklist Verification Summary

1. **Phase Plan (`shared/plan.md`):**
   - Verified `## Phase 1` (delivered, untouched), `## Phase 2` (`Requirements: R1, R2, R3, R4, R5, R6, R8, R9, R10, R11, R14`), and `## Phase 3` (`Requirements: R12, R13, R14`).
   - All 14 requirements (`R1`–`R14`) are cleanly allocated across Phases 1–3 with cohesive, incremental boundaries.

2. **Phase Design & Test Outline (`shared/phase-2/design.md`):**
   - Module dependency graph forms a clean DAG over Phase 1's `src/domain/` with zero browser DOM globals and narrow structural ports (`KvsClientLike`, `RealtimePublishFn`, `JiraRequester`, `ResolverRegistryLike`, `LogSink`, `now`).
   - `## Test outline` strictly adheres to Lintel syntax, covers every requirement allocated to Phase 2 (`R1`, `R2`, `R3`, `R4`, `R5`, `R6`, `R8`, `R9`, `R10`, `R11`, `R14`) under `unit`, references zero out-of-phase requirements or literal test filenames, and includes valid `integration: none` and `e2e: none` declarations matching `.lintel/steering/testing.md`.

3. **Phase Contract (`shared/phase-2/contract.md`):**
   - Contains all required sections (`## Signatures`, `## External interfaces`, `## UI hooks`, `## Data`, `## Stub files`).
   - **Open `major` finding (`ARC-01`):** `storyPointsField` resolution (`jira.getEditableStoryPointsField(issueId)`) is specified for `getSession` and partially for `withdrawVote`, but omitted for `castVote`, `revealVotes`, `selectOverrideScore`, and `resetRound` even though all six return `SessionSnapshot` (`readonly storyPointsField: StoryPointsFieldInfo | null`). See details below.
   - **Open `minor` finding (`ARC-02`):** `sanitizeLogMetadata` plain-object prototype check and root depth index (`0` vs `1`) for the depth-`4` `[TRUNCATED]` cutoff should be made explicit to avoid BVA off-by-one ambiguity.

4. **Code Stubs & Build/Baseline Gates:**
   - All 6 stub files listed in `## Stub files` (`src/observability/logger.ts`, `src/storage/session-store.ts`, `src/realtime/publisher.ts`, `src/jira/jira-client.ts`, `src/resolvers/poker-resolvers.ts`, `src/index.ts`) exist on disk inside `code` paths, match `contract.md` signatures, contain zero premature business logic, and throw `new Error('not implemented')` (with `src/index.ts` exporting `handler = resolver.getDefinitions()` safely so module imports do not throw at load time).
   - Verified `git status` shows no unauthorized file modifications.
   - `./.lintel/scripts/build.sh` passed (`exit 0`: manifest egress check, Biome lint/format, `tsc --noEmit`, and Vite Custom UI bundle).
   - `./.lintel/scripts/test-unit.sh` passed (`exit 0`: all 417 existing Phase 1 unit tests remain green).

---

## Detailed Findings

### `ARC-01` (`major`, `open`) — `shared/phase-2/contract.md :: ## Signatures (5. src/resolvers/poker-resolvers.ts)`

All six session-returning resolver handlers (`getSession`, `castVote`, `withdrawVote`, `revealVotes`, `selectOverrideScore`, `resetRound`) return `Promise<SessionSnapshot>`, where `SessionSnapshot.storyPointsField` is typed as `StoryPointsFieldInfo | null`.

In `contract.md`:
- `getSession` (line 423) states: *"Reads `meta` and `storyPointsField`."*
- `withdrawVote` (line 425) references `storyPointsField` on the idle/expired branch, without stating when `jira.getEditableStoryPointsField(issueId)` is invoked relative to the `'revealed'` state guard.
- `castVote` (line 424), `revealVotes` (line 426), `selectOverrideScore` (line 427), and `resetRound` (line 428) never mention `storyPointsField` or `jira.getEditableStoryPointsField(issueId)`.

This leaves two incompatible interpretations for QA and DEV:
1. If DEV passes `storyPointsField: null` on mutation snapshots while QA asserts `snapshot.storyPointsField` reflects the issue's editable Story Points field (or vice versa on `JiraRequester` call-count expectations), locked tests will fail.
2. Functionally, when the Custom UI panel calls `invoke<SessionSnapshot>('revealVotes')` or `invoke<SessionSnapshot>('selectOverrideScore')` and updates panel state from the returned `SessionSnapshot`, returning `storyPointsField: null` would wipe out Story Points field detection at the exact moment (`status === 'revealed'`) the UI needs it to render **Set Story Points → X** instead of the missing-field warning and **Copy Score (X)** (`R10`, `R11`, `R13`).

**Required fix:**
- Explicitly specify in `contract.md` (and align `design.md` if needed) that all 6 `SessionSnapshot`-returning handlers (`getSession`, `castVote`, `withdrawVote`, `revealVotes`, `selectOverrideScore`, `resetRound`) resolve `storyPointsField` via `jira.getEditableStoryPointsField(issueId)` when building their returned `SessionSnapshot`, **after** host-context validation, payload validation, `invalid-state`, and `precondition-failed` guards succeed (ensuring rejected requests make zero Jira `editmeta` calls).
- Also explicitly state in `castVote` and `withdrawVote` that a voter record returned by `store.getVoterRecord(...)` is treated as active only when `!isRoundExpired(vote.votedAt, nowMs)`.

### `ARC-02` (`minor`, `open`) — `shared/phase-2/contract.md :: ## Signatures (1. src/observability/logger.ts — sanitizeLogMetadata)`

- Line 57 parenthetically defines a plain object as `metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)`, which would accept `new Date()`, `new Error()`, `new Map()`, or `new Set()` as top-level `metadata` rather than throwing `validation-error`. Aligning with `Object.getPrototypeOf(metadata) === Object.prototype || Object.getPrototypeOf(metadata) === null` (already used in `src/domain/jira-fields.ts`) makes plain-object rejection unambiguous.
- Line 58 specifies *"up to depth `4` (replacing deeper nested objects/arrays with `'[TRUNCATED]'`)"*. Explicitly stating that root `metadata` is depth `0`, nested plain objects and arrays at depth `1..4` have their properties/elements recursively sanitized, and any nested plain object or array at depth `> 4` becomes `'[TRUNCATED]'` removes off-by-one ambiguity for boundary-value tests.
