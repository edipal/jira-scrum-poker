import { WhereConditions, kvs } from '@forge/kvs'
import { isValidDeckCard, isValidFibonacciScore, validateDeckCard } from '../domain/deck'
import { isRoundExpired, normalizeDisplayName } from '../domain/session-view'
import { PokerDomainError, type RoundMeta, type VoteRecord } from '../domain/types'

export const KVS_TTL_24H = {
  ttl: {
    value: 24,
    unit: 'HOURS',
  },
} as const

export const KVS_QUERY_LIMIT = 100

const MAX_IDENTIFIER_LENGTH = 128

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

export interface SessionStore {
  getRoundMeta(issueId: string): Promise<RoundMeta | null>
  setRoundMeta(issueId: string, meta: RoundMeta): Promise<void>
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

  return {
    async getRoundMeta(issueId: string): Promise<RoundMeta | null> {
      const key = buildMetaKey(issueId)
      const stored = await client.get(key)
      return parseStoredRoundMeta(stored)
    },

    async setRoundMeta(issueId: string, meta: RoundMeta): Promise<void> {
      const key = buildMetaKey(issueId)
      const validatedMeta = validateRoundMetaForWrite(meta)
      await client.set(key, validatedMeta, KVS_TTL_24H)
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
