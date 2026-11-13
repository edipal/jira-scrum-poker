# Estimation Rules & Score Calculation Specification

## Scope and Domain Concepts

Defines the deterministic rules governing selectable estimation cards, numeric score validation, participant projection and vote secrecy redaction, numeric average calculation, nearest-Fibonacci recommendation snapping, 24-hour inactivity expiration evaluation, and editable Story Points field qualification `[20261113-implement-scrum-poker-for-jira-per-plan]`.

Stateful round mutations, concurrent storage isolation, live event notifications, and user-attributed Story Points updates are governed by [estimation-session.md](estimation-session.md). Interactive panel controls, live client synchronization, and clipboard fallback presentation are governed by [issue-panel.md](issue-panel.md).

### Domain Entities and Value Objects
- **Deck Card:** One of the nine canonical estimation symbols in fixed display order: `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'` `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`.
- **Numeric Fibonacci Score:** One of the eight non-negative Fibonacci integers in `[0, 1, 2, 3, 5, 8, 13, 21]` `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`.
- **Uncertainty Card (`'?'`):** A valid castable card indicating uncertainty or pass; excluded from numeric averages and disallowed as a post-reveal target score or Story Points value `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R7, R8]`.
- **Participant Projection:** The caller-scoped representation of a voter (`accountId`, normalized `displayName`, optional `avatarUrl`, `hasVoted`, and redacted or revealed `card`) `[20261113-implement-scrum-poker-for-jira-per-plan / R5]`.
- **Story Points Field Descriptor:** The matched editable numeric issue field (`fieldId`, `fieldName`), or `null` when no qualifying field is editable on the issue screen `[20261113-implement-scrum-poker-for-jira-per-plan / R10]`.

---

## Invariants and Business Rules

- **Fixed Nine-Card Fibonacci Deck:** The selectable deck is strictly `['0', '1', '2', '3', '5', '8', '13', '21', '?']` in exact canonical order. No whitespace trimming or implicit coercion is performed on card or score inputs `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`.
- **Zero Is Numeric:** Card `'0'` represents the numeric value `0` and participates fully in both the numerator and denominator of the arithmetic mean as well as valid target scores `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R7, R8, R11]`.
- **Snapping Precedes Display Formatting:** Nearest-Fibonacci snapping always evaluates the exact unrounded arithmetic mean of numeric votes rather than the one-decimal display string `[20261113-implement-scrum-poker-for-jira-per-plan / R7]`.
- **Upward Midpoint Tie-Breaking:** Whenever the exact arithmetic mean falls equidistant between two adjacent numeric Fibonacci values (`0.5`, `1.5`, `2.5`, `4.0`, `6.5`, `10.5`, `17.0`), `recommendedScore` snaps upward to the higher Fibonacci value (`1`, `2`, `3`, `5`, `8`, `13`, `21` respectively) `[20261113-implement-scrum-poker-for-jira-per-plan / R7]`.
- **Voter-Only Deterministic Ordering:** Only users holding a recorded vote in the active round appear in `participants`. Participants are ordered by ascending vote timestamp (`votedAt`), with exact timestamp ties broken by ascending lexicographical `accountId` `[20261113-implement-scrum-poker-for-jira-per-plan / R5]`.
- **Non-Empty Display Name Guarantee:** Every projected participant entry has a non-empty trimmed `displayName`; blank or whitespace-only profile names fall back to a non-empty identifier (such as `'Unknown User'` or `accountId`) `[20261113-implement-scrum-poker-for-jira-per-plan / R5]`.
- **Strict Hidden-State Card Redaction:** While a round is in `'voting'`, every entry in `participants` reports `hasVoted: true` and `card: null`, exposing only the requesting viewer's own selection via `viewerCard` `[20261113-implement-scrum-poker-for-jira-per-plan / R5]`.
- **Exact 24-Hour Expiration Threshold:** A round is expired if and only if `now - updatedAt >= 86,400,000` milliseconds (`24` hours). Elapsed durations strictly below `86,400,000` ms—including `86,399,999` ms and negative deltas (`now < updatedAt`) from minor clock skew—remain active `[20261113-implement-scrum-poker-for-jira-per-plan / R9]`.

---

## Observable Domain Behaviour and Operations

### Validate Deck Card and Numeric Score `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`
Validates incoming vote selections, post-reveal overrides, and Story Points write-back values.
- **Preconditions:** Caller supplies a candidate deck card symbol or numeric score.
- **Inputs & Defaults:** Exact string match for deck cards (`'0'`..`'21'`, `'?'`); exact finite numeric match for Fibonacci scores (`0, 1, 2, 3, 5, 8, 13, 21`, rejecting signed `-0`). No defaults or whitespace normalization are applied.
- **Postconditions:** Returns the validated deck card or numeric Fibonacci value; classifies `'0'`..`'21'` as numeric (`0`..`21`) and `'?'` as non-numeric.
- **Error Semantics:** Empty strings (`""`), whitespace-padded values (`" 5"`, `"5 "`, `"   "`), negative numbers, signed `-0`, decimals (`3.5`, `4.5`), non-finite values, missing/`null` values, non-Fibonacci integers (`4`, `6`, `22`, `34`, `100`), arbitrary strings (`"coffee"`), or `'?'` submitted where a numeric score is required fail with `validation-error`.

### Compute Revealed Summary Statistics `[20261113-implement-scrum-poker-for-jira-per-plan / R7]`
Calculates the numeric average, formatted average text, and nearest-Fibonacci recommendation for a `'revealed'` round.
- **Preconditions:** Round status is `'revealed'` with `1` or more recorded votes.
- **Inputs & Defaults:** Collection of recorded deck cards (`'0'`..`'21'`, `'?'`).
- **Postconditions:**
  - Filters numeric cards (`0, 1, 2, 3, 5, 8, 13, 21`), excluding `'?'` from both sum and count.
  - **When `>= 1` numeric vote exists:**
    - `average`: Exact arithmetic mean (`sum / numericVoteCount`).
    - `formattedAverage`: Rounded half-up to at most `1` decimal place with trailing `.0` omitted (`0` -> `"0"`, `5` -> `"5"`, `1.5` -> `"1.5"`, `4.333...` -> `"4.3"`).
    - `recommendedScore`: Numeric Fibonacci value minimizing `|candidate - average|` using the unrounded `average` (for example, `6.49` snaps to `5`, whereas `6.5` snaps upward to `8`).
  - **When `0` numeric votes exist (all votes are `'?'`):**
    - Sets `average: null`, `formattedAverage: null`, and `recommendedScore: null`.

### Project Caller-Scoped Session Snapshot `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R5, R7, R8, R9]`
Produces a deterministic, redacted or revealed session view tailored to the requesting `viewerAccountId` at timestamp `now`.
- **Preconditions:** Authenticated `viewerAccountId` and current timestamp `now` are provided alongside optional stored round metadata and vote records.
- **Postconditions:**
  - **Uninitialized or Expired Round (`meta` absent or `now - updatedAt >= 86,400,000` ms):** Projects status `'voting'`, `participants: []` (`0` items), `viewerCard: null`, `average: null`, `formattedAverage: null`, `recommendedScore: null`, and `targetScore: null` without mutating `updatedAt`.
  - **Active `'voting'` Round:** Projects sorted voter-only `participants` with `hasVoted: true` and `card: null`, sets `viewerCard` to the caller's recorded card (or `null` if unvoted), and sets `average`, `formattedAverage`, `recommendedScore`, and `targetScore` to `null`.
  - **Active `'revealed'` Round:** Projects sorted voter-only `participants` with `hasVoted: true` and each voter's actual `card` (`'0'`..`'21'` or `'?'`), sets `viewerCard` to the caller's recorded card (or `null`), populates `average`, `formattedAverage`, and `recommendedScore`, and resolves `targetScore` to the active override score if set, otherwise `recommendedScore`.

### Qualify Editable Story Points Field `[20261113-implement-scrum-poker-for-jira-per-plan / R10]`
Determines which custom or system issue field, if any, represents the editable Story Points field on an issue's edit screen.
- **Inputs & Defaults:** Issue editable-fields metadata map (`fieldId -> { name, schema, operations }`) or absent/malformed metadata.
- **Qualification Rules:**
  1. Whitespace-trimmed field `name` matches `'Story Points'` or `'Story point estimate'` case-insensitively (exact match after trimming; partial/suffixed names such as `'Story Points Legacy'` do not match).
  2. Field `schema.type`, when present, equals `'number'`.
  3. Field `operations` list, when present, includes `'set'`.
- **Precedence & Tie-Breaking:**
  1. Any qualifying field matching `'Story Points'` (case-insensitive) takes precedence over `'Story point estimate'`.
  2. Multiple qualifying fields within the same name tier break ties by ascending lexicographical `fieldId` (for example, `'customfield_10010'` precedes `'customfield_10020'`).
- **Postconditions:** Returns `{ fieldId, fieldName }` (with trimmed `fieldName`) for the winning field, or `null` when zero fields qualify or metadata is empty, malformed, or inaccessible.

---

## Projection Summary by Round Condition

| Round Condition | Projected Status | `participants` Card Visibility | `viewerCard` | `average` / `recommendedScore` | `targetScore` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Uninitialized or expired (`now - updatedAt >= 86,400,000` ms) `[20261113-implement-scrum-poker-for-jira-per-plan / R2, R9]` | `'voting'` | Empty (`0` items) | `null` | `null` / `null` | `null` |
| Active `'voting'` `[20261113-implement-scrum-poker-for-jira-per-plan / R5]` | `'voting'` | `card: null`, `hasVoted: true` | Caller's card or `null` | `null` / `null` | `null` |
| Active `'revealed'` (`>= 1` numeric vote) `[20261113-implement-scrum-poker-for-jira-per-plan / R6, R7, R8]` | `'revealed'` | Actual card (`'0'`..`'21'`, `'?'`) | Caller's card or `null` | Numeric mean / nearest Fibonacci | Override score if set, else `recommendedScore` |
| Active `'revealed'` (all `'?'` votes) `[20261113-implement-scrum-poker-for-jira-per-plan / R7, R8]` | `'revealed'` | Actual card (`'?'`) | Caller's card or `null` | `null` / `null` | Override score if set, else `null` |

---

## Error Semantics and Edge Cases

- **Invalid Card or Score (`validation-error`):** Triggered immediately on any non-deck card string or non-Fibonacci target score. Leaves session state untouched `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`.
- **Exact Midpoint Boundary Values:**
  - `0.5` (`['0', '1']`) -> `1`
  - `1.5` (`['1', '2']`) -> `2`
  - `2.5` (`['2', '3']`) -> `3`
  - `4.0` (`['3', '5']`) -> `5`
  - `6.5` (`['5', '8']`) -> `8`
  - `10.5` (`['8', '13']`) -> `13`
  - `17.0` (`['13', '21']`) -> `21` `[20261113-implement-scrum-poker-for-jira-per-plan / R7]`.
- **Sub-Midpoint Unrounded Precision:** An unrounded mean strictly below a midpoint (such as `6.49`, which formats to `"6.5"` at one decimal place) snaps downward to `5` (`|6.49 - 5| = 1.49 < |6.49 - 8| = 1.51`) `[20261113-implement-scrum-poker-for-jira-per-plan / R7]`.
- **Expiration Boundary Precision:** At `elapsed = 86,399,999` ms or negative clock-skew deltas (`elapsed < 0`), the round remains active; at `elapsed = 86,400,000` ms, the round is expired `[20261113-implement-scrum-poker-for-jira-per-plan / R9]`.

---

## Unsupported Operations

- **Custom or Non-Fibonacci Decks:** T-shirt sizes (`XS`, `S`, `M`, `L`), powers of two (`4`, `16`, `32`), coffee/break cards, decimals, negative numbers, and Fibonacci numbers above `21` (such as `34`, `55`, `89`) are not supported and are actively rejected with `validation-error` `[20261113-implement-scrum-poker-for-jira-per-plan / R1]`.
- **Non-Numeric Target Scores:** Submitting `'?'` as a post-reveal override or Story Points value is actively rejected with `validation-error` `[20261113-implement-scrum-poker-for-jira-per-plan / R1, R8, R11]`.
- **Non-Numeric or Read-Only Story Points Fields:** Fields with non-numeric schemas (such as text/string fields) or lacking `'set'` permission in editable metadata are never matched as writable Story Points targets `[20261113-implement-scrum-poker-for-jira-per-plan / R10]`.
