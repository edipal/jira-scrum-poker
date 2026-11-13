import type {
  DeckCard,
  FibonacciScore,
  NumericDeckCard,
  ParticipantView,
  QuestionCard,
  RoundStatus,
  SessionSnapshot,
  StoryPointsFieldInfo,
} from '../../../../src/domain/types'
import type { ApplyStoryPointsFailureReason } from '../../../../src/jira/jira-client'
import type {
  PointsAppliedRealtimeEvent,
  PokerRealtimeEvent,
  SessionUpdatedRealtimeEvent,
} from '../../../../src/realtime/publisher'
import type { ApplyStoryPointsResult } from '../../../../src/resolvers/poker-resolvers'

export type {
  ApplyStoryPointsFailureReason,
  ApplyStoryPointsResult,
  DeckCard,
  FibonacciScore,
  NumericDeckCard,
  ParticipantView,
  PointsAppliedRealtimeEvent,
  PokerRealtimeEvent,
  QuestionCard,
  RoundStatus,
  SessionSnapshot,
  SessionUpdatedRealtimeEvent,
  StoryPointsFieldInfo,
}

export const PANEL_DECK_CARDS: readonly DeckCard[] = Object.freeze([
  '0',
  '1',
  '2',
  '3',
  '5',
  '8',
  '13',
  '21',
  '?',
] as const)

export const PANEL_NUMERIC_SCORES: readonly FibonacciScore[] = Object.freeze([0, 1, 2, 3, 5, 8, 13, 21] as const)

export const PANEL_REALTIME_CHANNEL = 'scrum-poker' as const

export const PANEL_RESOLVER_KEYS = Object.freeze({
  getSession: 'getSession',
  castVote: 'castVote',
  withdrawVote: 'withdrawVote',
  revealVotes: 'revealVotes',
  selectOverrideScore: 'selectOverrideScore',
  resetRound: 'resetRound',
  applyStoryPoints: 'applyStoryPoints',
} as const)

export type BridgeInvokeFn = <TResult = unknown>(
  functionKey: string,
  payload?: Record<string, unknown>,
) => Promise<TResult>

export interface BridgeRealtimeSubscription {
  unsubscribe(): Promise<void> | void
}

export type BridgeRealtimeSubscribeFn = (
  channel: string,
  callback: (payload: unknown, error?: Error) => unknown,
) => Promise<BridgeRealtimeSubscription>

export interface BridgeViewLike {
  readonly refresh: () => Promise<void>
  readonly theme: {
    readonly enable: () => Promise<void>
  }
}

export interface CreatePokerClientDeps {
  readonly invoke?: BridgeInvokeFn
  readonly subscribe?: BridgeRealtimeSubscribeFn
  readonly view?: BridgeViewLike
}

export interface PokerClient {
  enableTheme(): Promise<void>
  refreshIssueView(): Promise<void>
  getSession(): Promise<SessionSnapshot>
  castVote(card: DeckCard): Promise<SessionSnapshot>
  withdrawVote(): Promise<SessionSnapshot>
  revealVotes(): Promise<SessionSnapshot>
  selectOverrideScore(score: FibonacciScore): Promise<SessionSnapshot>
  resetRound(): Promise<SessionSnapshot>
  applyStoryPoints(score: FibonacciScore): Promise<ApplyStoryPointsResult>
  subscribeToSessionEvents(onEvent: (event: PokerRealtimeEvent) => void): () => Promise<void>
}

export interface UiAssetComplianceResult {
  readonly valid: boolean
  readonly violations: readonly string[]
}

export function parseRealtimeEvent(_rawPayload: unknown): PokerRealtimeEvent | null {
  throw new Error('not implemented')
}

export function validateUiAssetCompliance(_assetSource: string, _assetLabel?: string): UiAssetComplianceResult {
  throw new Error('not implemented')
}

export function createPokerClient(_deps?: CreatePokerClientDeps): PokerClient {
  throw new Error('not implemented')
}
