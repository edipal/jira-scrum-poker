import { isValidDeckCard, isValidFibonacciScore } from './deck'
import { calculateScoreSummary } from './scoring'
import {
  type DeckCard,
  type ParticipantView,
  PokerDomainError,
  type ProjectSessionParams,
  type SessionSnapshot,
  type StoryPointsFieldInfo,
  type VoteRecord,
} from './types'

export const SESSION_TTL_MS: number = 86_400_000

export const FALLBACK_DISPLAY_NAME: string = 'Unknown User'

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim()
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateVoteRecord(rawVote: unknown): VoteRecord {
  if (!isNonNullObject(rawVote)) {
    throw new PokerDomainError('validation-error', 'Each vote record must be an object')
  }
  const accountId = rawVote.accountId
  const card = rawVote.card
  const votedAt = rawVote.votedAt
  const rawDisplayName = rawVote.displayName
  const rawAvatarUrl = rawVote.avatarUrl

  if (!isCanonicalIdentifier(accountId)) {
    throw new PokerDomainError('validation-error', 'Voter account ID must be a non-empty trimmed string')
  }
  if (!isValidDeckCard(card)) {
    throw new PokerDomainError('validation-error', 'Invalid vote card')
  }
  if (!isFiniteTimestamp(votedAt)) {
    throw new PokerDomainError('validation-error', 'Vote timestamp must be a finite number')
  }

  return {
    accountId,
    displayName: typeof rawDisplayName === 'string' ? rawDisplayName : '',
    avatarUrl: typeof rawAvatarUrl === 'string' ? rawAvatarUrl : null,
    card,
    votedAt,
  }
}

export function isRoundExpired(updatedAt: number, nowMs: number): boolean {
  if (!isFiniteTimestamp(updatedAt) || !isFiniteTimestamp(nowMs)) {
    throw new PokerDomainError('validation-error', 'Timestamps must be finite numbers')
  }
  return nowMs - updatedAt >= SESSION_TTL_MS
}

export function normalizeDisplayName(displayName: string | null | undefined): string {
  if (typeof displayName === 'string' && displayName.trim().length > 0) {
    return displayName.trim()
  }
  return FALLBACK_DISPLAY_NAME
}

export function createIdleSessionSnapshot(
  storyPointsField: StoryPointsFieldInfo | null = null,
  roundId: string | null = null,
): SessionSnapshot {
  if (roundId !== undefined && roundId !== null && !isCanonicalIdentifier(roundId)) {
    throw new PokerDomainError('validation-error', 'Round ID must be a non-empty trimmed string when provided')
  }

  return {
    roundId: roundId ?? null,
    status: 'voting',
    participants: [],
    viewerCard: null,
    average: null,
    formattedAverage: null,
    recommendedScore: null,
    targetScore: null,
    storyPointsField: storyPointsField ?? null,
  }
}

export function projectSessionSnapshot(params: ProjectSessionParams): SessionSnapshot {
  if (!isNonNullObject(params)) {
    throw new PokerDomainError('validation-error', 'Session projection params must be an object')
  }
  if (!isCanonicalIdentifier(params.viewerAccountId)) {
    throw new PokerDomainError('validation-error', 'Viewer account ID must be a non-empty trimmed string')
  }
  if (!isFiniteTimestamp(params.nowMs)) {
    throw new PokerDomainError('validation-error', 'Current timestamp must be a finite number')
  }

  const storyPointsField = params.storyPointsField ?? null

  if (params.meta === null) {
    return createIdleSessionSnapshot(storyPointsField, null)
  }

  if (!isNonNullObject(params.meta)) {
    throw new PokerDomainError('validation-error', 'Round metadata must be null or an object')
  }

  if (isRoundExpired(params.meta.updatedAt, params.nowMs)) {
    return createIdleSessionSnapshot(storyPointsField, null)
  }

  if (!isCanonicalIdentifier(params.meta.roundId)) {
    throw new PokerDomainError('validation-error', 'Active round ID must be a non-empty trimmed string')
  }
  if (params.meta.status !== 'voting' && params.meta.status !== 'revealed') {
    throw new PokerDomainError('validation-error', 'Invalid round status')
  }
  if (params.meta.overrideScore !== null && !isValidFibonacciScore(params.meta.overrideScore)) {
    throw new PokerDomainError('validation-error', 'Invalid override score')
  }
  if (!Array.isArray(params.votes)) {
    throw new PokerDomainError('validation-error', 'Votes must be an array')
  }

  const dedupedByAccount = new Map<string, VoteRecord>()
  const rawVotes: readonly unknown[] = params.votes
  for (const rawVote of rawVotes) {
    const vote = validateVoteRecord(rawVote)
    const existing = dedupedByAccount.get(vote.accountId)
    if (existing === undefined || vote.votedAt >= existing.votedAt) {
      dedupedByAccount.set(vote.accountId, vote)
    }
  }

  const sortedVotes = Array.from(dedupedByAccount.values()).sort((a, b) => {
    if (a.votedAt !== b.votedAt) {
      return a.votedAt < b.votedAt ? -1 : 1
    }
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0
  })

  const viewerVote = dedupedByAccount.get(params.viewerAccountId)
  const viewerCard: DeckCard | null = viewerVote !== undefined ? viewerVote.card : null

  const isRevealed = params.meta.status === 'revealed'
  const participants: ParticipantView[] = sortedVotes.map((vote) => ({
    accountId: vote.accountId,
    displayName: normalizeDisplayName(vote.displayName),
    avatarUrl: typeof vote.avatarUrl === 'string' && vote.avatarUrl.trim().length > 0 ? vote.avatarUrl.trim() : null,
    hasVoted: true,
    card: isRevealed ? vote.card : null,
  }))

  if (!isRevealed) {
    return {
      roundId: params.meta.roundId,
      status: 'voting',
      participants,
      viewerCard,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField,
    }
  }

  const summary = calculateScoreSummary(sortedVotes.map((vote) => vote.card))
  const targetScore = params.meta.overrideScore !== null ? params.meta.overrideScore : summary.recommendedScore

  return {
    roundId: params.meta.roundId,
    status: 'revealed',
    participants,
    viewerCard,
    average: summary.average,
    formattedAverage: summary.formattedAverage,
    recommendedScore: summary.recommendedScore,
    targetScore,
    storyPointsField,
  }
}
