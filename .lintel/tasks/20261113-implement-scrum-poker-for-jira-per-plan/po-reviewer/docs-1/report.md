# PO Reviewer Report (`docs-1`)

## Verdict Summary

**Verdict:** `changes`

The living specifications in `.lintel/specs/` (`index.md`, `estimation-rules.md`, `estimation-session.md`, and `issue-panel.md`) are well-structured, stack-neutral, free of test-case prescriptions, and carry `[20261113-implement-scrum-poker-for-jira-per-plan]` traceability tags across all 14 delivered requirements (`R1`–`R14`). However, one **blocker** (`F1`) and one **major** (`F2`) contract discrepancy in `.lintel/specs/estimation-session.md` contradict `R3` and the delivered backend/client contracts and must be corrected before approval.

---

## Resolution of Prior Findings

No prior `docs`-stage findings exist (iteration 1).

---

## Open Blockers & Majors

### `F1` (`blocker`) — `.lintel/specs/estimation-session.md § Cast or Update Vote (castVote) & § State Transitions`
- **Issue:**
  - Under `### Cast or Update Vote (castVote)`, Postconditions state that `castVote` always *"returns the updated caller-scoped session snapshot (`viewerCard` equal to `card`)"*, and **Idempotency & Ordering** states: *"Re-submitting a new or identical valid card while `'voting'` updates the caller's recorded selection without duplicating their participant entry."*
  - Likewise, the `## State Transitions` table states `voting (>= 1 votes)` + `castVote(card)` always transitions to `voting (>= 1 votes)` (*"Inserts or updates caller's vote without affecting peers, emits update"*).
  - Both `shared/requirements.md § R3` and the delivered `castVote` handler (`src/resolvers/poker-resolvers.ts`) implement toggle-withdrawal when `card` equals the caller's currently active vote: `castVote` deletes the caller's vote record, removes the caller from `participants` (transitioning to `voting (0 votes)` when the caller was the sole voter), refreshes `updatedAt`, publishes a live update notification, and returns `viewerCard: null`.
- **Required Remediation:**
  1. Update `castVote` **Postconditions** and **Idempotency & Ordering** to specify that submitting a valid card different from the caller's active selection records/updates the vote (`viewerCard: card`), whereas submitting the same card currently recorded for the caller in an active `'voting'` round toggles (withdraws) their vote—removing their vote record and participant entry, refreshing `updatedAt`, publishing a session update notification, and returning `viewerCard: null`.
  2. Update the `voting (>= 1 votes)` + `castVote(card)` row(s) in **State Transitions** to reflect both branches (distinct card -> `voting (>= 1 votes)` with updated vote; matching caller's active card -> withdraws caller's vote to `voting (0 or >= 1 votes)` with `viewerCard: null`).

### `F2` (`major`) — `.lintel/specs/estimation-session.md § Scope and Domain Concepts & § Apply Story Points (applyStoryPoints)`
- **Issue:**
  - Line 12 documents **Live Session Notification** with literal backticked identifiers `` `session-updated` `` and `` `'points-applied'` carrying `appliedScore` ``, and line 91 documents ``publishes a `'points-applied'` live notification containing `appliedScore` ``.
  - In the delivered system, the live session update event type is uppercase `'SESSION_UPDATED'` (`{ type: 'SESSION_UPDATED', roundId, updatedAt }`), and the `'points-applied'` live event carries `score` (`{ type: 'points-applied', roundId, score, updatedAt }`), while `appliedScore` is the field name on the `applyStoryPoints` return object (`{ ok: true, appliedScore, fieldName, session }`). The panel's strict event validator discards events with `type: 'session-updated'` or `'points-applied'` events missing numeric `score`.
- **Required Remediation:**
  - Replace `` `session-updated` `` with `'SESSION_UPDATED'` and replace live-event `` `appliedScore` `` references on lines 12 and 91 with `score` (while keeping `appliedScore` in `{ ok: true, appliedScore, fieldName, session }`).

---

## Minor Advisory Notes

- **`F3` (`minor` — non-blocking):** In `.lintel/specs/estimation-session.md`:
  1. Include `score` in the `'forbidden'` and `'jira-error'` return shapes under `### Apply Story Points` (`{ ok: false, reason: 'forbidden', score, message }` and `{ ok: false, reason: 'jira-error', score, message }`) for consistency with `'missing-field'` and the delivered failure contract.
  2. Clarify in `### Withdraw Vote` and `## State Transitions` that `withdrawVote` on an `idle / expired` round or when the caller has no recorded vote in an active `'voting'` round returns idempotently without extending `updatedAt` or publishing a live notification.
