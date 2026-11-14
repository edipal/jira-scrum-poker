# Living Specifications

This directory holds the cumulative, stack-neutral specification of merged domain behaviour for Scrum Poker for Jira. Specifications describe **what the product does today**, never test suites or unmerged roadmap items. Planned capabilities live in [../../PLAN.md](../../PLAN.md), and product and architectural context lives in [../steering/product.md](../steering/product.md) and [../steering/architecture.md](../steering/architecture.md).

---

## System Overview

Scrum Poker for Jira provides fast, synchronous story-point estimation directly inside an issue view. Team members viewing the same issue cast hidden estimates from a standard Fibonacci deck, reveal votes simultaneously when ready, inspect the numeric average and nearest Fibonacci recommendation, optionally override the final estimate, and apply the selected Story Points value directly to the issue (or copy it when no editable Story Points field is available on the issue screen).

---

## Domain Area Directory

No feature specifications have been merged yet. As each phase in [../../PLAN.md](../../PLAN.md) completes its Lintel lifecycle, its delivered behaviour will be merged into cohesive domain specification files and registered here:

| Domain Area | Planned File | Scope |
| :--- | :--- | :--- |
| Estimation Rules & Score Calculation | `estimation-rules.md` *(planned — Phase 1)* | Fibonacci deck membership, hidden vs. revealed participant projections, arithmetic average, nearest-Fibonacci snapping with upward tie-breaking, question-mark vote handling, 24-hour session expiration, and Story Points field matching |
| Issue Estimation Session & Story Points Sync | `estimation-session.md` *(planned — Phase 2)* | Per-issue estimation round lifecycle, isolated concurrent voting and vote withdrawal, democratic reveal and reset transitions, live update notifications, and Story Points write-back with missing-field fallback |
| Issue Estimation Panel | `issue-panel.md` *(planned — Phase 3)* | Interactive card selection, participant chip states, post-reveal target score override, Story Points confirmation and issue view refresh, missing-field warning and clipboard copy fallback |

---

## Cross-Cutting Invariants

1. **Zero External Data Egress:** All session state, participant display identities, votes, and issue updates remain strictly within the host issue-tracking platform boundary. No telemetry, analytics, advertisements, or external network requests are emitted.
2. **Vote Secrecy Prior to Reveal:** While a round is in the hidden voting state, no operation or notification exposes another participant's selected card value; observers only learn which participants have cast a vote (`voted`) and their own selected card.
3. **Concurrent Vote Isolation:** Simultaneous votes or vote withdrawals by distinct participants in the same estimation round never overwrite or discard one another.
4. **Open Democratic Controls:** Any authenticated user with access to view the issue may cast or change their own vote while voting is open, reveal votes once at least one vote exists, reset the round, override the post-reveal target score, or apply Story Points (subject to their own issue-edit permission on write-back).
5. **Automatic Round Expiration:** Unfinished estimation rounds expire automatically 24 hours after their last state-changing activity and are treated identically to an empty idle round when subsequently accessed.

---

## Glossary

- **Deck:** The fixed sequence of selectable estimation cards: numeric Fibonacci values `0`, `1`, `2`, `3`, `5`, `8`, `13`, `21`, plus the non-numeric uncertainty card `?`.
- **Estimation Round:** A single cycle of hidden voting, simultaneous reveal, and optional score application or reset scoped to one issue. Identified by a monotonic or unique round identifier so stale votes from prior rounds cannot leak into a new round.
- **Hidden State (`voting`):** The active state of a round in which at least zero participants have voted and votes have not yet been revealed. Participants can cast, change, or withdraw their vote; other participants' card values remain redacted.
- **Revealed State (`revealed`):** The state of a round after someone triggers **Show Votes**. Individual card values become visible to all viewers, voting is locked until a reset, and numeric summary metrics are computed.
- **Numeric Vote:** Any vote whose card is one of `0, 1, 2, 3, 5, 8, 13, 21`. Excludes `?`.
- **Recommended Card:** The numeric Fibonacci card closest in absolute distance to the arithmetic mean of all numeric votes in a revealed round, breaking exact midpoint ties upward to the higher Fibonacci card. Undefined (`null`) when all cast votes are `?`.
- **Target Score:** The numeric Fibonacci value slated to be written to the issue's Story Points field after reveal. Defaults to the **Recommended Card** upon reveal and can be overridden in-place by selecting any numeric Fibonacci card while revealed.
- **Story Points Field:** The editable numeric custom field on the issue's edit screen whose name matches `Story Points` or `Story point estimate` (case-insensitive exact match).
