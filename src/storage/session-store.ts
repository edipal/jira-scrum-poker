import type { WhereConditions } from '@forge/kvs'
import type { RoundMeta, VoteRecord } from '../domain/types'

export const KVS_TTL_24H = {
  ttl: {
    value: 24,
    unit: 'HOURS',
  },
} as const

export const KVS_QUERY_LIMIT = 100

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

export function assertSafeIdentifier(_value: unknown, _label: string): string {
  throw new Error('not implemented')
}

export function buildMetaKey(_issueId: string): string {
  throw new Error('not implemented')
}

export function buildVoteKeyPrefix(_issueId: string, _roundId: string): string {
  throw new Error('not implemented')
}

export function buildVoteKey(_issueId: string, _roundId: string, _accountId: string): string {
  throw new Error('not implemented')
}

export function nextRoundId(_previousRoundId?: string | null): string {
  throw new Error('not implemented')
}

export function createSessionStore(_kvsClient?: KvsClientLike): SessionStore {
  throw new Error('not implemented')
}
