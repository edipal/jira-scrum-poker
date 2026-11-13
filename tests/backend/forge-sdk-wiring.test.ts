import type { Route } from '@forge/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraRequester, JiraRequestInit, JiraResponseLike } from '../../src/jira/jira-client'
import type { PokerRealtimeEvent } from '../../src/realtime/publisher'
import type { ForgeResolverRequest } from '../../src/resolvers/poker-resolvers'
import type { KvsClientLike } from '../../src/storage/session-store'

const sdkState = vi.hoisted(() => ({
  definedHandlers: new Map<string, (req: ForgeResolverRequest) => Promise<unknown>>(),
  asUserCalls: 0,
  asAppCalls: 0,
  kvsClient: null as KvsClientLike | null,
  requestJira: null as JiraRequester | null,
  publishRealtime: null as ((channel: string, payload: PokerRealtimeEvent) => Promise<unknown>) | null,
}))

vi.mock('@forge/resolver', () => {
  class MockResolver {
    define(functionKey: string, cb: (req: ForgeResolverRequest) => Promise<unknown>): this {
      sdkState.definedHandlers.set(functionKey, cb)
      return this
    }

    getDefinitions(): Record<string, (req: ForgeResolverRequest) => Promise<unknown>> {
      return Object.fromEntries(sdkState.definedHandlers.entries())
    }
  }

  return { default: MockResolver }
})

vi.mock('@forge/kvs', () => ({
  WhereConditions: {
    beginsWith(prefix: string) {
      return { condition: 'BEGINS_WITH', values: [prefix] }
    },
  },
  kvs: {
    get<T = unknown>(key: string): Promise<T | undefined> {
      if (sdkState.kvsClient === null) {
        throw new Error('kvsClient double not initialized')
      }
      return sdkState.kvsClient.get<T>(key)
    },
    set<T = unknown>(key: string, value: T, options?: Parameters<KvsClientLike['set']>[2]): Promise<void> {
      if (sdkState.kvsClient === null) {
        throw new Error('kvsClient double not initialized')
      }
      return sdkState.kvsClient.set<T>(key, value, options)
    },
    delete(key: string): Promise<void> {
      if (sdkState.kvsClient === null) {
        throw new Error('kvsClient double not initialized')
      }
      return sdkState.kvsClient.delete(key)
    },
    query() {
      if (sdkState.kvsClient === null) {
        throw new Error('kvsClient double not initialized')
      }
      return sdkState.kvsClient.query()
    },
  },
}))

vi.mock('@forge/api', () => ({
  default: {
    asUser() {
      sdkState.asUserCalls += 1
      return {
        requestJira(path: Route | string, init?: JiraRequestInit): Promise<JiraResponseLike> {
          if (sdkState.requestJira === null) {
            throw new Error('requestJira double not initialized')
          }
          return sdkState.requestJira(path, init)
        },
      }
    },
    asApp() {
      sdkState.asAppCalls += 1
      throw new Error('api.asApp() must not be called for user-scoped Jira operations')
    },
  },
  route(strings: TemplateStringsArray, ...values: unknown[]) {
    let built = ''
    for (let i = 0; i < strings.length; i += 1) {
      built += strings[i] ?? ''
      if (i < values.length) {
        built += encodeURIComponent(String(values[i]))
      }
    }
    return { value: built }
  },
}))

vi.mock('@forge/realtime', () => ({
  publish(channel: string, payload: PokerRealtimeEvent): Promise<unknown> {
    if (sdkState.publishRealtime === null) {
      throw new Error('publishRealtime double not initialized')
    }
    return sdkState.publishRealtime(channel, payload)
  },
}))

import { handler } from '../../src/index'
import { createJiraClient } from '../../src/jira/jira-client'
import { createRealtimePublisher } from '../../src/realtime/publisher'
import { RESOLVER_KEYS } from '../../src/resolvers/poker-resolvers'
import { createSessionStore } from '../../src/storage/session-store'
import {
  createFakeJiraDouble,
  createFakeRealtimeDouble,
  createInMemoryKvsDouble,
  makeHostContext,
} from '../helpers/forge-doubles'

describe('Forge SDK default wiring and src/index.ts entrypoint registration (R2, R10, R11, R14)', () => {
  beforeEach(() => {
    sdkState.asUserCalls = 0
    sdkState.asAppCalls = 0
    sdkState.kvsClient = createInMemoryKvsDouble().client
    sdkState.requestJira = createFakeJiraDouble().requestAsUser
    sdkState.publishRealtime = createFakeRealtimeDouble().publish
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('src/index.ts registers all 7 RESOLVER_KEYS on @forge/resolver and exports handler definitions', async () => {
    expect(handler).toBeDefined()
    expect(Array.from(sdkState.definedHandlers.keys()).sort()).toEqual(Object.values(RESOLVER_KEYS).sort())

    const castVoteFn = sdkState.definedHandlers.get('castVote')
    const revealVotesFn = sdkState.definedHandlers.get('revealVotes')
    const applyStoryPointsFn = sdkState.definedHandlers.get('applyStoryPoints')
    expect(castVoteFn).toBeTypeOf('function')
    expect(revealVotesFn).toBeTypeOf('function')
    expect(applyStoryPointsFn).toBeTypeOf('function')

    const ctx = makeHostContext('10001', '712020:alice')
    await castVoteFn?.({ context: ctx, payload: { card: '5' } })
    await revealVotesFn?.({ context: ctx })
    const result = await applyStoryPointsFn?.({ context: ctx, payload: { score: 5 } })

    expect(result).toMatchObject({
      ok: true,
      appliedScore: 5,
      fieldName: 'Story Points',
    })
    expect(sdkState.asUserCalls).toBeGreaterThanOrEqual(4)
    expect(sdkState.asAppCalls).toBe(0)
  })

  it('defaults createSessionStore, createJiraClient, and createRealtimePublisher to @forge/kvs, api.asUser(), and @forge/realtime', async () => {
    const kvsDouble = createInMemoryKvsDouble()
    const jiraDouble = createFakeJiraDouble()
    const realtimeDouble = createFakeRealtimeDouble()
    sdkState.kvsClient = kvsDouble.client
    sdkState.requestJira = jiraDouble.requestAsUser
    sdkState.publishRealtime = realtimeDouble.publish

    const store = createSessionStore()
    await store.setRoundMeta('10055', {
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 50_000,
    })
    expect(await store.getRoundMeta('10055')).toEqual({
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 50_000,
    })

    const jira = createJiraClient()
    const field = await jira.getEditableStoryPointsField('10055')
    expect(field).toEqual({ fieldId: 'customfield_10016', fieldName: 'Story Points' })
    expect(sdkState.asUserCalls).toBe(1)
    expect(sdkState.asAppCalls).toBe(0)

    const publisher = createRealtimePublisher()
    await publisher.publishSessionUpdated('round-1', 50_000)
    expect(realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 50_000 },
      },
    ])
  })
})
