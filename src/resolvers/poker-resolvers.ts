import type { DeckCard, FibonacciScore, SessionSnapshot } from '../domain/types'
import type { ApplyStoryPointsFailureReason, JiraClient } from '../jira/jira-client'
import type { BackendLogger } from '../observability/logger'
import type { RealtimePublisher } from '../realtime/publisher'
import type { SessionStore } from '../storage/session-store'

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

export function extractAuthenticatedContext(_context: unknown): AuthenticatedHostContext {
  throw new Error('not implemented')
}

export function createPokerResolverHandlers(_deps?: PokerBackendDeps): PokerResolverHandlers {
  throw new Error('not implemented')
}

export function registerPokerResolvers<TResolver extends ResolverRegistryLike>(
  _resolver: TResolver,
  _deps?: PokerBackendDeps,
): TResolver {
  throw new Error('not implemented')
}
