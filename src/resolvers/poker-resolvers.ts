import { validateDeckCard, validateFibonacciScore } from '../domain/deck'
import { createIdleSessionSnapshot, isRoundExpired, projectSessionSnapshot } from '../domain/session-view'
import {
  type DeckCard,
  type FibonacciScore,
  PokerDomainError,
  type RoundMeta,
  type SessionSnapshot,
  type VoteRecord,
} from '../domain/types'
import { type ApplyStoryPointsFailureReason, type JiraClient, createJiraClient } from '../jira/jira-client'
import { type BackendLogger, createBackendLogger } from '../observability/logger'
import { type RealtimePublisher, createRealtimePublisher } from '../realtime/publisher'
import { type SessionStore, assertSafeIdentifier, createSessionStore, nextRoundId } from '../storage/session-store'

export const RESOLVER_KEYS = {
  getSession: 'getSession',
  castVote: 'castVote',
  withdrawVote: 'withdrawVote',
  revealVotes: 'revealVotes',
  selectOverrideScore: 'selectOverrideScore',
  resetRound: 'resetRound',
  applyStoryPoints: 'applyStoryPoints',
} as const

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertPlainPayload(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new PokerDomainError('validation-error', 'Resolver payload must be a plain object')
  }
  return payload
}

function getNowMs(now: () => number): number {
  const value = now()
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PokerDomainError('validation-error', 'Clock timestamp must be a finite number')
  }
  return value === 0 ? 0 : value
}

export function extractAuthenticatedContext(context: unknown): AuthenticatedHostContext {
  if (!isPlainObject(context)) {
    throw new PokerDomainError('validation-error', 'Resolver host context must be a plain object')
  }

  const accountId = assertSafeIdentifier(context.accountId, 'accountId')
  const rawExtension = context.extension
  const rawIssue = isNonNullObject(rawExtension) ? rawExtension.issue : undefined
  const rawIssueId = isNonNullObject(rawIssue) ? rawIssue.id : undefined
  const issueId = assertSafeIdentifier(rawIssueId, 'issueId')

  const rawKey = isNonNullObject(rawIssue) ? rawIssue.key : undefined
  const issueKey = typeof rawKey === 'string' && rawKey.trim().length > 0 ? rawKey.trim() : null

  return {
    issueId,
    issueKey,
    accountId,
  }
}

export function createPokerResolverHandlers(deps?: PokerBackendDeps): PokerResolverHandlers {
  const logger = deps?.logger ?? createBackendLogger()
  const store = deps?.store ?? createSessionStore()
  const jira = deps?.jira ?? createJiraClient({ logger })
  const realtime = deps?.realtime ?? createRealtimePublisher({ logger })
  const now = deps?.now ?? (() => Date.now())

  return {
    async getSession(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const [meta, storyPointsField] = await Promise.all([
        store.getRoundMeta(issueId),
        jira.getEditableStoryPointsField(issueId),
      ])

      if (meta === null || isRoundExpired(meta.updatedAt, nowMs)) {
        return createIdleSessionSnapshot(storyPointsField, null)
      }

      const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs)
      return projectSessionSnapshot({
        meta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async castVote(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const payload = assertPlainPayload(req.payload)
      const card = validateDeckCard(payload.card)
      const nowMs = getNowMs(now)

      const meta = await store.getRoundMeta(issueId)
      const isActiveRound = meta !== null && !isRoundExpired(meta.updatedAt, nowMs)

      if (isActiveRound && meta.status === 'revealed') {
        throw new PokerDomainError('invalid-state', 'Cannot cast or update votes while the round is revealed')
      }

      if (!isActiveRound) {
        const roundId = nextRoundId(meta?.roundId)
        if (meta !== null) {
          await store.deleteRoundVotes(issueId, meta.roundId)
        }

        const [profile, storyPointsField] = await Promise.all([
          jira.getCurrentUserProfile(),
          jira.getEditableStoryPointsField(issueId),
        ])

        const voteRecord: VoteRecord = {
          accountId,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          card,
          votedAt: nowMs,
        }
        const newMeta: RoundMeta = {
          roundId,
          status: 'voting',
          overrideScore: null,
          updatedAt: nowMs,
        }

        await Promise.all([store.setVoterRecord(issueId, roundId, voteRecord), store.setRoundMeta(issueId, newMeta)])
        await realtime.publishSessionUpdated(roundId, nowMs)

        const votes = await store.listVoterRecords(issueId, roundId, nowMs)
        return projectSessionSnapshot({
          meta: newMeta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const existingVote = await store.getVoterRecord(issueId, meta.roundId, accountId)
      const isExistingActive = existingVote !== null && !isRoundExpired(existingVote.votedAt, nowMs)

      const updatedMeta: RoundMeta = {
        roundId: meta.roundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: nowMs,
      }

      if (isExistingActive && existingVote.card === card) {
        await Promise.all([
          store.deleteVoterRecord(issueId, meta.roundId, accountId),
          store.setRoundMeta(issueId, updatedMeta),
        ])
        const [, storyPointsField] = await Promise.all([
          realtime.publishSessionUpdated(meta.roundId, nowMs),
          jira.getEditableStoryPointsField(issueId),
        ])
        const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs)
        return projectSessionSnapshot({
          meta: updatedMeta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const [profile, storyPointsField] = await Promise.all([
        jira.getCurrentUserProfile(),
        jira.getEditableStoryPointsField(issueId),
      ])

      const voteRecord: VoteRecord = {
        accountId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        card,
        votedAt: nowMs,
      }

      await Promise.all([
        store.setVoterRecord(issueId, meta.roundId, voteRecord),
        store.setRoundMeta(issueId, updatedMeta),
      ])
      await realtime.publishSessionUpdated(meta.roundId, nowMs)

      const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs)
      return projectSessionSnapshot({
        meta: updatedMeta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async withdrawVote(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const meta = await store.getRoundMeta(issueId)
      if (meta !== null && !isRoundExpired(meta.updatedAt, nowMs) && meta.status === 'revealed') {
        throw new PokerDomainError('invalid-state', 'Cannot withdraw a vote while the round is revealed')
      }

      if (meta === null || isRoundExpired(meta.updatedAt, nowMs)) {
        const storyPointsField = await jira.getEditableStoryPointsField(issueId)
        return createIdleSessionSnapshot(storyPointsField, null)
      }

      const existingVote = await store.getVoterRecord(issueId, meta.roundId, accountId)
      if (existingVote === null || isRoundExpired(existingVote.votedAt, nowMs)) {
        const [storyPointsField, votes] = await Promise.all([
          jira.getEditableStoryPointsField(issueId),
          store.listVoterRecords(issueId, meta.roundId, nowMs),
        ])
        return projectSessionSnapshot({
          meta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const updatedMeta: RoundMeta = {
        roundId: meta.roundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: nowMs,
      }

      await Promise.all([
        store.deleteVoterRecord(issueId, meta.roundId, accountId),
        store.setRoundMeta(issueId, updatedMeta),
      ])
      const [, storyPointsField] = await Promise.all([
        realtime.publishSessionUpdated(meta.roundId, nowMs),
        jira.getEditableStoryPointsField(issueId),
      ])
      const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs)

      return projectSessionSnapshot({
        meta: updatedMeta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async revealVotes(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const meta = await store.getRoundMeta(issueId)
      if (meta === null || isRoundExpired(meta.updatedAt, nowMs)) {
        throw new PokerDomainError('precondition-failed', 'Cannot reveal votes when no active round exists')
      }

      if (meta.status === 'revealed') {
        const [storyPointsField, votes] = await Promise.all([
          jira.getEditableStoryPointsField(issueId),
          store.listVoterRecords(issueId, meta.roundId, nowMs),
        ])
        return projectSessionSnapshot({
          meta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs)
      if (votes.length === 0) {
        throw new PokerDomainError('precondition-failed', 'Cannot reveal votes when 0 votes have been cast')
      }

      const revealedMeta: RoundMeta = {
        roundId: meta.roundId,
        status: 'revealed',
        overrideScore: null,
        updatedAt: nowMs,
      }

      await store.setRoundMeta(issueId, revealedMeta)
      const [, storyPointsField] = await Promise.all([
        realtime.publishSessionUpdated(meta.roundId, nowMs),
        jira.getEditableStoryPointsField(issueId),
      ])

      return projectSessionSnapshot({
        meta: revealedMeta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async selectOverrideScore(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const payload = assertPlainPayload(req.payload)
      const score = validateFibonacciScore(payload.score)
      const nowMs = getNowMs(now)

      const meta = await store.getRoundMeta(issueId)
      if (meta === null || isRoundExpired(meta.updatedAt, nowMs) || meta.status !== 'revealed') {
        throw new PokerDomainError(
          'invalid-state',
          'Target score override is only allowed during an active revealed round',
        )
      }

      const updatedMeta: RoundMeta = {
        roundId: meta.roundId,
        status: 'revealed',
        overrideScore: score,
        updatedAt: nowMs,
      }

      await store.setRoundMeta(issueId, updatedMeta)
      const [, votes, storyPointsField] = await Promise.all([
        realtime.publishSessionUpdated(meta.roundId, nowMs),
        store.listVoterRecords(issueId, meta.roundId, nowMs),
        jira.getEditableStoryPointsField(issueId),
      ])

      return projectSessionSnapshot({
        meta: updatedMeta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async resetRound(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const meta = await store.getRoundMeta(issueId)
      const newRoundId = nextRoundId(meta?.roundId)
      const newMeta: RoundMeta = {
        roundId: newRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: nowMs,
      }

      await store.setRoundMeta(issueId, newMeta)
      if (meta !== null) {
        await store.deleteRoundVotes(issueId, meta.roundId)
      }

      const [, storyPointsField] = await Promise.all([
        realtime.publishSessionUpdated(newRoundId, nowMs),
        jira.getEditableStoryPointsField(issueId),
      ])

      return createIdleSessionSnapshot(storyPointsField, newRoundId)
    },

    async applyStoryPoints(req: ForgeResolverRequest): Promise<ApplyStoryPointsResult> {
      const { issueId } = extractAuthenticatedContext(req?.context)
      const payload = assertPlainPayload(req.payload)
      const score = validateFibonacciScore(payload.score)
      const nowMs = getNowMs(now)

      const meta = await store.getRoundMeta(issueId)
      if (meta === null || isRoundExpired(meta.updatedAt, nowMs) || meta.status !== 'revealed') {
        throw new PokerDomainError('invalid-state', 'Story Points can only be applied during an active revealed round')
      }

      const outcome = await jira.updateStoryPoints(issueId, score)
      if (!outcome.ok) {
        return {
          ok: false,
          reason: outcome.reason,
          score: outcome.score,
          message: outcome.message,
        }
      }

      const newRoundId = nextRoundId(meta.roundId)
      const clearedMeta: RoundMeta = {
        roundId: newRoundId,
        status: 'voting',
        overrideScore: null,
        updatedAt: nowMs,
      }

      await store.setRoundMeta(issueId, clearedMeta)
      await store.deleteRoundVotes(issueId, meta.roundId)
      await realtime.publishPointsApplied(newRoundId, score, nowMs)

      const session = createIdleSessionSnapshot(
        {
          fieldId: outcome.fieldId,
          fieldName: outcome.fieldName,
        },
        newRoundId,
      )

      return {
        ok: true,
        appliedScore: outcome.appliedScore,
        fieldName: outcome.fieldName,
        session,
      }
    },
  }
}

export function registerPokerResolvers<TResolver extends ResolverRegistryLike>(
  resolver: TResolver,
  deps?: PokerBackendDeps,
): TResolver {
  if (!isNonNullObject(resolver) || typeof resolver.define !== 'function') {
    throw new PokerDomainError('validation-error', 'Resolver instance must implement define(functionKey, callback)')
  }

  const handlers = createPokerResolverHandlers(deps)

  resolver.define(RESOLVER_KEYS.getSession, (req) => handlers.getSession(req))
  resolver.define(RESOLVER_KEYS.castVote, (req) => handlers.castVote(req))
  resolver.define(RESOLVER_KEYS.withdrawVote, (req) => handlers.withdrawVote(req))
  resolver.define(RESOLVER_KEYS.revealVotes, (req) => handlers.revealVotes(req))
  resolver.define(RESOLVER_KEYS.selectOverrideScore, (req) => handlers.selectOverrideScore(req))
  resolver.define(RESOLVER_KEYS.resetRound, (req) => handlers.resetRound(req))
  resolver.define(RESOLVER_KEYS.applyStoryPoints, (req) => handlers.applyStoryPoints(req))

  return resolver
}
