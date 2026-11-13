import type { FibonacciScore } from '../domain/types'
import type { BackendLogger } from '../observability/logger'

export const POKER_REALTIME_CHANNEL = 'scrum-poker'

export type SessionUpdatedRealtimeEvent = {
  readonly type: 'SESSION_UPDATED'
  readonly roundId: string
  readonly updatedAt: number
}

export type PointsAppliedRealtimeEvent = {
  readonly type: 'points-applied'
  readonly roundId: string
  readonly score: FibonacciScore
  readonly updatedAt: number
}

export type PokerRealtimeEvent = SessionUpdatedRealtimeEvent | PointsAppliedRealtimeEvent

export type RealtimePublishFn = (channel: string, payload: PokerRealtimeEvent) => Promise<unknown>

export interface CreateRealtimePublisherDeps {
  readonly publish?: RealtimePublishFn
  readonly logger?: BackendLogger
}

export interface RealtimePublisher {
  publishSessionUpdated(roundId: string, updatedAt: number): Promise<void>
  publishPointsApplied(roundId: string, score: FibonacciScore, updatedAt: number): Promise<void>
}

export function createRealtimePublisher(_deps?: CreateRealtimePublisherDeps): RealtimePublisher {
  throw new Error('not implemented')
}
