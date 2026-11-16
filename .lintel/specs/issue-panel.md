# Issue Estimation Panel Specification

## Scope and Domain Concepts

Defines the observable user-interface behaviour of the `Scrum Poker` per-issue estimation panel (`jira:issueContext` right-hand sidebar), including host Light/Dark theme synchronization before mount, live multi-user event synchronization with tab-focus resync, accessible card toggle controls across `'voting'` and `'revealed'` states, post-reveal consensus score overrides, Story Points write-back confirmation with parent issue refresh, and missing-field warning with clipboard copy fallback `[20261113-implement-scrum-poker-for-jira-per-plan]`.

Numeric scoring and field-matching rules are governed by [estimation-rules.md](estimation-rules.md). Session persistence, authorization, and host platform write-back semantics are governed by [estimation-session.md](estimation-session.md).

### Domain Concepts
- **Deck Controls:** Nine interactive card buttons rendered in canonical order (`0`, `1`, `2`, `3`, `5`, `8`, `13`, `21`, `?`), each exposing an accessible pressed toggle state (`aria-pressed`) `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R13]`.
- **Voter Chip:** Visual participant badge displaying `<Display Name> ✓` while votes are hidden (`'voting'`) and `<Display Name>: <card>` once votes are revealed (`'revealed'`) `[20261113-implement-scrum-poker-for-jira-per-plan / R5, R13]`.
- **Primary Score Action:** Context-dependent confirmation button in `'revealed'` state—either **Set Story Points → `<targetScore>`** when `storyPointsField` is available, or **Copy Score (`<targetScore>`)** alongside an inline missing-field warning when `storyPointsField` is `null` `[20261113-implement-scrum-poker-for-jira-per-plan / R13]`.

---

## Invariants and Business Rules

- **Local-Only Styling & Host Theme Sync:** On initialization, the panel activates host Light/Dark theme synchronization and renders accessible contrast across surfaces, text, borders, and interactive controls using strictly local assets with zero external stylesheets, fonts, images, scripts, advertisements, or telemetry `[20261113-implement-scrum-poker-for-jira-per-plan / R13, R14]`.
- **Voter-Only Display & Hidden Card Secrecy:** Non-voting viewers never appear as participant chips; while in `'voting'`, voter chips display `<Display Name> ✓` and never reveal any participant's card value `[20261113-implement-scrum-poker-for-jira-per-plan / R5, R13]`.
- **Push-Driven Live Synchronization Without Polling:** Connected panels update automatically in response to live issue-scoped channel events without background polling or full-page reloads, and release their live subscription cleanly when unmounted `[20261113-implement-scrum-poker-for-jira-per-plan / R12]`.
- **Immediate Host Issue View Refresh on Save:** Whenever Story Points are applied—either locally by the acting user or remotely via a peer's `'points-applied'` live event—every open panel on that issue transitions to the cleared idle state and triggers a host issue view refresh so the updated Story Points field appears immediately on the parent issue page `[20261113-implement-scrum-poker-for-jira-per-plan / R12]`.
- **Preserved Revealed State During Copy or Failed Save:** Activating **Copy Score** or encountering a missing-field, permission-denied, or host error during **Set Story Points** keeps the `'revealed'` round, participant votes, and `targetScore` visible on screen `[20261113-implement-scrum-poker-for-jira-per-plan / R11, R13]`.

---

## Observable Domain Behaviour and Operations

### Initialize Panel and Synchronize Live Updates `[20261113-implement-scrum-poker-for-jira-per-plan / R12, R13]`
Bootstraps theme sync, loads the caller's initial session snapshot, and maintains live multi-user synchronization.
- **Preconditions:** Authenticated viewer opens the `Scrum Poker` panel on an issue.
- **Postconditions:**
  - Enables host theme synchronization (`Light` / `Dark`) before mounting, fetches the initial caller-scoped session via `getSession`, subscribes to live session events for the issue, and refreshes session state in the background when the browser tab returns to the visible foreground (`visibilitychange`).
  - On receiving a peer `'SESSION_UPDATED'` mutation event (vote cast/updated/withdrawn, votes revealed, `targetScore` overridden, or round reset), automatically fetches and renders the viewer's updated caller-scoped session snapshot.
  - On receiving a peer `'points-applied'` event (`{ roundId, score, updatedAt }`), refreshes to the cleared idle session state and invokes host issue view refresh.
  - On panel unmount, unsubscribes cleanly so unmounted views ignore subsequent events.

### Select or Toggle Card During Hidden Voting (`'voting'`) `[20261113-implement-scrum-poker-for-jira-per-plan / R3, R13]`
Allows the viewer to cast, change, or withdraw their hidden estimate.
- **Preconditions:** Current session status is `'voting'`.
- **Postconditions:**
  - Selecting a card different from `viewerCard` (`aria-pressed="false"`) casts or updates the viewer's vote to that card and marks only that card with `aria-pressed="true"`.
  - Selecting the currently active `viewerCard` (`aria-pressed="true"`) withdraws the viewer's vote and resets all nine cards to `aria-pressed="false"`.
  - When `0` participants have voted, displays the empty-state prompt `Pick a card to start voting` and disables or omits **Show Votes** and **Reset**.
  - When `>= 1` participants have voted, renders `<Display Name> ✓` for each voter in canonical vote order and enables **Show Votes** and **Reset**.

### Inspect Results and Override Target Score (`'revealed'`) `[20261113-implement-scrum-poker-for-jira-per-plan / R7, R8, R13]`
Displays revealed votes, summary metrics, and consensus override controls.
- **Preconditions:** Current session status is `'revealed'`.
- **Postconditions:**
  - Renders `<Display Name>: <card>` for every voter (including `'?'` voters).
  - Displays formatted numeric **Average** (`formattedAverage`) and **Recommended** Fibonacci value (`recommendedScore`) when `>= 1` numeric vote exists, or displays `"No numeric votes"` when every cast vote is `'?'`.
  - Enables numeric cards `0, 1, 2, 3, 5, 8, 13, 21` for consensus override, marks the card matching `targetScore` with `aria-pressed="true"` (all cards `aria-pressed="false"` when `targetScore` is `null`), disables the `'?'` card button, and enables **Re-vote**.
  - Selecting any numeric card `0..21` invokes `selectOverrideScore` and updates the shared `targetScore` label on **Set Story Points → `<targetScore>`** or **Copy Score (`<targetScore>`)** across all open panels.
  - When all votes are `'?'` and `targetScore` is `null`, neither **Set Story Points** nor **Copy Score** is active, and the panel prompts that selecting any numeric card (`0..21`) enables setting or copying the score alongside **Re-vote**.

### Confirm Story Points or Copy Fallback Score `[20261113-implement-scrum-poker-for-jira-per-plan / R11, R12, R13]`
Applies `targetScore` directly to the issue when editable, or copies `targetScore` to the clipboard when unavailable.
- **Preconditions:** Current session status is `'revealed'` and `targetScore !== null`.
- **Postconditions:**
  - **Editable Story Points Field Available (`storyPointsField !== null`):**
    - Renders primary button **Set Story Points → `<targetScore>`**.
    - On success (`ok: true`), displays confirmation feedback (`Story Points set to <score>`), renders the cleared idle `'voting'` panel, and refreshes the parent issue view.
    - If `applyStoryPoints` returns `reason: 'missing-field'`, transitions the panel to the missing-field warning state with **Copy Score (`<targetScore>`)** while keeping the revealed session intact.
    - If `applyStoryPoints` returns `reason: 'forbidden'` or `'jira-error'`, displays an accessible inline error alert while keeping the revealed votes and `targetScore` intact for retry or peer completion.
  - **Editable Story Points Field Missing (`storyPointsField === null`):**
    - Displays an inline warning explaining that no editable Story Points field is available on this issue screen and renders **Copy Score (`<targetScore>`)** in place of **Set Story Points**.
    - Activating **Copy Score (`<targetScore>`)** writes the decimal string of `targetScore` (`"0"`, `"5"`, `"21"`, etc.) to the system clipboard and announces/displays `"Copied!"` confirmation while keeping the `'revealed'` round visible.
    - If system clipboard access fails or is unavailable, displays an inline manual-copy fallback message containing the numeric `targetScore` without failing or clearing the round.

---

## Panel View State Summary

| Session Condition | Deck Card States | Participant Area | Summary & Alerts | Action Buttons |
| :--- | :--- | :--- | :--- | :--- |
| `'voting'`, `0` voters `[20261113-implement-scrum-poker-for-jira-per-plan / R13]` | All 9 enabled; all `aria-pressed="false"` | `Pick a card to start voting` | Post-save banner if just applied | **Show Votes** & **Reset** disabled or omitted |
| `'voting'`, `>= 1` voters `[20261113-implement-scrum-poker-for-jira-per-plan / R13]` | All 9 enabled; `viewerCard` has `aria-pressed="true"` | `<Display Name> ✓` chips | — | **Show Votes** enabled, **Reset** enabled |
| `'revealed'`, `targetScore !== null`, field editable `[20261113-implement-scrum-poker-for-jira-per-plan / R13]` | `0..21` enabled (`targetScore` pressed); `?` disabled | `<Display Name>: <card>` chips | **Average** & **Recommended** (or `"No numeric votes"` if overridden from all-`?`) | **Set Story Points → `<targetScore>`**, **Re-vote** |
| `'revealed'`, `targetScore !== null`, field `null` `[20261113-implement-scrum-poker-for-jira-per-plan / R13]` | `0..21` enabled (`targetScore` pressed); `?` disabled | `<Display Name>: <card>` chips | Summary + inline missing-field warning | **Copy Score (`<targetScore>`)**, **Re-vote** |
| `'revealed'`, all `'?'` votes, `targetScore === null` `[20261113-implement-scrum-poker-for-jira-per-plan / R13]` | `0..21` enabled (none pressed); `?` disabled | `<Display Name>: ?` chips | `"No numeric votes"` + prompt to pick `0..21` to set/copy score | **Re-vote** enabled; save/copy inactive |

---

## Error Semantics and Edge Cases

- **Clipboard Write Denial or Unavailability:** If writing the decimal text representation of `targetScore` to the system clipboard fails or is blocked by host/browser policy, the panel surfaces an inline fallback message containing the numeric score (including `0`) and preserves the `'revealed'` round without failing `[20261113-implement-scrum-poker-for-jira-per-plan / R13]`.
- **Save Failure Recovery:** Permission (`forbidden`) or platform (`jira-error`) failures during **Set Story Points** display an inline error message and leave all revealed cards and `targetScore` intact so an authorized teammate can click **Set Story Points** or any viewer can copy the score `[20261113-implement-scrum-poker-for-jira-per-plan / R11, R13]`.
- **Score Zero (`0`) Handling:** `targetScore: 0` is treated as a valid present numeric score (`0 !== null`), rendering **Set Story Points → 0** or **Copy Score (0)** and copying `"0"` to the clipboard `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R11, R13]`.

---

## Unsupported Operations

- **Non-Voting Viewer Presence Indicators:** Users who open the panel without casting a card are never listed as active viewers or observers `[20261113-implement-scrum-poker-for-jira-per-plan / R5, R13]`.
- **Selecting `'?'` as Post-Reveal Override:** The `'?'` card is disabled throughout the `'revealed'` state and cannot be chosen as `targetScore` `[20261113-implement-scrum-poker-for-jira-per-plan / R8, R13]`.
- **External Network Assets or Ads:** Loading external fonts, stylesheets, icons, scripts, analytics beacons, or advertisements inside the issue panel is strictly prohibited `[20261113-implement-scrum-poker-for-jira-per-plan / R13, R14]`.
