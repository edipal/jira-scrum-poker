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

const MAX_ROUND_ID_LENGTH = 128

const DECK_CARD_SET: ReadonlySet<string> = new Set<string>(PANEL_DECK_CARDS)

const NUMERIC_SCORE_SET: ReadonlySet<number> = new Set<number>(PANEL_NUMERIC_SCORES)

const FORBIDDEN_REALTIME_KEYS: ReadonlySet<string> = new Set<string>([
  'card',
  'cards',
  'viewercard',
  'vote',
  'votes',
  'participants',
])

const ALLOWED_W3C_NAMESPACE_PATTERN =
  /http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1998\/Math\/MathML|1999\/xlink)(?=$|[\s"'`)>])/g

const EXTERNAL_HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s"'`)>]+/gi

const PROTOCOL_RELATIVE_ASSET_PATTERN = /(?:src|href)\s*=\s*["']\/\/|url\(\s*["']?\/\/|@import\s+["']\/\//gi

const DIRECT_BROWSER_NETWORK_PATTERN =
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnavigator\.sendBeacon\s*\(/g

const BACKEND_FORGE_IMPORT_PATTERN = /@forge\/(?:kvs|api|realtime|resolver)\b/g

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isValidDeckCardInput(value: unknown): value is DeckCard {
  return typeof value === 'string' && DECK_CARD_SET.has(value)
}

function isValidFibonacciScoreInput(value: unknown): value is FibonacciScore {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && NUMERIC_SCORE_SET.has(value)
}

function isValidRoundId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value === value.trim() &&
    value.length <= MAX_ROUND_ID_LENGTH &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}

function hasForbiddenVoteProperty(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') {
    return false
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenVoteProperty(entry, depth + 1))
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '')
    if (FORBIDDEN_REALTIME_KEYS.has(normalizedKey)) {
      return true
    }
    const nested = (value as Record<string, unknown>)[key]
    if (hasForbiddenVoteProperty(nested, depth + 1)) {
      return true
    }
  }

  return false
}

export function parseRealtimeEvent(rawPayload: unknown): PokerRealtimeEvent | null {
  try {
    let candidate: unknown = rawPayload
    if (typeof rawPayload === 'string') {
      if (rawPayload.trim().length === 0) {
        return null
      }
      candidate = JSON.parse(rawPayload)
    }

    if (!isPlainObject(candidate)) {
      return null
    }

    if (hasForbiddenVoteProperty(candidate)) {
      return null
    }

    const rawRoundId = candidate.roundId
    if (!isValidRoundId(rawRoundId)) {
      return null
    }

    const rawUpdatedAt = candidate.updatedAt
    if (typeof rawUpdatedAt !== 'number' || !Number.isFinite(rawUpdatedAt)) {
      return null
    }
    const updatedAt = rawUpdatedAt === 0 ? 0 : rawUpdatedAt

    if (candidate.type === 'SESSION_UPDATED') {
      return {
        type: 'SESSION_UPDATED',
        roundId: rawRoundId,
        updatedAt,
      }
    }

    if (candidate.type === 'points-applied') {
      const rawScore = candidate.score
      if (!isValidFibonacciScoreInput(rawScore)) {
        return null
      }
      return {
        type: 'points-applied',
        roundId: rawRoundId,
        score: rawScore,
        updatedAt,
      }
    }

    return null
  } catch {
    return null
  }
}

export function validateUiAssetCompliance(assetSource: string, assetLabel?: string): UiAssetComplianceResult {
  if (typeof assetSource !== 'string') {
    throw new TypeError('assetSource must be a string')
  }
  if (assetLabel !== undefined && typeof assetLabel !== 'string') {
    throw new TypeError('assetLabel must be a string when provided')
  }

  const prefix = assetLabel !== undefined && assetLabel.length > 0 ? `${assetLabel}: ` : ''
  const sanitized = assetSource.replace(ALLOWED_W3C_NAMESPACE_PATTERN, '')
  const violations: string[] = []

  for (const match of sanitized.matchAll(EXTERNAL_HTTP_URL_PATTERN)) {
    violations.push(`${prefix}External HTTP/HTTPS URL is not allowed (${match[0]})`)
  }

  for (const match of sanitized.matchAll(PROTOCOL_RELATIVE_ASSET_PATTERN)) {
    violations.push(`${prefix}Protocol-relative external asset reference is not allowed (${match[0]})`)
  }

  for (const match of sanitized.matchAll(DIRECT_BROWSER_NETWORK_PATTERN)) {
    violations.push(`${prefix}Direct browser network egress API is not allowed (${match[0]})`)
  }

  for (const match of sanitized.matchAll(BACKEND_FORGE_IMPORT_PATTERN)) {
    violations.push(`${prefix}Backend-only Forge package reference is not allowed (${match[0]})`)
  }

  return {
    valid: violations.length === 0,
    violations,
  }
}

type ForgeBridgeModule = typeof import('@forge/bridge')

function loadForgeBridge(): Promise<ForgeBridgeModule> {
  return import('@forge/bridge')
}

export function createPokerClient(deps?: CreatePokerClientDeps): PokerClient {
  const invokeRpc: BridgeInvokeFn = async <TResult = unknown>(
    functionKey: string,
    payload?: Record<string, unknown>,
  ): Promise<TResult> => {
    if (deps?.invoke !== undefined) {
      if (payload === undefined) {
        return deps.invoke<TResult>(functionKey)
      }
      return deps.invoke<TResult>(functionKey, payload)
    }

    const bridge = await loadForgeBridge()
    if (payload === undefined) {
      return bridge.invoke<TResult>(functionKey)
    }
    return bridge.invoke<Record<string, unknown>, TResult>(functionKey, payload)
  }

  return {
    async enableTheme(): Promise<void> {
      if (deps?.view !== undefined) {
        await deps.view.theme.enable()
        return
      }
      const bridge = await loadForgeBridge()
      await bridge.view.theme.enable()
    },

    async refreshIssueView(): Promise<void> {
      if (deps?.view !== undefined) {
        await deps.view.refresh()
        return
      }
      const bridge = await loadForgeBridge()
      await bridge.view.refresh()
    },

    async getSession(): Promise<SessionSnapshot> {
      return invokeRpc<SessionSnapshot>(PANEL_RESOLVER_KEYS.getSession)
    },

    async castVote(card: DeckCard): Promise<SessionSnapshot> {
      if (!isValidDeckCardInput(card)) {
        throw new RangeError('Invalid deck card: must belong to canonical Fibonacci deck')
      }
      return invokeRpc<SessionSnapshot>(PANEL_RESOLVER_KEYS.castVote, { card })
    },

    async withdrawVote(): Promise<SessionSnapshot> {
      return invokeRpc<SessionSnapshot>(PANEL_RESOLVER_KEYS.withdrawVote)
    },

    async revealVotes(): Promise<SessionSnapshot> {
      return invokeRpc<SessionSnapshot>(PANEL_RESOLVER_KEYS.revealVotes)
    },

    async selectOverrideScore(score: FibonacciScore): Promise<SessionSnapshot> {
      if (!isValidFibonacciScoreInput(score)) {
        throw new RangeError('Invalid override score: must be a numeric Fibonacci card value')
      }
      return invokeRpc<SessionSnapshot>(PANEL_RESOLVER_KEYS.selectOverrideScore, { score })
    },

    async resetRound(): Promise<SessionSnapshot> {
      return invokeRpc<SessionSnapshot>(PANEL_RESOLVER_KEYS.resetRound)
    },

    async applyStoryPoints(score: FibonacciScore): Promise<ApplyStoryPointsResult> {
      if (!isValidFibonacciScoreInput(score)) {
        throw new RangeError('Invalid Story Points score: must be a numeric Fibonacci card value')
      }
      return invokeRpc<ApplyStoryPointsResult>(PANEL_RESOLVER_KEYS.applyStoryPoints, { score })
    },

    subscribeToSessionEvents(onEvent: (event: PokerRealtimeEvent) => void): () => Promise<void> {
      if (typeof onEvent !== 'function') {
        throw new TypeError('onEvent callback must be a function')
      }

      let active = true
      let cleanupPromise: Promise<void> | null = null

      const handleBridgeMessage = (rawPayload: unknown, error?: Error): void => {
        if (!active || error !== undefined) {
          return
        }
        const parsed = parseRealtimeEvent(rawPayload)
        if (parsed !== null) {
          onEvent(parsed)
        }
      }

      let subscriptionPromise: Promise<BridgeRealtimeSubscription | null>
      if (deps?.subscribe !== undefined) {
        try {
          subscriptionPromise = Promise.resolve(deps.subscribe(PANEL_REALTIME_CHANNEL, handleBridgeMessage)).catch(
            () => null,
          )
        } catch {
          subscriptionPromise = Promise.resolve(null)
        }
      } else {
        subscriptionPromise = loadForgeBridge()
          .then((bridge) => bridge.realtime.subscribe(PANEL_REALTIME_CHANNEL, handleBridgeMessage))
          .catch(() => null)
      }

      return (): Promise<void> => {
        active = false
        if (cleanupPromise === null) {
          cleanupPromise = subscriptionPromise.then(async (subscription) => {
            if (
              subscription !== null &&
              typeof subscription === 'object' &&
              typeof subscription.unsubscribe === 'function'
            ) {
              try {
                await subscription.unsubscribe()
              } catch {
                // Ignore unsubscribe teardown errors
              }
            }
          })
        }
        return cleanupPromise
      }
    },
  }
}
