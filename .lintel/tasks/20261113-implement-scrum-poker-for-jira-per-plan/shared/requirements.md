# Requirements: Scrum Poker for Jira

## Context & Intent

Agile teams estimating work in Jira Cloud need a synchronous, zero-setup, ad-free Scrum Poker experience directly inside each Jira issue without per-seat licensing fees, external browser tabs, or external data egress.

This specification defines the complete observable product behaviour for **Scrum Poker for Jira**:
- **Team Members (Voters & Facilitators):** Authenticated Jira users viewing an issue who cast, update, or withdraw hidden Fibonacci votes, reveal votes, inspect averages and nearest-Fibonacci recommendations, optionally override the consensus score, and either apply Story Points directly to the issue or copy the score when no editable Story Points field is present on the issue screen.
- **Non-Voting Viewers / Observers:** Authenticated Jira users viewing the issue panel who observe voting progress without cluttering the participant list unless they cast a vote.
- **Jira Organization Administrators:** Platform administrators requiring strict containment within the host platform (`Runs on Atlassian`), zero external network egress, user-attributed issue updates, and minimal permission scopes.

---

## Assumptions & Decisions

1. **Exact 24-Hour Expiration Boundary (`D-08`):** A session round is considered expired when `now - updatedAt >= 86,400,000` milliseconds (`24 * 60 * 60 * 1000` ms). Elapsed durations strictly less than `86,400,000` milliseconds (including `86,399,999` ms and negative deltas caused by minor clock skew where `now < updatedAt`) remain active.
2. **Idempotent Concurrent Reveal and Vote Withdrawal (`D-05`):** Because session controls are open to every authenticated viewer, simultaneous clicks are expected. Triggering vote reveal on an already active `revealed` round returns the current revealed session state idempotently without clearing votes or overrides, and withdrawing a vote during an active `voting` round when the caller currently has no recorded vote succeeds idempotently without affecting other voters.
3. **Snapping Before Display Rounding (`D-06`):** Nearest-Fibonacci recommendation snapping operates on the exact unrounded arithmetic mean of numeric votes rather than the formatted display string, ensuring values such as `6.49` snap to `5` (`|6.49 - 5| = 1.49 < |6.49 - 8| = 1.51`) while display formatting rounds numeric averages to at most 1 decimal place with trailing `.0` omitted (for example, `5` -> `"5"`, `1.5` -> `"1.5"`, `4.333...` -> `"4.3"`).
4. **Shared Post-Reveal Override (`D-06`):** Selecting a numeric Fibonacci card after reveal updates the round's shared `targetScore` across all connected issue panels rather than only locally in one browser tab, keeping the whole team aligned on the consensus value before saving.
5. **Editable Numeric Story Points Field Qualification (`D-07`):** When inspecting an issue's editable field metadata, a candidate field qualifies when its trimmed display name matches `'Story Points'` or `'Story point estimate'` case-insensitively, its field schema type (if present) is `'number'`, and its allowed operations list (if present) includes `'set'`. Read-only viewers who lack issue-edit permission still load and view the estimation session normally with `storyPointsField` reported as unavailable (`null`).

---

## Requirements

### R1: Standard Fibonacci Deck and Score Validation

The estimation system shall provide a fixed ordered deck of nine selectable cards: `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, and `'?'`.
The estimation system shall recognize `0`, `1`, `2`, `3`, `5`, `8`, `13`, and `21` as the valid numeric Fibonacci values, and `'?'` as a valid non-numeric uncertainty card.
If a caller submits a card or numeric target score outside the valid set (including empty strings, whitespace-padded values such as `' 5 '`, negative numbers, decimals, `NaN`, `Infinity`, `null`, `undefined`, or non-deck integers such as `'4'`, `'6'`, or `100`), then the estimation system shall reject the request with a validation error (`validation-error`) and leave session state unmodified.

**Acceptance Criteria:**
- **Given** each of the nine deck cards (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`), **When** validated as a castable card, **Then** each is accepted in exact canonical deck order and `'0'` through `'21'` are classified as numeric values (`0` through `21`) while `'?'` is classified as non-numeric.
- **Given** an invalid card input (`""`, `"   "`, `" 5"`, `"5 "`, `"-1"`, `"4"`, `"6"`, `"34"`, `"3.5"`, `"coffee"`, `null`), **When** submitted to cast a vote, **Then** the operation is rejected with `validation-error` and no vote is recorded.
- **Given** an invalid numeric target score (`-1`, `4`, `4.5`, `22`, `NaN`, `Infinity`, `'?'`, `null`), **When** submitted as a post-reveal override or Story Points value, **Then** the operation is rejected with `validation-error` and prior session state remains intact.

### R2: Per-Issue Session Isolation and Authenticated Host Context

The estimation system shall scope every estimation session strictly to the single issue identified by the authenticated host platform context and identify the acting participant exclusively from the authenticated host user context.
When an issue has no prior estimation session, the estimation system shall present an idle `'voting'` round with `0` participants, `viewerCard: null`, `average: null`, `recommendedScore: null`, and `targetScore: null`.
If a request lacks an authenticated issue identifier or caller account identifier in the host context, then the estimation system shall reject the request with a context validation error (`validation-error`) and perform zero reads or writes.

**Acceptance Criteria:**
- **Given** two distinct issues (`Issue A` and `Issue B`) where votes have been cast on `Issue A`, **When** a user loads or mutates the session on `Issue B` (even if a payload attempts to supply `Issue A`'s identifier), **Then** all reads and writes apply strictly to `Issue B` from the authenticated host context and `Issue B` displays an independent session with `0` votes from `Issue A`.
- **Given** an issue that has never hosted an estimation round, **When** a viewer requests the session state, **Then** the system returns status `'voting'`, an empty participant list (`0` items), `viewerCard: null`, `average: null`, `recommendedScore: null`, and `targetScore: null`.
- **Given** a request missing a valid host issue ID or authenticated user account ID, **When** any session operation is invoked, **Then** the operation fails with `validation-error` and modifies no state.

### R3: Casting, Updating, and Withdrawing Votes in Hidden Voting State

While an issue's estimation round is in the `'voting'` state (including when initializing from an idle or expired round), when an authenticated viewer selects a valid deck card other than their currently recorded card, the estimation system shall record that card for the viewer, include the viewer once in the round's participant list, refresh the round's last-activity timestamp, and return the updated caller-scoped session snapshot.
While an issue's estimation round is in the `'voting'` state, when an authenticated viewer withdraws their vote (either explicitly or by toggling their currently selected card), the estimation system shall remove that viewer's vote record from the round, remove the viewer from the participant list, refresh the round's last-activity timestamp, and return the updated caller-scoped session snapshot.
While an issue's estimation round is in an active (non-expired) `'revealed'` state, if a caller attempts to cast, change, or withdraw a vote, then the estimation system shall reject the operation with an invalid-state error (`invalid-state`) and leave all revealed votes unchanged.

**Acceptance Criteria:**
- **Given** an idle `'voting'` round with `0` participants, **When** User A casts `'5'`, **Then** the round has `1` participant (User A) and User A receives `viewerCard: '5'`.
- **Given** an active `'voting'` round where User A previously cast `'5'`, **When** User A casts `'8'`, **Then** the participant count remains `1`, User A's recorded card becomes `'8'`, and User A receives `viewerCard: '8'`.
- **Given** an active `'voting'` round where User A is the only voter (`'8'`), **When** User A withdraws their vote (or clicks `'8'` again), **Then** User A's vote is removed, the participant list becomes empty (`0` participants), `viewerCard` becomes `null`, and the round remains in `'voting'` state.
- **Given** an active `'voting'` round where User B has no recorded vote and User A has voted `'5'`, **When** User B triggers vote withdrawal, **Then** the operation succeeds idempotently with `viewerCard: null` for User B while User A's vote remains intact.
- **Given** an active `'revealed'` round, **When** any user attempts to cast or withdraw a vote, **Then** the request is rejected with `invalid-state` and the revealed participant votes and scores remain unchanged.

### R4: Concurrent Vote Isolation and Large-Team Pagination Completeness

When two or more distinct participants cast, update, or withdraw votes concurrently within the same `'voting'` round, the estimation system shall persist each participant's vote state independently without overwriting or discarding any peer's concurrent change.
When an estimation round contains any number of participants—including more than 100 voters across storage pagination boundaries—the estimation system shall retrieve and include 100% of active voter records during session reads, reveals, and round cleanup without truncation.

**Acceptance Criteria:**
- **Given** an active `'voting'` round on an issue, **When** 5 distinct participants submit votes (`'1'`, `'2'`, `'5'`, `'8'`, `'?'`) simultaneously, **Then** subsequent session queries reflect all 5 participants with zero lost updates.
- **Given** an active `'voting'` round where Participant A updates `'3'` -> `'5'` concurrently while Participant B withdraws their vote and Participant C casts `'13'`, **Then** the resulting session contains Participant A (`'5'`) and Participant C (`'13'`), and omits Participant B.
- **Given** an estimation round in which 125 distinct participants have cast votes, **When** the session is read or revealed, **Then** all 125 participants are returned and included in score calculation with zero dropped records.

### R5: Vote Secrecy Redaction and Voter-Only Participant Projection

The estimation system shall include in the participant list only users who currently hold a recorded vote in the active round, omitting non-voting viewers.
The estimation system shall order participants deterministically by ascending vote timestamp, breaking exact timestamp ties by ascending lexicographical account identifier, and shall substitute a non-empty fallback display name (such as `'Unknown User'` or the account identifier) whenever a user's profile display name is empty or whitespace-only.
While a round is in the `'voting'` state, the estimation system shall redact all participant card values from the participant list (`hasVoted: true`, `card: null`), expose only the requesting caller's own selection in `viewerCard`, and omit all card values from live synchronization notifications.

**Acceptance Criteria:**
- **Given** an active `'voting'` round where User A voted `'3'` at `t = 1000` and User B voted `'13'` at `t = 2000`, while User C is viewing without voting, **When** User C queries the session, **Then** `participants` lists `[User A, User B]` with `hasVoted: true` and `card: null` for both, User C is absent from `participants`, and `viewerCard` is `null`.
- **Given** the same `'voting'` round, **When** User A queries the session, **Then** `viewerCard` is `'3'`, while both entries in `participants` still report `card: null` (never exposing User B's `'13'`).
- **Given** two voters with identical vote timestamps (`t = 1000`) and account IDs `'acc-z'` and `'acc-a'`, **When** the session is projected, **Then** `'acc-a'` appears before `'acc-z'`.
- **Given** a voter whose profile returns a blank or whitespace-only display name (`"   "`), **When** their vote is recorded and projected, **Then** their participant entry carries a non-empty display name.

### R6: Open Democratic Vote Reveal Transition

While an estimation round is in the `'voting'` state and has at least `1` recorded vote, when any authenticated viewer triggers vote reveal (**Show Votes**), the estimation system shall transition the round to `'revealed'`, expose every voter's selected card in the participant list, compute numeric summary statistics, initialize `targetScore` to `recommendedScore`, refresh the round's last-activity timestamp, publish a live session update notification, and return the revealed session snapshot.
If a caller triggers vote reveal when `0` active votes exist (including on an idle, reset, or expired round), then the estimation system shall reject the request with a precondition error (`precondition-failed`) and keep the round in the `'voting'` state.
When a caller triggers vote reveal on an already active (non-expired) `'revealed'` round, the estimation system shall return the current revealed session snapshot idempotently without modifying votes or resetting an existing post-reveal `targetScore` override.

**Acceptance Criteria:**
- **Given** a `'voting'` round where User A cast `'5'` and User B cast `'?'`, **When** User C (a non-voting viewer) triggers **Show Votes**, **Then** the round transitions to `'revealed'` and all viewers see `User A: '5'` and `User B: '?'`.
- **Given** an idle `'voting'` round with `0` votes, **When** a caller triggers **Show Votes**, **Then** the operation fails with `precondition-failed` and the round remains in `'voting'`.
- **Given** an already `'revealed'` round where `targetScore` was overridden to `8`, **When** a second teammate's concurrent **Show Votes** request arrives, **Then** the round remains `'revealed'` with `targetScore: 8` and no error is raised.

### R7: Numeric Average Calculation and Nearest-Fibonacci Snapping

When a round is in the `'revealed'` state, the estimation system shall calculate the arithmetic mean across all numeric votes (`0, 1, 2, 3, 5, 8, 13, 21`, including `0`) while excluding `'?'` votes from both the sum and divisor.
When at least `1` numeric vote exists in a `'revealed'` round, the estimation system shall:
1. Format the display average to at most `1` decimal place using standard half-up rounding and omitting trailing `.0` for whole numbers (for example, `0` -> `"0"`, `5` -> `"5"`, `1.5` -> `"1.5"`, `4.333...` -> `"4.3"`).
2. Snap `recommendedScore` from the exact unrounded arithmetic mean to the closest value in `[0, 1, 2, 3, 5, 8, 13, 21]` by minimum absolute difference, breaking exact midpoint ties (`0.5`, `1.5`, `2.5`, `4.0`, `6.5`, `10.5`, `17.0`) upward to the higher Fibonacci value.
When a `'revealed'` round contains `1` or more votes and every vote is `'?'` (`0` numeric votes), the estimation system shall set `average: null`, `formattedAverage: null`, and `recommendedScore: null`.

**Acceptance Criteria:**
- **Given** revealed votes `['0', '2', '?']`, **When** scores are calculated, **Then** `'0'` is counted as numeric (`(0 + 2) / 2 = 1`), `'?'` is excluded from the mean but retained in `participants`, `average` is `1`, `formattedAverage` is `"1"`, and `recommendedScore` is `1`.
- **Given** revealed numeric votes producing each exact midpoint (`['0','1']` -> `0.5`, `['1','2']` -> `1.5`, `['2','3']` -> `2.5`, `['3','5']` -> `4.0`, `['5','8']` -> `6.5`, `['8','13']` -> `10.5`, `['13','21']` -> `17.0`), **When** scores are calculated, **Then** `recommendedScore` snaps upward to `1`, `2`, `3`, `5`, `8`, `13`, and `21` respectively.
- **Given** revealed numeric votes whose exact mean is `6.49` (for example, 99 votes of `'5'` and 49 votes of `'8'`, or any combination strictly below `6.5` that rounds to `"6.5"` at one decimal place), **When** scores are calculated, **Then** `recommendedScore` snaps to `5` based on the unrounded mean (`6.49 < 6.5`).
- **Given** revealed votes `['3', '5', '5']`, **When** scores are calculated, **Then** `formattedAverage` is `"4.3"` and `recommendedScore` is `5`.
- **Given** revealed votes `['?', '?']`, **When** scores are calculated, **Then** `average` is `null`, `formattedAverage` is `null`, `recommendedScore` is `null`, and `targetScore` defaults to `null` until overridden.

### R8: Post-Reveal Target Score Override

While an estimation round is in an active (non-expired) `'revealed'` state, when any authenticated viewer selects a numeric Fibonacci value (`0, 1, 2, 3, 5, 8, 13, 21`) as an override, the estimation system shall update the round's shared `targetScore` to that value while preserving all recorded votes, `average`, and `recommendedScore`, refresh the round's last-activity timestamp, publish a live session update notification, and return the updated session snapshot.
If a caller attempts to select `'?'` or any non-Fibonacci value as an override, or attempts to set an override while the round is in `'voting'` or expired state, then the estimation system shall reject the request (`validation-error` for invalid score; `invalid-state` for non-revealed round) and leave session state unchanged.

**Acceptance Criteria:**
- **Given** a `'revealed'` round with votes `['3', '8']` (`recommendedScore: 5`, `targetScore: 5`), **When** any viewer selects override score `8`, **Then** `targetScore` becomes `8` for all viewers while `recommendedScore` remains `5` and recorded votes remain `['3', '8']`.
- **Given** a `'revealed'` round where all votes are `['?']` (`recommendedScore: null`, `targetScore: null`), **When** a viewer selects override score `3`, **Then** `targetScore` becomes `3` (`0` is also accepted if `0` is selected) while `average` and `recommendedScore` remain `null`.
- **Given** a `'voting'` round or an expired `'revealed'` round, **When** a caller invokes target score override with `5`, **Then** the request fails with `invalid-state` and no override is saved.

### R9: Round Reset (Re-Vote) and 24-Hour Inactivity Expiration

When any authenticated viewer triggers a round reset (**Reset** / **Re-vote**) on an issue, the estimation system shall advance the issue to a new idle `'voting'` round with a distinct round identifier, `0` participants, `viewerCard: null`, `average: null`, `recommendedScore: null`, and `targetScore: null`, remove prior round vote records, publish a live session update notification, and return the clean session snapshot.
Whenever at least `86,400,000` milliseconds (`24` hours) have elapsed since a round's last state-mutating activity (`now - updatedAt >= 86,400,000`), the estimation system shall treat that round as expired:
1. Session queries shall return a clean idle `'voting'` snapshot (`0` participants, all score fields `null`) without extending `updatedAt`.
2. Casting a vote shall start a fresh `'voting'` round containing only the newly cast vote and discard stale prior-round votes.
3. Attempting vote reveal, post-reveal score override, or Story Points application against an expired round shall fail (`precondition-failed` for reveal; `invalid-state` for override or apply) without exposing or writing stale votes.

**Acceptance Criteria:**
- **Given** an active `'voting'` or `'revealed'` round with existing votes and an override score, **When** any viewer triggers **Reset / Re-vote**, **Then** the session transitions to a fresh `'voting'` round with `0` participants and `targetScore: null`, and prior-round votes never appear in the new round.
- **Given** a round whose last mutation occurred at `t = 1,000,000`, **When** queried at `now = 87,399,999` (`elapsed = 86,399,999` ms) or `now = 999,500` (minor negative clock skew), **Then** the round remains active and retains its votes and status.
- **Given** a round whose last mutation occurred at `t = 1,000,000` with unrevealed or revealed votes, **When** queried at `now = 87,400,000` (`elapsed = 86,400,000` ms), **Then** the session projects as an empty `'voting'` round with `0` participants and `viewerCard: null`.
- **Given** a round expired at `elapsed >= 86,400,000` ms that previously held votes `['5', '8']`, **When** User C casts `'2'`, **Then** a new `'voting'` round is created containing only User C's vote (`1` participant total).

### R10: Zero-Configuration Story Points Field Detection

When loading an issue session or preparing to write Story Points, the estimation system shall inspect the issue's editable field metadata under the acting user's context and dynamically identify the target Story Points field:
1. A candidate field matches only when its whitespace-trimmed display name equals `'Story Points'` or `'Story point estimate'` (case-insensitive exact match), its schema type (when present) equals `'number'`, and its allowed operations list (when present) includes `'set'`.
2. If multiple candidate fields match on the same issue screen, any field matching `'Story Points'` (case-insensitive) shall take precedence over `'Story point estimate'`, and ties within the same name tier shall break by ascending lexicographical field identifier (`fieldId`).
3. If no candidate field matches, or if editable field metadata is empty, malformed, or inaccessible for the viewer, the estimation system shall report `storyPointsField: null` without failing session retrieval.

**Acceptance Criteria:**
- **Given** issue edit metadata containing `customfield_10016` named `'Story Points'` (`schema.type: 'number'`) on a company-managed project, **When** field detection runs, **Then** it returns `{ fieldId: 'customfield_10016', fieldName: 'Story Points' }`.
- **Given** issue edit metadata containing `customfield_10024` named `'  story point estimate '` (`schema.type: 'number'`) on a team-managed project, **When** field detection runs, **Then** it returns `{ fieldId: 'customfield_10024', fieldName: 'Story point estimate' }` (preserving trimmed display name or field's trimmed label).
- **Given** issue edit metadata containing both `customfield_10099` (`'Story Points'`) and `customfield_10001` (`'Story point estimate'`), **When** field detection runs, **Then** `customfield_10099` wins; if both `customfield_10020` and `customfield_10010` are named `'Story Points'`, `customfield_10010` wins.
- **Given** issue edit metadata containing only `'Story Points Legacy'`, a non-numeric `'Story Points'` field (`schema.type: 'string'`), a read-only field (`operations: []`), an empty `fields` map, or a `403` metadata response for a read-only observer, **When** session load runs, **Then** `storyPointsField` is `null` and the session snapshot still loads cleanly.

### R11: User-Attributed Story Points Write-Back and Failure Atomicity

While an estimation round is in an active (non-expired) `'revealed'` state, when an authenticated viewer submits **Set Story Points** with a valid numeric Fibonacci score (`0, 1, 2, 3, 5, 8, 13, 21`), the estimation system shall inspect the issue's editable Story Points field and attempt to update that field on the issue using the acting user's permissions and attribution:
1. **When an editable Story Points field is present and the issue update succeeds:** The estimation system shall write the numeric Fibonacci score (`0` included) to that field, clear the issue's estimation round back to a clean idle `'voting'` state (`0` participants), publish a `'points-applied'` live session notification containing the applied score, and return `{ ok: true, appliedScore, fieldName, session }`.
2. **When no editable Story Points field is present on the issue screen:** The estimation system shall perform no issue write, leave the `'revealed'` round, votes, and `targetScore` completely intact, and return `{ ok: false, reason: 'missing-field', score }` with an explanatory message.
3. **When the host platform rejects the user's permission (`401` or `403`) or fails the update (`400`, `404`, `5xx`, or transport error):** The estimation system shall leave the `'revealed'` round, votes, and `targetScore` completely intact and return `{ ok: false, reason: 'forbidden' | 'jira-error' }` with an actionable error message.
If Story Points application is invoked while the round is not in an active `'revealed'` state, then the estimation system shall reject the request with `invalid-state` before attempting any issue update.

**Acceptance Criteria:**
- **Given** an active `'revealed'` round and an issue with editable field `customfield_10016` (`'Story Points'`), **When** a user with edit permission applies score `0` or `8`, **Then** the issue field `customfield_10016` is updated to `0` or `8` as the acting user, the poker round resets to an empty `'voting'` state, `'points-applied'` is published, and `{ ok: true }` is returned.
- **Given** an active `'revealed'` round on a Sub-task or Bug screen lacking any editable Story Points field, **When** a user attempts to apply score `5`, **Then** `{ ok: false, reason: 'missing-field', score: 5 }` is returned and all revealed votes and `targetScore: 5` remain intact.
- **Given** an active `'revealed'` round where the acting user lacks Jira `Edit Issues` permission (`403`) or Jira returns `500`, **When** the user attempts to apply score `5`, **Then** `{ ok: false, reason: 'forbidden' }` (or `'jira-error'`) is returned and the `'revealed'` round remains intact so another teammate can apply the score or copy it.
- **Given** a `'voting'` or expired round, **When** a caller invokes Story Points write-back, **Then** the request is rejected with `invalid-state` and Jira is not modified.

### R12: Live Multi-User Synchronization and Parent Issue Refresh

When an issue estimation panel mounts, the panel shall subscribe to live session events for the current issue and unsubscribe cleanly when unmounted.
Whenever a peer participant casts, updates, or withdraws a vote, reveals votes, overrides the post-reveal target score, or resets the round, every other open panel on that issue shall automatically fetch and render its updated caller-scoped session snapshot without polling or full-page reload.
Whenever Story Points are successfully applied—either directly by the acting viewer or by a peer whose `'points-applied'` event arrives over the live channel—every open panel on that issue shall update to the cleared idle session state and trigger a host issue view refresh so the updated Story Points field renders immediately on the issue page.

**Acceptance Criteria:**
- **Given** User A and User B both have the Scrum Poker panel open on the same issue, **When** User A casts a vote, reveals votes, selects override `13`, or clicks **Re-vote**, **Then** User B's panel receives the live channel event and updates automatically to show the corresponding state (preserving vote secrecy while `'voting'`).
- **Given** User A and User B both have the panel open on a `'revealed'` round, **When** User A successfully clicks **Set Story Points → 8**, **Then** both User A's panel and User B's panel transition to the cleared idle state and both invoke host issue view refresh.
- **Given** an open issue panel subscribed to live updates, **When** the panel unmounts, **Then** its live subscription is released so unmounted views do not process subsequent events.

### R13: Issue Panel Controls, Theme Sync, Accessibility, and Clipboard Fallback

Upon initialization, the issue panel shall enable host theme synchronization so Light and Dark Jira themes render with appropriate surface, text, border, and interactive contrast using local styling only.
The issue panel shall render the nine deck cards (`0, 1, 2, 3, 5, 8, 13, 21, ?`) with accessible `aria-pressed` states and state-appropriate controls:
1. **During `'voting'`:**
   - Selecting an unpressed card casts or updates the user's vote; selecting the currently pressed card (`viewerCard`) withdraws it.
   - With `0` voters: displays an empty-state prompt (`Pick a card to start voting`) and disables or omits **Show Votes** and **Reset**.
   - With `>= 1` voters: displays each voter chip as `<Display Name> ✓` (never displaying card values) and enables **Show Votes** and **Reset**.
2. **During `'revealed'`:**
   - Displays each voter chip as `<Display Name>: <card>`, displays the formatted numeric **Average** and **Recommended** Fibonacci value (or `"No numeric votes"` when all votes are `'?'`), enables numeric cards (`0..21`) to override `targetScore` (marking the active `targetScore` card with `aria-pressed="true"`), disables the `'?'` card button, and enables **Re-vote**.
   - Where `storyPointsField` is available and `targetScore !== null`, the panel shall render a primary **Set Story Points → `<targetScore>`** action and, after a successful save, display confirmation feedback (`Story Points set to <score>`) on the cleared idle panel.
   - Where `storyPointsField` is `null` (or after an `applyStoryPoints` response with `reason: 'missing-field'`), the panel shall display an inline warning stating that no editable Story Points field is available on this issue screen and, whenever `targetScore !== null`, render **Copy Score (`<targetScore>`)** instead of **Set Story Points**.
   - When the user activates **Copy Score (`<targetScore>`)**, the panel shall copy the decimal text of `targetScore` (for example, `"5"`, `"0"`, `"21"`) to the system clipboard and display accessible `"Copied!"` confirmation feedback while keeping the `'revealed'` round visible; if clipboard access fails, the panel shall display an inline fallback message containing the numeric score without crashing.
   - When all cast votes are `'?'` and `targetScore` is `null`, neither **Set Story Points** nor **Copy Score** shall be enabled, and the panel shall prompt that selecting any numeric card (`0..21`) enables setting or copying the score alongside **Re-vote**.

**Acceptance Criteria:**
- **Given** a `'voting'` panel where the viewer selected `'5'` and a teammate also voted, **When** rendered, **Then** card `'5'` has `aria-pressed="true"`, all other cards have `aria-pressed="false"`, both voter chips display `<Name> ✓`, and **Show Votes** and **Reset** are enabled.
- **Given** a `'revealed'` panel with `storyPointsField` present and `targetScore: 8`, **When** the user clicks card `13`, **Then** card `13` shows `aria-pressed="true"`, card `?` is disabled, and the primary button updates to **Set Story Points → 13**.
- **Given** a `'revealed'` panel where `storyPointsField` is `null` and `targetScore` is `5`, **When** rendered and the user clicks **Copy Score (5)**, **Then** the missing-field warning is visible, `"5"` is written to the clipboard, `"Copied!"` confirmation is announced/displayed, and the revealed votes remain visible.
- **Given** a `'revealed'` panel where all votes are `'?'` (`targetScore: null`), **When** rendered before any numeric override is clicked, **Then** `"No numeric votes"` and **Re-vote** are shown, no save/copy button is active, and clicking numeric card `2` activates **Set Story Points → 2** (or **Copy Score (2)** when `storyPointsField` is `null`).

### R14: Zero External Egress and Minimal Platform Boundary

The application shall execute all backend logic, session storage, live event delivery, user profile lookups, issue field inspection, and UI rendering strictly inside the host platform (`Runs on Atlassian`) with zero external network egress, zero external stylesheets/fonts/scripts/images, and zero advertisements or telemetry.
The application manifest shall expose the `Scrum Poker` per-issue panel (`jira:issuePanel`) and request only the four required platform permission scopes: `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user`.

**Acceptance Criteria:**
- **Given** the application manifest and bundled UI assets, **When** inspected, **Then** zero external egress permissions (`permissions.external`) and zero external HTTP/HTTPS asset or API URLs are present, and only `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user` scopes are declared.
- **Given** any backend error or diagnostic log event during voting, **When** `status` is `'voting'`, **Then** unrevealed card values, authentication credentials, and personal email addresses are never written to logs.

---

## Not Supported / Out of Scope

**Rejected Inputs (Active Enforcement):**
- Casting cards outside `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'` (rejected with `validation-error` per R1).
- Overriding or applying non-Fibonacci, negative, decimal, `NaN`, or `'?'` Story Points values (rejected with `validation-error` per R1, R8, R11).
- Revealing votes when `0` active votes exist in the round (rejected with `precondition-failed` per R6).
- Casting or withdrawing votes while a round is actively `'revealed'`, or overriding/applying Story Points while a round is in `'voting'` or expired state (rejected with `invalid-state` per R3, R8, R9, R11).
- Requests missing authenticated host issue or user account context (rejected with `validation-error` per R2).

**Deferred Capabilities (Non-Goals):**
- Custom card decks (such as T-shirt sizes, powers of two, or admin-configurable card sets).
- Multi-issue JQL estimation lobbies, external room links, or cross-issue batch estimation sessions.
- Active non-voting viewer presence tracking / client heartbeat indicators (`D-04`).
- Facilitator / Scrum Master host-lock role restrictions (`D-05`).
- Countdown timers, historical estimation analytics dashboards, or persistent round history after Story Points are saved or rounds are reset (`D-08`).
- Automatic creation or screen-configuration modification of missing Story Points custom fields in Jira administration settings (`D-07`).

**Untouched Subsystems:**
- Existing Jira issue fields other than the single matched editable Story Points field during explicit **Set Story Points** confirmation must never be modified.
- Issue comments, workflow status transitions, sprint assignments, and project administration configurations remain completely untouched.
