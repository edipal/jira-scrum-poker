# Architect Report — Phase 2 Review Resolution (`r1-2`)

## Summary

Resolved both `architect-reviewer` findings (`ARC-01` and `ARC-02`) for **Phase 2: Forge Backend Resolvers, Per-Voter KVS Storage, Realtime Sync, and Jira Write-Back** without modifying delivered Phase 1 files or `shared/plan.md`.

## Findings Addressed

1. **`ARC-01` (major — fixed):**
   - Explicitly specified in `shared/phase-2/contract.md` and `shared/phase-2/design.md` that all 6 `SessionSnapshot`-returning handlers (`getSession`, `castVote`, `withdrawVote`, `revealVotes`, `selectOverrideScore`, and `resetRound`) resolve `storyPointsField` via `await jira.getEditableStoryPointsField(issueId)` once per non-throwing invocation **strictly after** host-context, payload (`validation-error`), round-state (`invalid-state`), and precondition (`precondition-failed`) guards pass.
   - Confirmed that any rejected handler call performs **zero** `jira` calls (`0` calls to `getEditableStoryPointsField`, `getCurrentUserProfile`, or `updateStoryPoints`), **zero** KVS writes, and **zero** realtime publishes, and that `applyStoryPoints` derives its post-save idle snapshot `storyPointsField` directly from `{ fieldId, fieldName }` returned by `jira.updateStoryPoints(issueId, score)` without a redundant `getEditableStoryPointsField` call.
   - Explicitly stated in both `castVote` and `withdrawVote` that a stored voter record from `store.getVoterRecord(issueId, meta.roundId, accountId)` counts as **active** iff `vote !== null && !isRoundExpired(vote.votedAt, nowMs)` (so an expired voter record neither triggers toggle-off withdrawal in `castVote` nor triggers a delete/update in `withdrawVote`).
   - Updated `## Test outline` in `shared/phase-2/design.md` (`R1`, `R3`, `R6`, `R8`, `R9`, `R10`) to reflect these exact verification boundaries.

2. **`ARC-02` (minor — fixed):**
   - Updated `sanitizeLogMetadata(metadata: unknown): Record<string, unknown>` in `shared/phase-2/contract.md`, `shared/phase-2/design.md`, and `src/observability/logger.ts` to require the strict prototype plain-object check (`Object.getPrototypeOf(metadata) === Object.prototype || Object.getPrototypeOf(metadata) === null`, matching `src/domain/jira-fields.ts`), deterministically throwing `PokerDomainError` (`code: 'validation-error'`) for top-level `Date`, `Error`, `Map`, `Set`, `RegExp`, arrays, `null`, `undefined`, primitives, or class instances.
   - Explicitly anchored the recursion depth counter: root `metadata` is `depth = 0`, nested plain objects and arrays at `depth = 1..4` are sanitized recursively property/element-wise (with sensitive-key redaction applied before value inspection), and nested plain objects/arrays at `depth > 4` (`depth >= 5`) are replaced with `'[TRUNCATED]'`.
   - Updated `R14 unit` in `## Test outline` to cover these BVA checks explicitly.

## Verification

- `./.lintel/scripts/build.sh` — passed (`exit 0`: `manifest.yml` check, `biome lint`, `biome format`, `tsc --noEmit`, `vite build`).
- `./.lintel/scripts/test-unit.sh` — passed (`exit 0`: 417/417 Phase 1 domain tests green).
