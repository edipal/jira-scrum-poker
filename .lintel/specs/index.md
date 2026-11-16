# Living Specifications

This directory holds the cumulative, stack-neutral specification of merged domain behaviour for Scrum Poker for Jira. Specifications describe **what the product does today**, never test suites or unmerged roadmap items. Product and architectural context lives in [../steering/product.md](../steering/product.md) and [../steering/architecture.md](../steering/architecture.md).

---

## System Overview

Scrum Poker for Jira provides synchronous, zero-setup story-point estimation directly inside each Jira issue view (`jira:issueContext` right-hand sidebar). Authenticated team members viewing the same issue cast, update, or withdraw hidden estimates from a standard nine-card Fibonacci deck, reveal votes democratically when ready, inspect the numeric average and nearest-Fibonacci recommendation, optionally override the shared consensus score, and apply the selected Story Points value directly to the issue as the acting user—or copy it to the clipboard when no editable Story Points field is available on the issue screen `[20261113-implement-scrum-poker-for-jira-per-plan]`.

---

## Domain Area Directory

| Domain Area | Specification File | Scope & Key Concepts |
| :--- | :--- | :--- |
| Estimation Rules & Score Calculation | [estimation-rules.md](estimation-rules.md) | Canonical Fibonacci deck (`0, 1, 2, 3, 5, 8, 13, 21, ?`), card/score input validation, voter-only participant sorting and hidden-state card redaction, exact arithmetic average and display formatting, nearest-Fibonacci snapping with upward tie-breaking, exact 24-hour expiration evaluation, and editable Story Points field qualification `[20261113-implement-scrum-poker-for-jira-per-plan]` |
| Issue Estimation Session & Story Points Sync | [estimation-session.md](estimation-session.md) | Authenticated per-issue session isolation, concurrent per-voter persistence and full-pagination retrieval (`> 100` voters), hidden vote casting/withdrawal, democratic reveal and reset transitions, shared post-reveal target score overrides, redacted live session notifications, and atomic user-attributed Story Points write-back `[20261113-implement-scrum-poker-for-jira-per-plan]` |
| Issue Estimation Panel | [issue-panel.md](issue-panel.md) | Host Light/Dark theme synchronization, accessible card toggle controls (`aria-pressed`), voter chip states, live channel event synchronization and parent issue view refresh, Story Points save confirmation, and missing-field warning with clipboard copy fallback `[20261113-implement-scrum-poker-for-jira-per-plan]` |

---

## Cross-Cutting Invariants

1. **Zero External Data Egress & Minimal Platform Scopes:** All session state, participant display identities, votes, live notifications, editable field checks, UI assets, and issue updates remain strictly inside the host issue-tracking platform (`Runs on Atlassian`) using only `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user`, with zero external network egress, advertisements, or telemetry `[20261113-implement-scrum-poker-for-jira-per-plan / R14]`.
2. **Authenticated Host Context Isolation:** Every session operation derives the target issue identifier and acting user account identifier exclusively from the authenticated host context, ignoring client-supplied overrides `[20261113-implement-scrum-poker-for-jira-per-plan / R2]`.
3. **Vote Secrecy Prior to Reveal:** While a round is in `'voting'`, no session projection, live notification, or diagnostic log exposes another participant's selected card value; observers only learn which participants have voted (`hasVoted: true`, `card: null`) plus their own `viewerCard` `[20261113-implement-scrum-poker-for-jira-per-plan / R5, R14]`.
4. **Concurrent Vote Isolation & Pagination Completeness:** Simultaneous votes or withdrawals by distinct participants in the same round never overwrite or discard one another, and 100% of voter records are retrieved across arbitrary team sizes (`> 100` voters) `[20261113-implement-scrum-poker-for-jira-per-plan / R4]`.
5. **Open Democratic Controls:** Any authenticated user viewing the issue may cast or withdraw their own vote while `'voting'`, reveal votes once `>= 1` vote exists, reset the round, override the shared post-reveal `targetScore`, or apply Story Points (subject to their own issue-edit permission on write-back) `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R6, R8, R9, R11]`.
6. **Exact 24-Hour Inactivity Expiration:** Unfinished rounds expire when `now - updatedAt >= 86,400,000` milliseconds (`24` hours), projecting as an empty idle `'voting'` round on read without extending `updatedAt` and discarding stale votes when a new vote is cast `[20261113-implement-scrum-poker-for-jira-per-plan / R9]`.
7. **Deterministic Error Semantics & State Atomicity:** Invalid inputs fail with `validation-error`, disallowed lifecycle mutations fail with `invalid-state`, empty-round reveals fail with `precondition-failed`, and failed Story Points write-backs (`missing-field`, `forbidden`, `jira-error`) preserve the active `'revealed'` round and votes intact `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R3, R6, R8, R11]`.

---

## Glossary

- **Deck:** The fixed sequence of nine selectable estimation cards: numeric Fibonacci values `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, plus the non-numeric uncertainty card `'?'` `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`.
- **Estimation Round:** A single cycle of hidden voting, simultaneous reveal, and optional score application or reset scoped to one issue (`issueId`), identified by a distinct `roundId` so prior-round votes never leak into subsequent rounds `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R9]`.
- **Hidden State (`'voting'`):** The state of a round before reveal in which `0` or more participants have voted; participants can cast, change, or withdraw votes while peer card values remain redacted (`card: null`) `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R5]`.
- **Revealed State (`'revealed'`):** The state of a round after **Show Votes** succeeds; individual card values become visible to all viewers, voting and vote withdrawal are locked (`invalid-state`), and numeric summary metrics are computed `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R6, R7]`.
- **Numeric Vote:** Any recorded vote whose card is one of `'0', '1', '2', '3', '5', '8', '13', '21'` (`0` through `21` inclusive), excluding `'?'` `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R7]`.
- **Recommended Score (`recommendedScore`):** The numeric Fibonacci value in `[0, 1, 2, 3, 5, 8, 13, 21]` closest in absolute distance to the exact unrounded arithmetic mean of all numeric votes in a `'revealed'` round, breaking exact midpoint ties upward; `null` when all cast votes are `'?'` `[20261113-implement-scrum-poker-for-jira-per-plan / R7]`.
- **Target Score (`targetScore`):** The shared numeric Fibonacci value slated to be written to Story Points (or copied) in a `'revealed'` round; defaults to `recommendedScore` on reveal and updates across all connected panels when any viewer selects a numeric card override (`0..21`) `[20261113-implement-scrum-poker-for-jira-per-plan / R6, R8, R13]`.
- **Story Points Field (`storyPointsField`):** The highest-precedence editable numeric issue field (`schema.type === 'number'` and `'set'` operation allowed, when present) whose trimmed display name matches `'Story Points'` (tier 0) or `'Story point estimate'` (tier 1) case-insensitively, or whose custom schema equals `'com.pyxis.greenhopper.jira:jsw-story-points'` (tier 2 fallback for localized/renamed fields), breaking same-tier ties by ascending lexicographical `fieldId`; `null` when unavailable `[20261113-implement-scrum-poker-for-jira-per-plan / R10]`.
