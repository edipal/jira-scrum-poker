import { WhereConditions, kvs } from '@forge/kvs'
import { isValidDeckCard, isValidFibonacciScore, validateDeckCard, validateFibonacciScore } from '../domain/deck'
import { isRoundExpired, normalizeDisplayName } from '../domain/session-view'
import { type FibonacciScore, PokerDomainError, type RoundMeta, type VoteRecord } from '../domain/types'

export const KVS_TTL_24H = {
  ttl: {
    value: 24,
    unit: 'HOURS',
  },
} as const

export const KVS_QUERY_LIMIT = 100

const MAX_IDENTIFIER_LENGTH = 128

const MAX_CLOSED_ROUND_HOPS = 16

const ROUND_ID_COUNTER_PATTERN = /^(.+)-([1-9]\d*)$/

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

interface StoredRoundStatusRecord {
  readonly status: 'revealed'
  readonly updatedAt: number
}

interface StoredRoundOverrideRecord {
  readonly score: FibonacciScore
  readonly updatedAt: number
}

interface StoredRoundActivityRecord {
  readonly updatedAt: number
}

interface StoredRoundClosedRecord {
  readonly nextRoundId: string
  readonly closedAt: number
}

export interface SessionStore {
  getRoundMeta(issueId: string): Promise<RoundMeta | null>
  setRoundMeta(issueId: string, meta: RoundMeta): Promise<void>
  initializeRound(issueId: string, roundId: string, nowMs: number): Promise<RoundMeta>
  advanceRound(
    issueId: string,
    previousRoundId: string | null,
    nextRoundIdValue: string,
    nowMs: number,
  ): Promise<RoundMeta>
  touchRoundActivity(issueId: string, roundId: string, nowMs: number): Promise<void>
  markRoundRevealed(issueId: string, roundId: string, nowMs: number): Promise<RoundMeta>
  setRoundOverride(issueId: string, roundId: string, score: FibonacciScore, nowMs: number): Promise<RoundMeta>
  getVoterRecord(issueId: string, roundId: string, accountId: string): Promise<VoteRecord | null>
  setVoterRecord(issueId: string, roundId: string, vote: VoteRecord): Promise<void>
  deleteVoterRecord(issueId: string, roundId: string, accountId: string): Promise<void>
  listVoterRecords(issueId: string, roundId: string, nowMs: number): Promise<VoteRecord[]>
  deleteRoundVotes(issueId: string, roundId: string): Promise<number>
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeIdentifierString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}

function normalizeFiniteTimestamp(value: number): number {
  return value === 0 ? 0 : value
}

function assertFiniteTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PokerDomainError('validation-error', `${label} must be a finite number`)
  }
  return normalizeFiniteTimestamp(value)
}

export function assertSafeIdentifier(value: unknown, label: string): string {
  if (!isSafeIdentifierString(value)) {
    throw new PokerDomainError('validation-error', `Invalid ${label}: must be a non-empty canonical identifier`)
  }
  return value
}

export function buildMetaKey(issueId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  return `poker:${validIssueId}:meta`
}

export function buildRoundStatusKey(issueId: string, roundId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  const validRoundId = assertSafeIdentifier(roundId, 'roundId')
  return `poker:${validIssueId}:${validRoundId}:status`
}

export function buildRoundOverrideKey(issueId: string, roundId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  const validRoundId = assertSafeIdentifier(roundId, 'roundId')
  return `poker:${validIssueId}:${validRoundId}:override`
}

export function buildRoundActivityKey(issueId: string, roundId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  const validRoundId = assertSafeIdentifier(roundId, 'roundId')
  return `poker:${validIssueId}:${validRoundId}:activity`
}

export function buildRoundClosedKey(issueId: string, roundId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  const validRoundId = assertSafeIdentifier(roundId, 'roundId')
  return `poker:${validIssueId}:${validRoundId}:closed`
}

export function buildVoteKeyPrefix(issueId: string, roundId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  const validRoundId = assertSafeIdentifier(roundId, 'roundId')
  return `poker:${validIssueId}:${validRoundId}:vote:`
}

export function buildVoteKey(issueId: string, roundId: string, accountId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  const validRoundId = assertSafeIdentifier(roundId, 'roundId')
  const validAccountId = assertSafeIdentifier(accountId, 'accountId')
  return `poker:${validIssueId}:${validRoundId}:vote:${validAccountId}`
}

export function nextRoundId(previousRoundId?: string | null): string {
  if (previousRoundId === undefined || previousRoundId === null) {
    return 'round-1'
  }
  const validated = assertSafeIdentifier(previousRoundId, 'roundId')
  const match = ROUND_ID_COUNTER_PATTERN.exec(validated)
  if (match !== null) {
    const prefix = match[1]
    const counter = match[2]
    if (prefix !== undefined && counter !== undefined) {
      return `${prefix}-${(BigInt(counter) + 1n).toString(10)}`
    }
  }
  return `${validated}-2`
}

function parseStoredRoundMeta(raw: unknown): RoundMeta | null {
  if (!isNonNullObject(raw)) {
    return null
  }
  if (!isSafeIdentifierString(raw.roundId)) {
    return null
  }
  if (raw.status !== 'voting' && raw.status !== 'revealed') {
    return null
  }
  if (raw.overrideScore !== null && !isValidFibonacciScore(raw.overrideScore)) {
    return null
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }

  return {
    roundId: raw.roundId,
    status: raw.status,
    overrideScore: raw.overrideScore,
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
  }
}

function parseStoredRoundStatus(raw: unknown): StoredRoundStatusRecord | null {
  if (!isNonNullObject(raw) || raw.status !== 'revealed') {
    return null
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }
  return {
    status: 'revealed',
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
  }
}

function parseStoredRoundOverride(raw: unknown): StoredRoundOverrideRecord | null {
  if (!isNonNullObject(raw) || !isValidFibonacciScore(raw.score)) {
    return null
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }
  return {
    score: raw.score,
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
  }
}

function parseStoredRoundActivity(raw: unknown): StoredRoundActivityRecord | null {
  if (!isNonNullObject(raw) || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }
  return {
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
  }
}

function parseStoredRoundClosed(raw: unknown): StoredRoundClosedRecord | null {
  if (!isNonNullObject(raw) || !isSafeIdentifierString(raw.nextRoundId)) {
    return null
  }
  if (typeof raw.closedAt !== 'number' || !Number.isFinite(raw.closedAt)) {
    return null
  }
  return {
    nextRoundId: raw.nextRoundId,
    closedAt: normalizeFiniteTimestamp(raw.closedAt),
  }
}

function validateRoundMetaForWrite(meta: unknown): RoundMeta {
  if (!isNonNullObject(meta)) {
    throw new PokerDomainError('validation-error', 'Round metadata must be an object')
  }
  const roundId = assertSafeIdentifier(meta.roundId, 'roundId')
  if (meta.status !== 'voting' && meta.status !== 'revealed') {
    throw new PokerDomainError('validation-error', `Invalid round status: ${String(meta.status)}`)
  }
  if (meta.overrideScore !== null && !isValidFibonacciScore(meta.overrideScore)) {
    throw new PokerDomainError('validation-error', `Invalid overrideScore: ${String(meta.overrideScore)}`)
  }
  if (typeof meta.updatedAt !== 'number' || !Number.isFinite(meta.updatedAt)) {
    throw new PokerDomainError('validation-error', 'Round updatedAt must be a finite number')
  }

  return {
    roundId,
    status: meta.status,
    overrideScore: meta.overrideScore,
    updatedAt: normalizeFiniteTimestamp(meta.updatedAt),
  }
}

function normalizeOptionalAvatarUrl(rawAvatarUrl: unknown): string | null {
  if (typeof rawAvatarUrl === 'string' && rawAvatarUrl.trim().length > 0) {
    return rawAvatarUrl.trim()
  }
  return null
}

function parseStoredVoteRecord(raw: unknown, expectedAccountId?: string): VoteRecord | null {
  if (!isNonNullObject(raw)) {
    return null
  }
  if (!isSafeIdentifierString(raw.accountId)) {
    return null
  }
  if (expectedAccountId !== undefined && raw.accountId !== expectedAccountId) {
    return null
  }
  if (!isValidDeckCard(raw.card)) {
    return null
  }
  if (typeof raw.votedAt !== 'number' || !Number.isFinite(raw.votedAt)) {
    return null
  }
  if (raw.displayName !== undefined && raw.displayName !== null && typeof raw.displayName !== 'string') {
    return null
  }
  if (raw.avatarUrl !== undefined && raw.avatarUrl !== null && typeof raw.avatarUrl !== 'string') {
    return null
  }

  return {
    accountId: raw.accountId,
    displayName: normalizeDisplayName(raw.displayName),
    avatarUrl: normalizeOptionalAvatarUrl(raw.avatarUrl),
    card: raw.card,
    votedAt: normalizeFiniteTimestamp(raw.votedAt),
  }
}

function validateVoteRecordForWrite(rawVote: unknown): VoteRecord {
  if (!isNonNullObject(rawVote)) {
    throw new PokerDomainError('validation-error', 'Vote record must be an object')
  }
  const accountId = assertSafeIdentifier(rawVote.accountId, 'accountId')
  const card = validateDeckCard(rawVote.card)
  if (typeof rawVote.votedAt !== 'number' || !Number.isFinite(rawVote.votedAt)) {
    throw new PokerDomainError('validation-error', 'Vote votedAt must be a finite number')
  }
  if (rawVote.displayName !== undefined && rawVote.displayName !== null && typeof rawVote.displayName !== 'string') {
    throw new PokerDomainError('validation-error', 'Vote displayName must be a string')
  }
  if (rawVote.avatarUrl !== undefined && rawVote.avatarUrl !== null && typeof rawVote.avatarUrl !== 'string') {
    throw new PokerDomainError('validation-error', 'Vote avatarUrl must be a string or null')
  }

  return {
    accountId,
    displayName: normalizeDisplayName(rawVote.displayName),
    avatarUrl: normalizeOptionalAvatarUrl(rawVote.avatarUrl),
    card,
    votedAt: normalizeFiniteTimestamp(rawVote.votedAt),
  }
}

export function createSessionStore(kvsClient?: KvsClientLike): SessionStore {
  const client: KvsClientLike = kvsClient ?? kvs

  async function resolveCurrentRoundMeta(issueId: string): Promise<RoundMeta | null> {
    const metaKey = buildMetaKey(issueId)
    const baseMeta = parseStoredRoundMeta(await client.get(metaKey))
    if (baseMeta === null) {
      return null
    }

    let currentRoundId = baseMeta.roundId
    let fallbackStatus: RoundMeta['status'] = baseMeta.status
    let fallbackOverride: FibonacciScore | null = baseMeta.overrideScore
    let latestUpdatedAt = baseMeta.updatedAt

    const visitedRounds = new Set<string>([currentRoundId])
    let statusRecord: StoredRoundStatusRecord | null = null
    let overrideRecord: StoredRoundOverrideRecord | null = null
    let activityRecord: StoredRoundActivityRecord | null = null

    for (let hop = 0; hop <= MAX_CLOSED_ROUND_HOPS; hop += 1) {
      const [rawClosed, rawStatus, rawOverride, rawActivity] = await Promise.all([
        client.get(buildRoundClosedKey(issueId, currentRoundId)),
        client.get(buildRoundStatusKey(issueId, currentRoundId)),
        client.get(buildRoundOverrideKey(issueId, currentRoundId)),
        client.get(buildRoundActivityKey(issueId, currentRoundId)),
      ])

      const closedRecord = parseStoredRoundClosed(rawClosed)
      if (hop < MAX_CLOSED_ROUND_HOPS && closedRecord !== null && !visitedRounds.has(closedRecord.nextRoundId)) {
        visitedRounds.add(closedRecord.nextRoundId)
        currentRoundId = closedRecord.nextRoundId
        fallbackStatus = 'voting'
        fallbackOverride = null
        latestUpdatedAt = closedRecord.closedAt
        continue
      }

      statusRecord = parseStoredRoundStatus(rawStatus)
      overrideRecord = parseStoredRoundOverride(rawOverride)
      activityRecord = parseStoredRoundActivity(rawActivity)
      break
    }

    const resolvedStatus: RoundMeta['status'] =
      fallbackStatus === 'revealed' || statusRecord?.status === 'revealed' ? 'revealed' : 'voting'

    const resolvedOverride: FibonacciScore | null =
      resolvedStatus === 'revealed' ? (overrideRecord !== null ? overrideRecord.score : fallbackOverride) : null

    if (statusRecord !== null && statusRecord.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = statusRecord.updatedAt
    }
    if (overrideRecord !== null && overrideRecord.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = overrideRecord.updatedAt
    }
    if (activityRecord !== null && activityRecord.updatedAt > latestUpdatedAt) {
      latestUpdatedAt = activityRecord.updatedAt
    }

    return {
      roundId: currentRoundId,
      status: resolvedStatus,
      overrideScore: resolvedOverride,
      updatedAt: normalizeFiniteTimestamp(latestUpdatedAt),
    }
  }

  return {
    async getRoundMeta(issueId: string): Promise<RoundMeta | null> {
      return await resolveCurrentRoundMeta(issueId)
    },

    async setRoundMeta(issueId: string, meta: RoundMeta): Promise<void> {
      const key = buildMetaKey(issueId)
      const validatedMeta = validateRoundMetaForWrite(meta)
      const writes: Promise<void>[] = [client.set(key, validatedMeta, KVS_TTL_24H)]
      if (validatedMeta.status === 'revealed') {
        writes.push(
          client.set(
            buildRoundStatusKey(issueId, validatedMeta.roundId),
            { status: 'revealed', updatedAt: validatedMeta.updatedAt } satisfies StoredRoundStatusRecord,
            KVS_TTL_24H,
          ),
        )
      }
      if (validatedMeta.overrideScore !== null) {
        writes.push(
          client.set(
            buildRoundOverrideKey(issueId, validatedMeta.roundId),
            {
              score: validatedMeta.overrideScore,
              updatedAt: validatedMeta.updatedAt,
            } satisfies StoredRoundOverrideRecord,
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)
    },

    async initializeRound(issueId: string, roundId: string, nowMs: number): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')
      const initialMeta: RoundMeta = {
        roundId: validRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: validNowMs,
      }
      await Promise.all([
        client.set(buildMetaKey(validIssueId), initialMeta, KVS_TTL_24H),
        client.set(
          buildRoundActivityKey(validIssueId, validRoundId),
          { updatedAt: validNowMs } satisfies StoredRoundActivityRecord,
          KVS_TTL_24H,
        ),
      ])
      return (await resolveCurrentRoundMeta(validIssueId)) ?? initialMeta
    },

    async advanceRound(
      issueId: string,
      previousRoundId: string | null,
      nextRoundIdValue: string,
      nowMs: number,
    ): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validNextRoundId = assertSafeIdentifier(nextRoundIdValue, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')
      const newMeta: RoundMeta = {
        roundId: validNextRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: validNowMs,
      }

      const writes: Promise<void>[] = [
        client.set(buildMetaKey(validIssueId), newMeta, KVS_TTL_24H),
        client.set(
          buildRoundActivityKey(validIssueId, validNextRoundId),
          { updatedAt: validNowMs } satisfies StoredRoundActivityRecord,
          KVS_TTL_24H,
        ),
      ]
      if (previousRoundId !== null && previousRoundId !== validNextRoundId) {
        const validPrevRoundId = assertSafeIdentifier(previousRoundId, 'previousRoundId')
        writes.push(
          client.set(
            buildRoundClosedKey(validIssueId, validPrevRoundId),
            { nextRoundId: validNextRoundId, closedAt: validNowMs } satisfies StoredRoundClosedRecord,
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)
      return (await resolveCurrentRoundMeta(validIssueId)) ?? newMeta
    },

    async touchRoundActivity(issueId: string, roundId: string, nowMs: number): Promise<void> {
      const activityKey = buildRoundActivityKey(issueId, roundId)
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')
      await client.set(activityKey, { updatedAt: validNowMs } satisfies StoredRoundActivityRecord, KVS_TTL_24H)
    },

    async markRoundRevealed(issueId: string, roundId: string, nowMs: number): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const existingOverride = parseStoredRoundOverride(
        await client.get(buildRoundOverrideKey(validIssueId, validRoundId)),
      )
      const revealedMeta: RoundMeta = {
        roundId: validRoundId,
        status: 'revealed',
        overrideScore: existingOverride?.score ?? null,
        updatedAt: validNowMs,
      }

      await Promise.all([
        client.set(
          buildRoundStatusKey(validIssueId, validRoundId),
          { status: 'revealed', updatedAt: validNowMs } satisfies StoredRoundStatusRecord,
          KVS_TTL_24H,
        ),
        client.set(buildMetaKey(validIssueId), revealedMeta, KVS_TTL_24H),
      ])

      return (await resolveCurrentRoundMeta(validIssueId)) ?? revealedMeta
    },

    async setRoundOverride(issueId: string, roundId: string, score: FibonacciScore, nowMs: number): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validScore = validateFibonacciScore(score)
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const updatedMeta: RoundMeta = {
        roundId: validRoundId,
        status: 'revealed',
        overrideScore: validScore,
        updatedAt: validNowMs,
      }

      await Promise.all([
        client.set(
          buildRoundOverrideKey(validIssueId, validRoundId),
          { score: validScore, updatedAt: validNowMs } satisfies StoredRoundOverrideRecord,
          KVS_TTL_24H,
        ),
        client.set(
          buildRoundStatusKey(validIssueId, validRoundId),
          { status: 'revealed', updatedAt: validNowMs } satisfies StoredRoundStatusRecord,
          KVS_TTL_24H,
        ),
        client.set(buildMetaKey(validIssueId), updatedMeta, KVS_TTL_24H),
      ])

      return (await resolveCurrentRoundMeta(validIssueId)) ?? updatedMeta
    },

    async getVoterRecord(issueId: string, roundId: string, accountId: string): Promise<VoteRecord | null> {
      const key = buildVoteKey(issueId, roundId, accountId)
      const stored = await client.get(key)
      return parseStoredVoteRecord(stored, accountId)
    },

    async setVoterRecord(issueId: string, roundId: string, vote: VoteRecord): Promise<void> {
      const normalizedVote = validateVoteRecordForWrite(vote)
      const key = buildVoteKey(issueId, roundId, normalizedVote.accountId)
      await client.set(key, normalizedVote, KVS_TTL_24H)
    },

    async deleteVoterRecord(issueId: string, roundId: string, accountId: string): Promise<void> {
      const key = buildVoteKey(issueId, roundId, accountId)
      await client.delete(key)
    },

    async listVoterRecords(issueId: string, roundId: string, nowMs: number): Promise<VoteRecord[]> {
      const prefix = buildVoteKeyPrefix(issueId, roundId)
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw new PokerDomainError('validation-error', 'nowMs must be a finite number')
      }

      const activeVotes: VoteRecord[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      do {
        let query = client.query().where('key', WhereConditions.beginsWith(prefix)).limit(KVS_QUERY_LIMIT)
        if (cursor !== undefined) {
          query = query.cursor(cursor)
        }
        const page = await query.getMany()
        for (const item of page.results) {
          if (!isNonNullObject(item)) {
            continue
          }
          const parsed = parseStoredVoteRecord(item.value)
          if (parsed !== null && !isRoundExpired(parsed.votedAt, nowMs)) {
            activeVotes.push(parsed)
          }
        }

        const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined
        if (next !== undefined && seenCursors.has(next)) {
          break
        }
        if (next !== undefined) {
          seenCursors.add(next)
        }
        cursor = next
      } while (cursor !== undefined)

      return activeVotes
    },

    async deleteRoundVotes(issueId: string, roundId: string): Promise<number> {
      const prefix = buildVoteKeyPrefix(issueId, roundId)
      const keysToDelete: string[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      do {
        let query = client.query().where('key', WhereConditions.beginsWith(prefix)).limit(KVS_QUERY_LIMIT)
        if (cursor !== undefined) {
          query = query.cursor(cursor)
        }
        const page = await query.getMany()
        for (const item of page.results) {
          if (isNonNullObject(item) && typeof item.key === 'string' && item.key.length > 0) {
            keysToDelete.push(item.key)
          }
        }

        const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined
        if (next !== undefined && seenCursors.has(next)) {
          break
        }
        if (next !== undefined) {
          seenCursors.add(next)
        }
        cursor = next
      } while (cursor !== undefined)

      await Promise.all(keysToDelete.map((key) => client.delete(key)))
      return keysToDelete.length
    },
  }
}
