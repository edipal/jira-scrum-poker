import { publish } from '@forge/realtime'
import { validateFibonacciScore } from '../domain/deck'
import { type FibonacciScore, PokerDomainError } from '../domain/types'
import { type BackendLogger, createBackendLogger } from '../observability/logger'
import { assertSafeIdentifier } from '../storage/session-store'

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

function assertFiniteUpdatedAt(updatedAt: unknown): number {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new PokerDomainError('validation-error', 'Realtime event updatedAt must be a finite number')
  }
  return updatedAt === 0 ? 0 : updatedAt
}

const defaultPublish: RealtimePublishFn = (channel, payload) => publish(channel, payload)

export function createRealtimePublisher(deps?: CreateRealtimePublisherDeps): RealtimePublisher {
  const publishFn = deps?.publish ?? defaultPublish
  const logger = deps?.logger ?? createBackendLogger()

  return {
    async publishSessionUpdated(roundId: string, updatedAt: number): Promise<void> {
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validUpdatedAt = assertFiniteUpdatedAt(updatedAt)
      const event: SessionUpdatedRealtimeEvent = {
        type: 'SESSION_UPDATED',
        roundId: validRoundId,
        updatedAt: validUpdatedAt,
      }

      try {
        await publishFn(POKER_REALTIME_CHANNEL, event)
      } catch (error: unknown) {
        logger.warn('realtime.publish_failed', {
          channel: POKER_REALTIME_CHANNEL,
          eventType: 'SESSION_UPDATED',
          roundId: validRoundId,
          error,
        })
      }
    },

    async publishPointsApplied(roundId: string, score: FibonacciScore, updatedAt: number): Promise<void> {
      const validRoundId = assertSafeIdentifier(roundId, 'roundId')
      const validScore = validateFibonacciScore(score)
      const validUpdatedAt = assertFiniteUpdatedAt(updatedAt)
      const event: PointsAppliedRealtimeEvent = {
        type: 'points-applied',
        roundId: validRoundId,
        score: validScore,
        updatedAt: validUpdatedAt,
      }

      try {
        await publishFn(POKER_REALTIME_CHANNEL, event)
      } catch (error: unknown) {
        logger.warn('realtime.publish_failed', {
          channel: POKER_REALTIME_CHANNEL,
          eventType: 'points-applied',
          roundId: validRoundId,
          error,
        })
      }
    },
  }
}
