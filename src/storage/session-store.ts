import { type GetOptions, type MetadataField, WhereConditions, kvs } from '@forge/kvs'
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

const EXPIRE_TIME_FIELD = 'EXPIRE_TIME' as MetadataField

export const KVS_GET_EXPIRE_OPTIONS: GetOptions = {
  metadataFields: [EXPIRE_TIME_FIELD],
}

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

export type KvsGetOptions = GetOptions

export interface KvsGetResult<T = unknown> {
  readonly key: string
  readonly value: T
  readonly expireTime?: string
}

export interface KvsListItem<T = unknown> {
  readonly key: string
  readonly value: T
  readonly expireTime?: string
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
  get<T = unknown>(key: string, options: KvsGetOptions): Promise<T | KvsGetResult<T> | undefined>
  set<T = unknown>(key: string, value: T, options?: KvsSetOptions): Promise<void>
  delete(key: string): Promise<void>
  query(options?: KvsGetOptions): KvsQueryBuilderLike
}

export interface SessionWriteOptions {
  readonly expectedEpoch?: string | null
}

export interface RoundContext {
  readonly meta: RoundMeta | null
  readonly sessionEpoch: string | null
}

interface StoredSessionRecord {
  readonly epoch: string
  readonly initialRoundId?: string
  readonly startedAt: number
  readonly updatedAt?: number
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
  getRoundMeta(issueId: string, nowMs?: number): Promise<RoundMeta | null>
  getRoundContext(issueId: string, nowMs?: number): Promise<RoundContext>
  setRoundMeta(issueId: string, meta: RoundMeta, options?: SessionWriteOptions): Promise<void>
  allocateRoundId(issueId: string, currentRoundId?: string | null): Promise<string>
  initializeRound(issueId: string, roundId: string, nowMs: number, options?: SessionWriteOptions): Promise<RoundMeta>
  advanceRound(
    issueId: string,
    previousRoundId: string | null,
    nextRoundIdValue: string,
    nowMs: number,
    options?: SessionWriteOptions,
  ): Promise<RoundMeta>
  touchRoundActivity(issueId: string, roundId: string, nowMs: number, options?: SessionWriteOptions): Promise<void>
  markRoundRevealed(issueId: string, roundId: string, nowMs: number, options?: SessionWriteOptions): Promise<RoundMeta>
  setRoundOverride(
    issueId: string,
    roundId: string,
    score: FibonacciScore,
    nowMs: number,
    options?: SessionWriteOptions,
  ): Promise<RoundMeta>
  getVoterRecord(
    issueId: string,
    roundId: string,
    accountId: string,
    options?: SessionWriteOptions,
  ): Promise<VoteRecord | null>
  setVoterRecord(issueId: string, roundId: string, vote: VoteRecord, options?: SessionWriteOptions): Promise<void>
  deleteVoterRecord(issueId: string, roundId: string, accountId: string, options?: SessionWriteOptions): Promise<void>
  listVoterRecords(
    issueId: string,
    roundId: string,
    nowMs: number,
    options?: SessionWriteOptions,
  ): Promise<VoteRecord[]>
  deleteRoundVotes(issueId: string, roundId: string, options?: SessionWriteOptions): Promise<number>
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

function assertOptionalTimestamp(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  return assertFiniteTimestamp(value, label)
}

function isExpireTimePast(expireTime: unknown, nowMs?: number): boolean {
  if (nowMs === undefined || typeof expireTime !== 'string' || expireTime.length === 0) {
    return false
  }
  const expireAtMs = Date.parse(expireTime)
  return Number.isFinite(expireAtMs) && nowMs >= expireAtMs
}

function unwrapKvsGetResult(raw: unknown, expectedKey: string, nowMs?: number): unknown {
  if (!isNonNullObject(raw) || raw.key !== expectedKey || !('value' in raw)) {
    return raw
  }
  if (isExpireTimePast(raw.expireTime, nowMs)) {
    return undefined
  }
  return raw.value
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
  seqRecords: readonly (StoredRoundSeqRecord | null | undefined)[],
  roundIds: readonly (string | null | undefined)[],
  epochNumbers: readonly number[],
): StoredRoundSeqRecord | null {
  let maxRound = 0n
  let maxEpoch = 0

  for (const seq of seqRecords) {
    if (seq !== null && seq !== undefined) {
      if (POSITIVE_DECIMAL_PATTERN.test(seq.lastRoundNumber)) {
        const parsed = BigInt(seq.lastRoundNumber)
        if (parsed > maxRound) {
          maxRound = parsed
        }
      }
      if (seq.lastEpochNumber > maxEpoch) {
        maxEpoch = seq.lastEpochNumber
      }
    }
  }

  for (const candidate of roundIds) {
    const parsed = extractStandardRoundNumber(candidate)
    if (parsed !== null && parsed > maxRound) {
      maxRound = parsed
    }
  }

  for (const epochNum of epochNumbers) {
    if (epochNum > maxEpoch) {
      maxEpoch = epochNum
    }
  }

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
  const initialRoundId = isSafeIdentifierString(raw.initialRoundId) ? raw.initialRoundId : undefined
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? normalizeFiniteTimestamp(raw.updatedAt)
      : undefined
  return {
    epoch: raw.epoch,
    startedAt: normalizeFiniteTimestamp(raw.startedAt),
    ...(initialRoundId !== undefined ? { initialRoundId } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
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

  async function kvsGetUnwrapped(key: string, nowMs?: number): Promise<unknown> {
    const raw = await client.get(key, KVS_GET_EXPIRE_OPTIONS)
    return unwrapKvsGetResult(raw, key, nowMs)
  }

  async function readActiveEpochAndSession(
    validIssueId: string,
    nowMs?: number,
  ): Promise<{
    activeEpoch: string | null
    session: StoredSessionRecord | null
    baseMeta: StoredRoundMetaEnvelope | null
  }> {
    const metaKey = buildMetaKey(validIssueId)
    const sessionKey = buildSessionKey(validIssueId)
    const [rawMeta, rawSession] = await Promise.all([
      kvsGetUnwrapped(metaKey, nowMs),
      kvsGetUnwrapped(sessionKey, nowMs),
    ])

    const parsedMeta = parseStoredRoundMetaEnvelope(rawMeta)
    const session = parseStoredSessionRecord(rawSession)

    if (parsedMeta === null) {
      return { activeEpoch: null, session, baseMeta: null }
    }

    const metaEpochNum = extractEpochNumber(parsedMeta.sessionEpoch)
    const sessionEpochNum = extractEpochNumber(session?.epoch)

    // If baseMeta explicitly carries an older epoch than session, baseMeta is a stale LWW write from a superseded epoch
    if (
      parsedMeta.sessionEpoch !== undefined &&
      session !== null &&
      sessionEpochNum > metaEpochNum &&
      session.initialRoundId !== undefined
    ) {
      const recoveredMeta: StoredRoundMetaEnvelope = {
        roundId: session.initialRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: session.updatedAt ?? session.startedAt,
        sessionEpoch: session.epoch,
      }
      return { activeEpoch: session.epoch, session, baseMeta: recoveredMeta }
    }

    const activeEpoch =
      metaEpochNum >= sessionEpochNum
        ? (parsedMeta.sessionEpoch ?? session?.epoch ?? null)
        : (session?.epoch ?? parsedMeta.sessionEpoch ?? null)

    return { activeEpoch, session, baseMeta: parsedMeta }
  }

  async function resolveCurrentRoundState(
    validIssueId: string,
    nowMs?: number,
  ): Promise<{
    meta: RoundMeta | null
    activeEpoch: string | null
    session: StoredSessionRecord | null
  }> {
    const { activeEpoch, session, baseMeta } = await readActiveEpochAndSession(validIssueId, nowMs)
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
      const closedKey = buildRoundClosedKey(validIssueId, currentRoundId)
      const statusKey = buildRoundStatusKey(validIssueId, currentRoundId)
      const overrideKey = buildRoundOverrideKey(validIssueId, currentRoundId)
      const activityKey = buildRoundActivityKey(validIssueId, currentRoundId)

      const [rawClosed, rawStatus, rawOverride, rawActivity] = await Promise.all([
        kvsGetUnwrapped(closedKey, nowMs),
        kvsGetUnwrapped(statusKey, nowMs),
        kvsGetUnwrapped(overrideKey, nowMs),
        kvsGetUnwrapped(activityKey, nowMs),
      ])

      const parsedClosed = parseStoredRoundClosed(rawClosed)
      const closedRecord =
        parsedClosed !== null &&
        recordMatchesEpoch(parsedClosed.epoch, activeEpoch) &&
        (nowMs === undefined || !isRoundExpired(parsedClosed.closedAt, nowMs))
          ? parsedClosed
          : null

      if (hop < MAX_CLOSED_ROUND_HOPS && closedRecord !== null && !visitedRounds.has(closedRecord.nextRoundId)) {
        visitedRounds.add(closedRecord.nextRoundId)
        currentRoundId = closedRecord.nextRoundId
        fallbackStatus = 'voting'
        fallbackOverride = null
        latestUpdatedAt = closedRecord.closedAt
        continue
      }

      const parsedStatus = parseStoredRoundStatus(rawStatus)
      statusRecord =
        parsedStatus !== null &&
        recordMatchesEpoch(parsedStatus.epoch, activeEpoch) &&
        (nowMs === undefined || !isRoundExpired(parsedStatus.updatedAt, nowMs))
          ? parsedStatus
          : null

      const parsedOverride = parseStoredRoundOverride(rawOverride)
      overrideRecord =
        parsedOverride !== null &&
        recordMatchesEpoch(parsedOverride.epoch, activeEpoch) &&
        (nowMs === undefined || !isRoundExpired(parsedOverride.updatedAt, nowMs))
          ? parsedOverride
          : null

      const parsedActivity = parseStoredRoundActivity(rawActivity)
      activityRecord =
        parsedActivity !== null &&
        recordMatchesEpoch(parsedActivity.epoch, activeEpoch) &&
        (nowMs === undefined || !isRoundExpired(parsedActivity.updatedAt, nowMs))
          ? parsedActivity
          : null
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
      let query = client
        .query(KVS_GET_EXPIRE_OPTIONS)
        .where('key', WhereConditions.beginsWith(prefix))
        .limit(KVS_QUERY_LIMIT)
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

  async function sweepStaleTargetRoundKeys(
    validIssueId: string,
    validRoundId: string,
    targetEpoch: string,
    targetEpochNumber: number,
    observedRawStatus: unknown,
    observedRawOverride: unknown,
    observedRawClosed: unknown,
  ): Promise<void> {
    const cleanupOps: Promise<unknown>[] = [deleteStaleRoundVotes(validIssueId, validRoundId, targetEpoch)]
    if (observedRawStatus !== undefined && extractEpochNumber(observedRawStatus) !== targetEpochNumber) {
      cleanupOps.push(client.delete(buildRoundStatusKey(validIssueId, validRoundId)))
    }
    if (observedRawOverride !== undefined && extractEpochNumber(observedRawOverride) !== targetEpochNumber) {
      cleanupOps.push(client.delete(buildRoundOverrideKey(validIssueId, validRoundId)))
    }
    if (observedRawClosed !== undefined && extractEpochNumber(observedRawClosed) !== targetEpochNumber) {
      cleanupOps.push(client.delete(buildRoundClosedKey(validIssueId, validRoundId)))
    }
    await Promise.all(cleanupOps)
  }

  return {
    async getRoundMeta(issueId: string, nowMs?: number): Promise<RoundMeta | null> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validNowMs = assertOptionalTimestamp(nowMs, 'nowMs')
      const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
      return meta
    },

    async getRoundContext(issueId: string, nowMs?: number): Promise<RoundContext> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validNowMs = assertOptionalTimestamp(nowMs, 'nowMs')
      const { meta, activeEpoch } = await resolveCurrentRoundState(validIssueId, validNowMs)
      return {
        meta,
        sessionEpoch: meta !== null ? activeEpoch : null,
      }
    },

    async setRoundMeta(issueId: string, meta: RoundMeta, options?: SessionWriteOptions): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validatedMeta = validateRoundMetaForWrite(meta)
      const { activeEpoch, session, baseMeta } = await readActiveEpochAndSession(validIssueId)

      if (options?.expectedEpoch !== undefined) {
        if (options.expectedEpoch !== null && baseMeta === null) {
          return
        }
        if (activeEpoch !== options.expectedEpoch) {
          return
        }
      }

      const metaEnvelope: StoredRoundMetaEnvelope =
        activeEpoch !== null ? { ...validatedMeta, sessionEpoch: activeEpoch } : validatedMeta
      const writes: Promise<void>[] = [client.set(buildMetaKey(validIssueId), metaEnvelope, KVS_TTL_24H)]
      if (session !== null && activeEpoch !== null) {
        writes.push(
          client.set(
            buildSessionKey(validIssueId),
            {
              ...session,
              updatedAt: Math.max(session.updatedAt ?? session.startedAt, validatedMeta.updatedAt),
            } satisfies StoredSessionRecord,
            KVS_TTL_24H,
          ),
        )
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

      const seqKey = buildRoundSeqKey(validIssueId)
      const seqRecord = parseStoredRoundSeqRecord(await kvsGetUnwrapped(seqKey))
      const seqNum =
        seqRecord !== null && POSITIVE_DECIMAL_PATTERN.test(seqRecord.lastRoundNumber)
          ? BigInt(seqRecord.lastRoundNumber)
          : 0n
      const maxSeen = (currentNum ?? 0n) >= seqNum ? (currentNum ?? 0n) : seqNum
      return `round-${(maxSeen + 1n).toString(10)}`
    },

    async initializeRound(
      issueId: string,
      roundId: string,
      nowMs: number,
      options?: SessionWriteOptions,
    ): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')
      const initialMeta: RoundMeta = {
        roundId: validRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: validNowMs,
      }

      const [
        { activeEpoch: activeExistingEpoch, session: existingSession, baseMeta: existingMeta },
        rawSeq,
        rawStatus,
        rawOverride,
        rawClosed,
        rawActivity,
      ] = await Promise.all([
        readActiveEpochAndSession(validIssueId, validNowMs),
        kvsGetUnwrapped(buildRoundSeqKey(validIssueId), validNowMs),
        kvsGetUnwrapped(buildRoundStatusKey(validIssueId, validRoundId), validNowMs),
        kvsGetUnwrapped(buildRoundOverrideKey(validIssueId, validRoundId), validNowMs),
        kvsGetUnwrapped(buildRoundClosedKey(validIssueId, validRoundId), validNowMs),
        kvsGetUnwrapped(buildRoundActivityKey(validIssueId, validRoundId), validNowMs),
      ])

      const existingSeq = parseStoredRoundSeqRecord(rawSeq)

      if (options?.expectedEpoch !== undefined && activeExistingEpoch !== options.expectedEpoch) {
        const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
        return meta ?? initialMeta
      }

      if (
        existingMeta !== null &&
        !isRoundExpired(existingMeta.updatedAt, validNowMs) &&
        activeExistingEpoch !== null
      ) {
        const refreshedSession: StoredSessionRecord = {
          epoch: activeExistingEpoch,
          initialRoundId: existingSession?.initialRoundId ?? existingMeta.roundId,
          startedAt: existingSession?.startedAt ?? existingMeta.updatedAt,
          updatedAt: Math.max(existingSession?.updatedAt ?? existingMeta.updatedAt, validNowMs),
        }
        const mergedSeq = computeMergedRoundSeq(
          [existingSeq],
          [existingMeta.roundId, validRoundId],
          [extractEpochNumber(activeExistingEpoch)],
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
        const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
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

      await sweepStaleTargetRoundKeys(
        validIssueId,
        validRoundId,
        newEpoch,
        nextEpochNumber,
        rawStatus,
        rawOverride,
        rawClosed,
      )

      const metaWithEpoch: StoredRoundMetaEnvelope = {
        ...initialMeta,
        sessionEpoch: newEpoch,
      }
      await client.set(buildMetaKey(validIssueId), metaWithEpoch, KVS_TTL_24H)

      const [latestRawSession, latestRawSeq] = await Promise.all([
        kvsGetUnwrapped(buildSessionKey(validIssueId), validNowMs),
        kvsGetUnwrapped(buildRoundSeqKey(validIssueId), validNowMs),
      ])
      const latestSession = parseStoredSessionRecord(latestRawSession)
      const latestSeq = parseStoredRoundSeqRecord(latestRawSeq)
      const latestEpochNumber = Math.max(extractEpochNumber(latestSession), latestSeq?.lastEpochNumber ?? 0)

      // Guard against a newer epoch that started while meta set was gated
      if (latestEpochNumber > nextEpochNumber) {
        const mergedHigherSeq = computeMergedRoundSeq(
          [existingSeq, latestSeq],
          [validRoundId],
          [nextEpochNumber, latestEpochNumber],
        )
        if (mergedHigherSeq !== null) {
          await client.set(buildRoundSeqKey(validIssueId), mergedHigherSeq, KVS_TTL_7D)
        }
        const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
        return meta ?? initialMeta
      }

      const sessionToWrite: StoredSessionRecord =
        latestSession !== null && extractEpochNumber(latestSession) === nextEpochNumber
          ? {
              ...latestSession,
              initialRoundId: latestSession.initialRoundId ?? validRoundId,
              updatedAt: Math.max(latestSession.updatedAt ?? latestSession.startedAt, validNowMs),
            }
          : {
              epoch: newEpoch,
              initialRoundId: validRoundId,
              startedAt: validNowMs,
              updatedAt: validNowMs,
            }

      const mergedSeq = computeMergedRoundSeq([existingSeq, latestSeq], [validRoundId], [nextEpochNumber])
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

      const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
      return meta ?? initialMeta
    },

    async advanceRound(
      issueId: string,
      previousRoundId: string | null,
      nextRoundIdValue: string,
      nowMs: number,
      options?: SessionWriteOptions,
    ): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validNextRoundId = assertSafeIdentifier(nextRoundIdValue, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')
      const validPrevRoundId =
        previousRoundId !== null && previousRoundId !== validNextRoundId
          ? assertSafeIdentifier(previousRoundId, 'previousRoundId')
          : null

      const newMeta: RoundMeta = {
        roundId: validNextRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: validNowMs,
      }

      const [
        { activeEpoch: currentActiveEpoch, session: existingSession, baseMeta: existingMeta },
        rawSeq,
        rawNextStatus,
        rawNextOverride,
        rawNextClosed,
        rawNextActivity,
      ] = await Promise.all([
        readActiveEpochAndSession(validIssueId, validNowMs),
        kvsGetUnwrapped(buildRoundSeqKey(validIssueId), validNowMs),
        kvsGetUnwrapped(buildRoundStatusKey(validIssueId, validNextRoundId), validNowMs),
        kvsGetUnwrapped(buildRoundOverrideKey(validIssueId, validNextRoundId), validNowMs),
        kvsGetUnwrapped(buildRoundClosedKey(validIssueId, validNextRoundId), validNowMs),
        kvsGetUnwrapped(buildRoundActivityKey(validIssueId, validNextRoundId), validNowMs),
      ])
      const existingSeq = parseStoredRoundSeqRecord(rawSeq)

      if (options?.expectedEpoch !== undefined) {
        if (existingMeta === null || currentActiveEpoch !== options.expectedEpoch) {
          const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
          return meta ?? newMeta
        }
      }

      const isContinuingActiveSession =
        existingMeta !== null && !isRoundExpired(existingMeta.updatedAt, validNowMs) && currentActiveEpoch !== null

      let targetEpoch: string
      let targetEpochNumber: number
      let sessionToWrite: StoredSessionRecord

      if (isContinuingActiveSession) {
        targetEpoch = currentActiveEpoch
        targetEpochNumber = extractEpochNumber(targetEpoch)
        sessionToWrite = {
          epoch: targetEpoch,
          initialRoundId: validNextRoundId,
          startedAt: existingSession?.startedAt ?? validNowMs,
          updatedAt: validNowMs,
        }
      } else {
        // Migrate un-epoched legacy state or start a fresh epoch after 24h round expiry
        const maxPrevEpochNumber = Math.max(
          existingSeq?.lastEpochNumber ?? 0,
          extractEpochNumber(existingMeta),
          extractEpochNumber(existingSession),
          extractEpochNumber(rawNextStatus),
          extractEpochNumber(rawNextOverride),
          extractEpochNumber(rawNextClosed),
          extractEpochNumber(rawNextActivity),
        )
        targetEpochNumber = maxPrevEpochNumber + 1
        targetEpoch = `epoch-${String(targetEpochNumber)}`
        sessionToWrite = {
          epoch: targetEpoch,
          initialRoundId: validNextRoundId,
          startedAt: validNowMs,
          updatedAt: validNowMs,
        }
      }

      const metaEnvelope: StoredRoundMetaEnvelope = {
        ...newMeta,
        sessionEpoch: targetEpoch,
      }

      const writes: Promise<void>[] = [
        client.set(buildMetaKey(validIssueId), metaEnvelope, KVS_TTL_24H),
        client.set(buildSessionKey(validIssueId), sessionToWrite, KVS_TTL_24H),
        client.set(
          buildRoundActivityKey(validIssueId, validNextRoundId),
          { updatedAt: validNowMs, epoch: targetEpoch } satisfies StoredRoundActivityRecord,
          KVS_TTL_24H,
        ),
      ]

      if (validPrevRoundId !== null) {
        writes.push(
          client.set(
            buildRoundClosedKey(validIssueId, validPrevRoundId),
            {
              nextRoundId: validNextRoundId,
              closedAt: validNowMs,
              epoch: targetEpoch,
            } satisfies StoredRoundClosedRecord,
            KVS_TTL_24H,
          ),
        )
      }

      const mergedSeq = computeMergedRoundSeq([existingSeq], [validPrevRoundId, validNextRoundId], [targetEpochNumber])
      if (mergedSeq !== null) {
        writes.push(client.set(buildRoundSeqKey(validIssueId), mergedSeq, KVS_TTL_7D))
      }

      await Promise.all(writes)

      // Sweep stale target-round keys AFTER committing meta so metaSetIdx < firstDeleteIdx holds
      // while sessionEpoch on meta immediately shields concurrent readers.
      if (!isContinuingActiveSession) {
        await sweepStaleTargetRoundKeys(
          validIssueId,
          validNextRoundId,
          targetEpoch,
          targetEpochNumber,
          rawNextStatus,
          rawNextOverride,
          rawNextClosed,
        )
      }

      const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
      return meta ?? newMeta
    },

    async touchRoundActivity(
      issueId: string,
      roundId: string,
      nowMs: number,
      options?: SessionWriteOptions,
    ): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const { activeEpoch: initialEpoch, baseMeta: initialBaseMeta } = await readActiveEpochAndSession(
        validIssueId,
        validNowMs,
      )
      if (options?.expectedEpoch !== undefined) {
        if (initialBaseMeta === null || initialEpoch !== options.expectedEpoch) {
          return
        }
      }

      await client.set(
        buildRoundActivityKey(validIssueId, validRoundId),
        initialEpoch !== null
          ? ({ updatedAt: validNowMs, epoch: initialEpoch } satisfies StoredRoundActivityRecord)
          : ({ updatedAt: validNowMs } satisfies StoredRoundActivityRecord),
        KVS_TTL_24H,
      )

      const { meta: currentMeta, activeEpoch, session } = await resolveCurrentRoundState(validIssueId, validNowMs)
      if (options?.expectedEpoch !== undefined && activeEpoch !== options.expectedEpoch) {
        return
      }
      if (activeEpoch !== initialEpoch) {
        return
      }

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
              {
                epoch: activeEpoch,
                initialRoundId: session?.initialRoundId ?? currentMeta.roundId,
                startedAt: session?.startedAt ?? refreshedUpdatedAt,
                updatedAt: refreshedUpdatedAt,
              } satisfies StoredSessionRecord,
              KVS_TTL_24H,
            ),
          )
        }
        await Promise.all(refreshWrites)
      }
    },

    async markRoundRevealed(
      issueId: string,
      roundId: string,
      nowMs: number,
      options?: SessionWriteOptions,
    ): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const [{ activeEpoch, session, baseMeta }, rawOverride] = await Promise.all([
        readActiveEpochAndSession(validIssueId, validNowMs),
        kvsGetUnwrapped(buildRoundOverrideKey(validIssueId, validRoundId), validNowMs),
      ])

      if (options?.expectedEpoch !== undefined) {
        if (baseMeta === null || activeEpoch !== options.expectedEpoch) {
          const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
          if (meta !== null) {
            return meta
          }
          throw new PokerDomainError('precondition-failed', 'Cannot reveal votes when no active round exists')
        }
      }

      const parsedOverride = parseStoredRoundOverride(rawOverride)
      const existingOverride =
        parsedOverride !== null &&
        recordMatchesEpoch(parsedOverride.epoch, activeEpoch) &&
        !isRoundExpired(parsedOverride.updatedAt, validNowMs)
          ? parsedOverride
          : null

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
            {
              epoch: activeEpoch,
              initialRoundId: session?.initialRoundId ?? validRoundId,
              startedAt: session?.startedAt ?? validNowMs,
              updatedAt: validNowMs,
            } satisfies StoredSessionRecord,
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)

      const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
      return meta ?? revealedMeta
    },

    async setRoundOverride(
      issueId: string,
      roundId: string,
      score: FibonacciScore,
      nowMs: number,
      options?: SessionWriteOptions,
    ): Promise<RoundMeta> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validScore = validateFibonacciScore(score)
      const validNowMs = assertFiniteTimestamp(nowMs, 'Round updatedAt')

      const { activeEpoch, session, baseMeta } = await readActiveEpochAndSession(validIssueId, validNowMs)
      if (options?.expectedEpoch !== undefined) {
        if (baseMeta === null || activeEpoch !== options.expectedEpoch) {
          const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
          if (meta !== null) {
            return meta
          }
          throw new PokerDomainError(
            'invalid-state',
            'Target score override is only allowed during an active revealed round',
          )
        }
      }

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
            {
              epoch: activeEpoch,
              initialRoundId: session?.initialRoundId ?? validRoundId,
              startedAt: session?.startedAt ?? validNowMs,
              updatedAt: validNowMs,
            } satisfies StoredSessionRecord,
            KVS_TTL_24H,
          ),
        )
      }
      await Promise.all(writes)

      const { meta } = await resolveCurrentRoundState(validIssueId, validNowMs)
      return meta ?? updatedMeta
    },

    async getVoterRecord(
      issueId: string,
      roundId: string,
      accountId: string,
      options?: SessionWriteOptions,
    ): Promise<VoteRecord | null> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const key = buildVoteKey(validIssueId, roundId, accountId)
      const [stored, { activeEpoch, baseMeta }] = await Promise.all([
        kvsGetUnwrapped(key),
        readActiveEpochAndSession(validIssueId),
      ])
      if (options?.expectedEpoch !== undefined && (baseMeta === null || activeEpoch !== options.expectedEpoch)) {
        return null
      }
      const targetEpoch = options?.expectedEpoch !== undefined ? options.expectedEpoch : activeEpoch
      const parsed = parseStoredVoteRecordEnvelope(stored, accountId)
      if (parsed === null || !recordMatchesEpoch(parsed.sessionEpoch, targetEpoch)) {
        return null
      }
      return stripVoteEnvelope(parsed)
    },

    async setVoterRecord(
      issueId: string,
      roundId: string,
      vote: VoteRecord,
      options?: SessionWriteOptions,
    ): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const normalizedVote = validateVoteRecordForWrite(vote)
      const key = buildVoteKey(validIssueId, roundId, normalizedVote.accountId)
      const { activeEpoch, session, baseMeta } = await readActiveEpochAndSession(validIssueId)

      if (options?.expectedEpoch !== undefined) {
        if (baseMeta === null || activeEpoch !== options.expectedEpoch) {
          return
        }
      } else if (activeEpoch !== null && session !== null && normalizedVote.votedAt < session.startedAt) {
        // Reject delayed pre-session vote writes even when invoked without an explicit expectedEpoch
        return
      }

      const targetEpoch = options?.expectedEpoch !== undefined ? options.expectedEpoch : activeEpoch
      const envelope: StoredVoteRecordEnvelope =
        targetEpoch !== null ? { ...normalizedVote, sessionEpoch: targetEpoch } : normalizedVote
      await client.set(key, envelope, KVS_TTL_24H)
    },

    async deleteVoterRecord(
      issueId: string,
      roundId: string,
      accountId: string,
      options?: SessionWriteOptions,
    ): Promise<void> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validAccountId = assertSafeIdentifier(accountId, 'accountId')
      const key = buildVoteKey(validIssueId, roundId, validAccountId)

      const [stored, { activeEpoch }] = await Promise.all([
        kvsGetUnwrapped(key),
        readActiveEpochAndSession(validIssueId),
      ])

      const targetEpoch = options?.expectedEpoch !== undefined ? options.expectedEpoch : activeEpoch
      if (stored === undefined) {
        if (targetEpoch === null) {
          await client.delete(key)
        }
        return
      }

      const parsed = parseStoredVoteRecordEnvelope(stored, validAccountId)
      if (parsed !== null && !recordMatchesEpoch(parsed.sessionEpoch, targetEpoch)) {
        return
      }

      await client.delete(key)
    },

    async listVoterRecords(
      issueId: string,
      roundId: string,
      nowMs: number,
      options?: SessionWriteOptions,
    ): Promise<VoteRecord[]> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const prefix = buildVoteKeyPrefix(validIssueId, roundId)
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw new PokerDomainError('validation-error', 'nowMs must be a finite number')
      }

      const { activeEpoch, baseMeta } = await readActiveEpochAndSession(validIssueId, nowMs)
      if (options?.expectedEpoch !== undefined && (baseMeta === null || activeEpoch !== options.expectedEpoch)) {
        return []
      }
      const targetEpoch = options?.expectedEpoch !== undefined ? options.expectedEpoch : activeEpoch

      const activeVotes: VoteRecord[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      do {
        let query = client
          .query(KVS_GET_EXPIRE_OPTIONS)
          .where('key', WhereConditions.beginsWith(prefix))
          .limit(KVS_QUERY_LIMIT)
        if (cursor !== undefined) {
          query = query.cursor(cursor)
        }
        const page = await query.getMany()
        for (const item of page.results) {
          if (!isNonNullObject(item)) {
            continue
          }
          if (isExpireTimePast(item.expireTime, nowMs)) {
            continue
          }
          const parsed = parseStoredVoteRecordEnvelope(item.value)
          if (
            parsed !== null &&
            recordMatchesEpoch(parsed.sessionEpoch, targetEpoch) &&
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

    async deleteRoundVotes(issueId: string, roundId: string, options?: SessionWriteOptions): Promise<number> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const prefix = buildVoteKeyPrefix(validIssueId, roundId)
      const keysToDelete: string[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined

      do {
        let query = client
          .query(KVS_GET_EXPIRE_OPTIONS)
          .where('key', WhereConditions.beginsWith(prefix))
          .limit(KVS_QUERY_LIMIT)
        if (cursor !== undefined) {
          query = query.cursor(cursor)
        }
        const page = await query.getMany()
        for (const item of page.results) {
          if (!isNonNullObject(item) || typeof item.key !== 'string' || item.key.length === 0) {
            continue
          }
          if (options?.expectedEpoch !== undefined) {
            const parsed = parseStoredVoteRecordEnvelope(item.value)
            if (parsed !== null && !recordMatchesEpoch(parsed.sessionEpoch, options.expectedEpoch)) {
              continue
            }
          }
          keysToDelete.push(item.key)
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
      return keysToDelete.length
    },
  }
}
