# Issue Estimation Session & Story Points Sync Specification

## Scope and Domain Concepts

Defines the stateful lifecycle of per-issue estimation rounds, authenticated host context isolation, concurrent per-voter persistence, open democratic reveal and reset transitions, post-reveal shared target score overrides, live session event notifications, user-attributed Story Points write-back, and host platform containment `[20261113-implement-scrum-poker-for-jira-per-plan]`.

Deterministic card validation, numeric average/snapping math, participant sorting, and Story Points field qualification rules are governed by [estimation-rules.md](estimation-rules.md). Interactive panel rendering, live client subscriptions, and clipboard fallback UX are governed by [issue-panel.md](issue-panel.md).

### Domain Entities and Actors
- **Estimation Session:** The active or idle estimation state strictly bound to one host issue (`issueId`), comprising round status (`'voting'` or `'revealed'`), monotonic/unique `roundId`, `updatedAt` activity timestamp, active participant votes, optional post-reveal `targetScore` override, and caller-scoped `storyPointsField` availability `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R3, R8, R10]`.
- **Authenticated Viewer:** Any authenticated host-platform user viewing the issue; identified exclusively from the authenticated host context (`accountId`) rather than client-supplied request payloads `[20261113-implement-scrum-poker-for-jira-per-plan / R2]`.
- **Live Session Notification:** An issue-scoped event emitted after state-changing mutations (`'SESSION_UPDATED'` carrying `{ roundId, updatedAt }` for vote/reveal/override/reset changes; `'points-applied'` carrying `{ roundId, score, updatedAt }` after successful Story Points write-back) containing zero unrevealed card values `[20261113-implement-scrum-poker-for-jira-per-plan / R5, R6, R8, R9, R11, R12]`.

---

## Invariants and Business Rules

- **Strict Per-Issue & Authenticated Caller Isolation:** Every session read and mutation derives the target issue identifier and acting user account identifier exclusively from the authenticated host platform context; client-supplied issue or account identifiers are ignored `[20261113-implement-scrum-poker-for-jira-per-plan / R2]`.
- **Concurrent Vote Isolation:** Simultaneous vote casts, updates, or withdrawals by distinct participants within the same `'voting'` round persist independently and never overwrite or discard a peer's concurrent mutation `[20261113-implement-scrum-poker-for-jira-per-plan / R4]`.
- **Unbounded Participant Completeness:** Session reads, reveals, and round cleanups retrieve and process 100% of active round voter records across storage pagination boundaries, including rounds with more than `100` participants, with zero record truncation `[20261113-implement-scrum-poker-for-jira-per-plan / R4]`.
- **Backend & Log Vote Secrecy:** While a round is in `'voting'`, live session notifications and peer participant projections never contain cast card values, and diagnostic or error logs never emit unrevealed card values, authentication credentials, or personal email addresses `[20261113-implement-scrum-poker-for-jira-per-plan / R5, R14]`.
- **Open Democratic Session Controls:** Any authenticated viewer—whether or not they cast a vote—may trigger **Show Votes**, **Reset / Re-vote**, post-reveal target score override, or **Set Story Points** (subject to the acting viewer's own issue-edit permission on write-back) `[20261113-implement-scrum-poker-for-jira-per-plan / R6, R8, R9, R11]`.
- **Shared Post-Reveal Consensus Score:** Selecting a numeric override in an active `'revealed'` round updates the round's shared `targetScore` for all viewers while keeping recorded votes, `average`, and `recommendedScore` intact `[20261113-implement-scrum-poker-for-jira-per-plan / R8]`.
- **Write-Back Failure Atomicity:** Applying Story Points clears the estimation round if and only if the host issue field update succeeds. Missing editable fields, permission denials (`401`/`403`), or host API/transport errors leave the `'revealed'` round, all votes, and `targetScore` intact `[20261113-implement-scrum-poker-for-jira-per-plan / R11]`.
- **Zero External Egress & Minimal Platform Scopes:** All compute, storage, live notifications, user profile lookups, editable field inspections, and issue updates execute strictly within the host platform (`Runs on Atlassian`) with zero external network egress and only four permission scopes: `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user` `[20261113-implement-scrum-poker-for-jira-per-plan / R14]`.

---

## Observable Domain Behaviour and Operations

### Get Session (`getSession`) `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R4, R5, R9, R10]`
Retrieves the caller-scoped estimation snapshot and editable Story Points field availability for the current issue.
- **Preconditions:** Authenticated host issue ID and caller account ID are present.
- **Postconditions:**
  - Inspects editable field metadata on the issue under the acting user's context per [estimation-rules.md](estimation-rules.md); sets `storyPointsField` to `{ fieldId, fieldName }` when matched or `null` when missing, non-editable, or inaccessible (`401`/`403` or error) without failing session retrieval.
  - Returns the caller-scoped session projection (`status`, `roundId`, `participants`, `viewerCard`, `average`, `formattedAverage`, `recommendedScore`, `targetScore`, `storyPointsField`).
  - Does not extend `updatedAt` when reading an idle or expired round.
- **Error Semantics:** Missing authenticated issue ID or caller account ID fails with `validation-error` with zero storage or platform calls.

### Cast, Update, or Toggle Vote (`castVote`) `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R2, R3, R4, R9]`
Records, updates, or toggles (withdraws) the acting viewer's hidden vote in an open `'voting'` round.
- **Preconditions:** Authenticated host context is present; submitted `card` is one of `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`; round is uninitialized, expired (`now - updatedAt >= 86,400,000` ms), or actively `'voting'`.
- **Postconditions:**
  - **Uninitialized or Expired Round:** Initializes a fresh `'voting'` round with a distinct `roundId` (discarding stale prior-round votes), persists the caller's vote (`card`, normalized `displayName`, optional `avatarUrl`, `votedAt`) with a 24-hour retention policy, refreshes `updatedAt`, publishes a redacted `'SESSION_UPDATED'` live session notification, and returns the updated caller-scoped session snapshot (`viewerCard` equal to `card`).
  - **Active `'voting'` Round — Unvoted or Different Card (`viewerCard !== card`):** Persists or updates the caller's vote (`card`, normalized `displayName`, optional `avatarUrl`, `votedAt`) with a 24-hour retention policy (appearing at most once in `participants`), refreshes `updatedAt`, publishes a redacted `'SESSION_UPDATED'` live session notification, and returns the updated caller-scoped session snapshot (`viewerCard` equal to `card`).
  - **Active `'voting'` Round — Matching Active Card (`viewerCard === card`):** Toggles (withdraws) the caller's vote—removing the caller's vote record and participant entry (transitioning the round to `0` votes if the caller was the sole voter while leaving peer votes untouched), refreshes `updatedAt`, publishes a redacted `'SESSION_UPDATED'` live session notification, and returns the updated caller-scoped session snapshot (`viewerCard: null`).
- **Toggle & Ordering Semantics:** Submitting a different valid `card` replaces the caller's active vote in place without duplicating their participant entry; submitting a `card` identical to the caller's active recorded vote toggles (withdraws) the vote (`viewerCard: null`), whereas submitting `card` again on a subsequent call casts a fresh vote (`viewerCard: card`).
- **Error Semantics:**
  - Invalid `card` or missing host context -> rejected with `validation-error`; state unchanged.
  - Active (non-expired) `'revealed'` round -> rejected with `invalid-state`; revealed votes and scores unchanged.

### Withdraw Vote (`withdrawVote`) `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R3, R4, R9]`
Removes the acting viewer's recorded vote during an open `'voting'` round.
- **Preconditions:** Authenticated host context is present; round is uninitialized, expired, or actively `'voting'`.
- **Postconditions:**
  - **Caller Holds an Active Vote in `'voting'` (`viewerCard !== null`):** Removes the caller's vote record and removes the caller from `participants` while leaving all peer selections untouched, refreshes `updatedAt`, publishes a `'SESSION_UPDATED'` live session notification, and returns the updated caller-scoped snapshot with `viewerCard: null`.
  - **Idle/Expired Round or Caller Holds No Active Vote (`viewerCard === null`):** Returns the current caller-scoped `'voting'` snapshot (`viewerCard: null`) without modifying peer votes, without extending `updatedAt`, and without emitting a live session notification.
- **Idempotency:** Invoking `withdrawVote` on an idle or expired round, or on an active `'voting'` round when the caller holds no recorded vote, returns the snapshot idempotently (`viewerCard: null`) without extending `updatedAt` or emitting a live notification.
- **Error Semantics:**
  - Missing host context -> rejected with `validation-error`.
  - Active (non-expired) `'revealed'` round -> rejected with `invalid-state`; revealed votes unchanged.

### Reveal Votes (`revealVotes`) `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R6, R7, R9]`
Transitions an open `'voting'` round with at least one vote to `'revealed'`.
- **Preconditions:** Authenticated host context is present; active (non-expired) round has at least `1` recorded vote (or is already actively `'revealed'`).
- **Postconditions:**
  - Transitions status from `'voting'` to `'revealed'`, exposes every participant's cast card (`'0'`..`'21'` or `'?'`), computes `average`, `formattedAverage`, and `recommendedScore`, initializes `targetScore` to `recommendedScore`, refreshes `updatedAt`, publishes a `'SESSION_UPDATED'` live session notification, and returns the revealed session snapshot.
- **Idempotency:** When invoked on an already active (non-expired) `'revealed'` round, returns the current `'revealed'` session snapshot idempotently without modifying votes or resetting an existing post-reveal `targetScore` override.
- **Error Semantics:**
  - Missing host context -> rejected with `validation-error`.
  - `0` active votes (idle round, round after all voters withdrew, reset round, or expired round) -> rejected with `precondition-failed`; round remains in `'voting'`.

### Override Target Score (`selectOverrideScore`) `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R2, R8, R9]`
Updates the shared post-reveal consensus `targetScore` without altering cast votes or computed statistics.
- **Preconditions:** Authenticated host context is present; submitted `score` is a valid numeric Fibonacci value (`0, 1, 2, 3, 5, 8, 13, 21`); round is actively (non-expired) `'revealed'`.
- **Postconditions:** Sets shared `targetScore` to `score` (including when all cast votes were `'?'` and `recommendedScore` is `null`), preserves all recorded votes, `average`, and `recommendedScore`, refreshes `updatedAt`, publishes a `'SESSION_UPDATED'` live session notification, and returns the updated session snapshot.
- **Error Semantics:**
  - Non-Fibonacci score, `'?'`, or missing host context -> rejected with `validation-error`.
  - `'voting'`, uninitialized, or expired round -> rejected with `invalid-state`; no override saved.

### Reset Round (`resetRound`) `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R4, R9]`
Clears the current estimation round and advances the issue to a clean `'voting'` round.
- **Preconditions:** Authenticated host context is present.
- **Postconditions:** Advances the issue to a new `'voting'` round with a distinct `roundId`, `0` participants, `viewerCard: null`, `average: null`, `recommendedScore: null`, and `targetScore: null`, removes prior-round vote records across all pages, publishes a `'SESSION_UPDATED'` live session notification, and returns the clean session snapshot.
- **Error Semantics:** Missing host context -> rejected with `validation-error`.

### Apply Story Points (`applyStoryPoints`) `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R2, R9, R10, R11]`
Writes the confirmed numeric Fibonacci score to the issue's editable Story Points field as the acting user and clears the round upon success.
- **Preconditions:** Authenticated host context is present; submitted `score` is a valid numeric Fibonacci value (`0, 1, 2, 3, 5, 8, 13, 21`); round is actively (non-expired) `'revealed'`.
- **Postconditions:**
  1. **Success (`ok: true`):** Dynamically verifies the issue's editable Story Points field via the acting user's permissions, updates only that field to `score` (`0` included) attributed to the acting user, clears the poker round to a clean idle `'voting'` state (`0` participants), publishes a `'points-applied'` live notification carrying `{ roundId, score, updatedAt }`, and returns `{ ok: true, appliedScore, fieldName, session }` (where `appliedScore` equals `score`).
  2. **Missing Editable Field (`ok: false, reason: 'missing-field'`):** When no qualifying editable Story Points field exists on the issue screen (and metadata lookup itself succeeded), performs zero issue writes, leaves the `'revealed'` round, votes, and `targetScore` intact, and returns `{ ok: false, reason: 'missing-field', score, message }`.
  3. **Permission Denied (`ok: false, reason: 'forbidden'`):** When the host platform rejects metadata lookup or issue update with `401` or `403`, leaves the `'revealed'` round, votes, and `targetScore` intact, and returns `{ ok: false, reason: 'forbidden', score, message }`.
  4. **Host Update Failure (`ok: false, reason: 'jira-error'`):** When the host platform returns `400`, `404`, `5xx`, or a transport failure, leaves the `'revealed'` round, votes, and `targetScore` intact, and returns `{ ok: false, reason: 'jira-error', score, message }`.
- **Error Semantics:**
  - Invalid `score` or missing host context -> rejected with `validation-error` before any platform call.
  - `'voting'`, uninitialized, or expired round -> rejected with `invalid-state` before any issue update.

---

## State Transitions

| Current State | Trigger / Operation | Guard Conditions | Next State | Observable Outcome |
| :--- | :--- | :--- | :--- | :--- |
| `idle / expired` | `getSession` | Valid host context | `voting (0 votes)` | Returns empty `'voting'` snapshot without extending `updatedAt` `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R9]` |
| `idle / expired` | `castVote(card)` | Valid deck card | `voting (>= 1 votes)` | Starts fresh `roundId`, discards stale votes, records caller's vote, emits `'SESSION_UPDATED'` `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R9]` |
| `idle / expired` | `withdrawVote` | Valid host context | `voting (0 votes)` | Returns empty `'voting'` snapshot idempotently (`viewerCard: null`) without extending `updatedAt` or emitting a live notification `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R9]` |
| `idle / expired` | `revealVotes` | — | *(rejected)* | Fails with `precondition-failed`; state remains idle/expired `[20261113-implement-scrum-poker-for-jira-per-plan / R6, R9]` |
| `idle / expired` | `selectOverrideScore` / `applyStoryPoints` | — | *(rejected)* | Fails with `invalid-state`; no issue or session write `[20261113-implement-scrum-poker-for-jira-per-plan / R8, R9, R11]` |
| `voting (0 votes)` | `castVote(card)` | Valid deck card | `voting (>= 1 votes)` | Records caller's vote, refreshes `updatedAt`, emits `'SESSION_UPDATED'` `[20261113-implement-scrum-poker-for-jira-per-plan / R3]` |
| `voting (0 votes)` | `withdrawVote` | — | `voting (0 votes)` | Returns snapshot idempotently (`viewerCard: null`) without extending `updatedAt` or emitting a live notification `[20261113-implement-scrum-poker-for-jira-per-plan / R3]` |
| `voting (0 votes)` | `revealVotes` | — | *(rejected)* | Fails with `precondition-failed` `[20261113-implement-scrum-poker-for-jira-per-plan / R6]` |
| `voting (>= 1 votes)` | `castVote(card)` | Valid deck card; `card !== viewerCard` | `voting (>= 1 votes)` | Inserts or updates caller's vote without affecting peers, refreshes `updatedAt`, emits `'SESSION_UPDATED'`, returns `viewerCard: card` `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R4]` |
| `voting (>= 1 votes)` | `castVote(card)` | Valid deck card; `card === viewerCard` | `voting (0 or >= 1 votes)` | Toggles (withdraws) caller's vote (`0` votes if sole voter), refreshes `updatedAt`, emits `'SESSION_UPDATED'`, returns `viewerCard: null` `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R4]` |
| `voting (>= 1 votes)` | `withdrawVote` | Caller holds active vote (`viewerCard !== null`) | `voting (0 or >= 1 votes)` | Removes caller's vote (`0` votes if sole voter), refreshes `updatedAt`, emits `'SESSION_UPDATED'`, returns `viewerCard: null` `[20261113-implement-scrum-poker-for-jira-per-plan / R3]` |
| `voting (>= 1 votes)` | `withdrawVote` | Caller holds no active vote (`viewerCard === null`) | `voting (>= 1 votes)` | Returns snapshot idempotently (`viewerCard: null`) without extending `updatedAt` or emitting a live notification `[20261113-implement-scrum-poker-for-jira-per-plan / R3]` |
| `voting (>= 1 votes)` | `revealVotes` | Active (`< 24h`), `>= 1` vote | `revealed` | Exposes all cards, computes metrics, sets `targetScore = recommendedScore`, emits `'SESSION_UPDATED'` `[20261113-implement-scrum-poker-for-jira-per-plan / R6]` |
| `voting (any)` | `selectOverrideScore` / `applyStoryPoints` | — | *(rejected)* | Fails with `invalid-state` `[20261113-implement-scrum-poker-for-jira-per-plan / R8, R11]` |
| `revealed` | `revealVotes` | Active (`< 24h`) | `revealed` | Succeeds idempotently; preserves votes and existing `targetScore` override `[20261113-implement-scrum-poker-for-jira-per-plan / R6]` |
| `revealed` | `castVote` / `withdrawVote` | Active (`< 24h`) | *(rejected)* | Fails with `invalid-state`; revealed votes unchanged `[20261113-implement-scrum-poker-for-jira-per-plan / R3]` |
| `revealed` | `selectOverrideScore(score)` | Active (`< 24h`), valid Fibonacci `0..21` | `revealed` | Updates shared `targetScore` to `score`, preserves votes & `recommendedScore`, emits `'SESSION_UPDATED'` `[20261113-implement-scrum-poker-for-jira-per-plan / R8]` |
| `revealed` | `applyStoryPoints(score)` | Active (`< 24h`), editable field & write succeeds | `voting (0 votes)` | Writes `score` as acting user, resets round, emits `'points-applied'` (`{ roundId, score, updatedAt }`) `[20261113-implement-scrum-poker-for-jira-per-plan / R11]` |
| `revealed` | `applyStoryPoints(score)` | Missing field, `401`/`403`, or API error | `revealed` | Returns `{ ok: false, reason, score, message }`; preserves revealed round, votes, and `targetScore` `[20261113-implement-scrum-poker-for-jira-per-plan / R11]` |
| `any` | `resetRound` | Valid host context | `voting (0 votes)` | Advances `roundId`, clears prior votes, resets scores to `null`, emits `'SESSION_UPDATED'` `[20261113-implement-scrum-poker-for-jira-per-plan / R9]` |

---

## Error Semantics and Edge Cases

- **Missing Host Context (`validation-error`):** Requests without an authenticated host issue ID or user account ID fail before reading or writing any state `[20261113-implement-scrum-poker-for-jira-per-plan / R2]`.
- **Invalid Card or Score (`validation-error`):** Non-deck cards or non-Fibonacci scores fail before touching session storage or host issue APIs `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R8, R11]`.
- **Disallowed Lifecycle Mutation (`invalid-state`):** Voting or withdrawing during an active `'revealed'` round, or overriding/applying Story Points during a `'voting'` or expired round, fails atomically `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R8, R9, R11]`.
- **Empty-Round Reveal (`precondition-failed`):** Revealing with `0` active votes (including expired rounds) fails atomically `[20261113-implement-scrum-poker-for-jira-per-plan / R6, R9]`.
- **Read-Only Viewers Loading Sessions:** Viewers whose editable-metadata check returns `401` or `403` still load and participate in the session normally with `storyPointsField: null` `[20261113-implement-scrum-poker-for-jira-per-plan / R10]`.

---

## Unsupported Operations

- **Client-Supplied Issue or User Spoofing:** Supplying another issue's ID or another user's account ID in request payloads cannot redirect reads or writes away from the authenticated host context `[20261113-implement-scrum-poker-for-jira-per-plan / R2]`.
- **Cross-Issue Lobbies & Persistent Round History:** Multi-issue batch sessions, external room URLs, and historical round logs after reset or Story Points application are not supported `[20261113-implement-scrum-poker-for-jira-per-plan]`.
- **Host-Locked Facilitator Roles:** Restricting reveal, reset, or override actions to a designated host or Scrum Master is not supported `[20261113-implement-scrum-poker-for-jira-per-plan / R6, R8, R9]`.
- **Modifying Non-Estimation Issue Data:** Updating issue fields other than the single matched Story Points field, posting issue comments, transitioning workflow statuses, changing sprints, or auto-creating missing custom fields in project administration settings is never performed `[20261113-implement-scrum-poker-for-jira-per-plan / R11, R14]`.
