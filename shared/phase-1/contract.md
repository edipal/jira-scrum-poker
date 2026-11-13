# Phase 1 Contract: Scrum Poker Domain Rules, Fibonacci Scoring, Expiry, and Jira Field Matching

## Signatures

### 1. `src/domain/types.ts`

```ts
export type NumericDeckCard = '0' | '1' | '2' | '3' | '5' | '8' | '13' | '21'

export type QuestionCard = '?'

export type DeckCard = NumericDeckCard | QuestionCard

export type FibonacciScore = 0 | 1 | 2 | 3 | 5 | 8 | 13 | 21

export type RoundStatus = 'voting' | 'revealed'

export type PokerErrorCode = 'validation-error' | 'invalid-state' | 'precondition-failed'

export class PokerDomainError extends Error {
  readonly code: PokerErrorCode

  constructor(code: PokerErrorCode, message: string)
}

export interface StoryPointsFieldInfo {
  readonly fieldId: string
  readonly fieldName: string
}

export interface RoundMeta {
  readonly roundId: string
  readonly status: RoundStatus
  readonly overrideScore: FibonacciScore | null
  readonly updatedAt: number
}

export interface VoteRecord {
  readonly accountId: string
  readonly displayName: string
  readonly avatarUrl?: string | null
  readonly card: DeckCard
  readonly votedAt: number
}

export interface ParticipantView {
  readonly accountId: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly hasVoted: true
  readonly card: DeckCard | null
}

export interface ScoreSummary {
  readonly numericVoteCount: number
  readonly average: number | null
  readonly formattedAverage: string | null
  readonly recommendedScore: FibonacciScore | null
}

export interface SessionSnapshot {
  readonly roundId: string | null
  readonly status: RoundStatus
  readonly participants: readonly ParticipantView[]
  readonly viewerCard: DeckCard | null
  readonly average: number | null
  readonly formattedAverage: string | null
  readonly recommendedScore: FibonacciScore | null
  readonly targetScore: FibonacciScore | null
  readonly storyPointsField: StoryPointsFieldInfo | null
}

export interface ProjectSessionParams {
  readonly meta: RoundMeta | null
  readonly votes: readonly VoteRecord[]
  readonly viewerAccountId: string
  readonly storyPointsField: StoryPointsFieldInfo | null
  readonly nowMs: number
}
```

- **`PokerDomainError` invariants:**
  - `instance instanceof Error === true` and `instance instanceof PokerDomainError === true`.
  - `instance.name === 'PokerDomainError'`.
  - `instance.code` equals the `PokerErrorCode` passed to `constructor`.
  - `instance.message` equals the `message` passed to `constructor`.

---

### 2. `src/domain/deck.ts`

```ts
import type { DeckCard, FibonacciScore, NumericDeckCard } from './types'

export const FIBONACCI_DECK: readonly DeckCard[]

export const NUMERIC_FIBONACCI_SCORES: readonly FibonacciScore[]

export function isValidDeckCard(value: unknown): value is DeckCard

export function isNumericDeckCard(value: unknown): value is NumericDeckCard

export function isValidFibonacciScore(value: unknown): value is FibonacciScore

export function cardToNumericScore(card: DeckCard): FibonacciScore | null

export function validateDeckCard(value: unknown): DeckCard

export function validateFibonacciScore(value: unknown): FibonacciScore
```

- **Behaviour & Error Conditions:**
  - `FIBONACCI_DECK`: Frozen/readonly array containing the exact 9 cards in canonical order: `['0', '1', '2', '3', '5', '8', '13', '21', '?']`.
  - `NUMERIC_FIBONACCI_SCORES`: Frozen/readonly array containing the exact 8 numeric Fibonacci values in ascending order: `[0, 1, 2, 3, 5, 8, 13, 21]`.
  - `isValidDeckCard(value)`: Returns `true` iff `typeof value === 'string'` and `value` strictly matches (no whitespace trimming) one of `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`.
  - `isNumericDeckCard(value)`: Returns `true` iff `typeof value === 'string'` and `value` strictly matches one of `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'` (`false` for `'?'` and all other inputs).
  - `isValidFibonacciScore(value)`: Returns `true` iff `typeof value === 'number'`, `Number.isFinite(value)`, `!Object.is(value, -0)`, and `value` is one of `0, 1, 2, 3, 5, 8, 13, 21`.
  - `cardToNumericScore(card)`: Validates `card` via `validateDeckCard(card)`; returns `0..21` for `'0'..'21'` and `null` for `'?'`. Throws `PokerDomainError` (`code: 'validation-error'`) if `card` is invalid at runtime.
  - `validateDeckCard(value)`: Returns `value` as `DeckCard` when `isValidDeckCard(value)` is `true`; otherwise throws `PokerDomainError` with `code: 'validation-error'`.
  - `validateFibonacciScore(value)`: Returns `value` as `FibonacciScore` when `isValidFibonacciScore(value)` is `true`; otherwise throws `PokerDomainError` with `code: 'validation-error'`.

---

### 3. `src/domain/scoring.ts`

```ts
import type { DeckCard, FibonacciScore, ScoreSummary } from './types'

export function formatAverage(mean: number): string

export function snapToNearestFibonacci(mean: number): FibonacciScore

export function calculateScoreSummary(cards: readonly DeckCard[]): ScoreSummary
```

- **Behaviour & Error Conditions:**
  - `formatAverage(mean)`:
    - Throws `PokerDomainError` (`code: 'validation-error'`) if `typeof mean !== 'number'`, `!Number.isFinite(mean)`, `Object.is(mean, -0)`, or `mean < 0`.
    - Rounds `mean` half-up to at most `1` fractional digit against `mean`'s canonical base-10 decimal representation (`Number.prototype.toString(10)`: when the hundredths digit is `>= 5`, the tenths digit increments by `1`, carrying into the integer part when the tenths digit is `9`), omitting trailing `'.0'` when the rounded result is an integer and omitting grouping separators (e.g., `0 -> '0'`, `0.04 -> '0'`, `0.05 -> '0.1'`, `5 -> '5'`, `1.5 -> '1.5'`, `2.55 -> '2.6'`, `4.333333333333333 -> '4.3'`, `6.49 -> '6.5'`, `9.95 -> '10'`, `17.15 -> '17.2'`).
  - `snapToNearestFibonacci(mean)`:
    - Throws `PokerDomainError` (`code: 'validation-error'`) if `typeof mean !== 'number'`, `!Number.isFinite(mean)`, `Object.is(mean, -0)`, or `mean < 0`.
    - Evaluates the exact unrounded `mean` against `[0, 1, 2, 3, 5, 8, 13, 21]` by minimum `Math.abs(mean - candidate)`, breaking exact midpoint ties (`0.5`, `1.5`, `2.5`, `4.0`, `6.5`, `10.5`, `17.0`) upward to the higher Fibonacci score.
  - `calculateScoreSummary(cards)`:
    - Validates `Array.isArray(cards)` and each element via `validateDeckCard` (throwing `PokerDomainError` with `code: 'validation-error'` on invalid input).
    - Counts `'0'` through `'21'` as numeric votes (`0` through `21`) and excludes `'?'` from both numerator and divisor.
    - When `numericVoteCount === 0` (empty `cards` or all `'?'`), returns `{ numericVoteCount: 0, average: null, formattedAverage: null, recommendedScore: null }`.
    - When `numericVoteCount >= 1`, computes `average = sum / numericVoteCount`, `formattedAverage = formatAverage(average)`, and `recommendedScore = snapToNearestFibonacci(average)` (snapping from exact unrounded `average`).

---

### 4. `src/domain/session-view.ts`

```ts
import type {
  ProjectSessionParams,
  SessionSnapshot,
  StoryPointsFieldInfo,
} from './types'

export const SESSION_TTL_MS: number

export const FALLBACK_DISPLAY_NAME: string

export function isRoundExpired(updatedAt: number, nowMs: number): boolean

export function normalizeDisplayName(displayName: string | null | undefined): string

export function createIdleSessionSnapshot(
  storyPointsField?: StoryPointsFieldInfo | null,
  roundId?: string | null,
): SessionSnapshot

export function projectSessionSnapshot(params: ProjectSessionParams): SessionSnapshot
```

- **Behaviour & Error Conditions:**
  - `SESSION_TTL_MS`: Exact 24-hour expiration threshold in milliseconds (`86_400_000`).
  - `FALLBACK_DISPLAY_NAME`: Exact fallback display label (`'Unknown User'`).
  - `isRoundExpired(updatedAt, nowMs)`:
    - Throws `PokerDomainError` (`code: 'validation-error'`) if `typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || typeof nowMs !== 'number' || !Number.isFinite(nowMs)`.
    - Returns `nowMs - updatedAt >= SESSION_TTL_MS` (`true` at `86_400_000` ms and above; `false` at `86_399_999` ms and below, including negative deltas when `nowMs < updatedAt`).
  - `normalizeDisplayName(displayName)`:
    - If `typeof displayName === 'string'` and `displayName.trim().length > 0`, returns `displayName.trim()`.
    - Otherwise returns `FALLBACK_DISPLAY_NAME` (`'Unknown User'`).
  - `createIdleSessionSnapshot(storyPointsField = null, roundId = null)`:
    - Validates `roundId === undefined || roundId === null || (typeof roundId === 'string' && roundId.trim().length > 0 && roundId === roundId.trim())`; throws `PokerDomainError` (`code: 'validation-error'`) if a non-null `roundId` fails this predicate.
    - Returns `{ roundId: roundId ?? null, status: 'voting', participants: [], viewerCard: null, average: null, formattedAverage: null, recommendedScore: null, targetScore: null, storyPointsField: storyPointsField ?? null }`.
  - `projectSessionSnapshot(params)`:
    - Validates `params !== null && typeof params === 'object'`, `typeof params.viewerAccountId === 'string' && params.viewerAccountId.trim().length > 0 && params.viewerAccountId === params.viewerAccountId.trim()`, and `typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)`; otherwise throws `PokerDomainError` (`code: 'validation-error'`).
    - If `params.meta === null`, returns `createIdleSessionSnapshot(params.storyPointsField, null)`.
    - Validates `params.meta !== null && typeof params.meta === 'object'` and evaluates `isRoundExpired(params.meta.updatedAt, params.nowMs)` (throwing `PokerDomainError` with `code: 'validation-error'` if `params.meta` is not an object or `updatedAt` is non-finite). If expired, returns `createIdleSessionSnapshot(params.storyPointsField, null)`.
    - Validates active `params.meta`: `typeof params.meta.roundId === 'string' && params.meta.roundId.trim().length > 0 && params.meta.roundId === params.meta.roundId.trim()`, `params.meta.status === 'voting' || params.meta.status === 'revealed'`, and `params.meta.overrideScore === null || isValidFibonacciScore(params.meta.overrideScore)`; validates `Array.isArray(params.votes)` and each `vote` in `params.votes` (`vote !== null && typeof vote === 'object'`, `typeof vote.accountId === 'string' && vote.accountId.trim().length > 0 && vote.accountId === vote.accountId.trim()`, `isValidDeckCard(vote.card)`, `typeof vote.votedAt === 'number' && Number.isFinite(vote.votedAt)`); throws `PokerDomainError` (`code: 'validation-error'`) on any violation.
    - Deduplicates repeated `accountId` records (retaining the entry with the highest `votedAt`, or the later array element on an exact `votedAt` tie).
    - Sorts unique voters by ascending `votedAt`, breaking ties by ascending UTF-16 code-unit `accountId` (`a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0`).
    - Sets `viewerCard` to the recorded `card` where `vote.accountId === params.viewerAccountId` (exact match on validated canonical identifiers), or `null` when the viewer has no recorded vote.
    - Normalizes each participant's `displayName` with `normalizeDisplayName(vote.displayName)` and `avatarUrl` to `typeof vote.avatarUrl === 'string' && vote.avatarUrl.trim().length > 0 ? vote.avatarUrl.trim() : null`.
    - When `params.meta.status === 'voting'`: sets `hasVoted: true` and `card: null` on every `ParticipantView`, and sets `average`, `formattedAverage`, `recommendedScore`, and `targetScore` to `null`.
    - When `params.meta.status === 'revealed'`: sets `hasVoted: true` and `card: vote.card` on every `ParticipantView`, populates `average`, `formattedAverage`, and `recommendedScore` from `calculateScoreSummary`, and sets `targetScore` to `params.meta.overrideScore !== null ? params.meta.overrideScore : summary.recommendedScore`.

---

### 5. `src/domain/jira-fields.ts`

```ts
import type { StoryPointsFieldInfo } from './types'

export function detectStoryPointsField(editMeta: unknown): StoryPointsFieldInfo | null
```

- **Behaviour & Error Conditions:**
  - Never throws on `null`, `undefined`, primitives, arrays, or malformed nested objects; returns `null` when no qualifying field exists.
  - Inspects own enumerable properties of `(editMeta as { fields?: unknown }).fields` when `editMeta` and `editMeta.fields` are non-null plain objects (`!Array.isArray(...)`), ignoring empty/whitespace `fieldId` keys and reserved keys (`'__proto__'`, `'constructor'`, `'prototype'`).
  - A candidate entry `(fieldId, fieldDef)` qualifies iff `fieldDef` is a non-null plain object and all three conditions hold:
    1. `typeof fieldDef.name === 'string'` and `fieldDef.name.trim().toLowerCase()` equals either `'story points'` (tier `0`, `fieldName: 'Story Points'`) or `'story point estimate'` (tier `1`, `fieldName: 'Story point estimate'`).
    2. If `fieldDef.schema !== undefined && fieldDef.schema !== null`, `fieldDef.schema` is a plain object (`!Array.isArray(fieldDef.schema)`) and, if `fieldDef.schema.type !== undefined && fieldDef.schema.type !== null`, `fieldDef.schema.type === 'number'`.
    3. If `fieldDef.operations !== undefined && fieldDef.operations !== null`, `Array.isArray(fieldDef.operations)` is `true` and `fieldDef.operations.includes('set')`.
  - Ranks qualifying candidates by ascending tier (`0` before `1`), breaking ties within the same tier by ascending UTF-16 code-unit `fieldId` (`a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0`), and returns `{ fieldId, fieldName }` for the winning candidate (or `null` if none qualify).

---

## External interfaces

None in Phase 1. All modules in `src/domain/` are internal pure TypeScript modules with zero network, filesystem, environment-variable, CLI, or Forge SDK calls.

---

## UI hooks

None in Phase 1. Custom UI components, `aria-pressed` card controls, and DOM hooks are introduced in Phase 3 (`static/panel/src/`).

---

## Data

- **Deck Order Invariant (`R1`):** `FIBONACCI_DECK` is strictly `['0', '1', '2', '3', '5', '8', '13', '21', '?']`; `NUMERIC_FIBONACCI_SCORES` is strictly `[0, 1, 2, 3, 5, 8, 13, 21]`.
- **Canonical Identifier Invariant (`R2`, `R5`, `R9`):** `viewerAccountId`, active `meta.roundId`, non-null `roundId` in `createIdleSessionSnapshot`, and `vote.accountId` all satisfy the exact predicate `typeof s === 'string' && s.trim().length > 0 && s === s.trim()` (non-empty and already trimmed; empty, whitespace-only, or leading/trailing whitespace-padded identifiers throw `PokerDomainError` with `code: 'validation-error'`).
- **Expiration Window (`R9`):** `SESSION_TTL_MS = 86_400_000` ms (`24` hours). `nowMs - updatedAt >= 86_400_000` is expired; `< 86_400_000` (including negative clock-skew deltas) is active.
- **Secrecy Invariant (`R5`):** Whenever `SessionSnapshot.status === 'voting'`, every item in `SessionSnapshot.participants` satisfies `hasVoted === true` and `card === null`; only `SessionSnapshot.viewerCard` carries the requesting caller's card (`DeckCard | null`).
- **Override Resolution Invariant (`R7`, `R8`):** Whenever `SessionSnapshot.status === 'revealed'`, `targetScore` equals `meta.overrideScore` when `meta.overrideScore !== null` (including `0`), and equals `recommendedScore` (`FibonacciScore | null`) when `meta.overrideScore === null`.
- **Canonical Story Points Field Labels (`R10`):** `StoryPointsFieldInfo.fieldName` is normalized to `'Story Points'` for tier-0 matches and `'Story point estimate'` for tier-1 matches.

---

## Stub files

- src/domain/types.ts
- src/domain/deck.ts
- src/domain/scoring.ts
- src/domain/session-view.ts
- src/domain/jira-fields.ts
