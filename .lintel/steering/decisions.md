# Decisions

Architectural and product decisions for **Scrum Poker for Jira** (`scrum-poker-jira`). To record a new decision, append the next sequential `### D-XX: <short title>` entry with status, date, decision, and rationale; never reuse an ID.

### D-01: Free, Ad-Free Atlassian Forge App (`Runs on Atlassian`)

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Build the app natively on Atlassian Forge (`nodejs22.x` + Forge KVS + Forge Realtime + Custom UI) with zero external network egress and zero advertisements, using only `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user` scopes.
- **Why:** Commercial Jira Marketplace poker plugins charge per total Jira seat across the entire organization, while free external web apps show ads or require leaving Jira. Running 100% inside Atlassian Forge costs $0 within Forge's monthly free quota and qualifies for the **Runs on Atlassian** enterprise trust badge.

### D-02: Per-Issue Placement via `jira:issuePanel`

- **Status:** live
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
- **Decision:** Compute the arithmetic mean of all numeric votes (ignoring `?`, while still displaying `?` voters in results) and snap the recommended score to the closest numeric Fibonacci card (`0, 1, 2, 3, 5, 8, 13, 21`), rounding **up** to the higher Fibonacci card on an exact midpoint tie (e.g., `4.0 -> 5`). Once revealed, clicking any numeric Fibonacci card updates the target score on the **Set Story Points** / **Copy Score** button without requiring a re-vote. If all votes are `?`, only **Re-vote** is enabled.
- **Why:** Teams store Fibonacci numbers—not raw decimals like `4.33`—in Jira Story Points, and a 1-click post-reveal card override lets teams record quick verbal consensus without running an extra round.

### D-07: Zero-Config Story Points Detection via `editmeta` with Clipboard Fallback

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Detect the target estimation field dynamically per issue via `GET /rest/api/3/issue/{issueIdOrKey}/editmeta`, matching editable numeric fields for `Story Points` (company-managed) or `Story point estimate` (team-managed), and write the score via `PUT /rest/api/3/issue/{issueIdOrKey}` using `api.asUser()`. When no matching editable field exists on the issue screen, show an inline warning and switch the action button to **Copy Score**.
- **Why:** Story Points is a custom field (`customfield_XXXXX`) whose ID varies across every Jira instance and project template, and some issue types (such as Sub-tasks or Bugs) omit it from their edit screen.

### D-08: Clear Round After Saving & Expire Unfinished Rounds After 24 Hours

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Clear the issue's poker round back to idle immediately after Story Points are saved to Jira, and expire unfinished/abandoned rounds after 24 hours using both Forge KVS `ttl: { value: 24, unit: 'HOURS' }` and an explicit `updatedAt` timestamp check on read.
- **Why:** Keeps tickets clean during sprint execution and prevents abandoned half-voted rounds from reappearing weeks later (accounting for Forge KVS's lazy up-to-48h background TTL sweep).

### D-09: Forge Custom UI + Per-Voter `@forge/kvs` Keys

- **Status:** live
- **Decided:** 2026-11-12
- **Decision:** Build the frontend with Forge Custom UI (React + Vite + `view.theme.enable()`) rather than Forge UI Kit, and store each voter's pick under an isolated KVS key `poker:{issueId}:{roundId}:vote:{accountId}` alongside round metadata `poker:{issueId}:meta`.
- **Why:** Forge UI Kit blocks browser clipboard access needed for the D-07 **Copy Score** fallback, and per-voter KVS keys guarantee that simultaneous card clicks never overwrite each other.
