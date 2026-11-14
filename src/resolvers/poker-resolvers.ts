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
import { type SessionStore, assertSafeIdentifier, createSessionStore } from '../storage/session-store'

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

      const [{ meta, sessionEpoch }, storyPointsField] = await Promise.all([
        store.getRoundContext(issueId, nowMs),
        jira.getEditableStoryPointsField(issueId),
      ])

      if (meta === null || isRoundExpired(meta.updatedAt, nowMs)) {
        return createIdleSessionSnapshot(storyPointsField, null)
      }

      const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch })
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

      const { meta, sessionEpoch } = await store.getRoundContext(issueId, nowMs)
      const isActiveRound = meta !== null && !isRoundExpired(meta.updatedAt, nowMs)

      if (isActiveRound && meta.status === 'revealed') {
        throw new PokerDomainError('invalid-state', 'Cannot cast or update votes while the round is revealed')
      }

      if (!isActiveRound) {
        const expectedRoundId = await store.allocateRoundId(issueId, meta?.roundId ?? null)
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

        const currentCtx = await store.getRoundContext(issueId, nowMs)
        const isCurrentActive = currentCtx.meta !== null && !isRoundExpired(currentCtx.meta.updatedAt, nowMs)

        let settledMeta: RoundMeta | null = null
        let activeWriteEpoch: string | null = null
        let wroteVoteToExpectedRound = false

        if (isCurrentActive && currentCtx.meta !== null) {
          if (currentCtx.meta.roundId !== expectedRoundId || currentCtx.meta.status === 'revealed') {
            const currentVotes = await store.listVoterRecords(issueId, currentCtx.meta.roundId, nowMs, {
              expectedEpoch: currentCtx.sessionEpoch,
            })
            return projectSessionSnapshot({
              meta: currentCtx.meta,
              votes: currentVotes,
              viewerAccountId: accountId,
              storyPointsField,
              nowMs,
            })
          }

          activeWriteEpoch = currentCtx.sessionEpoch
          await Promise.all([
            store.setVoterRecord(issueId, expectedRoundId, voteRecord, { expectedEpoch: activeWriteEpoch }),
            store.touchRoundActivity(issueId, expectedRoundId, nowMs, { expectedEpoch: activeWriteEpoch }),
          ])
          wroteVoteToExpectedRound = true
        } else if (meta !== null) {
          const advancedMeta = await store.advanceRound(issueId, meta.roundId, expectedRoundId, nowMs, {
            expectedEpoch: sessionEpoch,
          })
          const afterAdvance = await store.getRoundContext(issueId, nowMs)
          settledMeta = afterAdvance.meta ?? advancedMeta
          activeWriteEpoch = afterAdvance.sessionEpoch

          if (
            afterAdvance.meta !== null &&
            settledMeta.roundId === expectedRoundId &&
            settledMeta.status === 'voting'
          ) {
            await Promise.all([
              store.deleteRoundVotes(issueId, meta.roundId, { expectedEpoch: sessionEpoch }),
              store.setVoterRecord(issueId, expectedRoundId, voteRecord, { expectedEpoch: activeWriteEpoch }),
            ])
            wroteVoteToExpectedRound = true
          } else {
            await store.deleteRoundVotes(issueId, meta.roundId, { expectedEpoch: sessionEpoch })
          }
        } else {
          const initializedMeta = await store.initializeRound(issueId, expectedRoundId, nowMs)
          const afterInit = await store.getRoundContext(issueId, nowMs)
          settledMeta = afterInit.meta ?? initializedMeta
          activeWriteEpoch = afterInit.sessionEpoch

          if (afterInit.meta !== null && settledMeta.roundId === expectedRoundId && settledMeta.status === 'voting') {
            await store.setVoterRecord(issueId, expectedRoundId, voteRecord, { expectedEpoch: activeWriteEpoch })
            wroteVoteToExpectedRound = true
          }
        }

        const finalCtx = wroteVoteToExpectedRound
          ? await store.getRoundContext(issueId, nowMs)
          : { meta: settledMeta, sessionEpoch: activeWriteEpoch }

        if (finalCtx.meta === null || isRoundExpired(finalCtx.meta.updatedAt, nowMs)) {
          if (wroteVoteToExpectedRound) {
            await store.deleteVoterRecord(issueId, expectedRoundId, accountId, { expectedEpoch: activeWriteEpoch })
          }
          return createIdleSessionSnapshot(storyPointsField, null)
        }

        if (
          wroteVoteToExpectedRound &&
          (finalCtx.meta.roundId !== expectedRoundId || finalCtx.sessionEpoch !== activeWriteEpoch)
        ) {
          await store.deleteVoterRecord(issueId, expectedRoundId, accountId, { expectedEpoch: activeWriteEpoch })
        } else if (finalCtx.meta.roundId === expectedRoundId && finalCtx.sessionEpoch === activeWriteEpoch) {
          await realtime.publishSessionUpdated(expectedRoundId, nowMs)
        }

        const votes = await store.listVoterRecords(issueId, finalCtx.meta.roundId, nowMs, {
          expectedEpoch: finalCtx.sessionEpoch,
        })
        return projectSessionSnapshot({
          meta: finalCtx.meta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const existingVote = await store.getVoterRecord(issueId, meta.roundId, accountId, {
        expectedEpoch: sessionEpoch,
      })
      const isExistingActive = existingVote !== null && !isRoundExpired(existingVote.votedAt, nowMs)

      if (isExistingActive && existingVote.card === card) {
        const beforeToggle = await store.getRoundContext(issueId, nowMs)
        if (beforeToggle.meta === null || isRoundExpired(beforeToggle.meta.updatedAt, nowMs)) {
          const storyPointsField = await jira.getEditableStoryPointsField(issueId)
          return createIdleSessionSnapshot(storyPointsField, null)
        }
        if (
          beforeToggle.meta.roundId !== meta.roundId ||
          beforeToggle.sessionEpoch !== sessionEpoch ||
          beforeToggle.meta.status === 'revealed'
        ) {
          const [storyPointsField, currentVotes] = await Promise.all([
            jira.getEditableStoryPointsField(issueId),
            store.listVoterRecords(issueId, beforeToggle.meta.roundId, nowMs, {
              expectedEpoch: beforeToggle.sessionEpoch,
            }),
          ])
          return projectSessionSnapshot({
            meta: beforeToggle.meta,
            votes: currentVotes,
            viewerAccountId: accountId,
            storyPointsField,
            nowMs,
          })
        }

        await Promise.all([
          store.deleteVoterRecord(issueId, meta.roundId, accountId, { expectedEpoch: sessionEpoch }),
          store.touchRoundActivity(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch }),
        ])
        const [finalCtx, storyPointsField] = await Promise.all([
          store.getRoundContext(issueId, nowMs),
          jira.getEditableStoryPointsField(issueId),
        ])

        if (finalCtx.meta === null || isRoundExpired(finalCtx.meta.updatedAt, nowMs)) {
          return createIdleSessionSnapshot(storyPointsField, null)
        }

        if (finalCtx.meta.roundId === meta.roundId && finalCtx.sessionEpoch === sessionEpoch) {
          await realtime.publishSessionUpdated(meta.roundId, nowMs)
        }

        const votes = await store.listVoterRecords(issueId, finalCtx.meta.roundId, nowMs, {
          expectedEpoch: finalCtx.sessionEpoch,
        })
        return projectSessionSnapshot({
          meta: finalCtx.meta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const [profile, storyPointsField] = await Promise.all([
        isExistingActive
          ? Promise.resolve({ displayName: existingVote.displayName, avatarUrl: existingVote.avatarUrl })
          : jira.getCurrentUserProfile(),
        jira.getEditableStoryPointsField(issueId),
      ])

      const beforeWrite = await store.getRoundContext(issueId, nowMs)
      if (beforeWrite.meta === null || isRoundExpired(beforeWrite.meta.updatedAt, nowMs)) {
        return createIdleSessionSnapshot(storyPointsField, null)
      }
      if (
        beforeWrite.meta.roundId !== meta.roundId ||
        beforeWrite.sessionEpoch !== sessionEpoch ||
        beforeWrite.meta.status === 'revealed'
      ) {
        const currentVotes = await store.listVoterRecords(issueId, beforeWrite.meta.roundId, nowMs, {
          expectedEpoch: beforeWrite.sessionEpoch,
        })
        return projectSessionSnapshot({
          meta: beforeWrite.meta,
          votes: currentVotes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const voteRecord: VoteRecord = {
        accountId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        card,
        votedAt: nowMs,
      }

      await Promise.all([
        store.setVoterRecord(issueId, meta.roundId, voteRecord, { expectedEpoch: sessionEpoch }),
        store.touchRoundActivity(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch }),
      ])

      const finalCtx = await store.getRoundContext(issueId, nowMs)
      if (finalCtx.meta === null || isRoundExpired(finalCtx.meta.updatedAt, nowMs)) {
        await store.deleteVoterRecord(issueId, meta.roundId, accountId, { expectedEpoch: sessionEpoch })
        return createIdleSessionSnapshot(storyPointsField, null)
      }

      if (finalCtx.meta.roundId !== meta.roundId || finalCtx.sessionEpoch !== sessionEpoch) {
        await store.deleteVoterRecord(issueId, meta.roundId, accountId, { expectedEpoch: sessionEpoch })
      } else {
        await realtime.publishSessionUpdated(meta.roundId, nowMs)
      }

      const votes = await store.listVoterRecords(issueId, finalCtx.meta.roundId, nowMs, {
        expectedEpoch: finalCtx.sessionEpoch,
      })
      return projectSessionSnapshot({
        meta: finalCtx.meta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async withdrawVote(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const { meta, sessionEpoch } = await store.getRoundContext(issueId, nowMs)
      if (meta !== null && !isRoundExpired(meta.updatedAt, nowMs) && meta.status === 'revealed') {
        throw new PokerDomainError('invalid-state', 'Cannot withdraw a vote while the round is revealed')
      }

      if (meta === null || isRoundExpired(meta.updatedAt, nowMs)) {
        const storyPointsField = await jira.getEditableStoryPointsField(issueId)
        return createIdleSessionSnapshot(storyPointsField, null)
      }

      const existingVote = await store.getVoterRecord(issueId, meta.roundId, accountId, {
        expectedEpoch: sessionEpoch,
      })
      if (existingVote === null || isRoundExpired(existingVote.votedAt, nowMs)) {
        const [storyPointsField, votes] = await Promise.all([
          jira.getEditableStoryPointsField(issueId),
          store.listVoterRecords(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch }),
        ])
        return projectSessionSnapshot({
          meta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const beforeDelete = await store.getRoundContext(issueId, nowMs)
      if (beforeDelete.meta === null || isRoundExpired(beforeDelete.meta.updatedAt, nowMs)) {
        const storyPointsField = await jira.getEditableStoryPointsField(issueId)
        return createIdleSessionSnapshot(storyPointsField, null)
      }
      if (
        beforeDelete.meta.roundId !== meta.roundId ||
        beforeDelete.sessionEpoch !== sessionEpoch ||
        beforeDelete.meta.status === 'revealed'
      ) {
        const [storyPointsField, currentVotes] = await Promise.all([
          jira.getEditableStoryPointsField(issueId),
          store.listVoterRecords(issueId, beforeDelete.meta.roundId, nowMs, {
            expectedEpoch: beforeDelete.sessionEpoch,
          }),
        ])
        return projectSessionSnapshot({
          meta: beforeDelete.meta,
          votes: currentVotes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      await Promise.all([
        store.deleteVoterRecord(issueId, meta.roundId, accountId, { expectedEpoch: sessionEpoch }),
        store.touchRoundActivity(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch }),
      ])
      const [finalCtx, storyPointsField] = await Promise.all([
        store.getRoundContext(issueId, nowMs),
        jira.getEditableStoryPointsField(issueId),
      ])

      if (finalCtx.meta === null || isRoundExpired(finalCtx.meta.updatedAt, nowMs)) {
        return createIdleSessionSnapshot(storyPointsField, null)
      }

      if (finalCtx.meta.roundId === meta.roundId && finalCtx.sessionEpoch === sessionEpoch) {
        await realtime.publishSessionUpdated(meta.roundId, nowMs)
      }

      const votes = await store.listVoterRecords(issueId, finalCtx.meta.roundId, nowMs, {
        expectedEpoch: finalCtx.sessionEpoch,
      })

      return projectSessionSnapshot({
        meta: finalCtx.meta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async revealVotes(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const { meta, sessionEpoch } = await store.getRoundContext(issueId, nowMs)
      if (meta === null || isRoundExpired(meta.updatedAt, nowMs)) {
        throw new PokerDomainError('precondition-failed', 'Cannot reveal votes when no active round exists')
      }

      if (meta.status === 'revealed') {
        const [storyPointsField, votes] = await Promise.all([
          jira.getEditableStoryPointsField(issueId),
          store.listVoterRecords(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch }),
        ])
        return projectSessionSnapshot({
          meta,
          votes,
          viewerAccountId: accountId,
          storyPointsField,
          nowMs,
        })
      }

      const votes = await store.listVoterRecords(issueId, meta.roundId, nowMs, { expectedEpoch: sessionEpoch })
      if (votes.length === 0) {
        throw new PokerDomainError('precondition-failed', 'Cannot reveal votes when 0 votes have been cast')
      }

      const revealedMeta = await store.markRoundRevealed(issueId, meta.roundId, nowMs, {
        expectedEpoch: sessionEpoch,
      })
      const finalCtx = await store.getRoundContext(issueId, nowMs)
      const effectiveMeta = finalCtx.meta ?? revealedMeta
      const effectiveEpoch = finalCtx.meta !== null ? finalCtx.sessionEpoch : sessionEpoch

      const [, storyPointsField, effectiveVotes] = await Promise.all([
        effectiveEpoch === sessionEpoch
          ? realtime.publishSessionUpdated(effectiveMeta.roundId, nowMs)
          : Promise.resolve(),
        jira.getEditableStoryPointsField(issueId),
        effectiveMeta.roundId === meta.roundId && effectiveEpoch === sessionEpoch
          ? Promise.resolve(votes)
          : store.listVoterRecords(issueId, effectiveMeta.roundId, nowMs, { expectedEpoch: effectiveEpoch }),
      ])

      return projectSessionSnapshot({
        meta: effectiveMeta,
        votes: effectiveVotes,
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

      const { meta, sessionEpoch } = await store.getRoundContext(issueId, nowMs)
      if (meta === null || isRoundExpired(meta.updatedAt, nowMs) || meta.status !== 'revealed') {
        throw new PokerDomainError(
          'invalid-state',
          'Target score override is only allowed during an active revealed round',
        )
      }

      const updatedMeta = await store.setRoundOverride(issueId, meta.roundId, score, nowMs, {
        expectedEpoch: sessionEpoch,
      })
      const finalCtx = await store.getRoundContext(issueId, nowMs)
      const effectiveMeta = finalCtx.meta ?? updatedMeta
      const effectiveEpoch = finalCtx.meta !== null ? finalCtx.sessionEpoch : sessionEpoch

      const [, votes, storyPointsField] = await Promise.all([
        effectiveEpoch === sessionEpoch
          ? realtime.publishSessionUpdated(effectiveMeta.roundId, nowMs)
          : Promise.resolve(),
        store.listVoterRecords(issueId, effectiveMeta.roundId, nowMs, { expectedEpoch: effectiveEpoch }),
        jira.getEditableStoryPointsField(issueId),
      ])

      return projectSessionSnapshot({
        meta: effectiveMeta,
        votes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async resetRound(req: ForgeResolverRequest): Promise<SessionSnapshot> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const nowMs = getNowMs(now)

      const { meta, sessionEpoch } = await store.getRoundContext(issueId, nowMs)
      const newRoundId = await store.allocateRoundId(issueId, meta?.roundId ?? null)

      let advancedMeta: RoundMeta
      if (meta === null) {
        advancedMeta = await store.initializeRound(issueId, newRoundId, nowMs)
      } else {
        advancedMeta = await store.advanceRound(issueId, meta.roundId, newRoundId, nowMs, {
          expectedEpoch: sessionEpoch,
        })
        await store.deleteRoundVotes(issueId, meta.roundId, { expectedEpoch: sessionEpoch })
      }

      const finalCtx = await store.getRoundContext(issueId, nowMs)
      const effectiveMeta = finalCtx.meta ?? advancedMeta
      const effectiveEpoch = finalCtx.meta !== null ? finalCtx.sessionEpoch : sessionEpoch

      const [, storyPointsField, activeVotes] = await Promise.all([
        realtime.publishSessionUpdated(effectiveMeta.roundId, nowMs),
        jira.getEditableStoryPointsField(issueId),
        store.listVoterRecords(issueId, effectiveMeta.roundId, nowMs, { expectedEpoch: effectiveEpoch }),
      ])

      if (effectiveMeta.status === 'voting' && activeVotes.length === 0) {
        return createIdleSessionSnapshot(storyPointsField, effectiveMeta.roundId)
      }

      return projectSessionSnapshot({
        meta: effectiveMeta,
        votes: activeVotes,
        viewerAccountId: accountId,
        storyPointsField,
        nowMs,
      })
    },

    async applyStoryPoints(req: ForgeResolverRequest): Promise<ApplyStoryPointsResult> {
      const { issueId, accountId } = extractAuthenticatedContext(req?.context)
      const payload = assertPlainPayload(req.payload)
      const score = validateFibonacciScore(payload.score)
      const nowMs = getNowMs(now)

      const { meta, sessionEpoch } = await store.getRoundContext(issueId, nowMs)
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

      const storyPointsField = {
        fieldId: outcome.fieldId,
        fieldName: outcome.fieldName,
      }

      const afterJira = await store.getRoundContext(issueId, nowMs)
      const isSameSessionRound =
        afterJira.meta !== null && afterJira.sessionEpoch === sessionEpoch && afterJira.meta.roundId === meta.roundId

      if (!isSameSessionRound) {
        await store.deleteRoundVotes(issueId, meta.roundId, { expectedEpoch: sessionEpoch })
        await realtime.publishPointsApplied(meta.roundId, score, nowMs)

        if (afterJira.meta === null || isRoundExpired(afterJira.meta.updatedAt, nowMs)) {
          return {
            ok: true,
            appliedScore: outcome.appliedScore,
            fieldName: outcome.fieldName,
            session: createIdleSessionSnapshot(storyPointsField, null),
          }
        }

        const currentVotes = await store.listVoterRecords(issueId, afterJira.meta.roundId, nowMs, {
          expectedEpoch: afterJira.sessionEpoch,
        })
        return {
          ok: true,
          appliedScore: outcome.appliedScore,
          fieldName: outcome.fieldName,
          session: projectSessionSnapshot({
            meta: afterJira.meta,
            votes: currentVotes,
            viewerAccountId: accountId,
            storyPointsField,
            nowMs,
          }),
        }
      }

      const newRoundId = await store.allocateRoundId(issueId, meta.roundId)
      const advancedMeta = await store.advanceRound(issueId, meta.roundId, newRoundId, nowMs, {
        expectedEpoch: sessionEpoch,
      })
      await store.deleteRoundVotes(issueId, meta.roundId, { expectedEpoch: sessionEpoch })

      const finalCtx = await store.getRoundContext(issueId, nowMs)
      const effectiveMeta = finalCtx.meta ?? advancedMeta
      const effectiveEpoch = finalCtx.meta !== null ? finalCtx.sessionEpoch : sessionEpoch

      const [, activeVotes] = await Promise.all([
        realtime.publishPointsApplied(effectiveMeta.roundId, score, nowMs),
        store.listVoterRecords(issueId, effectiveMeta.roundId, nowMs, { expectedEpoch: effectiveEpoch }),
      ])

      const session =
        effectiveMeta.status === 'voting' && activeVotes.length === 0
          ? createIdleSessionSnapshot(storyPointsField, effectiveMeta.roundId)
          : projectSessionSnapshot({
              meta: effectiveMeta,
              votes: activeVotes,
              viewerAccountId: accountId,
              storyPointsField,
              nowMs,
            })

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
