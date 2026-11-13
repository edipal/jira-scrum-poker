# Phase 3 Contract: Custom UI Jira Issue Panel, Live Synchronization, Score Override, and Clipboard Fallback

## Signatures

All Phase 1 (`src/domain/*`) and Phase 2 (`src/observability/logger.ts`, `src/storage/session-store.ts`, `src/realtime/publisher.ts`, `src/jira/jira-client.ts`, `src/resolvers/poker-resolvers.ts`, `src/index.ts`) exports remain unchanged and active.

Frontend modules under `static/panel/src/` must import runtime values exclusively from `react`, `react-dom/client`, `@forge/bridge`, and sibling files inside `static/panel/src/`. Imports from `src/` are restricted strictly to `import type` declarations.

---

### 1. `static/panel/src/bridge/poker-client.ts`

```ts
import type {
  DeckCard,
  FibonacciScore,
  NumericDeckCard,
  ParticipantView,
  QuestionCard,
  RoundStatus,
  SessionSnapshot,
  StoryPointsFieldInfo,
} from '../../../../src/domain/types'
import type { ApplyStoryPointsFailureReason } from '../../../../src/jira/jira-client'
import type {
  PointsAppliedRealtimeEvent,
  PokerRealtimeEvent,
  SessionUpdatedRealtimeEvent,
} from '../../../../src/realtime/publisher'
import type { ApplyStoryPointsResult } from '../../../../src/resolvers/poker-resolvers'

export type {
  ApplyStoryPointsFailureReason,
  ApplyStoryPointsResult,
  DeckCard,
  FibonacciScore,
  NumericDeckCard,
  ParticipantView,
  PointsAppliedRealtimeEvent,
  PokerRealtimeEvent,
  QuestionCard,
  RoundStatus,
  SessionSnapshot,
  SessionUpdatedRealtimeEvent,
  StoryPointsFieldInfo,
}

export const PANEL_DECK_CARDS: readonly DeckCard[]

export const PANEL_NUMERIC_SCORES: readonly FibonacciScore[]

export const PANEL_REALTIME_CHANNEL: 'scrum-poker'

export const PANEL_RESOLVER_KEYS: {
  readonly getSession: 'getSession'
  readonly castVote: 'castVote'
  readonly withdrawVote: 'withdrawVote'
  readonly revealVotes: 'revealVotes'
  readonly selectOverrideScore: 'selectOverrideScore'
  readonly resetRound: 'resetRound'
  readonly applyStoryPoints: 'applyStoryPoints'
}

export type BridgeInvokeFn = <TResult = unknown>(
  functionKey: string,
  payload?: Record<string, unknown>,
) => Promise<TResult>

export interface BridgeRealtimeSubscription {
  unsubscribe(): Promise<void> | void
}

export type BridgeRealtimeSubscribeFn = (
  channel: string,
  callback: (payload: unknown, error?: Error) => unknown,
) => Promise<BridgeRealtimeSubscription>

export interface BridgeViewLike {
  readonly refresh: () => Promise<void>
  readonly theme: {
    readonly enable: () => Promise<void>
  }
}

export interface CreatePokerClientDeps {
  readonly invoke?: BridgeInvokeFn
  readonly subscribe?: BridgeRealtimeSubscribeFn
  readonly view?: BridgeViewLike
}

export interface PokerClient {
  enableTheme(): Promise<void>
  refreshIssueView(): Promise<void>
  getSession(): Promise<SessionSnapshot>
  castVote(card: DeckCard): Promise<SessionSnapshot>
  withdrawVote(): Promise<SessionSnapshot>
  revealVotes(): Promise<SessionSnapshot>
  selectOverrideScore(score: FibonacciScore): Promise<SessionSnapshot>
  resetRound(): Promise<SessionSnapshot>
  applyStoryPoints(score: FibonacciScore): Promise<ApplyStoryPointsResult>
  subscribeToSessionEvents(onEvent: (event: PokerRealtimeEvent) => void): () => Promise<void>
}

export interface UiAssetComplianceResult {
  readonly valid: boolean
  readonly violations: readonly string[]
}

export function parseRealtimeEvent(rawPayload: unknown): PokerRealtimeEvent | null

export function validateUiAssetCompliance(assetSource: string, assetLabel?: string): UiAssetComplianceResult

export function createPokerClient(deps?: CreatePokerClientDeps): PokerClient
```

- **Behaviour & Error Conditions:**
  - `PANEL_DECK_CARDS`: Frozen array `['0', '1', '2', '3', '5', '8', '13', '21', '?']`.
  - `PANEL_NUMERIC_SCORES`: Frozen array `[0, 1, 2, 3, 5, 8, 13, 21]`.
  - `PANEL_REALTIME_CHANNEL`: Exact string `'scrum-poker'`.
  - `PANEL_RESOLVER_KEYS`: Frozen dictionary matching Phase 2's 7 resolver function keys.
  - `parseRealtimeEvent(rawPayload)`:
    - Never throws on any input.
    - If `typeof rawPayload === 'string'`: returns `null` when `rawPayload.trim().length === 0`; otherwise attempts a single `JSON.parse(rawPayload)` (returning `null` on invalid JSON or double-encoded strings whose parsed result is not a plain object).
    - Requires a plain object (`value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)`).
    - Actively enforces realtime vote secrecy (`R5`, `R14`): returns `null` if the object has any own property whose normalized lowercase key (`key.toLowerCase().replace(/[-_]/g, '')`) is `'card'`, `'cards'`, `'viewercard'`, `'vote'`, `'votes'`, or `'participants'`.
    - Validates `roundId` (`typeof obj.roundId === 'string' && obj.roundId.trim().length > 0 && obj.roundId === obj.roundId.trim() && obj.roundId.length <= 128 && !/[/\\\0]/.test(obj.roundId)`) and `updatedAt` (`typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)`, normalizing `-0` to `0`).
    - When `obj.type === 'SESSION_UPDATED'`: returns `{ type: 'SESSION_UPDATED', roundId: obj.roundId, updatedAt }`.
    - When `obj.type === 'points-applied'`: validates `obj.score` is a valid `FibonacciScore` (`typeof obj.score === 'number' && Number.isFinite(obj.score) && !Object.is(obj.score, -0)` and member of `PANEL_NUMERIC_SCORES`, including `0`) and returns `{ type: 'points-applied', roundId: obj.roundId, score: obj.score, updatedAt }`.
    - Otherwise returns `null`.
  - `validateUiAssetCompliance(assetSource, assetLabel)`:
    - Throws `TypeError` synchronously if `typeof assetSource !== 'string'` (or if `assetLabel !== undefined && typeof assetLabel !== 'string'`).
    - Strips standard W3C XML namespace URIs (`'http://www.w3.org/2000/svg'`, `'http://www.w3.org/1999/xhtml'`, `'http://www.w3.org/1998/Math/MathML'`, `'http://www.w3.org/1999/xlink'`) before URL scanning so local SVG assets (`static/assets/icon.svg`) pass cleanly.
    - Appends a descriptive violation string (prefixed with `${assetLabel}: ` when `assetLabel` is non-empty) for every violated rule:
      1. Contains any remaining `http://` or `https://` URL (`/\bhttps?:\/\/[^\s"'`)>]+/i`).
      2. Contains any protocol-relative external asset reference (`/(?:src|href)\s*=\s*["']\/\/|url\(\s*["']?\/\/|@import\s+["']\/\//i`).
      3. Invokes direct browser network egress APIs (`/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnavigator\.sendBeacon\s*\(/`).
      4. References backend-only Forge packages (`/@forge\/(?:kvs|api|realtime|resolver)\b/`).
    - Returns `{ valid: violations.length === 0, violations }`.
    - Every file under `static/panel/index.html`, `static/assets/icon.svg`, `static/panel/src/styles.css`, and `static/panel/src/**/*.{ts,tsx}` (including `poker-client.ts` itself) must satisfy `validateUiAssetCompliance(content).valid === true`.
  - `createPokerClient(deps)`:
    - Defaults `deps.invoke` to `invoke`, `deps.subscribe` to `realtime.subscribe`, and `deps.view` to `view` from `@forge/bridge`.
    - `enableTheme()`: calls `await view.theme.enable()`.
    - `refreshIssueView()`: calls `await view.refresh()`.
    - `getSession()`: calls `invoke<SessionSnapshot>('getSession')`.
    - `castVote(card)`: rejects with `RangeError` (before calling `invoke`) if `card` is not a member of `PANEL_DECK_CARDS`; otherwise calls `invoke<SessionSnapshot>('castVote', { card })`.
    - `withdrawVote()`: calls `invoke<SessionSnapshot>('withdrawVote')`.
    - `revealVotes()`: calls `invoke<SessionSnapshot>('revealVotes')`.
    - `selectOverrideScore(score)`: rejects with `RangeError` (before calling `invoke`) if `score` is not a member of `PANEL_NUMERIC_SCORES` or `Object.is(score, -0)`; otherwise calls `invoke<SessionSnapshot>('selectOverrideScore', { score })`.
    - `resetRound()`: calls `invoke<SessionSnapshot>('resetRound')`.
    - `applyStoryPoints(score)`: rejects with `RangeError` (before calling `invoke`) if `score` is not a member of `PANEL_NUMERIC_SCORES` or `Object.is(score, -0)`; otherwise calls `invoke<ApplyStoryPointsResult>('applyStoryPoints', { score })`.
    - `subscribeToSessionEvents(onEvent)`:
      - Throws `TypeError` synchronously if `typeof onEvent !== 'function'`.
      - Subscribes to `PANEL_REALTIME_CHANNEL` (`'scrum-poker'`).
      - Inside the bridge callback `(rawPayload, error)`: ignores delivery when already cleaned up (`!active`) or when `error !== undefined`; otherwise calls `parseRealtimeEvent(rawPayload)` and invokes `onEvent(parsed)` iff `parsed !== null`.
      - Catches any rejection from `subscribe(...)` itself so unhandled promise rejections never escape.
      - Returns an idempotent `cleanup: () => Promise<void>` function:
        - Immediately sets `active = false` synchronously on the first call so subsequent realtime callbacks are suppressed even while `subscribe(...)` or `unsubscribe()` is pending.
        - Awaits the `subscribe(...)` promise and, if a subscription object resolved, calls `await subscription.unsubscribe()` (catching and swallowing any `unsubscribe` rejection).
        - Repeated calls to `cleanup()` return the same settled `Promise<void>` without calling `subscription.unsubscribe()` more than once.

---

### 2. `static/panel/src/clipboard/copy-score.ts`

```ts
import type { FibonacciScore } from '../../../../src/domain/types'

export interface ClipboardWriteApiLike {
  writeText(text: string): Promise<void>
}

export interface LegacyCopyDocumentLike {
  readonly body: HTMLElement | null
  createElement(tagName: 'textarea'): HTMLTextAreaElement
  execCommand?(commandId: string): boolean
}

export interface CopyScoreEnv {
  readonly clipboard?: ClipboardWriteApiLike | null
  readonly document?: LegacyCopyDocumentLike | null
}

export type CopyScoreResult =
  | {
      readonly ok: true
      readonly text: string
      readonly method: 'clipboard-api' | 'exec-command'
    }
  | {
      readonly ok: false
      readonly text: string
      readonly message: string
    }

export function formatScoreForClipboard(score: FibonacciScore): string

export function copyScoreToClipboard(score: FibonacciScore, env?: CopyScoreEnv): Promise<CopyScoreResult>
```

- **Behaviour & Error Conditions:**
  - `formatScoreForClipboard(score)`:
    - Validates `typeof score === 'number' && Number.isFinite(score) && !Object.is(score, -0)` and membership in `[0, 1, 2, 3, 5, 8, 13, 21]`; throws `RangeError` synchronously otherwise.
    - Returns decimal text `String(score)` (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`).
  - `copyScoreToClipboard(score, env)`:
    - Validates `score` via `formatScoreForClipboard(score)`, returning a rejected `Promise` with `RangeError` if invalid.
    - Resolves `clipboard` from `env.clipboard` when `env !== undefined && 'clipboard' in env`, else `typeof navigator !== 'undefined' ? navigator.clipboard : null`.
    - Resolves `doc` from `env.document` when `env !== undefined && 'document' in env`, else `typeof document !== 'undefined' ? (document as LegacyCopyDocumentLike) : null`.
    - **Primary path (`'clipboard-api'`):** If `clipboard` has `typeof clipboard.writeText === 'function'`, awaits `clipboard.writeText(text)` and returns `{ ok: true, text, method: 'clipboard-api' }`. If `writeText` throws/rejects or is absent, falls through to the legacy path.
    - **Fallback path (`'exec-command'`):** If `doc?.body` is non-null and `typeof doc.execCommand === 'function'`, creates an off-screen read-only `<textarea>` (`value = text`, `readOnly = true`, `aria-hidden="true"`), appends it to `doc.body`, calls `focus()` and `select()`, executes `doc.execCommand('copy')`, **always** removes the `<textarea>` from the DOM in a `finally` block, and returns `{ ok: true, text, method: 'exec-command' }` when `execCommand('copy') === true`.
    - **Graceful failure:** When both clipboard mechanisms are unavailable or fail, resolves (never throws) `{ ok: false, text, message }` where `message` is a non-empty string containing `text` (for example, `'Clipboard unavailable — copy score manually: 5'`).

---

### 3. `static/panel/src/App.tsx`

```ts
import type React from 'react'
import type { FibonacciScore } from '../../../src/domain/types'
import type { PokerClient } from './bridge/poker-client'
import type { CopyScoreEnv, CopyScoreResult } from './clipboard/copy-score'

export type CopyScoreFn = (score: FibonacciScore, env?: CopyScoreEnv) => Promise<CopyScoreResult>

export interface ScrumPokerAppProps {
  readonly client?: PokerClient
  readonly copyScore?: CopyScoreFn
  readonly clipboardEnv?: CopyScoreEnv
}

export function ScrumPokerApp(props?: ScrumPokerAppProps): React.JSX.Element
```

- **Behaviour & Error Conditions:**
  - Defaults `props?.client` (memoized via `useMemo`) to `createPokerClient()` and `props?.copyScore` to `copyScoreToClipboard`.
  - **Mount & Unmount (`R12`, `R13`):**
    - Calls `client.enableTheme()` once on mount (catching and ignoring rejections).
    - Subscribes via `client.subscribeToSessionEvents(...)` on mount and invokes its cleanup function on unmount.
    - Fetches initial `SessionSnapshot` via `client.getSession()` on mount. If initial `getSession()` rejects while `session === null`, displays `data-testid="error-banner"` (`role="alert"`) and `data-testid="retry-load-button"` (`Retry`), which re-runs `client.getSession()`.
    - Suppresses all state updates and `refreshIssueView()` calls after unmount.
  - **Live Synchronization & Issue Refresh (`R12`):**
    - On `SESSION_UPDATED`: fetches `client.getSession()` in background and updates `session` unless superseded by a newer background fetch or an in-flight/newer user mutation (`mutationEpoch`); clears copy feedback if `status !== 'revealed'` or `targetScore` changed, and clears `appliedConfirmationScore` if `participants.length > 0 || status === 'revealed'`.
    - On `'points-applied'`: sets `appliedConfirmationScore = event.score` and clears action/copy notices. If `event.roundId` is not yet in `handledPointsAppliedRoundIds` (bounded FIFO set of max `64` entries), adds `event.roundId` and concurrently invokes `client.getSession()` (updating `session` to the cleared idle snapshot) and `client.refreshIssueView()` (swallowing refresh rejections).
  - **Interactive Actions (`R13`):**
    - Locks interactive buttons (`isSubmitting = true`) while a user RPC mutation is in flight, unlocking in `finally`.
    - **Card click in `'voting'`:** invokes `client.withdrawVote()` when `session.viewerCard === card`; otherwise invokes `client.castVote(card)`.
    - **Card click in `'revealed'` (`'0'..'21'`):** invokes `client.selectOverrideScore(Number(card) as FibonacciScore)` and resets any prior copy feedback.
    - **Show Votes click:** invokes `client.revealVotes()`.
    - **Reset / Re-vote click:** invokes `client.resetRound()` and resets copy/confirmation/error notices.
    - **Set Story Points click:** invokes `client.applyStoryPoints(targetScore)`:
      - `ok: true`: sets `session = result.session`, sets `appliedConfirmationScore = result.appliedScore`, records `result.session.roundId` in `handledPointsAppliedRoundIds` (if non-null and not yet recorded), and calls `client.refreshIssueView()` once for that round.
      - `ok: false` with `reason === 'missing-field'`: updates `session = { ...currentSession, storyPointsField: null }` (preserving `'revealed'` status, votes, and `targetScore`) so the inline missing-field warning and `Copy Score (<targetScore>)` button render immediately.
      - `ok: false` with `reason === 'forbidden' | 'jira-error'` (or RPC rejection): preserves `session` unchanged and displays the error message in `data-testid="error-banner"` (`role="alert"`).
    - **Copy Score click:** invokes `copyScore(targetScore, clipboardEnv)` while keeping the `'revealed'` session and votes visible; on `ok: true` displays `Copied!` (`data-testid="copy-feedback"`, `role="status"`), and on `ok: false` (or unexpected rejection) displays the inline fallback message containing `String(targetScore)` (`data-testid="copy-fallback-message"`, `role="alert"`).

---

### 4. `static/panel/src/main.tsx` & `static/panel/src/styles.css`

```ts
import type { Root } from 'react-dom/client'
import type { ScrumPokerAppProps } from './App'

export function bootstrapIssuePanel(container: HTMLElement, props?: ScrumPokerAppProps): Root
```

- **Behaviour & Error Conditions:**
  - `bootstrapIssuePanel(container, props)`:
    - Throws `TypeError` synchronously if `!(container instanceof HTMLElement)`.
    - Creates a React 19 root via `createRoot(container)`, renders `<ScrumPokerApp {...props} />` (without `StrictMode` double-effect invocation), and returns the `Root` instance.
  - Module top-level in `static/panel/src/main.tsx`:
    - Imports `'./styles.css'`.
    - When `typeof document !== 'undefined'` and `document.getElementById('root')` is an `HTMLElement`, invokes `bootstrapIssuePanel(rootElement)`.
  - `static/panel/src/styles.css`:
    - Pure local CSS referencing Atlassian Design System theme tokens (`--ds-surface`, `--ds-surface-raised`, `--ds-text`, `--ds-text-subtle`, `--ds-text-inverse`, `--ds-border`, `--ds-border-focused`, `--ds-background-neutral`, `--ds-background-selected`, `--ds-text-selected`, `--ds-background-brand-bold`, `--ds-background-warning`, `--ds-text-warning`, `--ds-background-danger`, `--ds-text-danger`, `--ds-background-success`, `--ds-text-success`) with Light and Dark (`@media (prefers-color-scheme: dark)` and `[data-color-mode="dark"]`) fallback values and zero external URLs.

---

## External interfaces

- **Atlassian Forge Custom UI Bridge (`@forge/bridge`):**
  - `view.theme.enable() -> Promise<void>` (invoked on panel initialization).
  - `view.refresh() -> Promise<void>` (invoked once per Story Points application on both acting and peer panels).
  - `realtime.subscribe('scrum-poker', callback) -> Promise<{ unsubscribe: () => Promise<void> }>` (issue-scoped live channel).
  - `invoke<T>(functionKey, payload?) -> Promise<T>` calling Phase 2's 7 resolver keys (`getSession`, `castVote`, `withdrawVote`, `revealVotes`, `selectOverrideScore`, `resetRound`, `applyStoryPoints`).
- **Browser Clipboard Boundary (`static/panel/src/clipboard/copy-score.ts`):**
  - `navigator.clipboard.writeText(String(score))` with off-screen `<textarea>` + `document.execCommand('copy')` fallback.
- **Platform Asset Boundary (`static/panel/`, `static/assets/`, `manifest.yml`):**
  - Zero external `http://` / `https://` asset or API URLs, zero `permissions.external`, and zero direct browser network API calls.

---

## UI hooks

All DOM queries and assertions in `tests/` anchor to these exact attributes, roles, and labels rendered by `ScrumPokerApp`:

- **Panel root:** `<section aria-label="Scrum Poker" data-testid="scrum-poker-panel">`
- **Initial loading state:** `<div role="status" data-testid="panel-loading">Loading Scrum Poker…</div>`
- **Retry button (only when initial `getSession` fails while `session === null`):** `<button type="button" data-testid="retry-load-button">Retry</button>`
- **Error banner (`role="alert"`):** `<div role="alert" data-testid="error-banner">{errorMessage}</div>`
- **Post-save confirmation banner (shown on cleared idle `'voting'` panel with `0` participants after save or `'points-applied'` event):**
  - `<div role="status" aria-live="polite" data-testid="points-applied-banner">Story Points set to {score}</div>`
- **Missing Story Points field warning (rendered when `session.status === 'revealed' && session.storyPointsField === null`):**
  - `<div role="note" data-testid="missing-field-warning">No editable Story Points field is available on this issue screen.</div>`
- **Deck card buttons (`9` buttons in exact order `'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`):**
  - Group wrapper: `<div role="group" aria-label="Estimation cards" data-testid="deck-cards">`
  - Each button:
    - `<button type="button" data-testid={card === '?' ? 'poker-card-question' : \`poker-card-${card}\`} data-card={card} aria-pressed={isPressed} disabled={isDisabled}>{card}</button>`
    - Accessible name is the exact card string (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`).
    - In `'voting'`: `aria-pressed="true"` iff `session.viewerCard === card` (else `"false"`); `disabled={isSubmitting}`.
    - In `'revealed'`: for `'?'`, `disabled={true}` and `aria-pressed="false"`; for `'0'..'21'`, `disabled={isSubmitting}` and `aria-pressed="true"` iff `session.targetScore !== null && String(session.targetScore) === card` (else `"false"`).
- **Participants area:**
  - When `session.status === 'voting' && session.participants.length === 0`:
    - `<p data-testid="empty-voters-prompt">Pick a card to start voting</p>`
  - When `session.participants.length >= 1` (or `session.status === 'revealed'`):
    - `<ul aria-label="Participants" data-testid="participant-list">`
    - Each voter (`<li data-testid="participant-chip">`):
      - In `'voting'`: exact text `${participant.displayName} ✓` (never rendering `participant.card` or `<img src>`).
      - In `'revealed'`: exact text `${participant.displayName}: ${participant.card ?? '?'}`.
- **Revealed score summary (rendered when `session.status === 'revealed'`):**
  - Wrapper: `<div data-testid="score-summary">`
  - When `session.recommendedScore !== null && session.formattedAverage !== null`:
    - `<span data-testid="average-score">Average: <strong>{session.formattedAverage}</strong></span>`
    - `<span data-testid="recommended-score">Recommended: <strong>{session.recommendedScore}</strong></span>`
  - When `session.recommendedScore === null`:
    - `<span data-testid="no-numeric-votes">No numeric votes</span>`
    - When additionally `session.targetScore === null`:
      - `<p data-testid="override-prompt">Select any numeric card (0–21) to set or copy a score.</p>`
- **Action controls (`<div data-testid="panel-actions">`):**
  - When `session.status === 'voting'`:
    - `<button type="button" data-testid="show-votes-button" disabled={session.participants.length === 0 || isSubmitting}>Show Votes</button>`
    - `<button type="button" data-testid="reset-round-button" disabled={session.participants.length === 0 || isSubmitting}>Reset</button>`
  - When `session.status === 'revealed'`:
    - If `session.storyPointsField !== null && session.targetScore !== null`:
      - `<button type="button" data-testid="apply-story-points-button" disabled={isSubmitting}>Set Story Points → {session.targetScore}</button>`
    - If `session.storyPointsField === null && session.targetScore !== null`:
      - `<button type="button" data-testid="copy-score-button" disabled={isSubmitting}>Copy Score ({session.targetScore})</button>`
    - If `session.targetScore === null`: neither `apply-story-points-button` nor `copy-score-button` is rendered.
    - Always in `'revealed'`:
      - `<button type="button" data-testid="revote-button" disabled={isSubmitting}>Re-vote</button>`
    - Copy feedback (in `'revealed'`):
      - Success: `<span role="status" aria-live="polite" data-testid="copy-feedback">Copied!</span>`
      - Failure fallback: `<span role="alert" data-testid="copy-fallback-message">{copyFallbackMessage}</span>` (containing decimal `String(targetScore)`).

---

## Data

- **Frontend Vote Secrecy Invariant (`R5`, `R12`, `R13`, `R14`):** During `'voting'`, `ScrumPokerApp` renders only `${displayName} ✓` for participants, `parseRealtimeEvent` rejects any payload carrying vote/card keys, and zero vote values or user profiles are written to `console`.
- **Zero-Value Numeric Fidelity (`R7`, `R8`, `R11`, `R13`):** Score `0` is a first-class `FibonacciScore`; all UI checks test `targetScore !== null` and `recommendedScore !== null` explicitly (never truthiness), ensuring `Set Story Points → 0`, `Copy Score (0)`, `Story Points set to 0`, and `aria-pressed="true"` on card `'0'` work identically to positive scores.
- **Deduplicated Refresh State (`R12`):** `handledPointsAppliedRoundIds` tracks up to `64` handled `roundId` strings FIFO so each panel invokes `view.refresh()` once per applied round even if a self-originated `'points-applied'` event echoes back over `@forge/bridge` `realtime`.
- **Zero-Egress Asset Invariant (`R14`):** All frontend HTML, SVG, CSS, and TS/TSX source files pass `validateUiAssetCompliance` with zero violations and zero runtime imports from `src/` or backend `@forge/*` packages.

---

## Stub files

- static/panel/src/bridge/poker-client.ts
- static/panel/src/clipboard/copy-score.ts
- static/panel/src/styles.css
- static/panel/src/App.tsx
- static/panel/src/main.tsx
