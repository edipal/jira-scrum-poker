# Implementation Plan: Scrum Poker for Jira

Phased delivery plan for **Scrum Poker for Jira** (`scrum-poker-jira`), translating `shared/requirements.md` (`R1`–`R14`) into three sequential, self-contained phases aligned with the repository architecture (`src/domain/`, Forge backend modules under `src/`, and the Custom UI issue panel under `static/panel/src/`).

## Phase 1: Scrum Poker Domain Rules, Fibonacci Scoring, Expiry, and Jira Field Matching

Requirements: R1, R5, R7, R9, R10

### Scope

Establish the pure, stateless, framework-free domain layer in `src/domain/` with zero `@forge/*`, React, or browser DOM dependencies so all business invariants are deterministically verifiable in isolation and reusable across backend resolvers and frontend views:

- **Deck & Input Validation (`src/domain/types.ts`, `src/domain/deck.ts` — `R1`):**
  - Canonical 9-card Fibonacci deck (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`) and 8-value numeric Fibonacci score set (`0`, `1`, `2`, `3`, `5`, `8`, `13`, `21`), classifying `'?'` as non-numeric.
  - Typed `PokerDomainError` (`code: 'validation-error' | 'invalid-state' | 'precondition-failed'`) and strict allowlist validators (`validateDeckCard`, `validateFibonacciScore`, type guards, and numeric card conversion) rejecting empty, whitespace-padded, negative, `-0`, decimal, `NaN`, `Infinity`, `null`, `undefined`, and non-Fibonacci values with `validation-error`.
- **Numeric Average & Nearest-Fibonacci Snapping (`src/domain/scoring.ts` — `R7`):**
  - Exact arithmetic mean across numeric votes (`0` through `21`, counting `'0'` as `0` and excluding `'?'` from sum and divisor).
  - Display formatting (`formatAverage`) rounded half-up to at most `1` decimal place with trailing `.0` omitted.
  - Nearest-Fibonacci recommendation (`snapToNearestFibonacci`) computed from the exact unrounded arithmetic mean against `[0, 1, 2, 3, 5, 8, 13, 21]`, breaking exact midpoint ties (`0.5`, `1.5`, `2.5`, `4.0`, `6.5`, `10.5`, `17.0`) upward, and returning `null` summary metrics when zero numeric votes exist.
- **Vote Secrecy Projection, Participant Ordering & 24-Hour Expiry (`src/domain/session-view.ts` — `R5`, `R7`, `R9`):**
  - Exact 24-hour expiration check (`isRoundExpired`: `nowMs - updatedAt >= 86_400_000`, preserving `86_399_999` ms and negative clock-skew deltas).
  - Voter-only participant projection (`projectSessionSnapshot`) sorted by ascending `votedAt` with ascending lexicographical `accountId` tie-breaking, non-empty display-name fallback (`normalizeDisplayName`), pre-reveal card redaction (`hasVoted: true`, `card: null`, caller-only `viewerCard`), revealed score/override resolution (`targetScore = overrideScore ?? recommendedScore`), and clean idle `'voting'` snapshots when uninitialized or expired.
- **Zero-Config Story Points Field Detection (`src/domain/jira-fields.ts` — `R10`):**
  - Pure `detectStoryPointsField` inspection of Jira `editmeta` payloads matching trimmed `'Story Points'` or `'Story point estimate'` (case-insensitive), enforcing `schema.type === 'number'` (when present) and `operations` containing `'set'` (when present), prioritizing `'Story Points'` over `'Story point estimate'` with ascending lexicographical `fieldId` tie-breaking, and returning `null` safely on empty, non-matching, or malformed metadata.

## Phase 2: Forge Backend Resolvers, Per-Voter KVS Storage, Realtime Sync, and Jira Write-Back

Requirements: R1, R2, R3, R4, R5, R6, R8, R9, R10, R11, R14

### Scope

Implement the Atlassian Forge backend (`src/storage/`, `src/jira/`, `src/realtime/`, `src/resolvers/`, `src/index.ts`, and `manifest.yml` verification) enforcing isolated concurrent persistence, strict trust-boundary validation, live event notifications, and user-attributed Jira REST v3 integration:

- **Authenticated Host Context & Input Guards (`R1`, `R2`):**
  - Derive `issueId` and caller `accountId` exclusively from Forge's authenticated resolver context (`context.extension.issue.id`, `context.accountId`), ignoring client-supplied issue/account identifiers and rejecting missing context or invalid card/score inputs with `validation-error` before any storage or Jira I/O.
- **Per-Voter KVS Isolation, Cursor Pagination & Lifecycle Transitions (`R3`, `R4`, `R5`, `R6`, `R8`, `R9`):**
  - Store round metadata under `poker:${issueId}:meta` and each participant's vote under `poker:${issueId}:${roundId}:vote:${accountId}` with `{ ttl: { value: 24, unit: 'HOURS' } }`.
  - Load and clean up 100% of round votes across `>100` participants by looping `@forge/kvs` `nextCursor` pagination to completion.
  - Implement `getSession`, `castVote`, `withdrawVote` (idempotent when unvoted; rejected with `invalid-state` when `'revealed'`), `revealVotes` (`precondition-failed` on `0` votes or expired rounds; idempotent on active `'revealed'` rounds preserving `targetScore`), `selectOverrideScore` (`validation-error` on non-Fibonacci/`'?'`; `invalid-state` on `'voting'` or expired rounds), and `resetRound` (advancing `roundId`, cleaning prior votes, and returning a clean `'voting'` snapshot).
  - Ensure expired rounds (`>= 86_400_000` ms) project as idle without extending `updatedAt`, start a fresh round discarding stale votes on `castVote`, and reject reveal/override/apply mutations.
- **Realtime Publishing & Redaction (`R5`, `R6`, `R8`, `R9`, `R11`):**
  - Publish lightweight event notifications via `@forge/realtime` (`SESSION_UPDATED` and `'points-applied'`) with zero unrevealed card values.
- **Jira REST v3 Profile, `editmeta` & Atomic Story Points Write-Back (`R10`, `R11`, `R14`):**
  - Fetch voter profile metadata and issue `editmeta` via `api.asUser().requestJira(...)`, degrading gracefully to `storyPointsField: null` on `401`/`403` or inaccessible metadata without failing `getSession`.
  - Execute Story Points updates via `PUT /rest/api/3/issue/${issueId}` as the acting user; clear the round and publish `'points-applied'` only on HTTP success, while leaving revealed votes and `targetScore` intact on `'missing-field'`, `'forbidden'` (`401`/`403`), or `'jira-error'` outcomes, and rejecting non-revealed/expired rounds with `invalid-state`.
  - Enforce `manifest.yml` zero external egress (`Runs on Atlassian`, four minimal scopes only) and redacted backend logging (never logging unrevealed cards, credentials, or email addresses).

## Phase 3: Custom UI Jira Issue Panel, Live Synchronization, Score Override, and Clipboard Fallback

Requirements: R12, R13, R14

### Scope

Build the React 19 Custom UI Jira issue panel (`static/panel/src/`) bundled cleanly via Vite with zero external network assets:

- **Theme Sync & Bridge Client (`R12`, `R13`, `R14`):**
  - Enable Jira Light/Dark theme synchronization on startup via `view.theme.enable()` using local CSS custom-property styling with zero external fonts, stylesheets, images, scripts, ads, or telemetry.
  - Subscribe to the issue-scoped `@forge/bridge` `realtime` channel on mount and invoke `unsubscribe()` deterministically on unmount; automatically re-fetch `getSession` on peer mutations and call `view.refresh()` whenever Story Points are applied locally or via a peer `'points-applied'` event.
- **Interactive Voting, Consensus Override & Missing-Field Clipboard Fallback (`R13`):**
  - Render the 9 Fibonacci cards (`0, 1, 2, 3, 5, 8, 13, 21, ?`) with `aria-pressed` states: cast/update or toggle-withdraw votes during `'voting'`; select numeric override scores (`0..21`) with `'?'` disabled during `'revealed'`.
  - Render empty-state guidance (`Pick a card to start voting`) when `0` votes exist, `<Display Name> ✓` voter chips with **Show Votes** and **Reset** enabled when `>= 1` votes exist during `'voting'`, and `<Display Name>: <card>` chips alongside **Average**, **Recommended** (`"No numeric votes"` when all votes are `'?'`), and **Re-vote** during `'revealed'`.
  - Render **Set Story Points → `<targetScore>`** (with post-save `Story Points set to <score>` confirmation) when `storyPointsField` is available, or render an inline missing-field warning and **Copy Score (`<targetScore>`)** with clipboard write, `"Copied!"` confirmation, and inline manual-copy fallback when `storyPointsField` is `null` or `'missing-field'` is returned.
