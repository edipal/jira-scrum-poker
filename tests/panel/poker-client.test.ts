import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const defaultBridgeState = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ functionKey: string; payload: Record<string, unknown> | undefined }>,
  subscribeCalls: [] as Array<{ channel: string; callback: (payload: unknown, error?: Error) => unknown }>,
  unsubscribeCalls: 0,
  themeEnableCalls: 0,
  viewRefreshCalls: 0,
}))

vi.mock('@forge/bridge', () => ({
  invoke: async <TResult = unknown>(functionKey: string, payload?: Record<string, unknown>): Promise<TResult> => {
    defaultBridgeState.invokeCalls.push({ functionKey, payload })
    return {
      roundId: 'bridge-round-1',
      status: 'voting',
      participants: [],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: { fieldId: 'customfield_10016', fieldName: 'Story Points' },
    } as unknown as TResult
  },
  realtime: {
    subscribe: async (channel: string, callback: (payload: unknown, error?: Error) => unknown) => {
      defaultBridgeState.subscribeCalls.push({ channel, callback })
      return {
        unsubscribe: async (): Promise<void> => {
          defaultBridgeState.unsubscribeCalls += 1
        },
      }
    },
  },
  view: {
    refresh: async (): Promise<void> => {
      defaultBridgeState.viewRefreshCalls += 1
    },
    theme: {
      enable: async (): Promise<void> => {
        defaultBridgeState.themeEnableCalls += 1
      },
    },
  },
}))

import {
  createPokerClient,
  type DeckCard,
  type FibonacciScore,
  PANEL_DECK_CARDS,
  PANEL_NUMERIC_SCORES,
  PANEL_REALTIME_CHANNEL,
  PANEL_RESOLVER_KEYS,
  type PokerRealtimeEvent,
  parseRealtimeEvent,
} from '../../static/panel/src/bridge/poker-client'
import {
  createDeferred,
  createFakeBridgeDouble,
  makeIdleVotingSnapshot,
  makeRevealedSnapshot,
} from '../helpers/panel-doubles'

class CustomPrototypePayload {
  readonly type = 'SESSION_UPDATED'
  readonly roundId = 'round-1'
  readonly updatedAt = 1_000
}

describe('parseRealtimeEvent boundary, serialization, and secrecy validation (R12, R14)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses valid object and single-encoded JSON-string SESSION_UPDATED payloads including 1-char, 128-char, and null-prototype objects', () => {
    const minRoundEvent = parseRealtimeEvent({
      type: 'SESSION_UPDATED',
      roundId: 'a',
      updatedAt: 0,
      extraIgnoredField: 'ignored',
    })
    expect(minRoundEvent).toEqual({
      type: 'SESSION_UPDATED',
      roundId: 'a',
      updatedAt: 0,
    })

    const maxRoundId = 'r'.repeat(128)
    const jsonEncoded = JSON.stringify({
      type: 'SESSION_UPDATED',
      roundId: maxRoundId,
      updatedAt: 1_700_000_000_000,
    })
    expect(parseRealtimeEvent(jsonEncoded)).toEqual({
      type: 'SESSION_UPDATED',
      roundId: maxRoundId,
      updatedAt: 1_700_000_000_000,
    })

    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto.type = 'SESSION_UPDATED'
    nullProto.roundId = 'round-null-proto'
    nullProto.updatedAt = -0
    const parsedNullProto = parseRealtimeEvent(nullProto)
    expect(parsedNullProto).toEqual({
      type: 'SESSION_UPDATED',
      roundId: 'round-null-proto',
      updatedAt: 0,
    })
    expect(Object.is(parsedNullProto?.updatedAt, -0)).toBe(false)
    expect(Object.is(parsedNullProto?.updatedAt, 0)).toBe(true)
  })

  it.each([0, 1, 2, 3, 5, 8, 13, 21] as const)(
    'parses valid object and JSON-string points-applied events for Fibonacci score %d',
    (score) => {
      const rawObj = {
        type: 'points-applied',
        roundId: `round-score-${score}`,
        score,
        updatedAt: 55_000,
      }
      expect(parseRealtimeEvent(rawObj)).toEqual(rawObj)
      expect(parseRealtimeEvent(JSON.stringify(rawObj))).toEqual(rawObj)
    },
  )

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'empty string', value: '' },
    { label: 'whitespace-only string', value: '   \n\t  ' },
    { label: 'malformed JSON string', value: '{"type":"SESSION_UPDATED"' },
    {
      label: 'double-encoded JSON string',
      value: JSON.stringify(JSON.stringify({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100 })),
    },
    { label: 'JSON array string', value: '[{"type":"SESSION_UPDATED","roundId":"round-1","updatedAt":100}]' },
    { label: 'JSON number string', value: '42' },
    { label: 'number primitive', value: 42 },
    { label: 'boolean primitive', value: true },
    { label: 'array instance', value: [] },
    { label: 'Date instance', value: new Date() },
    { label: 'custom prototype instance', value: new CustomPrototypePayload() },
    { label: 'bridge error payload object', value: { error: 'subscription-failed', message: 'boom' } },
    { label: 'unknown event type', value: { type: 'VOTE_CAST', roundId: 'round-1', updatedAt: 100 } },
    { label: 'empty roundId', value: { type: 'SESSION_UPDATED', roundId: '', updatedAt: 100 } },
    { label: 'whitespace-padded roundId', value: { type: 'SESSION_UPDATED', roundId: ' round-1 ', updatedAt: 100 } },
    { label: '129-char roundId (max + 1)', value: { type: 'SESSION_UPDATED', roundId: 'r'.repeat(129), updatedAt: 1 } },
    { label: 'slash in roundId', value: { type: 'SESSION_UPDATED', roundId: 'round/1', updatedAt: 100 } },
    { label: 'backslash in roundId', value: { type: 'SESSION_UPDATED', roundId: 'round\\1', updatedAt: 100 } },
    { label: 'null-byte in roundId', value: { type: 'SESSION_UPDATED', roundId: 'round\0a', updatedAt: 100 } },
    { label: 'NaN updatedAt', value: { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: Number.NaN } },
    {
      label: 'Infinity updatedAt',
      value: { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: Number.POSITIVE_INFINITY },
    },
    { label: 'string updatedAt', value: { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: '100' } },
    {
      label: '-0 score on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: -0, updatedAt: 100 },
    },
    {
      label: 'negative score on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: -1, updatedAt: 100 },
    },
    {
      label: 'non-Fibonacci score 4 on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: 4, updatedAt: 100 },
    },
    {
      label: 'decimal score 3.5 on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: 3.5, updatedAt: 100 },
    },
    {
      label: 'score 22 on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: 22, updatedAt: 100 },
    },
    {
      label: 'string score on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: '5', updatedAt: 100 },
    },
    {
      label: 'question card on points-applied',
      value: { type: 'points-applied', roundId: 'round-1', score: '?', updatedAt: 100 },
    },
  ])('returns null without throwing for invalid input: $label', ({ value }) => {
    expect(parseRealtimeEvent(value)).toBeNull()
  })

  it.each([
    'card',
    'Card',
    'cards',
    'CARDS',
    'viewerCard',
    'viewer_card',
    'viewer-card',
    'vote',
    'votes',
    'VOTES',
    'participants',
  ])('rejects vote/card-bearing property %s on both object and JSON-string payloads (R5, R12, R14)', (forbiddenKey) => {
    const sessionEventWithSecret: Record<string, unknown> = {
      type: 'SESSION_UPDATED',
      roundId: 'round-1',
      updatedAt: 1_000,
      [forbiddenKey]: '8',
    }
    const pointsEventWithSecret: Record<string, unknown> = {
      type: 'points-applied',
      roundId: 'round-2',
      score: 5,
      updatedAt: 2_000,
      [forbiddenKey]: null,
    }

    expect(parseRealtimeEvent(sessionEventWithSecret)).toBeNull()
    expect(parseRealtimeEvent(JSON.stringify(sessionEventWithSecret))).toBeNull()
    expect(parseRealtimeEvent(pointsEventWithSecret)).toBeNull()
    expect(parseRealtimeEvent(JSON.stringify(pointsEventWithSecret))).toBeNull()
  })
})

describe('createPokerClient RPC forwarding, validation guards, and realtime lifecycle (R12, R13)', () => {
  beforeEach(() => {
    defaultBridgeState.invokeCalls.length = 0
    defaultBridgeState.subscribeCalls.length = 0
    defaultBridgeState.unsubscribeCalls = 0
    defaultBridgeState.themeEnableCalls = 0
    defaultBridgeState.viewRefreshCalls = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes canonical frozen constants and routes all 7 resolver methods plus view helpers through injected deps', async () => {
    expect(PANEL_DECK_CARDS).toEqual(['0', '1', '2', '3', '5', '8', '13', '21', '?'])
    expect(Object.isFrozen(PANEL_DECK_CARDS)).toBe(true)
    expect(PANEL_NUMERIC_SCORES).toEqual([0, 1, 2, 3, 5, 8, 13, 21])
    expect(Object.isFrozen(PANEL_NUMERIC_SCORES)).toBe(true)
    expect(PANEL_REALTIME_CHANNEL).toBe('scrum-poker')
    expect(PANEL_RESOLVER_KEYS).toEqual({
      getSession: 'getSession',
      castVote: 'castVote',
      withdrawVote: 'withdrawVote',
      revealVotes: 'revealVotes',
      selectOverrideScore: 'selectOverrideScore',
      resetRound: 'resetRound',
      applyStoryPoints: 'applyStoryPoints',
    })
    expect(Object.isFrozen(PANEL_RESOLVER_KEYS)).toBe(true)

    const revealedSnapshot = makeRevealedSnapshot({ targetScore: 0 })
    const bridge = createFakeBridgeDouble({
      onInvoke: (functionKey, payload) => {
        if (functionKey === 'applyStoryPoints') {
          return {
            ok: true,
            appliedScore: (payload?.score ?? 0) as FibonacciScore,
            fieldName: 'Story Points',
            session: makeIdleVotingSnapshot({ roundId: 'round-saved' }),
          }
        }
        return revealedSnapshot
      },
    })

    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    await client.enableTheme()
    await client.refreshIssueView()
    expect(bridge.enableThemeCalls).toBe(1)
    expect(bridge.refreshCalls).toBe(1)

    await client.getSession()
    await client.castVote('0')
    await client.castVote('?')
    await client.withdrawVote()
    await client.revealVotes()
    await client.selectOverrideScore(0)
    await client.selectOverrideScore(21)
    await client.resetRound()
    const saveZeroResult = await client.applyStoryPoints(0)

    expect(saveZeroResult).toEqual({
      ok: true,
      appliedScore: 0,
      fieldName: 'Story Points',
      session: makeIdleVotingSnapshot({ roundId: 'round-saved' }),
    })

    expect(bridge.invokeCalls).toEqual([
      { functionKey: 'getSession', payload: undefined },
      { functionKey: 'castVote', payload: { card: '0' } },
      { functionKey: 'castVote', payload: { card: '?' } },
      { functionKey: 'withdrawVote', payload: undefined },
      { functionKey: 'revealVotes', payload: undefined },
      { functionKey: 'selectOverrideScore', payload: { score: 0 } },
      { functionKey: 'selectOverrideScore', payload: { score: 21 } },
      { functionKey: 'resetRound', payload: undefined },
      { functionKey: 'applyStoryPoints', payload: { score: 0 } },
    ])
  })

  it.each(['', ' ', ' 5 ', '4', '6', '-1', '3.5', 'coffee', null, undefined, 5])(
    'rejects invalid castVote card (%j) with RangeError before invoking @forge/bridge',
    async (badCard) => {
      const bridge = createFakeBridgeDouble()
      const client = createPokerClient({
        invoke: bridge.invoke,
        subscribe: bridge.subscribe,
        view: bridge.view,
      })

      await expect(client.castVote(badCard as unknown as DeckCard)).rejects.toThrow(RangeError)
      expect(bridge.invokeCalls).toHaveLength(0)
    },
  )

  it.each([-0, -1, 4, 6, 22, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '?', '5', null, undefined])(
    'rejects invalid score (%j) on selectOverrideScore and applyStoryPoints with RangeError before invoking @forge/bridge',
    async (badScore) => {
      const bridge = createFakeBridgeDouble()
      const client = createPokerClient({
        invoke: bridge.invoke,
        subscribe: bridge.subscribe,
        view: bridge.view,
      })

      await expect(client.selectOverrideScore(badScore as unknown as FibonacciScore)).rejects.toThrow(RangeError)
      await expect(client.applyStoryPoints(badScore as unknown as FibonacciScore)).rejects.toThrow(RangeError)
      expect(bridge.invokeCalls).toHaveLength(0)
    },
  )

  it('throws TypeError synchronously when subscribeToSessionEvents is given a non-function listener', () => {
    const bridge = createFakeBridgeDouble()
    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    expect(() => client.subscribeToSessionEvents(null as unknown as (event: PokerRealtimeEvent) => void)).toThrow(
      TypeError,
    )
    expect(bridge.subscribers).toHaveLength(0)
  })

  it('subscribes to scrum-poker, filters bridge errors and invalid payloads, suppresses events synchronously on cleanup, and calls unsubscribe idempotently', async () => {
    const unsubGate = createDeferred<void>()
    const bridge = createFakeBridgeDouble({ unsubscribeGate: unsubGate })
    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    const received: PokerRealtimeEvent[] = []
    const cleanup = client.subscribeToSessionEvents((event) => {
      received.push(event)
    })

    await Promise.resolve()
    expect(bridge.subscribers).toHaveLength(1)
    expect(bridge.subscribers[0]?.channel).toBe('scrum-poker')

    bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100 })
    bridge.emitRawRealtime(JSON.stringify({ type: 'points-applied', roundId: 'round-2', score: 0, updatedAt: 200 }))
    bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-err', updatedAt: 300 }, new Error('transport'))
    bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-leak', updatedAt: 301, card: '13' })
    bridge.emitRawRealtime('not-valid-json')

    expect(received).toEqual([
      { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100 },
      { type: 'points-applied', roundId: 'round-2', score: 0, updatedAt: 200 },
    ])

    const firstCleanupPromise = cleanup()
    const secondCleanupPromise = cleanup()

    // Even while unsubscribe() is still pending, active=false must suppress late callbacks immediately
    bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-after-cleanup', updatedAt: 400 })
    expect(received).toHaveLength(2)

    unsubGate.resolve()
    await Promise.all([firstCleanupPromise, secondCleanupPromise])

    expect(bridge.subscribers[0]?.unsubscribeCalls).toBe(1)
  })

  it('calls subscription.unsubscribe() and suppresses callbacks when cleaned up BEFORE realtime.subscribe settles', async () => {
    const subscribeGate = createDeferred<void>()
    const bridge = createFakeBridgeDouble({ subscribeGate })
    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    const received: PokerRealtimeEvent[] = []
    const cleanup = client.subscribeToSessionEvents((event) => {
      received.push(event)
    })

    expect(bridge.subscribers).toHaveLength(1)

    // Unmount happens before subscribeGate resolves
    const cleanupPromise = cleanup()

    // Any event arriving before subscribe settles must already be suppressed
    bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-early', updatedAt: 500 })
    expect(received).toHaveLength(0)

    subscribeGate.resolve()
    await cleanupPromise

    expect(bridge.subscribers[0]?.unsubscribeCalls).toBe(1)
    bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-late', updatedAt: 600 })
    expect(received).toHaveLength(0)
  })

  it('swallows rejections from realtime.subscribe and subscription.unsubscribe without unhandled errors', async () => {
    const failingSubBridge = createFakeBridgeDouble({
      subscribeError: new Error('realtime unavailable'),
    })
    const clientA = createPokerClient({
      invoke: failingSubBridge.invoke,
      subscribe: failingSubBridge.subscribe,
      view: failingSubBridge.view,
    })
    const cleanupA = clientA.subscribeToSessionEvents(() => {})
    await expect(cleanupA()).resolves.toBeUndefined()

    const failingUnsubBridge = createFakeBridgeDouble({
      unsubscribeError: new Error('unsubscribe failed'),
    })
    const clientB = createPokerClient({
      invoke: failingUnsubBridge.invoke,
      subscribe: failingUnsubBridge.subscribe,
      view: failingUnsubBridge.view,
    })
    const cleanupB = clientB.subscribeToSessionEvents(() => {})
    await Promise.resolve()
    await expect(cleanupB()).resolves.toBeUndefined()
    expect(failingUnsubBridge.subscribers[0]?.unsubscribeCalls).toBe(1)
  })

  it('defaults to @forge/bridge invoke, realtime.subscribe, view.theme.enable, and view.refresh when deps are omitted', async () => {
    const client = createPokerClient()

    await client.enableTheme()
    await client.refreshIssueView()
    const session = await client.getSession()
    expect(session.roundId).toBe('bridge-round-1')

    const events: PokerRealtimeEvent[] = []
    const cleanup = client.subscribeToSessionEvents((ev) => {
      events.push(ev)
    })

    await vi.waitFor(() => {
      expect(defaultBridgeState.subscribeCalls).toHaveLength(1)
    })
    expect(defaultBridgeState.themeEnableCalls).toBe(1)
    expect(defaultBridgeState.viewRefreshCalls).toBe(1)
    expect(defaultBridgeState.invokeCalls).toEqual([{ functionKey: 'getSession', payload: undefined }])
    expect(defaultBridgeState.subscribeCalls[0]?.channel).toBe('scrum-poker')

    defaultBridgeState.subscribeCalls[0]?.callback({
      type: 'SESSION_UPDATED',
      roundId: 'bridge-round-1',
      updatedAt: 999,
    })
    expect(events).toEqual([{ type: 'SESSION_UPDATED', roundId: 'bridge-round-1', updatedAt: 999 }])

    await cleanup()
    expect(defaultBridgeState.unsubscribeCalls).toBe(1)
  })
})
