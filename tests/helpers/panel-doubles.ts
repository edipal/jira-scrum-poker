import { vi } from 'vitest'
import type {
  DeckCard,
  FibonacciScore,
  ParticipantView,
  SessionSnapshot,
  StoryPointsFieldInfo,
} from '../../src/domain/types'
import { createJiraClient } from '../../src/jira/jira-client'
import { createRealtimePublisher, type PokerRealtimeEvent } from '../../src/realtime/publisher'
import { type ApplyStoryPointsResult, createPokerResolverHandlers } from '../../src/resolvers/poker-resolvers'
import { createSessionStore } from '../../src/storage/session-store'
import {
  type BridgeInvokeFn,
  type BridgeRealtimeSubscribeFn,
  type BridgeRealtimeSubscription,
  type BridgeViewLike,
  createPokerClient,
  type PokerClient,
} from '../../static/panel/src/bridge/poker-client'
import {
  COMPANY_MANAGED_STORY_POINTS_EDITMETA,
  createFakeJiraDouble,
  createInMemoryKvsDouble,
  jsonJiraResponse,
  makeHostContext,
} from './forge-doubles'

export const DEFAULT_STORY_POINTS_FIELD: StoryPointsFieldInfo = Object.freeze({
  fieldId: 'customfield_10016',
  fieldName: 'Story Points',
})

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolveFn!: (value: T | PromiseLike<T>) => void
  let rejectFn!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  }
}

export function makeParticipant(
  accountId: string,
  displayName: string,
  card: DeckCard | null = null,
  avatarUrl: string | null = 'https://avatar.atlassian.example/user.png',
): ParticipantView {
  return {
    accountId,
    displayName,
    avatarUrl,
    hasVoted: true,
    card,
  }
}

export function makeIdleVotingSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    roundId: null,
    status: 'voting',
    participants: [],
    viewerCard: null,
    average: null,
    formattedAverage: null,
    recommendedScore: null,
    targetScore: null,
    storyPointsField: DEFAULT_STORY_POINTS_FIELD,
    ...overrides,
  }
}

export function makeVotingSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    roundId: 'round-1',
    status: 'voting',
    participants: [makeParticipant('acc-alice', 'Alice', null), makeParticipant('acc-bob', 'Bob', null)],
    viewerCard: '5',
    average: null,
    formattedAverage: null,
    recommendedScore: null,
    targetScore: null,
    storyPointsField: DEFAULT_STORY_POINTS_FIELD,
    ...overrides,
  }
}

export function makeRevealedSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    roundId: 'round-1',
    status: 'revealed',
    participants: [
      makeParticipant('acc-alice', 'Alice', '3'),
      makeParticipant('acc-bob', 'Bob', '5'),
      makeParticipant('acc-cara', 'Cara', '5'),
    ],
    viewerCard: '5',
    average: 13 / 3,
    formattedAverage: '4.3',
    recommendedScore: 5,
    targetScore: 5,
    storyPointsField: DEFAULT_STORY_POINTS_FIELD,
    ...overrides,
  }
}

export interface RecordedBridgeInvoke {
  readonly functionKey: string
  readonly payload: Record<string, unknown> | undefined
}

export interface RecordedRealtimeSubscriber {
  readonly channel: string
  readonly callback: (payload: unknown, error?: Error) => unknown
  unsubscribeCalls: number
}

export interface FakeBridgeDouble {
  readonly invoke: BridgeInvokeFn
  readonly subscribe: BridgeRealtimeSubscribeFn
  readonly view: BridgeViewLike
  readonly invokeCalls: RecordedBridgeInvoke[]
  readonly subscribers: RecordedRealtimeSubscriber[]
  enableThemeCalls: number
  refreshCalls: number
  emitRawRealtime(payload: unknown, error?: Error): void
}

export interface FakeBridgeOptions {
  readonly onInvoke?: (functionKey: string, payload?: Record<string, unknown>) => Promise<unknown> | unknown
  readonly subscribeGate?: Deferred<void>
  readonly subscribeError?: Error
  readonly unsubscribeGate?: Deferred<void>
  readonly unsubscribeError?: Error
  readonly enableThemeError?: Error
  readonly refreshError?: Error
}

export function createFakeBridgeDouble(options: FakeBridgeOptions = {}): FakeBridgeDouble {
  const invokeCalls: RecordedBridgeInvoke[] = []
  const subscribers: RecordedRealtimeSubscriber[] = []

  const double: FakeBridgeDouble = {
    invokeCalls,
    subscribers,
    enableThemeCalls: 0,
    refreshCalls: 0,

    invoke: async <TResult = unknown>(functionKey: string, payload?: Record<string, unknown>): Promise<TResult> => {
      invokeCalls.push({ functionKey, payload })
      if (options.onInvoke !== undefined) {
        return (await options.onInvoke(functionKey, payload)) as TResult
      }
      return makeIdleVotingSnapshot() as unknown as TResult
    },

    subscribe: async (
      channel: string,
      callback: (payload: unknown, error?: Error) => unknown,
    ): Promise<BridgeRealtimeSubscription> => {
      const record: RecordedRealtimeSubscriber = {
        channel,
        callback,
        unsubscribeCalls: 0,
      }
      subscribers.push(record)

      if (options.subscribeGate !== undefined) {
        await options.subscribeGate.promise
      }
      if (options.subscribeError !== undefined) {
        throw options.subscribeError
      }

      return {
        async unsubscribe(): Promise<void> {
          record.unsubscribeCalls += 1
          if (options.unsubscribeGate !== undefined) {
            await options.unsubscribeGate.promise
          }
          if (options.unsubscribeError !== undefined) {
            throw options.unsubscribeError
          }
        },
      }
    },

    view: {
      async refresh(): Promise<void> {
        double.refreshCalls += 1
        if (options.refreshError !== undefined) {
          throw options.refreshError
        }
      },
      theme: {
        async enable(): Promise<void> {
          double.enableThemeCalls += 1
          if (options.enableThemeError !== undefined) {
            throw options.enableThemeError
          }
        },
      },
    },

    emitRawRealtime(payload: unknown, error?: Error): void {
      for (const sub of [...subscribers]) {
        sub.callback(payload, error)
      }
    },
  }

  return double
}

export interface MockPokerClientController {
  readonly client: PokerClient
  readonly enableTheme: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly refreshIssueView: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly getSession: ReturnType<typeof vi.fn<() => Promise<SessionSnapshot>>>
  readonly castVote: ReturnType<typeof vi.fn<(card: DeckCard) => Promise<SessionSnapshot>>>
  readonly withdrawVote: ReturnType<typeof vi.fn<() => Promise<SessionSnapshot>>>
  readonly revealVotes: ReturnType<typeof vi.fn<() => Promise<SessionSnapshot>>>
  readonly selectOverrideScore: ReturnType<typeof vi.fn<(score: FibonacciScore) => Promise<SessionSnapshot>>>
  readonly resetRound: ReturnType<typeof vi.fn<() => Promise<SessionSnapshot>>>
  readonly applyStoryPoints: ReturnType<typeof vi.fn<(score: FibonacciScore) => Promise<ApplyStoryPointsResult>>>
  readonly subscribeToSessionEvents: ReturnType<
    typeof vi.fn<(onEvent: (event: PokerRealtimeEvent) => void) => () => Promise<void>>
  >
  unsubscribeCalls: number
  emitRealtimeEvent(event: PokerRealtimeEvent): void
}

export function createMockPokerClient(
  initialSession: SessionSnapshot = makeIdleVotingSnapshot(),
): MockPokerClientController {
  let currentSession = initialSession
  const activeListeners = new Set<(event: PokerRealtimeEvent) => void>()

  const enableTheme = vi.fn(async (): Promise<void> => {})
  const refreshIssueView = vi.fn(async (): Promise<void> => {})
  const getSession = vi.fn(async (): Promise<SessionSnapshot> => currentSession)
  const castVote = vi.fn(async (card: DeckCard): Promise<SessionSnapshot> => {
    currentSession = {
      ...currentSession,
      roundId: currentSession.roundId ?? 'round-1',
      viewerCard: card,
    }
    return currentSession
  })
  const withdrawVote = vi.fn(async (): Promise<SessionSnapshot> => {
    currentSession = {
      ...currentSession,
      viewerCard: null,
    }
    return currentSession
  })
  const revealVotes = vi.fn(async (): Promise<SessionSnapshot> => currentSession)
  const selectOverrideScore = vi.fn(async (score: FibonacciScore): Promise<SessionSnapshot> => {
    currentSession = {
      ...currentSession,
      targetScore: score,
    }
    return currentSession
  })
  const resetRound = vi.fn(async (): Promise<SessionSnapshot> => {
    currentSession = makeIdleVotingSnapshot({ roundId: 'round-reset' })
    return currentSession
  })
  const applyStoryPoints = vi.fn(
    async (score: FibonacciScore): Promise<ApplyStoryPointsResult> => ({
      ok: true,
      appliedScore: score,
      fieldName: 'Story Points',
      session: makeIdleVotingSnapshot({ roundId: 'round-after-save' }),
    }),
  )

  const controller: MockPokerClientController = {
    enableTheme,
    refreshIssueView,
    getSession,
    castVote,
    withdrawVote,
    revealVotes,
    selectOverrideScore,
    resetRound,
    applyStoryPoints,
    unsubscribeCalls: 0,
    subscribeToSessionEvents: vi.fn((onEvent: (event: PokerRealtimeEvent) => void) => {
      activeListeners.add(onEvent)
      let cleaned = false
      return async (): Promise<void> => {
        if (!cleaned) {
          cleaned = true
          controller.unsubscribeCalls += 1
          activeListeners.delete(onEvent)
        }
      }
    }),
    emitRealtimeEvent(event: PokerRealtimeEvent): void {
      for (const listener of [...activeListeners]) {
        listener(event)
      }
    },
    client: {} as PokerClient,
  }

  const client: PokerClient = {
    enableTheme: () => enableTheme(),
    refreshIssueView: () => refreshIssueView(),
    getSession: () => getSession(),
    castVote: (card) => castVote(card),
    withdrawVote: () => withdrawVote(),
    revealVotes: () => revealVotes(),
    selectOverrideScore: (score) => selectOverrideScore(score),
    resetRound: () => resetRound(),
    applyStoryPoints: (score) => applyStoryPoints(score),
    subscribeToSessionEvents: (onEvent) => controller.subscribeToSessionEvents(onEvent),
  }
  ;(controller as { client: PokerClient }).client = client

  return controller
}

export interface MultiPanelPeerHandle {
  readonly client: PokerClient
  readonly bridge: FakeBridgeDouble
}

export interface MultiPanelHarness {
  createPeer(accountId: string, displayName: string): MultiPanelPeerHandle
  setStoryPointsFieldAvailable(available: boolean): void
  emitRawChannelPayload(payload: unknown, asJsonString?: boolean): void
}

export function createMultiPanelHarness(issueId = '10001'): MultiPanelHarness {
  const kvs = createInMemoryKvsDouble()
  let storyPointsAvailable = true
  let nowMs = 1_700_000_000_000

  const channelBridges: FakeBridgeDouble[] = []

  const store = createSessionStore(kvs.client)
  const realtime = createRealtimePublisher({
    publish: async (_channel: string, event: PokerRealtimeEvent): Promise<void> => {
      for (const peerBridge of [...channelBridges]) {
        peerBridge.emitRawRealtime(structuredClone(event))
      }
    },
  })

  const nextTimestamp = (): number => {
    nowMs += 10
    return nowMs
  }

  return {
    createPeer(accountId: string, displayName: string): MultiPanelPeerHandle {
      const hostContext = makeHostContext(issueId, accountId, 'SP-101')
      const jiraDouble = createFakeJiraDouble({
        onMyself: () =>
          jsonJiraResponse(200, {
            accountId,
            displayName,
            avatarUrls: {
              '24x24': `https://avatar.atlassian.example/${encodeURIComponent(accountId)}.png`,
            },
          }),
        onEditMeta: () =>
          storyPointsAvailable
            ? jsonJiraResponse(200, COMPANY_MANAGED_STORY_POINTS_EDITMETA)
            : jsonJiraResponse(200, { fields: {} }),
        onPutIssue: () => jsonJiraResponse(204, {}),
      })

      const resolvers = createPokerResolverHandlers({
        store,
        jira: createJiraClient({ requestAsUser: jiraDouble.requestAsUser }),
        realtime,
        now: nextTimestamp,
      })

      const bridge = createFakeBridgeDouble({
        onInvoke: async (functionKey: string, payload?: Record<string, unknown>): Promise<unknown> => {
          const req = { context: hostContext, payload }
          switch (functionKey) {
            case 'getSession':
              return await resolvers.getSession(req)
            case 'castVote':
              return await resolvers.castVote(req)
            case 'withdrawVote':
              return await resolvers.withdrawVote(req)
            case 'revealVotes':
              return await resolvers.revealVotes(req)
            case 'selectOverrideScore':
              return await resolvers.selectOverrideScore(req)
            case 'resetRound':
              return await resolvers.resetRound(req)
            case 'applyStoryPoints':
              return await resolvers.applyStoryPoints(req)
            default:
              throw new Error(`Unknown resolver key: ${functionKey}`)
          }
        },
      })
      channelBridges.push(bridge)

      const client = createPokerClient({
        invoke: bridge.invoke,
        subscribe: bridge.subscribe,
        view: bridge.view,
      })

      return { client, bridge }
    },

    setStoryPointsFieldAvailable(available: boolean): void {
      storyPointsAvailable = available
    },

    emitRawChannelPayload(payload: unknown, asJsonString = false): void {
      const wirePayload = asJsonString ? JSON.stringify(payload) : payload
      for (const peerBridge of [...channelBridges]) {
        peerBridge.emitRawRealtime(wirePayload)
      }
    },
  }
}
