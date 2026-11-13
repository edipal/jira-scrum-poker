# Phase 2 Contract: Forge Backend Resolvers, Per-Voter KVS Storage, Realtime Sync, and Jira Write-Back

## Signatures

All Phase 1 exports in `src/domain/types.ts`, `src/domain/deck.ts`, `src/domain/scoring.ts`, `src/domain/session-view.ts`, and `src/domain/jira-fields.ts` remain unchanged and active.

---

### 1. `src/observability/logger.ts`

```ts
export const REQUIRED_FORGE_SCOPES: readonly string[]

export const REDACTED_VALUE: '[REDACTED]'

export type LogLevel = 'WARN' | 'ERROR'

export interface StructuredLogEntry {
  readonly level: LogLevel
  readonly event: string
  readonly timestamp: string
  readonly context: Readonly<Record<string, unknown>>
}

export interface LogSink {
  readonly warn: (serializedEntry: string) => void
  readonly error: (serializedEntry: string) => void
}

export interface BackendLogger {
  warn(event: string, context?: Readonly<Record<string, unknown>>): void
  error(event: string, context?: Readonly<Record<string, unknown>>): void
}

export interface CreateBackendLoggerOptions {
  readonly sink?: LogSink
  readonly now?: () => number
}

export interface ManifestValidationResult {
  readonly valid: boolean
  readonly scopes: readonly string[]
  readonly violations: readonly string[]
}

export function sanitizeLogMetadata(metadata: unknown): Record<string, unknown>

export function createBackendLogger(options?: CreateBackendLoggerOptions): BackendLogger

export function validatePlatformManifest(manifestYaml: string): ManifestValidationResult
```

- **Behaviour & Error Conditions:**
  - `REQUIRED_FORGE_SCOPES`: Frozen array `['storage:app', 'read:jira-work', 'write:jira-work', 'read:jira-user']`.
  - `REDACTED_VALUE`: Exact string literal `'[REDACTED]'`.
  - `sanitizeLogMetadata(metadata)`:
    - Validates `metadata` using the strict plain-object prototype check (`metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) && (Object.getPrototypeOf(metadata) === Object.prototype || Object.getPrototypeOf(metadata) === null)`, matching `isPlainObject` in `src/domain/jira-fields.ts`); throws `PokerDomainError` (`code: 'validation-error'`) if `metadata` fails this check (including `null`, `undefined`, primitives, arrays, functions, `Date`, `Error`, `RegExp`, `Map`, `Set`, or custom class instances).
    - Anchors the recursion depth counter explicitly:
      - Root `metadata` is at **`depth = 0`**; its own enumerable string properties (ignoring `'__proto__'`, `'constructor'`, `'prototype'`) are copied into a fresh plain object.
      - Sensitive-key redaction runs **first** on every own property at `depth = 0..4`: any property whose normalized lowercase key (stripping `-` and `_`, i.e. `key.toLowerCase().replace(/[-_]/g, '')`) matches `'card'`, `'cards'`, `'viewercard'`, `'vote'`, `'votes'`, `'participants'`, `'authorization'`, `'cookie'`, `'setcookie'`, `'token'`, `'accesstoken'`, `'refreshtoken'`, `'apikey'`, `'secret'`, `'password'`, `'credential'`, `'credentials'`, `'email'`, or `'emailaddress'` has its value immediately set to `REDACTED_VALUE` (`'[REDACTED]'`) regardless of value type or child depth.
      - For non-redacted property values and array elements, each nested plain object (`isPlainObject(val)`) or `Array` (`Array.isArray(val)`) is evaluated at `childDepth = parentDepth + 1`:
        - At **`depth = 1..4`** (`childDepth <= 4`): nested plain objects are recursively sanitized property-wise (ignoring `'__proto__'`, `'constructor'`, `'prototype'`), and arrays are recursively sanitized element-wise (`val.map(...)` where any nested plain object or array element enters at `childDepth + 1`).
        - At **`depth > 4`** (`childDepth >= 5`, i.e. a nested plain object or array inside a `depth = 4` plain object or array): replaced with `'[TRUNCATED]'`.
    - Replaces any string value containing an email pattern (`/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/`) or bearer/basic credential prefix (`/^\s*(Bearer|Basic)\s+\S+/i`) with `REDACTED_VALUE`.
    - Formats nested `Error` instances (`val instanceof Error`) safely as `{ name: err.name, message: <sanitized message> }` (omitting raw stack traces and scrubbing email/credential strings in `message`), serializes nested `Date` instances via `Number.isFinite(d.getTime()) ? d.toISOString() : 'Invalid Date'`, preserves `boolean | number | null | undefined`, and converts other non-plain values (`bigint`, `symbol`, `function`, `Map`, `Set`, `RegExp`, custom class instances) via `String(val)` (with string email/credential scrubbing applied) so `JSON.stringify` never throws.
  - `createBackendLogger(options)`:
    - Defaults `sink` to `{ warn: (s) => console.warn(s), error: (s) => console.error(s) }` and `now` to `() => Date.now()`.
    - `warn(event, context = {})` and `error(event, context = {})` serialize a `StructuredLogEntry` (`level: 'WARN' | 'ERROR'`, `event`, `timestamp: new Date(now()).toISOString()`, `context: sanitizeLogMetadata(context)`) via `JSON.stringify` and pass the JSON string to `sink.warn` / `sink.error`.
  - `validatePlatformManifest(manifestYaml)`:
    - Pure string/YAML validator (never throws on malformed string input; throws `PokerDomainError` with `code: 'validation-error'` only if `typeof manifestYaml !== 'string'`).
    - Records a violation in `violations` whenever any of the following fail:
      1. `manifestYaml.trim().length > 0`.
      2. No `external:` key appears anywhere in `manifestYaml` (`!/^\s*external\s*:/m.test(manifestYaml)`).
      3. No `http://` or `https://` URL appears anywhere in `manifestYaml` (`!/https?:\/\//i.test(manifestYaml)`).
      4. Declares `jira:issuePanel`, `title: Scrum Poker`, `handler: index.handler`, and runtime `name: nodejs22.x`.
      5. Extracted `scopes` list under `permissions:` contains the exact 4 scopes in `REQUIRED_FORGE_SCOPES` (`storage:app`, `read:jira-work`, `write:jira-work`, `read:jira-user`) with zero missing scopes, zero duplicate scopes, and zero extra scopes.
    - Returns `{ valid: violations.length === 0, scopes, violations }`.

---

### 2. `src/storage/session-store.ts`

```ts
import type { WhereConditions } from '@forge/kvs'
import type { RoundMeta, VoteRecord } from '../domain/types'

export const KVS_TTL_24H: {
  readonly ttl: {
    readonly value: 24
    readonly unit: 'HOURS'
  }
}

export const KVS_QUERY_LIMIT: 100

export interface KvsSetOptions {
  readonly ttl?: {
    readonly value: number
    readonly unit: 'SECONDS' | 'MINUTES' | 'HOURS' | 'DAYS'
  }
}

export interface KvsListItem<T = unknown> {
  readonly key: string
  readonly value: T
}

export interface KvsListPage<T = unknown> {
  readonly results: readonly KvsListItem<T>[]
  readonly nextCursor?: string
}

export type KvsBeginsWithCondition = ReturnType<typeof WhereConditions.beginsWith>

export interface KvsQueryBuilderLike {
  where(field: 'key', condition: KvsBeginsWithCondition): KvsQueryBuilderLike
  limit(count: number): KvsQueryBuilderLike
  cursor(afterCursor: string): KvsQueryBuilderLike
  getMany<T = unknown>(): Promise<KvsListPage<T>>
}

export interface KvsClientLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T, options?: KvsSetOptions): Promise<void>
  delete(key: string): Promise<void>
  query(): KvsQueryBuilderLike
}

export interface SessionStore {
  getRoundMeta(issueId: string): Promise<RoundMeta | null>
  setRoundMeta(issueId: string, meta: RoundMeta): Promise<void>
  getVoterRecord(issueId: string, roundId: string, accountId: string): Promise<VoteRecord | null>
  setVoterRecord(issueId: string, roundId: string, vote: VoteRecord): Promise<void>
  deleteVoterRecord(issueId: string, roundId: string, accountId: string): Promise<void>
  listVoterRecords(issueId: string, roundId: string, nowMs: number): Promise<VoteRecord[]>
  deleteRoundVotes(issueId: string, roundId: string): Promise<number>
}

export function assertSafeIdentifier(value: unknown, label: string): string

export function buildMetaKey(issueId: string): string

export function buildVoteKeyPrefix(issueId: string, roundId: string): string

export function buildVoteKey(issueId: string, roundId: string, accountId: string): string

export function nextRoundId(previousRoundId?: string | null): string

export function createSessionStore(kvsClient?: KvsClientLike): SessionStore
```

- **Behaviour & Error Conditions:**
  - `assertSafeIdentifier(value, label)`:
    - Returns `value` iff `typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= 128 && !/[/\\\0]/.test(value)`.
    - Otherwise throws `PokerDomainError` (`code: 'validation-error'`) referencing `label`.
  - `buildMetaKey(issueId)`: Validates `issueId` via `assertSafeIdentifier(issueId, 'issueId')` and returns `` `poker:${issueId}:meta` ``.
  - `buildVoteKeyPrefix(issueId, roundId)`: Validates `issueId` and `roundId` via `assertSafeIdentifier` and returns `` `poker:${issueId}:${roundId}:vote:` ``.
  - `buildVoteKey(issueId, roundId, accountId)`: Validates `issueId`, `roundId`, and `accountId` via `assertSafeIdentifier` and returns `` `poker:${issueId}:${roundId}:vote:${accountId}` ``.
  - `nextRoundId(previousRoundId)`:
    - When `previousRoundId === undefined || previousRoundId === null`: returns `'round-1'`.
    - Otherwise validates `previousRoundId` via `assertSafeIdentifier(previousRoundId, 'roundId')`.
    - If `previousRoundId` matches `/^(.+)-([1-9]\d*)$/` (including `'round-1' -> 'round-2'`, `'round-99' -> 'round-100'`, `'r-2' -> 'r-3'`), increments the trailing decimal counter via `BigInt` (`${prefix}-${BigInt(counter) + 1n}`).
    - Otherwise returns `${previousRoundId}-2`.
  - `createSessionStore(kvsClient = kvs)`:
    - Defaults `kvsClient` to `kvs` from `@forge/kvs`.
    - `getRoundMeta(issueId)`: Validates `issueId`, reads `kvsClient.get(buildMetaKey(issueId))`, and returns a validated `RoundMeta` (`roundId` passes `assertSafeIdentifier`, `status` is `'voting' | 'revealed'`, `overrideScore === null || isValidFibonacciScore(overrideScore)`, `Number.isFinite(updatedAt)`) or `null` if absent or malformed.
    - `setRoundMeta(issueId, meta)`: Validates `issueId` and `meta` (throwing `PokerDomainError` with `code: 'validation-error'` if `meta` is invalid) and writes `kvsClient.set(buildMetaKey(issueId), meta, KVS_TTL_24H)`.
    - `getVoterRecord(issueId, roundId, accountId)`: Validates identifiers, reads `kvsClient.get(buildVoteKey(issueId, roundId, accountId))`, and returns a normalized `VoteRecord` (`displayName` via `normalizeDisplayName`, `avatarUrl` trimmed or `null`, valid `DeckCard`, finite `votedAt`) or `null` if absent or malformed.
    - `setVoterRecord(issueId, roundId, vote)`: Validates `issueId`, `roundId`, `vote.accountId` (`vote.accountId === accountId` canonical identifier), `validateDeckCard(vote.card)`, and finite `vote.votedAt`, normalizes `displayName` and `avatarUrl`, and writes `kvsClient.set(buildVoteKey(issueId, roundId, vote.accountId), normalizedVote, KVS_TTL_24H)`.
    - `deleteVoterRecord(issueId, roundId, accountId)`: Validates identifiers and calls `kvsClient.delete(buildVoteKey(issueId, roundId, accountId))`.
    - `listVoterRecords(issueId, roundId, nowMs)`: Validates `issueId`, `roundId`, and finite `nowMs` (throwing `PokerDomainError` with `code: 'validation-error'` on invalid input). Queries `kvsClient.query().where('key', WhereConditions.beginsWith(prefix)).limit(KVS_QUERY_LIMIT)` looping `.cursor(nextCursor)` across all pages until `!nextCursor`. Filters out malformed entries and any entry where `isRoundExpired(vote.votedAt, nowMs)` is `true`, returning all active `VoteRecord` items.
    - `deleteRoundVotes(issueId, roundId)`: Validates `issueId` and `roundId`. Collects **all** matching item keys across every `nextCursor` page until `!nextCursor`, then calls `kvsClient.delete(key)` for every collected key, returning the number of deleted keys.

---

### 3. `src/realtime/publisher.ts`

```ts
import type { FibonacciScore } from '../domain/types'
import type { BackendLogger } from '../observability/logger'

export const POKER_REALTIME_CHANNEL: 'scrum-poker'

export type SessionUpdatedRealtimeEvent = {
  readonly type: 'SESSION_UPDATED'
  readonly roundId: string
  readonly updatedAt: number
}

export type PointsAppliedRealtimeEvent = {
  readonly type: 'points-applied'
  readonly roundId: string
  readonly score: FibonacciScore
  readonly updatedAt: number
}

export type PokerRealtimeEvent = SessionUpdatedRealtimeEvent | PointsAppliedRealtimeEvent

export type RealtimePublishFn = (channel: string, payload: PokerRealtimeEvent) => Promise<unknown>

export interface CreateRealtimePublisherDeps {
  readonly publish?: RealtimePublishFn
  readonly logger?: BackendLogger
}

export interface RealtimePublisher {
  publishSessionUpdated(roundId: string, updatedAt: number): Promise<void>
  publishPointsApplied(roundId: string, score: FibonacciScore, updatedAt: number): Promise<void>
}

export function createRealtimePublisher(deps?: CreateRealtimePublisherDeps): RealtimePublisher
```

- **Behaviour & Error Conditions:**
  - Defaults `deps.publish` to `publish` from `@forge/realtime` and `deps.logger` to `createBackendLogger()`.
  - `publishSessionUpdated(roundId, updatedAt)`:
    - Validates `assertSafeIdentifier(roundId, 'roundId')` and finite `updatedAt` (`typeof updatedAt === 'number' && Number.isFinite(updatedAt)`), throwing `PokerDomainError` (`code: 'validation-error'`) if invalid.
    - Publishes `{ type: 'SESSION_UPDATED', roundId, updatedAt }` to `POKER_REALTIME_CHANNEL` (`'scrum-poker'`).
    - If `publish` rejects at runtime, logs via `logger.warn('realtime.publish_failed', { channel: POKER_REALTIME_CHANNEL, eventType: 'SESSION_UPDATED', roundId, error })` and resolves `undefined` without rethrowing.
  - `publishPointsApplied(roundId, score, updatedAt)`:
    - Validates `assertSafeIdentifier(roundId, 'roundId')`, `validateFibonacciScore(score)`, and finite `updatedAt`, throwing `PokerDomainError` (`code: 'validation-error'`) if invalid.
    - Publishes `{ type: 'points-applied', roundId, score, updatedAt }` to `POKER_REALTIME_CHANNEL` (`'scrum-poker'`).
    - If `publish` rejects at runtime, logs via `logger.warn('realtime.publish_failed', { channel: POKER_REALTIME_CHANNEL, eventType: 'points-applied', roundId, error })` and resolves `undefined` without rethrowing.

---

### 4. `src/jira/jira-client.ts`

```ts
import type { Route } from '@forge/api'
import type { FibonacciScore, StoryPointsFieldInfo } from '../domain/types'
import type { BackendLogger } from '../observability/logger'

export interface VoterProfile {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export type ApplyStoryPointsFailureReason = 'missing-field' | 'forbidden' | 'jira-error'

export type JiraWriteStoryPointsOutcome =
  | {
      readonly ok: true
      readonly appliedScore: FibonacciScore
      readonly fieldId: string
      readonly fieldName: string
    }
  | {
      readonly ok: false
      readonly reason: ApplyStoryPointsFailureReason
      readonly score: FibonacciScore
      readonly message: string
    }

export interface JiraResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface JiraRequestInit {
  readonly method?: 'GET' | 'PUT'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export type JiraRequester = (path: Route | string, init?: JiraRequestInit) => Promise<JiraResponseLike>

export interface CreateJiraClientDeps {
  readonly requestAsUser?: JiraRequester
  readonly logger?: BackendLogger
}

export interface JiraClient {
  getCurrentUserProfile(): Promise<VoterProfile>
  getEditableStoryPointsField(issueId: string): Promise<StoryPointsFieldInfo | null>
  updateStoryPoints(issueId: string, score: FibonacciScore): Promise<JiraWriteStoryPointsOutcome>
}

export function createJiraClient(deps?: CreateJiraClientDeps): JiraClient
```

- **Behaviour & Error Conditions:**
  - Defaults `deps.requestAsUser` to `(path, init) => api.asUser().requestJira(path as Route, init)` (using `api` and `route` from `@forge/api`) and `deps.logger` to `createBackendLogger()`.
  - `getCurrentUserProfile()`:
    - Calls `requestAsUser(route\`/rest/api/3/myself\`, { headers: { Accept: 'application/json' } })`.
    - On `response.ok === true`: parses JSON; sets `displayName = normalizeDisplayName(body.displayName)`; resolves `avatarUrl` to the first trimmed non-empty string among `body.avatarUrl`, `body.avatarUrls['24x24']`, `body.avatarUrls['32x32']`, `body.avatarUrls['48x48']`, `body.avatarUrls['16x16']`, or `null`; ignores `emailAddress` and all other fields.
    - On `!response.ok`, invalid JSON, or transport exception: logs `logger.warn('jira.myself_failed', { status })` (or `{ error }`) and returns `{ displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null }`.
  - `getEditableStoryPointsField(issueId)`:
    - Validates `assertSafeIdentifier(issueId, 'issueId')` (throws `PokerDomainError` with `code: 'validation-error'` if invalid).
    - Calls `requestAsUser(route\`/rest/api/3/issue/${issueId}/editmeta\`, { headers: { Accept: 'application/json' } })`.
    - On `response.ok === true`: parses JSON and returns `detectStoryPointsField(json)` (`StoryPointsFieldInfo | null`).
    - On `401` or `403`: returns `null` silently without logging an error.
    - On other `!response.ok` statuses, invalid JSON, or transport exception: logs `logger.warn('jira.editmeta_failed', { issueId, status })` and returns `null`.
  - `updateStoryPoints(issueId, score)`:
    - Validates `assertSafeIdentifier(issueId, 'issueId')` and `validateFibonacciScore(score)` (throws `PokerDomainError` with `code: 'validation-error'` if invalid).
    - Step 1 (`editmeta` inspection): Calls `requestAsUser(route\`/rest/api/3/issue/${issueId}/editmeta\`, { headers: { Accept: 'application/json' } })`:
      - If `status === 401 || status === 403`: returns `{ ok: false, reason: 'forbidden', score, message: <non-empty string> }`.
      - If `!response.ok`, JSON parse fails, or transport throws: logs via `logger.error('jira.editmeta_write_check_failed', { issueId, status })` and returns `{ ok: false, reason: 'jira-error', score, message: <non-empty string> }`.
      - Runs `detectStoryPointsField(editMetaJson)`: if `null`, returns `{ ok: false, reason: 'missing-field', score, message: <non-empty string> }` without calling `PUT`.
    - Step 2 (`PUT` issue field update): Calls `requestAsUser(route\`/rest/api/3/issue/${issueId}\`, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { [detected.fieldId]: score } }) })`:
      - If `response.ok === true`: returns `{ ok: true, appliedScore: score, fieldId: detected.fieldId, fieldName: detected.fieldName }`.
      - If `status === 401 || status === 403`: returns `{ ok: false, reason: 'forbidden', score, message: <non-empty string> }`.
      - If `!response.ok` or transport throws: extracts a safe non-empty message (from Jira JSON `errorMessages` / `errors` if available, else HTTP status diagnostic), logs via `logger.error('jira.update_story_points_failed', { issueId, status })`, and returns `{ ok: false, reason: 'jira-error', score, message }`.

---

### 5. `src/resolvers/poker-resolvers.ts` & `src/index.ts`

```ts
import type { DeckCard, FibonacciScore, SessionSnapshot } from '../domain/types'
import type { ApplyStoryPointsFailureReason, JiraClient } from '../jira/jira-client'
import type { BackendLogger } from '../observability/logger'
import type { RealtimePublisher } from '../realtime/publisher'
import type { SessionStore } from '../storage/session-store'

export const RESOLVER_KEYS: {
  readonly getSession: 'getSession'
  readonly castVote: 'castVote'
  readonly withdrawVote: 'withdrawVote'
  readonly revealVotes: 'revealVotes'
  readonly selectOverrideScore: 'selectOverrideScore'
  readonly resetRound: 'resetRound'
  readonly applyStoryPoints: 'applyStoryPoints'
}

export type ResolverKey = (typeof RESOLVER_KEYS)[keyof typeof RESOLVER_KEYS]

export interface CastVotePayload {
  readonly card: DeckCard
}

export interface SelectOverrideScorePayload {
  readonly score: FibonacciScore
}

export interface ApplyStoryPointsPayload {
  readonly score: FibonacciScore
}

export type ApplyStoryPointsResult =
  | {
      readonly ok: true
      readonly appliedScore: FibonacciScore
      readonly fieldName: string
      readonly session: SessionSnapshot
    }
  | {
      readonly ok: false
      readonly reason: ApplyStoryPointsFailureReason
      readonly score: FibonacciScore
      readonly message: string
    }

export interface ForgeIssueContext {
  readonly id?: unknown
  readonly key?: unknown
}

export interface ForgeExtensionContext {
  readonly issue?: ForgeIssueContext | null
}

export interface ForgeResolverContext {
  readonly accountId?: unknown
  readonly extension?: ForgeExtensionContext | null
}

export interface ForgeResolverRequest<TPayload = unknown> {
  readonly payload?: TPayload
  readonly context?: ForgeResolverContext | null
}

export interface AuthenticatedHostContext {
  readonly issueId: string
  readonly issueKey: string | null
  readonly accountId: string
}

export interface PokerBackendDeps {
  readonly store?: SessionStore
  readonly jira?: JiraClient
  readonly realtime?: RealtimePublisher
  readonly logger?: BackendLogger
  readonly now?: () => number
}

export interface PokerResolverHandlers {
  getSession(req: ForgeResolverRequest): Promise<SessionSnapshot>
  castVote(req: ForgeResolverRequest): Promise<SessionSnapshot>
  withdrawVote(req: ForgeResolverRequest): Promise<SessionSnapshot>
  revealVotes(req: ForgeResolverRequest): Promise<SessionSnapshot>
  selectOverrideScore(req: ForgeResolverRequest): Promise<SessionSnapshot>
  resetRound(req: ForgeResolverRequest): Promise<SessionSnapshot>
  applyStoryPoints(req: ForgeResolverRequest): Promise<ApplyStoryPointsResult>
}

export interface ResolverRegistryLike {
  define(functionKey: string, cb: (req: ForgeResolverRequest) => Promise<unknown>): unknown
}

export function extractAuthenticatedContext(context: unknown): AuthenticatedHostContext

export function createPokerResolverHandlers(deps?: PokerBackendDeps): PokerResolverHandlers

export function registerPokerResolvers<TResolver extends ResolverRegistryLike>(
  resolver: TResolver,
  deps?: PokerBackendDeps,
): TResolver
```

And in `src/index.ts`:

```ts
import Resolver from '@forge/resolver'

export const handler: ReturnType<Resolver['getDefinitions']>
```

- **Behaviour & Error Conditions:**
  - `extractAuthenticatedContext(context)`:
    - Validates `context` is a plain object (`context !== null && typeof context === 'object' && !Array.isArray(context) && (Object.getPrototypeOf(context) === Object.prototype || Object.getPrototypeOf(context) === null)`), `accountId = assertSafeIdentifier(context.accountId, 'accountId')`, and `issueId = assertSafeIdentifier(context.extension?.issue?.id, 'issueId')`; throws `PokerDomainError` (`code: 'validation-error'`) if any check fails.
    - Sets `issueKey` to `context.extension.issue.key.trim()` when `typeof context.extension?.issue?.key === 'string' && context.extension.issue.key.trim().length > 0`, or `null` otherwise.
  - `createPokerResolverHandlers(deps)`:
    - Defaults `logger` to `createBackendLogger()`, `store` to `createSessionStore()`, `jira` to `createJiraClient({ logger })`, `realtime` to `createRealtimePublisher({ logger })`, and `now` to `() => Date.now()`.
    - All 7 handlers validate `extractAuthenticatedContext(req?.context)` **first** (ignoring any `issueId`, `issueKey`, or `accountId` properties inside `req.payload`).
    - **Cross-handler `storyPointsField` & Jira call invariant (`R10`, `R11`, `R13`):**
      - All 6 `SessionSnapshot`-returning handlers (`getSession`, `castVote`, `withdrawVote`, `revealVotes`, `selectOverrideScore`, and `resetRound`) resolve `storyPointsField` via `await jira.getEditableStoryPointsField(issueId)` **exactly once per non-throwing invocation**, and **only after** all host-context, payload (`validation-error`), round-state (`invalid-state`), and precondition (`precondition-failed`) guards have passed.
      - Any invocation that rejects with `PokerDomainError` (`validation-error`, `invalid-state`, or `precondition-failed`) performs **zero** `jira` calls (`0` calls to `getEditableStoryPointsField`, `getCurrentUserProfile`, or `updateStoryPoints`), **zero** KVS writes, and **zero** realtime publishes.
    - **Active voter record rule (`castVote`, `withdrawVote`):**
      - A stored voter record returned by `store.getVoterRecord(issueId, meta.roundId, accountId)` counts as **active** iff `vote !== null && !isRoundExpired(vote.votedAt, nowMs)`.
    - `getSession(req)`: Reads `meta` and resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)`. If `meta === null` or `isRoundExpired(meta.updatedAt, nowMs)`, returns `createIdleSessionSnapshot(storyPointsField, null)` with zero KVS writes. Otherwise loads `listVoterRecords(issueId, meta.roundId, nowMs)` and returns `projectSessionSnapshot({ meta, votes, viewerAccountId: accountId, storyPointsField, nowMs })`.
    - `castVote(req)`: Validates `req.payload` is a plain object (`proto === Object.prototype || proto === null`) and `card = validateDeckCard(req.payload.card)` (`validation-error` on failure, before KVS/Jira I/O). Reads `meta`; rejects active `'revealed'` rounds (`meta !== null && !isRoundExpired(meta.updatedAt, nowMs) && meta.status === 'revealed'`) with `PokerDomainError` (`code: 'invalid-state'`, making zero Jira calls). When `meta` is `null` or expired, initializes `roundId = nextRoundId(meta?.roundId)`, deletes any stale votes under `meta.roundId`, resolves `getCurrentUserProfile()` and `storyPointsField = await jira.getEditableStoryPointsField(issueId)`, writes caller's `VoteRecord` (`votedAt: nowMs`) and `RoundMeta` (`status: 'voting'`, `overrideScore: null`, `updatedAt: nowMs`), publishes `'SESSION_UPDATED'`, loads `listVoterRecords(issueId, roundId, nowMs)`, and returns `projectSessionSnapshot(...)`. When `meta` is an active `'voting'` round, inspects caller's `existingVote = await store.getVoterRecord(issueId, meta.roundId, accountId)`: if `existingVote !== null && !isRoundExpired(existingVote.votedAt, nowMs) && existingVote.card === card`, deletes caller's vote record, refreshes `meta.updatedAt = nowMs`, publishes `'SESSION_UPDATED'`, resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)` (zero `getCurrentUserProfile` calls), loads `listVoterRecords(issueId, meta.roundId, nowMs)`, and returns `projectSessionSnapshot(...)` (`viewerCard: null`); otherwise (including when `existingVote === null`, `isRoundExpired(existingVote.votedAt, nowMs)` is `true`, or `existingVote.card !== card`) resolves `getCurrentUserProfile()` and `storyPointsField = await jira.getEditableStoryPointsField(issueId)`, writes caller's `VoteRecord` (`votedAt: nowMs`), refreshes `meta.updatedAt = nowMs`, publishes `'SESSION_UPDATED'`, loads `listVoterRecords(issueId, meta.roundId, nowMs)`, and returns `projectSessionSnapshot(...)` (`viewerCard: card`).
    - `withdrawVote(req)`: Reads `meta`; rejects active `'revealed'` rounds (`meta !== null && !isRoundExpired(meta.updatedAt, nowMs) && meta.status === 'revealed'`) with `PokerDomainError` (`code: 'invalid-state'`, making zero Jira calls). When `meta` is `null` or expired, resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)` and returns `createIdleSessionSnapshot(storyPointsField, null)` idempotently (zero KVS writes, zero realtime publishes). In an active `'voting'` round, inspects `existingVote = await store.getVoterRecord(issueId, meta.roundId, accountId)`: if caller has no active vote record (`existingVote === null || isRoundExpired(existingVote.votedAt, nowMs)`), resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)`, loads `listVoterRecords(issueId, meta.roundId, nowMs)`, and returns `projectSessionSnapshot(...)` idempotently without modifying `meta`, deleting keys, or publishing `'SESSION_UPDATED'`; otherwise deletes caller's vote key, refreshes `meta.updatedAt = nowMs`, publishes `'SESSION_UPDATED'`, resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)`, loads `listVoterRecords(issueId, meta.roundId, nowMs)`, and returns `projectSessionSnapshot(...)` (`viewerCard: null`).
    - `revealVotes(req)`: Reads `meta`; rejects with `PokerDomainError` (`code: 'precondition-failed'`, making zero Jira calls) when `meta` is `null`, expired, or (`meta.status === 'voting'` and `listVoterRecords(issueId, meta.roundId, nowMs)` returns `0` active votes). Once guards pass, resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)`: when already actively `'revealed'`, loads `listVoterRecords(issueId, meta.roundId, nowMs)` and returns `projectSessionSnapshot(...)` idempotently preserving `meta.overrideScore` and votes (zero KVS writes, zero realtime publishes); when `'voting'` with `>= 1` active votes, writes `meta = { roundId: meta.roundId, status: 'revealed', overrideScore: null, updatedAt: nowMs }`, publishes `'SESSION_UPDATED'`, and returns the revealed `SessionSnapshot` (`targetScore = recommendedScore`, `storyPointsField`).
    - `selectOverrideScore(req)`: Validates `req.payload` is a plain object (`proto === Object.prototype || proto === null`) and `score = validateFibonacciScore(req.payload.score)` (`validation-error` on failure, before KVS/Jira I/O). Reads `meta`; rejects `'voting'`, idle, or expired rounds with `PokerDomainError` (`code: 'invalid-state'`, making zero Jira calls). Writes `meta = { roundId: meta.roundId, status: 'revealed', overrideScore: score, updatedAt: nowMs }`, publishes `'SESSION_UPDATED'`, loads `listVoterRecords(issueId, meta.roundId, nowMs)`, resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)`, and returns `projectSessionSnapshot(...)` (`targetScore === score`, `storyPointsField`).
    - `resetRound(req)`: Reads `meta`, computes `newRoundId = nextRoundId(meta?.roundId)`, writes `newMeta = { roundId: newRoundId, status: 'voting', overrideScore: null, updatedAt: nowMs }`, sweeps any prior-round votes (`if (meta !== null) await store.deleteRoundVotes(issueId, meta.roundId)`), publishes `'SESSION_UPDATED'`, resolves `storyPointsField = await jira.getEditableStoryPointsField(issueId)`, and returns `createIdleSessionSnapshot(storyPointsField, newRoundId)` (`roundId === newRoundId`, `participants: []`, `storyPointsField`).
    - `applyStoryPoints(req)`: Validates `req.payload` is a plain object (`proto === Object.prototype || proto === null`) and `score = validateFibonacciScore(req.payload.score)` (`validation-error` on failure, before KVS/Jira I/O). Reads `meta`; rejects `'voting'`, idle, or expired rounds with `PokerDomainError` (`code: 'invalid-state'`) before calling Jira. Calls `jira.updateStoryPoints(issueId, score)` (without calling `getEditableStoryPointsField` separately): on `ok: false`, leaves `meta` and votes untouched in KVS and returns `{ ok: false, reason, score, message }`; on `ok: true`, advances `meta` to `newRoundId = nextRoundId(meta.roundId)` (`status: 'voting'`, `overrideScore: null`, `updatedAt: nowMs`), deletes prior-round votes, publishes `{ type: 'points-applied', roundId: newRoundId, score, updatedAt: nowMs }`, and returns `{ ok: true, appliedScore: score, fieldName, session }` where `session` is `createIdleSessionSnapshot({ fieldId, fieldName }, newRoundId)`.
  - `registerPokerResolvers(resolver, deps)`: Registers all 7 `RESOLVER_KEYS` on `resolver` via `resolver.define(key, handlers[key])` and returns `resolver`.
  - `src/index.ts`: Instantiates `new Resolver()`, calls `registerPokerResolvers(resolver)`, and exports `export const handler = resolver.getDefinitions()`.

---

## External interfaces

- **Atlassian Forge Resolver RPC (`manifest.yml` `function: resolver-fn -> index.handler`):**
  - `getSession() -> SessionSnapshot`
  - `castVote({ card: DeckCard }) -> SessionSnapshot`
  - `withdrawVote() -> SessionSnapshot`
  - `revealVotes() -> SessionSnapshot`
  - `selectOverrideScore({ score: FibonacciScore }) -> SessionSnapshot`
  - `resetRound() -> SessionSnapshot`
  - `applyStoryPoints({ score: FibonacciScore }) -> ApplyStoryPointsResult`
- **Atlassian Forge Key-Value Store (`@forge/kvs`):**
  - `poker:${issueId}:meta` (`RoundMeta`, TTL `24 HOURS`)
  - `poker:${issueId}:${roundId}:vote:${accountId}` (`VoteRecord`, TTL `24 HOURS`, prefix-queried with `.limit(100)` and `nextCursor` loop)
- **Atlassian Forge Realtime (`@forge/realtime`):**
  - Channel `'scrum-poker'` publishing `PokerRealtimeEvent` (`'SESSION_UPDATED'` and `'points-applied'`).
- **Jira Cloud REST API v3 (`@forge/api` `api.asUser().requestJira`):**
  - `GET /rest/api/3/myself`
  - `GET /rest/api/3/issue/{issueId}/editmeta`
  - `PUT /rest/api/3/issue/{issueId}` (`{ fields: { [fieldId]: score } }`)
- **Platform Manifest (`manifest.yml`):**
  - Zero `permissions.external` egress; exact scopes `storage:app`, `read:jira-work`, `write:jira-work`, `read:jira-user`.

---

## UI hooks

None in Phase 2. Custom UI components, `aria-pressed` card buttons, and DOM hooks are introduced in Phase 3 (`static/panel/src/`).

---

## Data

- **KVS Key Isolation Invariant (`R2`, `R4`):** Every voter's selection is persisted exclusively under `poker:${issueId}:${roundId}:vote:${accountId}` (`KVS_TTL_24H`); concurrent votes by distinct `accountId`s never write to a shared vote array.
- **Deterministic Round Progression (`R4`, `R9`):** `nextRoundId` advances deterministically (`null -> 'round-1'`, `'round-1' -> 'round-2'`, etc.), guaranteeing distinct round identifiers across resets/expirations and conflict-free round initialization under concurrent first votes.
- **Dual 24-Hour Expiration Invariant (`R9`):** Every KVS write includes `{ ttl: { value: 24, unit: 'HOURS' } }`, and every read enforces `nowMs - timestamp < 86_400_000` (`SESSION_TTL_MS`) without extending `updatedAt` on expired reads.
- **Realtime & Log Redaction Invariant (`R5`, `R14`):** `@forge/realtime` payloads contain only `{ type, roundId, updatedAt, score? }`, `/rest/api/3/myself` discards `emailAddress`, and `BackendLogger` replaces card, vote, credential, and email values with `'[REDACTED]'`.
- **Story Points Write Atomicity (`R11`):** Failed Story Points writes (`'missing-field'`, `'forbidden'`, `'jira-error'`) perform zero KVS mutations and publish zero realtime events, leaving the `'revealed'` round, votes, and `targetScore` intact.

---

## Stub files

- src/observability/logger.ts
- src/storage/session-store.ts
- src/realtime/publisher.ts
- src/jira/jira-client.ts
- src/resolvers/poker-resolvers.ts
- src/index.ts
