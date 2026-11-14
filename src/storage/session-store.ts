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

export const KVS_TTL_7D = {
  ttl: {
    value: 7,
    unit: 'DAYS',
  },
} as const

export const KVS_QUERY_LIMIT = 100

const MAX_IDENTIFIER_LENGTH = 128

const MAX_CLOSED_ROUND_HOPS = 16

const ROUND_ID_COUNTER_PATTERN = /^(.+)-([1-9]\d*)$/
const STANDARD_ROUND_ID_PATTERN = /^round-([1-9]\d*)$/
const EPOCH_ID_PATTERN = /^epoch-([1-9]\d*)$/
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/

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

interface StoredSessionRecord {
  readonly epoch: string
  readonly startedAt: number
}

interface StoredRoundSeqRecord {
  readonly lastRoundNumber: string
  readonly lastEpochNumber: number
}

interface StoredRoundMetaEnvelope extends RoundMeta {
  readonly sessionEpoch?: string
}

interface StoredRoundStatusRecord {
  readonly status: 'revealed'
  readonly updatedAt: number
  readonly epoch?: string
}

interface StoredRoundOverrideRecord {
  readonly score: FibonacciScore
  readonly updatedAt: number
  readonly epoch?: string
}

interface StoredRoundActivityRecord {
  readonly updatedAt: number
  readonly epoch?: string
}

interface StoredRoundClosedRecord {
  readonly nextRoundId: string
  readonly closedAt: number
  readonly epoch?: string
}

interface StoredVoteRecordEnvelope extends VoteRecord {
  readonly sessionEpoch?: string
}

export interface SessionStore {
  getRoundMeta(issueId: string): Promise<RoundMeta | null>
  setRoundMeta(issueId: string, meta: RoundMeta): Promise<void>
  allocateRoundId(issueId: string, currentRoundId?: string | null): Promise<string>
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

export function buildSessionKey(issueId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  return `poker:${validIssueId}:session`
}

export function buildRoundSeqKey(issueId: string): string {
  const validIssueId = assertSafeIdentifier(issueId, 'issueId')
  return `poker:${validIssueId}:seq`
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

function extractStandardRoundNumber(roundId: string | null | undefined): bigint | null {
  if (typeof roundId !== 'string') {
    return null
  }
  const match = STANDARD_ROUND_ID_PATTERN.exec(roundId)
  const digits = match?.[1]
  if (digits === undefined) {
    return null
  }
  return BigInt(digits)
}

function extractEpochNumber(value: unknown): number {
  if (typeof value === 'string') {
    const match = EPOCH_ID_PATTERN.exec(value)
    const digits = match?.[1]
    if (digits === undefined) {
      return 0
    }
    const parsed = Number.parseInt(digits, 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }
  if (isNonNullObject(value)) {
    if (typeof value.epoch === 'string') {
      return extractEpochNumber(value.epoch)
    }
    if (typeof value.sessionEpoch === 'string') {
      return extractEpochNumber(value.sessionEpoch)
    }
  }
  return 0
}

function computeMergedRoundSeq(
  existingSeq: StoredRoundSeqRecord | null,
  roundIds: readonly (string | null | undefined)[],
  epochNumber: number,
): StoredRoundSeqRecord | null {
  let maxRound =
    existingSeq !== null && POSITIVE_DECIMAL_PATTERN.test(existingSeq.lastRoundNumber)
      ? BigInt(existingSeq.lastRoundNumber)
      : 0n
  for (const candidate of roundIds) {
    const parsed = extractStandardRoundNumber(candidate)
    if (parsed !== null && parsed > maxRound) {
      maxRound = parsed
    }
  }
  const maxEpoch = Math.max(existingSeq?.lastEpochNumber ?? 0, epochNumber)
  if (maxRound === 0n && maxEpoch === 0) {
    return null
  }
  return {
    lastRoundNumber: maxRound > 0n ? maxRound.toString(10) : '0',
    lastEpochNumber: maxEpoch,
  }
}

function parseOptionalEpochField(rawEpoch: unknown): string | undefined {
  return isSafeIdentifierString(rawEpoch) ? rawEpoch : undefined
}

function recordMatchesEpoch(recordEpoch: string | undefined, activeEpoch: string | null): boolean {
  if (activeEpoch === null) {
    return recordEpoch === undefined
  }
  return recordEpoch === activeEpoch
}

function parseStoredSessionRecord(raw: unknown): StoredSessionRecord | null {
  if (!isNonNullObject(raw) || !isSafeIdentifierString(raw.epoch)) {
    return null
  }
  if (typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)) {
    return null
  }
  return {
    epoch: raw.epoch,
    startedAt: normalizeFiniteTimestamp(raw.startedAt),
  }
}

function parseStoredRoundSeqRecord(raw: unknown): StoredRoundSeqRecord | null {
  if (!isNonNullObject(raw)) {
    return null
  }
  const lastRoundNumber =
    typeof raw.lastRoundNumber === 'string' && POSITIVE_DECIMAL_PATTERN.test(raw.lastRoundNumber)
      ? raw.lastRoundNumber
      : '0'
  const lastEpochNumber =
    typeof raw.lastEpochNumber === 'number' && Number.isSafeInteger(raw.lastEpochNumber) && raw.lastEpochNumber >= 0
      ? raw.lastEpochNumber
      : 0
  if (lastRoundNumber === '0' && lastEpochNumber === 0) {
    return null
  }
  return {
    lastRoundNumber,
    lastEpochNumber,
  }
}

function parseStoredRoundMetaEnvelope(raw: unknown): StoredRoundMetaEnvelope | null {
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
  const sessionEpoch = parseOptionalEpochField(raw.sessionEpoch)
  return {
    roundId: raw.roundId,
    status: raw.status,
    overrideScore: raw.overrideScore,
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
    ...(sessionEpoch !== undefined ? { sessionEpoch } : {}),
  }
}

function parseStoredRoundStatus(raw: unknown): StoredRoundStatusRecord | null {
  if (!isNonNullObject(raw) || raw.status !== 'revealed') {
    return null
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }
  const epoch = parseOptionalEpochField(raw.epoch)
  return {
    status: 'revealed',
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
    ...(epoch !== undefined ? { epoch } : {}),
  }
}

function parseStoredRoundOverride(raw: unknown): StoredRoundOverrideRecord | null {
  if (!isNonNullObject(raw) || !isValidFibonacciScore(raw.score)) {
    return null
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }
  const epoch = parseOptionalEpochField(raw.epoch)
  return {
    score: raw.score,
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
    ...(epoch !== undefined ? { epoch } : {}),
  }
}

function parseStoredRoundActivity(raw: unknown): StoredRoundActivityRecord | null {
  if (!isNonNullObject(raw) || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
    return null
  }
  const epoch = parseOptionalEpochField(raw.epoch)
  return {
    updatedAt: normalizeFiniteTimestamp(raw.updatedAt),
    ...(epoch !== undefined ? { epoch } : {}),
  }
}

function parseStoredRoundClosed(raw: unknown): StoredRoundClosedRecord | null {
  if (!isNonNullObject(raw) || !isSafeIdentifierString(raw.nextRoundId)) {
    return null
  }
  if (typeof raw.closedAt !== 'number' || !Number.isFinite(raw.closedAt)) {
    return null
  }
  const epoch = parseOptionalEpochField(raw.epoch)
  return {
    nextRoundId: raw.nextRoundId,
    closedAt: normalizeFiniteTimestamp(raw.closedAt),
    ...(epoch !== undefined ? { epoch } : {}),
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

function parseStoredVoteRecordEnvelope(raw: unknown, expectedAccountId?: string): StoredVoteRecordEnvelope | null {
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

  const sessionEpoch = parseOptionalEpochField(raw.sessionEpoch)
  return {
    accountId: raw.accountId,
    displayName: normalizeDisplayName(raw.displayName),
    avatarUrl: normalizeOptionalAvatarUrl(raw.avatarUrl),
    card: raw.card,
    votedAt: normalizeFiniteTimestamp(raw.votedAt),
    ...(sessionEpoch !== undefined ? { sessionEpoch } : {}),
  }
}

function stripVoteEnvelope(envelope: StoredVoteRecordEnvelope): VoteRecord {
  return {
    accountId: envelope.accountId,
    displayName: envelope.displayName,
    avatarUrl: envelope.avatarUrl,
    card: envelope.card,
    votedAt: envelope.votedAt,
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

  async function readActiveEpochAndSession(validIssueId: string): Promise<{
    activeEpoch: string | null
    session: StoredSessionRecord | null
    baseMeta: StoredRoundMetaEnvelope | null
  }> {
    const [rawMeta, rawSession] = await Promise.all([
      client.get(buildMetaKey(validIssueId)),
      client.get(buildSessionKey(validIssueId)),
    ])
    const baseMeta = parseStoredRoundMetaEnvelope(rawMeta)
    const session = parseStoredSessionRecord(rawSession)
    const activeEpoch = baseMeta?.sessionEpoch ?? session?.epoch ?? null
    return { activeEpoch, session, baseMeta }
  }

  async function resolveCurrentRoundState(validIssueId: string): Promise<{
    meta: RoundMeta | null
    activeEpoch: string | null
    session: StoredSessionRecord | null
  }> {
    const { activeEpoch, session, baseMeta } = await readActiveEpochAndSession(validIssueId)
    if (baseMeta === null) {
      return { meta: null, activeEpoch: null, session }
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
        client.get(buildRoundClosedKey(validIssueId, currentRoundId)),
        client.get(buildRoundStatusKey(validIssueId, currentRoundId)),
        client.get(buildRoundOverrideKey(validIssueId, currentRoundId)),
        client.get(buildRoundActivityKey(validIssueId, currentRoundId)),
      ])

      const parsedClosed = parseStoredRoundClosed(rawClosed)
      const closedRecord =
        parsedClosed !== null && recordMatchesEpoch(parsedClosed.epoch, activeEpoch) ? parsedClosed : null

      if (hop < MAX_CLOSED_ROUND_HOPS && closedRecord !== null && !visitedRounds.has(closedRecord.nextRoundId)) {
        visitedRounds.add(closedRecord.nextRoundId)
        currentRoundId = closedRecord.nextRoundId
        fallbackStatus = 'voting'
        fallbackOverride = null
        latestUpdatedAt = closedRecord.closedAt
        continue
      }

      const parsedStatus = parseStoredRoundStatus(rawStatus)
      statusRecord = parsedStatus !== null && recordMatchesEpoch(parsedStatus.epoch, activeEpoch) ? parsedStatus : null

      const parsedOverride = parseStoredRoundOverride(rawOverride)
      overrideRecord =
        parsedOverride !== null && recordMatchesEpoch(parsedOverride.epoch, activeEpoch) ? parsedOverride : null

      const parsedActivity = parseStoredRoundActivity(rawActivity)
      activityRecord =
        parsedActivity !== null && recordMatchesEpoch(parsedActivity.epoch, activeEpoch) ? parsedActivity : null
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
      meta: {
        roundId: currentRoundId,
        status: resolvedStatus,
        overrideScore: resolvedOverride,
        updatedAt: normalizeFiniteTimestamp(latestUpdatedAt),
      },
      activeEpoch,
      session,
    }
  }

  async function deleteStaleRoundVotes(validIssueId: string, validRoundId: string, activeEpoch: string): Promise<void> {
    const prefix = buildVoteKeyPrefix(validIssueId, validRoundId)
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
        if (!isNonNullObject(item) || typeof item.key !== 'string' || item.key.length === 0) {
          continue
        }
        const parsed = parseStoredVoteRecordEnvelope(item.value)
        if (parsed === null || parsed.sessionEpoch !== activeEpoch) {
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

    if (keysToDelete.length > 0) {
      await Promise.all(keysToDelete.map((key) => client.delete(key)))
    }
  }

  return {
    async getRoundMeta(issueId: string): Promise<RoundMeta | null> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const { meta } = await resolveCurrentRoundState(validIssueId)
      return meta
    },

    async setRoundMeta(issueId: string, meta: RoundMeta): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validatedMeta = validateRoundMetaForWrite(meta)
      const { activeEpoch, session } = await readActiveEpochAndSession(validIssueId)

      const metaEnvelope: StoredRoundMetaEnvelope =
        activeEpoch !== null ? { ...validatedMeta, sessionEpoch: activeEpoch } : validatedMeta
      const writes: Promise<void>[] = [client.set(buildMetaKey(validIssueId), metaEnvelope, KVS_TTL_24H)]
      if (session !== null) {
        writes.push(client.set(buildSessionKey(validIssueId), session, KVS_TTL_24H))
      }
      if (validatedMeta.status === 'revealed') {
        writes.push(
          client.set(
            buildRoundStatusKey(validIssueId, validatedMeta.roundId),
            activeEpoch !== null
              ? ({
                  status: 'revealed',
                  updatedAt: validatedMeta.updatedAt,
                  epoch: activeEpoch,
                } satisfies StoredRoundStatusRecord)
              : ({ status: 'revealed', updatedAt: validatedMeta.updatedAt } satisfies StoredRoundStatusRecord),
            KVS_TTL_24H,
          ),
        )
      }
      if (validatedMeta.overrideScore !== null) {
        writes.push(
          client.set(
            buildRoundOverrideKey(validIssueId, validatedMeta.roundId),
            activeEpoch !== null
              ? ({
                  score: validatedMeta.overrideScore,
                  updatedAt: validatedMeta.updatedAt,
                  epoch: activeEpoch,
                } satisfies StoredRoundOverrideRecord)
              : ({
                  score: validatedMeta.overrideScore,
                  updatedAt: validatedMeta.updatedAt,
                } satisfies StoredRoundOverrideRecord),
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)
    },

    async allocateRoundId(issueId: string, currentRoundId?: string | null): Promise<string> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      let currentNum: bigint | null = null

      if (currentRoundId !== undefined && currentRoundId !== null) {
        const validCurrentRoundId = assertSafeIdentifier(currentRoundId, 'roundId')
        currentNum = extractStandardRoundNumber(validCurrentRoundId)
        if (currentNum === null) {
          return nextRoundId(validCurrentRoundId)
        }
      }

      const seqRecord = parseStoredRoundSeqRecord(await client.get(buildRoundSeqKey(validIssueId)))
      const seqNum =
        seqRecord !== null && POSITIVE_DECIMAL_PATTERN.test(seqRecord.lastRoundNumber)
          ? BigInt(seqRecord.lastRoundNumber)
          : 0n
      const maxSeen = (currentNum ?? 0n) >= seqNum ? (currentNum ?? 0n) : seqNum
      return `round-${(maxSeen + 1n).toString(10)}`
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

      const [rawMeta, rawSession, rawSeq, rawStatus, rawOverride, rawClosed, rawActivity] = await Promise.all([
        client.get(buildMetaKey(validIssueId)),
        client.get(buildSessionKey(validIssueId)),
        client.get(buildRoundSeqKey(validIssueId)),
        client.get(buildRoundStatusKey(validIssueId, validRoundId)),
        client.get(buildRoundOverrideKey(validIssueId, validRoundId)),
        client.get(buildRoundClosedKey(validIssueId, validRoundId)),
        client.get(buildRoundActivityKey(validIssueId, validRoundId)),
      ])

      const existingMeta = parseStoredRoundMetaEnvelope(rawMeta)
      const existingSession = parseStoredSessionRecord(rawSession)
      const existingSeq = parseStoredRoundSeqRecord(rawSeq)
      const activeExistingEpoch = existingMeta?.sessionEpoch ?? existingSession?.epoch ?? null

      if (
        existingMeta !== null &&
        !isRoundExpired(existingMeta.updatedAt, validNowMs) &&
        activeExistingEpoch !== null
      ) {
        const refreshedSession: StoredSessionRecord = existingSession ?? {
          epoch: activeExistingEpoch,
          startedAt: existingMeta.updatedAt,
        }
        const mergedSeq = computeMergedRoundSeq(
          existingSeq,
          [existingMeta.roundId, validRoundId],
          extractEpochNumber(activeExistingEpoch),
        )
        const refreshWrites: Promise<void>[] = [
          client.set(buildSessionKey(validIssueId), refreshedSession, KVS_TTL_24H),
          client.set(
            buildRoundActivityKey(validIssueId, existingMeta.roundId),
            { updatedAt: validNowMs, epoch: activeExistingEpoch } satisfies StoredRoundActivityRecord,
            KVS_TTL_24H,
          ),
        ]
        if (mergedSeq !== null) {
          refreshWrites.push(client.set(buildRoundSeqKey(validIssueId), mergedSeq, KVS_TTL_7D))
        }
        await Promise.all(refreshWrites)
        const { meta } = await resolveCurrentRoundState(validIssueId)
        return meta ?? initialMeta
      }

      const maxPrevEpochNumber = Math.max(
        existingSeq?.lastEpochNumber ?? 0,
        extractEpochNumber(existingMeta),
        extractEpochNumber(existingSession),
        extractEpochNumber(rawStatus),
        extractEpochNumber(rawOverride),
        extractEpochNumber(rawClosed),
        extractEpochNumber(rawActivity),
      )
      const nextEpochNumber = maxPrevEpochNumber + 1
      const newEpoch = `epoch-${String(nextEpochNumber)}`

      const staleKeyDeletes: Promise<unknown>[] = [deleteStaleRoundVotes(validIssueId, validRoundId, newEpoch)]
      if (rawStatus !== undefined && extractEpochNumber(rawStatus) !== nextEpochNumber) {
        staleKeyDeletes.push(client.delete(buildRoundStatusKey(validIssueId, validRoundId)))
      }
      if (rawOverride !== undefined && extractEpochNumber(rawOverride) !== nextEpochNumber) {
        staleKeyDeletes.push(client.delete(buildRoundOverrideKey(validIssueId, validRoundId)))
      }
      if (rawClosed !== undefined && extractEpochNumber(rawClosed) !== nextEpochNumber) {
        staleKeyDeletes.push(client.delete(buildRoundClosedKey(validIssueId, validRoundId)))
      }
      await Promise.all(staleKeyDeletes)

      // Persist meta (carrying sessionEpoch) first so gated/concurrent writers share the deterministic epoch
      // before advancing sequence counters, while readers immediately see sessionEpoch on meta.
      const metaWithEpoch: StoredRoundMetaEnvelope = {
        ...initialMeta,
        sessionEpoch: newEpoch,
      }
      await client.set(buildMetaKey(validIssueId), metaWithEpoch, KVS_TTL_24H)

      const [latestRawSession, latestRawSeq] = await Promise.all([
        client.get(buildSessionKey(validIssueId)),
        client.get(buildRoundSeqKey(validIssueId)),
      ])
      const latestSession = parseStoredSessionRecord(latestRawSession)
      const latestSeq = parseStoredRoundSeqRecord(latestRawSeq)

      const sessionToWrite: StoredSessionRecord =
        latestSession !== null && extractEpochNumber(latestSession) >= nextEpochNumber
          ? latestSession
          : { epoch: newEpoch, startedAt: validNowMs }

      const mergedSeq = computeMergedRoundSeq(latestSeq ?? existingSeq, [validRoundId], nextEpochNumber)
      const followUpWrites: Promise<void>[] = [
        client.set(buildSessionKey(validIssueId), sessionToWrite, KVS_TTL_24H),
        client.set(
          buildRoundActivityKey(validIssueId, validRoundId),
          { updatedAt: validNowMs, epoch: sessionToWrite.epoch } satisfies StoredRoundActivityRecord,
          KVS_TTL_24H,
        ),
      ]
      if (mergedSeq !== null) {
        followUpWrites.push(client.set(buildRoundSeqKey(validIssueId), mergedSeq, KVS_TTL_7D))
      }
      await Promise.all(followUpWrites)

      const { meta } = await resolveCurrentRoundState(validIssueId)
      return meta ?? initialMeta
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

      const [{ activeEpoch, session }, rawSeq] = await Promise.all([
        readActiveEpochAndSession(validIssueId),
        client.get(buildRoundSeqKey(validIssueId)),
      ])
      const existingSeq = parseStoredRoundSeqRecord(rawSeq)
      const metaEnvelope: StoredRoundMetaEnvelope =
        activeEpoch !== null ? { ...newMeta, sessionEpoch: activeEpoch } : newMeta

      const writes: Promise<void>[] = [
        client.set(buildMetaKey(validIssueId), metaEnvelope, KVS_TTL_24H),
        client.set(
          buildRoundActivityKey(validIssueId, validNextRoundId),
          activeEpoch !== null
            ? ({ updatedAt: validNowMs, epoch: activeEpoch } satisfies StoredRoundActivityRecord)
            : ({ updatedAt: validNowMs } satisfies StoredRoundActivityRecord),
          KVS_TTL_24H,
        ),
      ]

      if (activeEpoch !== null) {
        writes.push(
          client.set(
            buildSessionKey(validIssueId),
            session ?? { epoch: activeEpoch, startedAt: validNowMs },
            KVS_TTL_24H,
          ),
        )
      }

      let validPrevRoundId: string | null = null
      if (previousRoundId !== null && previousRoundId !== validNextRoundId) {
        validPrevRoundId = assertSafeIdentifier(previousRoundId, 'previousRoundId')
        writes.push(
          client.set(
            buildRoundClosedKey(validIssueId, validPrevRoundId),
            activeEpoch !== null
              ? ({
                  nextRoundId: validNextRoundId,
                  closedAt: validNowMs,
                  epoch: activeEpoch,
                } satisfies StoredRoundClosedRecord)
              : ({ nextRoundId: validNextRoundId, closedAt: validNowMs } satisfies StoredRoundClosedRecord),
            KVS_TTL_24H,
          ),
        )
      }

      const mergedSeq = computeMergedRoundSeq(
        existingSeq,
        [validPrevRoundId, validNextRoundId],
        extractEpochNumber(activeEpoch),
      )
      if (mergedSeq !== null) {
        writes.push(client.set(buildRoundSeqKey(validIssueId), mergedSeq, KVS_TTL_7D))
      }

      await Promise.all(writes)
      const { meta } = await resolveCurrentRoundState(validIssueId)
      return meta ?? newMeta
    },

    async touchRoundActivity(issueId: string, roundId: string, nowMs: number): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const { activeEpoch: initialEpoch } = await readActiveEpochAndSession(validIssueId)
      await client.set(
        buildRoundActivityKey(validIssueId, validRoundId),
        initialEpoch !== null
          ? ({ updatedAt: validNowMs, epoch: initialEpoch } satisfies StoredRoundActivityRecord)
          : ({ updatedAt: validNowMs } satisfies StoredRoundActivityRecord),
        KVS_TTL_24H,
      )

      const { meta: currentMeta, activeEpoch, session } = await resolveCurrentRoundState(validIssueId)
      if (currentMeta !== null && currentMeta.roundId === validRoundId) {
        const refreshedUpdatedAt = Math.max(currentMeta.updatedAt, validNowMs)
        const refreshedMeta: StoredRoundMetaEnvelope =
          activeEpoch !== null
            ? { ...currentMeta, updatedAt: refreshedUpdatedAt, sessionEpoch: activeEpoch }
            : { ...currentMeta, updatedAt: refreshedUpdatedAt }

        const refreshWrites: Promise<void>[] = [client.set(buildMetaKey(validIssueId), refreshedMeta, KVS_TTL_24H)]
        if (activeEpoch !== null) {
          refreshWrites.push(
            client.set(
              buildSessionKey(validIssueId),
              session ?? { epoch: activeEpoch, startedAt: refreshedUpdatedAt },
              KVS_TTL_24H,
            ),
          )
        }
        await Promise.all(refreshWrites)
      }
    },

    async markRoundRevealed(issueId: string, roundId: string, nowMs: number): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const [{ activeEpoch, session }, rawOverride] = await Promise.all([
        readActiveEpochAndSession(validIssueId),
        client.get(buildRoundOverrideKey(validIssueId, validRoundId)),
      ])
      const parsedOverride = parseStoredRoundOverride(rawOverride)
      const existingOverride =
        parsedOverride !== null && recordMatchesEpoch(parsedOverride.epoch, activeEpoch) ? parsedOverride : null

      const revealedMeta: RoundMeta = {
        roundId: validRoundId,
        status: 'revealed',
        overrideScore: existingOverride?.score ?? null,
        updatedAt: validNowMs,
      }
      const metaEnvelope: StoredRoundMetaEnvelope =
        activeEpoch !== null ? { ...revealedMeta, sessionEpoch: activeEpoch } : revealedMeta

      const writes: Promise<void>[] = [
        client.set(
          buildRoundStatusKey(validIssueId, validRoundId),
          activeEpoch !== null
            ? ({ status: 'revealed', updatedAt: validNowMs, epoch: activeEpoch } satisfies StoredRoundStatusRecord)
            : ({ status: 'revealed', updatedAt: validNowMs } satisfies StoredRoundStatusRecord),
          KVS_TTL_24H,
        ),
        client.set(buildMetaKey(validIssueId), metaEnvelope, KVS_TTL_24H),
      ]
      if (activeEpoch !== null) {
        writes.push(
          client.set(
            buildSessionKey(validIssueId),
            session ?? { epoch: activeEpoch, startedAt: validNowMs },
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)

      const { meta } = await resolveCurrentRoundState(validIssueId)
      return meta ?? revealedMeta
    },

    async setRoundOverride(issueId: string, roundId: string, score: FibonacciScore, nowMs: number): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validScore = validateFibonacciScore(score)
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const { activeEpoch, session } = await readActiveEpochAndSession(validIssueId)
      const updatedMeta: RoundMeta = {
        roundId: validRoundId,
        status: 'revealed',
        overrideScore: validScore,
        updatedAt: validNowMs,
      }
      const metaEnvelope: StoredRoundMetaEnvelope =
        activeEpoch !== null ? { ...updatedMeta, sessionEpoch: activeEpoch } : updatedMeta

      const writes: Promise<void>[] = [
        client.set(
          buildRoundOverrideKey(validIssueId, validRoundId),
          activeEpoch !== null
            ? ({ score: validScore, updatedAt: validNowMs, epoch: activeEpoch } satisfies StoredRoundOverrideRecord)
            : ({ score: validScore, updatedAt: validNowMs } satisfies StoredRoundOverrideRecord),
          KVS_TTL_24H,
        ),
        client.set(
          buildRoundStatusKey(validIssueId, validRoundId),
          activeEpoch !== null
            ? ({ status: 'revealed', updatedAt: validNowMs, epoch: activeEpoch } satisfies StoredRoundStatusRecord)
            : ({ status: 'revealed', updatedAt: validNowMs } satisfies StoredRoundStatusRecord),
          KVS_TTL_24H,
        ),
        client.set(buildMetaKey(validIssueId), metaEnvelope, KVS_TTL_24H),
      ]
      if (activeEpoch !== null) {
        writes.push(
          client.set(
            buildSessionKey(validIssueId),
            session ?? { epoch: activeEpoch, startedAt: validNowMs },
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)

      const { meta } = await resolveCurrentRoundState(validIssueId)
      return meta ?? updatedMeta
    },

    async getVoterRecord(issueId: string, roundId: string, accountId: string): Promise<VoteRecord | null> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const key = buildVoteKey(validIssueId, roundId, accountId)
      const [stored, { activeEpoch }] = await Promise.all([client.get(key), readActiveEpochAndSession(validIssueId)])
      const parsed = parseStoredVoteRecordEnvelope(stored, accountId)
      if (parsed === null || !recordMatchesEpoch(parsed.sessionEpoch, activeEpoch)) {
        return null
      }
      return stripVoteEnvelope(parsed)
    },

    async setVoterRecord(issueId: string, roundId: string, vote: VoteRecord): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const normalizedVote = validateVoteRecordForWrite(vote)
      const key = buildVoteKey(validIssueId, roundId, normalizedVote.accountId)
      const { activeEpoch } = await readActiveEpochAndSession(validIssueId)
      const envelope: StoredVoteRecordEnvelope =
        activeEpoch !== null ? { ...normalizedVote, sessionEpoch: activeEpoch } : normalizedVote
      await client.set(key, envelope, KVS_TTL_24H)
    },

    async deleteVoterRecord(issueId: string, roundId: string, accountId: string): Promise<void> {
      const key = buildVoteKey(issueId, roundId, accountId)
      await client.delete(key)
    },

    async listVoterRecords(issueId: string, roundId: string, nowMs: number): Promise<VoteRecord[]> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const prefix = buildVoteKeyPrefix(validIssueId, roundId)
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw new PokerDomainError('validation-error', 'nowMs must be a finite number')
      }

      const { activeEpoch } = await readActiveEpochAndSession(validIssueId)
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
          const parsed = parseStoredVoteRecordEnvelope(item.value)
          if (
            parsed !== null &&
            recordMatchesEpoch(parsed.sessionEpoch, activeEpoch) &&
            !isRoundExpired(parsed.votedAt, nowMs)
          ) {
            activeVotes.push(stripVoteEnvelope(parsed))
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
