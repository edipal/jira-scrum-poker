# PO Living Specifications Review Update (`docs-2`)

## Summary of Changes

Updated the living specifications in `.lintel/specs/estimation-session.md` and `.lintel/specs/issue-panel.md` to resolve all open review findings (`F1`, `F2`, `F3`) so the specs match `shared/requirements.md` and the delivered domain contracts.

## Resolution of Open Findings

- **F1 (fixed):** Updated `castVote` in `.lintel/specs/estimation-session.md` (`Postconditions`, `Toggle & Ordering Semantics`, and `State Transitions`) to accurately specify toggle-withdrawal behaviour when `card === viewerCard` in an active `'voting'` round—removing the caller's vote record and participant entry (transitioning to `0` votes if they were the sole voter), refreshing `updatedAt`, publishing `'SESSION_UPDATED'`, and returning `viewerCard: null`.
- **F2 (fixed):** Replaced the mismatched `session-updated` event name and `appliedScore` event payload field in `.lintel/specs/estimation-session.md` (and synchronized `.lintel/specs/issue-panel.md`) with the delivered live event contracts: `'SESSION_UPDATED'` carrying `{ roundId, updatedAt }` and `'points-applied'` carrying `{ roundId, score, updatedAt }` (keeping `appliedScore` exclusively on the `applyStoryPoints` return object).
- **F3 (fixed):**
  1. Added `score` to the `{ ok: false, reason, score, message }` failure return shape in `applyStoryPoints` Postconditions 3 (`'forbidden'`) and 4 (`'jira-error'`) as well as the `State Transitions` table in `.lintel/specs/estimation-session.md`.
  2. Explicitly documented in `withdrawVote` (`Postconditions` and `Idempotency`) and `State Transitions` (`idle / expired`, `voting (0 votes)`, and `voting (>= 1 votes)` with `viewerCard === null`) that invoking `withdrawVote` when idle/expired or when the caller holds no active vote returns the snapshot idempotently without extending `updatedAt` or emitting a live notification.
