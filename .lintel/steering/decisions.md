# Decisions

Architectural and product decisions for **Scrum Poker for Jira** (`scrum-poker-jira`). To record a new decision, append the next sequential `### D-XX: <short title>` entry with status, date, decision, and rationale; never reuse an ID.

### D-01: Free, Ad-Free Atlassian Forge App (`Runs on Atlassian`)

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Build the app natively on Atlassian Forge (`nodejs22.x` + Forge KVS + Forge Realtime + Custom UI) with zero external network egress and zero advertisements, using only `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user` scopes.
- **Why:** Commercial Jira Marketplace poker plugins charge per total Jira seat across the entire organization, while free external web apps show ads or require leaving Jira. Running 100% inside Atlassian Forge costs $0 within Forge's monthly free quota and qualifies for the **Runs on Atlassian** enterprise trust badge.

### D-02: Per-Issue Placement via `jira:issuePanel`

- **Status:** superseded by D-11
- **Decided:** 2026-11-12
- **Decision:** Scope estimation strictly per Jira issue using the `jira:issuePanel` module (toggled from the Apps icon bar directly beneath the issue summary), rather than project-wide session rooms, right-sidebar `issueContext`, or `issueAction` modals.
- **Why:** During refinement, everyone already views the ticket being discussed. Jira tracks `issuePanel` activation per issue (opening it once makes it visible on that ticket for teammates) while keeping unestimated issues clutter-free and leaving the issue description uncovered.

### D-03: Standard Fibonacci Deck Only in v1

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Use the standard Fibonacci estimation deck `0, 1, 2, 3, 5, 8, 13, 21, ?` with no deck-configuration UI in v1.
- **Why:** Eliminates settings complexity and covers standard Agile Story Point estimation out of the box, including `0` for trivial items and `?` for uncertainty/pass.

### D-04: Show Only Users Who Voted (No Viewer Presence Tracking)

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Display participants in the panel only after they cast a card (`Name ✓` while hidden; `Name: <card>` once revealed), rather than tracking everyone who merely has the ticket open.
- **Why:** Jira provides no native active-viewers API, and client-heartbeat presence clutters the panel with background tabs and non-voting observers (Product Owners, stakeholders).

### D-05: Open Session Controls (No Host Lock)

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Allow any authenticated user viewing the issue panel to trigger **Show Votes**, **Reset / Re-vote**, and **Set Story Points** (subject to their Jira issue edit permission on write-back).
- **Why:** Avoids session deadlocks when a Scrum Master is absent, switches screen-sharers, or closes their tab mid-refinement.

### D-06: Nearest-Fibonacci Rounding (Ties Round Up) + Post-Reveal Override

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Compute the exact arithmetic mean of all numeric votes (counting `0` as numeric and ignoring `?`, while still displaying `?` voters in results), format display averages half-up to at most 1 decimal place (omitting trailing `.0`), and snap `recommendedScore` from the unrounded mean to the closest numeric Fibonacci card (`0, 1, 2, 3, 5, 8, 13, 21`), rounding **up** to the higher Fibonacci card on an exact midpoint tie (e.g., `4.0 -> 5`). Once revealed, clicking any numeric Fibonacci card updates the target score on the **Set Story Points** / **Copy Score** button without requiring a re-vote. If all votes are `?`, no numeric score is recommended and only **Re-vote** is enabled until a numeric card (`0..21`) is clicked to set an override.
- **Why:** Teams store Fibonacci numbers—not raw decimals like `4.33`—in Jira Story Points, snapping before display rounding avoids double-rounding drift (e.g., `6.49 -> 5`), and a 1-click post-reveal card override lets teams record quick verbal consensus without running an extra round.

### D-07: Zero-Config Story Points Detection via `editmeta` with Clipboard Fallback

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Detect the target estimation field dynamically per issue via `GET /rest/api/3/issue/{issueIdOrKey}/editmeta`, matching editable (`operations` containing `'set'` when present) numeric (`schema.type === 'number'` when present) fields for `Story Points` (company-managed, tier 0), `Story point estimate` (team-managed, tier 1), or `schema.custom === 'com.pyxis.greenhopper.jira:jsw-story-points'` (localized/renamed Jira Software Story Points fallback, tier 2, breaking same-tier ties by ascending `fieldId`), and write the score via `PUT /rest/api/3/issue/{issueIdOrKey}` using `api.asUser()`. When no matching editable field exists on the issue screen (or metadata is `401`/`403` for a read-only viewer), report `storyPointsField: null` so the panel shows an inline warning and switches the action button to **Copy Score**.
- **Why:** Story Points is a custom field (`customfield_XXXXX`) whose ID varies across every Jira instance and project template, and some issue types (such as Sub-tasks or Bugs) omit it from their edit screen.

### D-08: Clear Round After Saving & Expire Unfinished Rounds After 24 Hours

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Clear the issue's poker round back to idle immediately after Story Points are saved to Jira, and expire unfinished/abandoned rounds after 24 hours using both Forge KVS `ttl: { value: 24, unit: 'HOURS' }` and an explicit timestamp check on read (`nowMs - updatedAt >= 86_400_000` ms, keeping `< 86_400_000` ms and minor negative clock skew active without extending `updatedAt` on expired reads).
- **Why:** Keeps tickets clean during sprint execution and prevents abandoned half-voted rounds from reappearing weeks later (accounting for Forge KVS's lazy up-to-48h background TTL sweep).

### D-09: Forge Custom UI + Per-Voter `@forge/kvs` Keys

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Build the frontend with Forge Custom UI (React 19 + Vite + `view.theme.enable()`) rather than Forge UI Kit, and store each voter's pick under an isolated KVS key `poker:{issueId}:{roundId}:vote:{accountId}` alongside round metadata `poker:{issueId}:meta` (`{ roundId, status, overrideScore, updatedAt }`).
- **Why:** Forge UI Kit blocks browser clipboard access needed for the D-07 **Copy Score** fallback, and per-voter KVS keys guarantee that simultaneous card clicks never overwrite each other.

### D-10: Shared Server-Persisted Override & Atomic Discriminated Write-Back Results

- **Status:** live
- **Decided:** 2026-11-13
- **Decision:** Persist post-reveal consensus overrides on `RoundMeta.overrideScore` (`targetScore = overrideScore ?? recommendedScore`) and broadcast updates over `@forge/realtime`, while modeling `applyStoryPoints` outcomes as a discriminated union (`{ ok: true, appliedScore, fieldName, session } | { ok: false, reason: 'missing-field' | 'forbidden' | 'jira-error', score, message }`) distinct from `PokerDomainError` (`'validation-error' | 'invalid-state' | 'precondition-failed'`).
- **Why:** Storing `overrideScore` on the round metadata keeps every connected teammate's panel aligned on the agreed target score before saving, and returning structured failure reasons on missing fields or Jira `401`/`403`/`5xx` responses guarantees atomic rollback-free preservation of revealed votes so another user can apply or copy the score.

### D-11: Right-Sidebar Placement via `jira:issueContext`

- **Status:** live
- **Decided:** 2026-11-14
- **Decision:** Render the per-issue Scrum Poker UI in Jira's right-hand sidebar using `jira:issueContext` in `manifest.yml` (superseding `D-02`'s `jira:issuePanel`).
- **Why:** In Jira Cloud's current issue layout, `jira:issuePanel` renders below Description, Subtasks, Linked work items, and Confluence content rather than directly beneath the issue summary. Placing Scrum Poker in `jira:issueContext` keeps the estimation cards visible at the top of the right-hand sidebar alongside Story Points and Details so teammates can read the Description and vote side-by-side without scrolling.

### D-12: Session-Epoched Monotonic Per-Round KVS Keys & Sequence Allocation

- **Status:** live
- **Decided:** 2026-11-14
- **Decision:** Isolate round lifecycle transitions into monotonic per-round KVS keys (`poker:{issueId}:{roundId}:status` for reveal, `:override` for target score override, `:activity` for vote activity timestamps, and `:closed` for forward round pointers on reset/apply/expiry rollover), stamp per-round keys and voter records with a deterministic per-session generation (`poker:{issueId}:session` + `sessionEpoch`) bound (`expectedEpoch`) at read time onto every write/delete and created on both fresh session initialization and legacy/expired `advanceRound` upgrades, allocate monotonic per-issue round numbers via `poker:{issueId}:seq` (`7 DAYS` TTL), inspect KVS `EXPIRE_TIME` metadata on reads/queries, and refresh `poker:{issueId}:meta` / `:session` 24-hour TTLs on vote activity from the resolved monotonic state.
- **Why:** `castVote` and `applyStoryPoints` perform Jira REST calls (`/myself`, `/editmeta`, `PUT /issue`) before writing to KVS, and Forge KVS sweeps expired 24-hour keys lazily (up to 48 hours). Monotonic per-round keys guarantee that in-flight votes/withdrawals never revert a concurrent reveal, override, or reset; binding `expectedEpoch` onto writes and deletes prevents delayed operations from an older session from stamping votes or deleting records in a newer session even under forced round-ID reuse; migrating un-epoched legacy rounds on `advanceRound` prevents stale pre-epoch tombstones from leaking across rolling upgrades; and refreshing `:meta` on vote activity plus `EXPIRE_TIME` filtering preserve exact 24-hour inactivity semantics.
