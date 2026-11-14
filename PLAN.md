# Scrum Poker for Jira: Implementation Plan

> **Scope:** Free, ad-free, zero-egress Jira Cloud Scrum Poker plugin built natively on Atlassian Forge (`Runs on Atlassian`). Living specifications live in [`.lintel/specs/index.md`](.lintel/specs/index.md), and product, architectural, and testing standards live in [`.lintel/steering/`](.lintel/steering/).

Each phase below is self-contained and designed to be executed sequentially through Lintel (`lintel-feature` / `lintel task start "<title>"`). Every phase produces testable, modular TypeScript with 100% deterministic unit/component verification before advancing.

---

## Implementation Order

| Phase | Suggested Lintel Task Title | Primary Directories | Target Living Spec |
| :--- | :--- | :--- | :--- |
| **Phase 1** | `Scrum Poker domain rules, Fibonacci rounding, expiry, and Jira field matching` | `src/domain/` | `.lintel/specs/estimation-rules.md` |
| **Phase 2** | `Forge backend resolvers, isolated per-voter KVS storage, realtime sync, and Jira write-back` | `src/resolvers/`, `src/storage/`, `src/jira/`, `src/index.ts`, `manifest.yml` | `.lintel/specs/estimation-session.md` |
| **Phase 3** | `Custom UI Jira issue panel, realtime subscription, score override, and clipboard fallback` | `static/panel/src/` | `.lintel/specs/issue-panel.md` |

---

## Phase 1: Scrum Poker Domain Rules, Fibonacci Rounding, Expiry & Jira Field Matching

### Goal
Implement the pure, framework-free domain types, invariants, score mathematics, redaction projections, round expiration checks, and Jira `editmeta` Story Points field detection under `src/domain/`. Zero `@forge/*` runtime imports so all rules can be shared or mirrored cleanly across backend resolvers and frontend UI state.

### Scope & Deliverables

1. **Deck & Domain Types (`src/domain/deck.ts`, `src/domain/types.ts`):**
   - Fixed Fibonacci deck constant: `['0', '1', '2', '3', '5', '8', '13', '21', '?']` and numeric Fibonacci values `[0, 1, 2, 3, 5, 8, 13, 21]`.
   - Type guards and validators (`isValidCard`, `isNumericCard`, `parseNumericCard`) rejecting arbitrary strings, negative numbers, `NaN`, or non-deck numbers (`4`, `6`, `100`, etc.).
   - Canonical session state types (`RoundStatus`: `'voting' | 'revealed'`, stored `RoundMeta`, stored `VoterRecord`, redacted `ParticipantView`, and `SessionSnapshot` returned to clients).

2. **Score Calculation & Nearest-Fibonacci Snapping (`src/domain/scoring.ts`):**
   - Compute arithmetic mean across numeric votes only (`0..21`), ignoring `?` votes while keeping `?` voters in the participant list.
   - Format display average cleanly (e.g., integer or rounded to 1 decimal place for display alongside exact numeric average).
   - Snap arithmetic mean to the nearest card in `[0, 1, 2, 3, 5, 8, 13, 21]` by minimum absolute difference; on an exact midpoint tie (such as `0.5 -> 1`, `1.5 -> 2`, `2.5 -> 3`, `4.0 -> 5`, `6.5 -> 8`, `10.5 -> 13`, `17.0 -> 21`), round **up** to the higher Fibonacci card.
   - When a revealed round contains **only `?` votes** (zero numeric votes), return `average: null` and `recommendedScore: null` (indicating only **Re-vote** is actionable unless a numeric card is manually selected or re-voted).

3. **Vote Secrecy Redaction & Deterministic Participant Ordering (`src/domain/session-view.ts`):**
   - Build `SessionSnapshot` from `RoundMeta`, `VoterRecord[]`, `viewerAccountId`, `nowMs`, and detected Story Points field info:
     - **While `'voting'`:** Expose `viewerCard` only for `viewerAccountId`; redact every participant's card from `participants[]` (`hasVoted: true`, `card: null`), ordered deterministically (e.g., by `votedAt` ascending with `accountId` tie-breaker).
     - **While `'revealed'`:** Expose every voter's `card` in `participants[]`, include computed `average`, `recommendedScore`, and active `targetScore` (either an explicit post-reveal numeric override if set on `RoundMeta`, or `recommendedScore`).
   - **24-Hour Expiration Check:** `isRoundExpired(meta, nowMs)` returns `true` when `nowMs - meta.updatedAt >= 24 * 60 * 60 * 1000` (`86_400_000` ms). Expired rounds project as clean empty `'voting'` state with zero participants.

4. **Jira `editmeta` Story Points Field Detection (`src/domain/jira-fields.ts`):**
   - Inspect a Jira REST v3 `editmeta` payload (`fields` dictionary) and locate the editable field whose trimmed name matches `'story points'` or `'story point estimate'` (case-insensitive).
   - Deterministic precedence if both exist on an unusual screen: prefer exact `'Story Points'` over `'Story point estimate'`, then lexical field key tie-breaker.
   - Return `{ fieldId: string, fieldName: string } | null` without throwing on missing/malformed `editmeta` objects.

---

## Phase 2: Forge Backend Resolvers, Isolated Per-Voter KVS Storage, Realtime Sync & Jira Write-Back

### Goal
Implement the Atlassian Forge backend (`src/storage/`, `src/jira/`, `src/resolvers/`, `src/index.ts`, and `manifest.yml` resolver wiring) enforcing per-voter KVS key isolation, cursor-paginated reads, 24-hour TTL, `@forge/realtime` live notifications, and `api.asUser()` Jira issue inspection and Story Points updates.

### Scope & Deliverables

1. **Isolated Per-Voter KVS Repository (`src/storage/session-store.ts`):**
   - Key layout scoped by `issueId` from trusted Forge `req.context.extension.issue.id` (never trusting client-supplied `issueId`):
     - Metadata key: `poker:${issueId}:meta` storing `{ roundId, status, overrideScore, updatedAt }`.
     - Per-voter key: `poker:${issueId}:${roundId}:vote:${accountId}` storing `{ accountId, displayName, avatarUrl?, card, updatedAt }`.
   - Every `kvs.set(...)` call passes `{ ttl: { value: 24, unit: 'HOURS' } }`.
   - List all votes for `(issueId, roundId)` via `kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100)` **looping `nextCursor`** until exhausted so teams of any size never lose votes.
   - On `resetRound`, after `applyStoryPoints`, or when `isRoundExpired` is true: advance `roundId` (fresh random/monotonic ID) and delete prior round keys cleanly (best-effort cleanup alongside 24h TTL safety net).

2. **Jira REST v3 User & Issue Adapter (`src/jira/jira-client.ts`):**
   - Resolve current voter profile (`displayName`, optional `avatarUrl`) via `api.asUser().requestJira(route`/rest/api/3/myself`)` (or cache lightly on the voter's record so repeat clicks stay fast).
   - Detect editable Story Points field for the issue via `api.asUser().requestJira(route`/rest/api/3/issue/${issueId}/editmeta`)` combined with Phase 1's `detectStoryPointsField`.
   - Write Story Points via `api.asUser().requestJira(route`/rest/api/3/issue/${issueId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { [fieldId]: score } }) })`.
   - Map `403` / `400` / missing-field outcomes into structured resolver result codes (`{ ok: false, reason: 'missing-field' | 'forbidden' | 'jira-error', message }`) rather than unhandled exceptions.

3. **Realtime Channel Publisher (`src/realtime/publisher.ts`):**
   - Publish lightweight `{ roundId, updatedAt, type }` notifications via `publish('scrum-poker-session', payload)` from `@forge/realtime` after every state-mutating action (`castVote`, `withdrawVote`, `revealVotes`, `overrideScore`, `resetRound`, `applyStoryPoints`). Never broadcast unrevealed card values over the realtime payload; clients re-fetch their caller-scoped `getSession` snapshot (or trigger `view.refresh()` when Story Points are saved).

4. **Forge Resolver Endpoints (`src/resolvers/index.ts`, `src/index.ts`, `manifest.yml`):**
   - `getSession`: Reads metadata + paginated votes, applies 24h expiry check, detects editable Story Points field availability, and returns caller-redacted `SessionSnapshot`.
   - `castVote({ card })`: Validates `card` against deck; if round is `'voting'` (or expired/uninitialized, initializing a fresh round), writes only caller's `poker:${issueId}:${roundId}:vote:${accountId}` key, refreshes `meta.updatedAt`, publishes realtime event, and returns updated `SessionSnapshot`. Clicking the already-selected card (or calling `withdrawVote`) deletes caller's vote key so users can un-vote before reveal.
   - `revealVotes()`: Requires at least 1 vote; transitions `meta.status` to `'revealed'`, publishes realtime event, and returns revealed `SessionSnapshot`.
   - `selectOverrideScore({ score })`: When `'revealed'`, validates numeric Fibonacci `score` (`0..21`), stores `meta.overrideScore = score`, publishes realtime event, and returns updated `SessionSnapshot`.
   - `resetRound()`: Starts a new empty `'voting'` round (`newRoundId`), cleans up previous round keys, publishes realtime event, and returns clean `SessionSnapshot`.
   - `applyStoryPoints({ score })`: Validates numeric Fibonacci `score` (`0..21`); inspects `editmeta` and writes Story Points via `api.asUser()`. When write succeeds, clears the round back to clean idle state, publishes `{ type: 'points-applied', score }` on realtime, and returns `{ ok: true, appliedScore: score, fieldName, session }`. When no editable Story Points field exists, leaves revealed round intact and returns `{ ok: false, reason: 'missing-field', score }` so the UI can warn and offer **Copy Score**.

---

## Phase 3: Custom UI Jira Issue Panel, Realtime Subscription, Score Override & Clipboard Fallback

### Goal
Build the fast, compact, native-feeling Jira issue panel in `static/panel/src/` (React 19 + `@forge/bridge`), supporting Jira light/dark themes automatically, live multi-user updates without polling, one-click post-reveal override, zero-setup Story Points write-back with issue refresh, and clipboard fallback when the Story Points field is absent from the screen.

### Scope & Deliverables

1. **Theme & Bridge Initialization (`static/panel/src/`):**
   - Call `view.theme.enable()` on startup and style with Atlassian Design System CSS tokens (`--ds-surface`, `--ds-text`, `--ds-border`, `--ds-background-brand-bold`, etc.) with sensible fallbacks so light and dark modes look native inside Jira.
   - Wrap `@forge/bridge` (`invoke`, `realtime.subscribe`, `view.refresh`) behind a clean typed client interface (`static/panel/src/bridge/poker-client.ts`) for straightforward component testing.

2. **Voting & Participant Strip UI:**
   - **Deck Row:** Render `0, 1, 2, 3, 5, 8, 13, 21, ?` buttons with clear `aria-pressed` state:
     - During `'voting'`: clicking a card casts/changes your vote; clicking your currently selected card withdraws your vote.
     - During `'revealed'`: clicking any numeric card (`0..21`) selects it as the override target score (`Set Story Points -> X`), while `?` is disabled for override.
   - **Participants List (Voters Only):**
     - Empty state: concise prompt (`Pick a card to start voting`).
     - Hidden `'voting'` state: render each voter chip as `Name ✓` (never leaking cards).
     - Revealed `'revealed'` state: render each voter chip as `Name: <card>`.

3. **Action Controls, Results Summary & Fallback UX:**
   - **While `'voting'`:** Enable **Show Votes** whenever `participants.length >= 1`, plus **Reset** when votes exist.
   - **While `'revealed'`:**
     - Display **Average** (formatted numeric mean) and **Recommended / Selected Fibonacci score** (or `"No numeric votes"` when all votes were `?`).
     - When `storyPointsField` is available and `targetScore !== null`: show primary **Set Story Points → `<targetScore>`** button and secondary **Re-vote** button. On successful apply, call `view.refresh()` so Jira updates the Story Points field on the issue view immediately, and show a brief confirmation banner (`Story Points set to X`) on the cleared idle panel.
     - When all votes are `?` and no numeric override card has been clicked: show **Re-vote** (and prompt that clicking any numeric card enables setting Story Points).
     - When `storyPointsField === null` (neither `Story Points` nor `Story point estimate` is editable on the issue screen) or `applyStoryPoints` returns `'missing-field'`: display a clear inline warning explaining that no editable Story Points field is on this issue screen, and render **Copy Score (`<targetScore>`)** using `navigator.clipboard.writeText(String(targetScore))` (with accessible `"Copied!"` confirmation feedback).

4. **Realtime Multi-User Sync:**
   - Subscribe via `realtime.subscribe('scrum-poker-session', ...)` on mount and clean up (`unsubscribe()`) on unmount.
   - Re-fetch `getSession` automatically when peers vote, reveal, override, or reset; trigger `getSession` + `view.refresh()` when a peer applies Story Points.
