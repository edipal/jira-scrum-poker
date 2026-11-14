import type { Route } from '@forge/api'
import { WhereConditions } from '@forge/kvs'
import type { RoundMeta, VoteRecord } from '../../src/domain/types'
import type { JiraRequestInit, JiraRequester, JiraResponseLike } from '../../src/jira/jira-client'
import type { LogSink, StructuredLogEntry } from '../../src/observability/logger'
import type { PokerRealtimeEvent, RealtimePublishFn } from '../../src/realtime/publisher'
import type { ForgeResolverContext } from '../../src/resolvers/poker-resolvers'
import {
  KVS_TTL_24H,
  type KvsBeginsWithCondition,
  type KvsClientLike,
  type KvsGetOptions,
  type KvsGetResult,
  type KvsListItem,
  type KvsListPage,
  type KvsQueryBuilderLike,
  type KvsSetOptions,
} from '../../src/storage/session-store'

const PROBE_TOKEN = '__LINTEL_BEGINS_WITH_PROBE__'

function findStringSlotPath(
  target: unknown,
  needle: string,
  currentPath: readonly (string | number)[] = [],
): readonly (string | number)[] | null {
  if (target === needle) {
    return currentPath
  }
  if (Array.isArray(target)) {
    for (let idx = 0; idx < target.length; idx += 1) {
      const found = findStringSlotPath(target[idx], needle, [...currentPath, idx])
      if (found !== null) {
        return found
      }
    }
    return null
  }
  if (target !== null && typeof target === 'object') {
    for (const [key, val] of Object.entries(target as Record<string, unknown>)) {
      const found = findStringSlotPath(val, needle, [...currentPath, key])
      if (found !== null) {
        return found
      }
    }
  }
  return null
}

function readSlotPath(target: unknown, slotPath: readonly (string | number)[]): unknown {
  let cursor: unknown = target
  for (const segment of slotPath) {
    if (cursor === null || typeof cursor !== 'object') {
      return undefined
    }
    if (Array.isArray(cursor) && typeof segment === 'number') {
      cursor = cursor[segment]
    } else if (!Array.isArray(cursor) && typeof segment === 'string') {
      cursor = (cursor as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cursor
}

const BEGINS_WITH_SLOT_PATH = findStringSlotPath(WhereConditions.beginsWith(PROBE_TOKEN), PROBE_TOKEN)

export function extractBeginsWithPrefix(condition: KvsBeginsWithCondition): string {
  if (BEGINS_WITH_SLOT_PATH !== null) {
    const candidate = readSlotPath(condition, BEGINS_WITH_SLOT_PATH)
    if (typeof candidate === 'string') {
      return candidate
    }
  }
  if (condition !== null && typeof condition === 'object') {
    const record = condition as unknown as Record<string, unknown>
    if (typeof record.value === 'string') {
      return record.value
    }
    if (Array.isArray(record.values) && typeof record.values[0] === 'string') {
      return record.values[0]
    }
    if (typeof record.prefix === 'string') {
      return record.prefix
    }
  }
  throw new Error(`Unable to extract beginsWith prefix from condition: ${JSON.stringify(condition)}`)
}

export interface KvsOperationRecord {
  readonly op: 'get' | 'set' | 'delete' | 'query'
  readonly key?: string
  readonly prefix?: string
  readonly limit?: number
  readonly cursor?: string
  readonly options?: KvsSetOptions
}

export interface InMemoryKvsDouble {
  readonly client: KvsClientLike
  readonly operations: KvsOperationRecord[]
  seedRaw(key: string, value: unknown, options?: KvsSetOptions): void
  seedRoundMeta(issueId: string, meta: RoundMeta): void
  seedVoteRecord(issueId: string, roundId: string, vote: VoteRecord): void
  deleteRaw(key: string): void
  readRaw(key: string): unknown
  hasKey(key: string): boolean
  keysWithPrefix(prefix: string): string[]
  getSetOptions(key: string): KvsSetOptions | undefined
  resetOperations(): void
}

function requestsExpireTime(options?: KvsGetOptions): boolean {
  return (
    Array.isArray(options?.metadataFields) && options.metadataFields.some((field) => String(field) === 'EXPIRE_TIME')
  )
}

export function createInMemoryKvsDouble(config?: { readonly maxPageSize?: number }): InMemoryKvsDouble {
  const store = new Map<string, { value: unknown; options: KvsSetOptions | undefined }>()
  const operations: KvsOperationRecord[] = []

  async function get<T = unknown>(key: string): Promise<T | undefined>
  async function get<T = unknown>(key: string, options: KvsGetOptions): Promise<T | KvsGetResult<T> | undefined>
  async function get<T = unknown>(key: string, options?: KvsGetOptions): Promise<T | KvsGetResult<T> | undefined> {
    operations.push({ op: 'get', key })
    const entry = store.get(key)
    if (entry === undefined) {
      return undefined
    }
    const cloned = structuredClone(entry.value) as T
    if (requestsExpireTime(options)) {
      return { key, value: cloned }
    }
    return cloned
  }

  const client: KvsClientLike = {
    get,

    async set<T = unknown>(key: string, value: T, options?: KvsSetOptions): Promise<void> {
      operations.push({ op: 'set', key, options })
      store.set(key, {
        value: structuredClone(value),
        options: options !== undefined ? structuredClone(options) : undefined,
      })
    },

    async delete(key: string): Promise<void> {
      operations.push({ op: 'delete', key })
      store.delete(key)
    },

    query(_options?: KvsGetOptions): KvsQueryBuilderLike {
      let queryPrefix: string | null = null
      let queryLimit = 10
      let queryCursor: string | undefined

      const builder: KvsQueryBuilderLike = {
        where(field: 'key', condition: KvsBeginsWithCondition): KvsQueryBuilderLike {
          if (field !== 'key') {
            throw new Error(`Unsupported where field: ${String(field)}`)
          }
          queryPrefix = extractBeginsWithPrefix(condition)
          return builder
        },

        limit(count: number): KvsQueryBuilderLike {
          queryLimit = count
          return builder
        },

        cursor(afterCursor: string): KvsQueryBuilderLike {
          queryCursor = afterCursor
          return builder
        },

        async getMany<T = unknown>(): Promise<KvsListPage<T>> {
          const activePrefix = queryPrefix ?? ''
          operations.push({
            op: 'query',
            prefix: activePrefix,
            limit: queryLimit,
            cursor: queryCursor,
          })

          const matchingKeys = Array.from(store.keys())
            .filter((k) => k.startsWith(activePrefix))
            .sort()

          const startOffset = queryCursor !== undefined ? Number.parseInt(queryCursor, 10) : 0
          const effectiveLimit =
            config?.maxPageSize !== undefined ? Math.min(queryLimit, config.maxPageSize) : queryLimit
          const endOffset = startOffset + effectiveLimit

          const sliceKeys = matchingKeys.slice(startOffset, endOffset)
          const results: KvsListItem<T>[] = sliceKeys.map((k) => {
            const entry = store.get(k)
            return {
              key: k,
              value: structuredClone(entry?.value) as T,
            }
          })

          const nextCursor = endOffset < matchingKeys.length ? String(endOffset) : undefined
          if (nextCursor !== undefined) {
            return { results, nextCursor }
          }
          return { results }
        },
      }

      return builder
    },
  }

  return {
    client,
    operations,
    seedRaw(key: string, value: unknown, options: KvsSetOptions = KVS_TTL_24H): void {
      store.set(key, { value: structuredClone(value), options: structuredClone(options) })
    },
    seedRoundMeta(issueId: string, meta: RoundMeta): void {
      store.set(`poker:${issueId}:meta`, {
        value: structuredClone(meta),
        options: structuredClone(KVS_TTL_24H),
      })
    },
    seedVoteRecord(issueId: string, roundId: string, vote: VoteRecord): void {
      store.set(`poker:${issueId}:${roundId}:vote:${vote.accountId}`, {
        value: structuredClone(vote),
        options: structuredClone(KVS_TTL_24H),
      })
    },
    deleteRaw(key: string): void {
      store.delete(key)
    },
    readRaw(key: string): unknown {
      const entry = store.get(key)
      return entry !== undefined ? structuredClone(entry.value) : undefined
    },
    hasKey(key: string): boolean {
      return store.has(key)
    },
    keysWithPrefix(prefix: string): string[] {
      return Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
    },
    getSetOptions(key: string): KvsSetOptions | undefined {
      const entry = store.get(key)
      return entry?.options !== undefined ? structuredClone(entry.options) : undefined
    },
    resetOperations(): void {
      operations.length = 0
    },
  }
}

export interface TtlAwareKvsDouble extends InMemoryKvsDouble {
  evictExpired(nowMs?: number): string[]
  evictKey(key: string): void
  getExpiresAt(key: string): number | null
}

function ttlOptionsToMs(options?: KvsSetOptions): number | null {
  const ttl = options?.ttl
  if (ttl === undefined) {
    return null
  }
  switch (ttl.unit) {
    case 'SECONDS':
      return ttl.value * 1_000
    case 'MINUTES':
      return ttl.value * 60_000
    case 'HOURS':
      return ttl.value * 3_600_000
    case 'DAYS':
      return ttl.value * 86_400_000
  }
}

export function createTtlAwareKvsDouble(config: {
  readonly now: () => number
  readonly autoEvictOnRead?: boolean
  readonly maxPageSize?: number
}): TtlAwareKvsDouble {
  const base = createInMemoryKvsDouble({ maxPageSize: config.maxPageSize })
  const autoEvict = config.autoEvictOnRead ?? true
  const expiresAtByKey = new Map<string, number | null>()

  function recordWriteTtl(key: string, options?: KvsSetOptions): void {
    const ttlMs = ttlOptionsToMs(options)
    expiresAtByKey.set(key, ttlMs !== null ? config.now() + ttlMs : null)
  }

  function evictKeySilently(key: string): void {
    expiresAtByKey.delete(key)
    base.deleteRaw(key)
  }

  function purgeExpiredSync(atMs: number): string[] {
    const evicted: string[] = []
    for (const [key, expiresAt] of Array.from(expiresAtByKey.entries())) {
      if (expiresAt !== null && atMs >= expiresAt) {
        evictKeySilently(key)
        evicted.push(key)
      }
    }
    return evicted
  }

  async function get<T = unknown>(key: string): Promise<T | undefined>
  async function get<T = unknown>(key: string, options: KvsGetOptions): Promise<T | KvsGetResult<T> | undefined>
  async function get<T = unknown>(key: string, options?: KvsGetOptions): Promise<T | KvsGetResult<T> | undefined> {
    if (autoEvict) {
      purgeExpiredSync(config.now())
    }
    const raw = await base.client.get<T>(key)
    if (raw === undefined) {
      return undefined
    }
    if (requestsExpireTime(options)) {
      const expiresAt = expiresAtByKey.get(key) ?? null
      if (expiresAt !== null) {
        return { key, value: raw, expireTime: new Date(expiresAt).toISOString() }
      }
      return { key, value: raw }
    }
    return raw
  }

  const client: KvsClientLike = {
    get,
    async set<T = unknown>(key: string, value: T, options?: KvsSetOptions): Promise<void> {
      recordWriteTtl(key, options)
      await base.client.set(key, value, options)
    },
    async delete(key: string): Promise<void> {
      expiresAtByKey.delete(key)
      await base.client.delete(key)
    },
    query(options?: KvsGetOptions): KvsQueryBuilderLike {
      const inner = base.client.query(options)
      const wrapper: KvsQueryBuilderLike = {
        where(field, condition) {
          inner.where(field, condition)
          return wrapper
        },
        limit(count) {
          inner.limit(count)
          return wrapper
        },
        cursor(afterCursor) {
          inner.cursor(afterCursor)
          return wrapper
        },
        async getMany<T = unknown>(): Promise<KvsListPage<T>> {
          if (autoEvict) {
            purgeExpiredSync(config.now())
          }
          const page = await inner.getMany<T>()
          if (!requestsExpireTime(options)) {
            return page
          }
          const results: KvsListItem<T>[] = page.results.map((item) => {
            const expiresAt = expiresAtByKey.get(item.key) ?? null
            if (expiresAt !== null) {
              return { ...item, expireTime: new Date(expiresAt).toISOString() }
            }
            return item
          })
          return page.nextCursor !== undefined ? { results, nextCursor: page.nextCursor } : { results }
        },
      }
      return wrapper
    },
  }

  return {
    ...base,
    client,
    seedRaw(key: string, value: unknown, options: KvsSetOptions = KVS_TTL_24H): void {
      recordWriteTtl(key, options)
      base.seedRaw(key, value, options)
    },
    seedRoundMeta(issueId: string, meta: RoundMeta): void {
      recordWriteTtl(`poker:${issueId}:meta`, KVS_TTL_24H)
      base.seedRoundMeta(issueId, meta)
    },
    seedVoteRecord(issueId: string, roundId: string, vote: VoteRecord): void {
      recordWriteTtl(`poker:${issueId}:${roundId}:vote:${vote.accountId}`, KVS_TTL_24H)
      base.seedVoteRecord(issueId, roundId, vote)
    },
    deleteRaw(key: string): void {
      evictKeySilently(key)
    },
    evictExpired(nowMs = config.now()): string[] {
      return purgeExpiredSync(nowMs)
    },
    evictKey(key: string): void {
      evictKeySilently(key)
    },
    getExpiresAt(key: string): number | null {
      return expiresAtByKey.get(key) ?? null
    },
  }
}

export function normalizeJiraRoutePath(path: Route | string): string {
  if (typeof path === 'string') {
    return path
  }
  if (path !== null && typeof path === 'object' && 'value' in path) {
    const rawValue = (path as { readonly value?: unknown }).value
    if (typeof rawValue === 'string') {
      return rawValue
    }
  }
  return String(path)
}

export function jsonJiraResponse(status: number, body: unknown): JiraResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json(): Promise<unknown> {
      return structuredClone(body)
    },
  }
}

export function malformedJsonJiraResponse(status: number): JiraResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json(): Promise<unknown> {
      throw new SyntaxError('Unexpected token < in JSON at position 0')
    },
  }
}

export interface RecordedJiraCall {
  readonly path: string
  readonly rawPath: Route | string
  readonly method: 'GET' | 'PUT'
  readonly headers: Readonly<Record<string, string>> | undefined
  readonly body: string | undefined
}

export interface FakeJiraRouterConfig {
  onMyself?: (init?: JiraRequestInit) => Promise<JiraResponseLike> | JiraResponseLike
  onEditMeta?: (issueId: string, init?: JiraRequestInit) => Promise<JiraResponseLike> | JiraResponseLike
  onPutIssue?: (
    issueId: string,
    parsedBody: unknown,
    init?: JiraRequestInit,
  ) => Promise<JiraResponseLike> | JiraResponseLike
}

export interface FakeJiraDouble {
  readonly requestAsUser: JiraRequester
  readonly calls: RecordedJiraCall[]
  resetCalls(): void
}

export const COMPANY_MANAGED_STORY_POINTS_EDITMETA = {
  fields: {
    customfield_10016: {
      name: 'Story Points',
      schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points' },
      operations: ['set'],
    },
  },
} as const

export function createFakeJiraDouble(config: FakeJiraRouterConfig = {}): FakeJiraDouble {
  const calls: RecordedJiraCall[] = []

  const requestAsUser: JiraRequester = async (path: Route | string, init?: JiraRequestInit) => {
    const normalizedPath = normalizeJiraRoutePath(path)
    const method = init?.method ?? 'GET'
    calls.push({
      path: normalizedPath,
      rawPath: path,
      method,
      headers: init?.headers,
      body: init?.body,
    })

    if (method === 'GET' && normalizedPath === '/rest/api/3/myself') {
      if (config.onMyself !== undefined) {
        return await config.onMyself(init)
      }
      return jsonJiraResponse(200, {
        accountId: 'default-account',
        displayName: 'Default Voter',
        emailAddress: 'default.voter@example.com',
        avatarUrls: {
          '24x24': 'https://avatar.atlassian.example/24',
        },
      })
    }

    const editMetaMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/editmeta$/.exec(normalizedPath)
    if (method === 'GET' && editMetaMatch !== null && editMetaMatch[1] !== undefined) {
      const issueId = decodeURIComponent(editMetaMatch[1])
      if (config.onEditMeta !== undefined) {
        return await config.onEditMeta(issueId, init)
      }
      return jsonJiraResponse(200, COMPANY_MANAGED_STORY_POINTS_EDITMETA)
    }

    const putIssueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(normalizedPath)
    if (method === 'PUT' && putIssueMatch !== null && putIssueMatch[1] !== undefined) {
      const issueId = decodeURIComponent(putIssueMatch[1])
      const parsedBody: unknown = init?.body !== undefined ? JSON.parse(init.body) : undefined
      if (config.onPutIssue !== undefined) {
        return await config.onPutIssue(issueId, parsedBody, init)
      }
      return jsonJiraResponse(204, {})
    }

    throw new Error(`Unexpected Jira request: ${method} ${normalizedPath}`)
  }

  return {
    requestAsUser,
    calls,
    resetCalls(): void {
      calls.length = 0
    },
  }
}

export interface RecordedRealtimePublish {
  readonly channel: string
  readonly payload: PokerRealtimeEvent
}

export interface FakeRealtimeDouble {
  readonly publish: RealtimePublishFn
  readonly events: RecordedRealtimePublish[]
  setFailure(error: Error | null): void
  resetEvents(): void
}

export function createFakeRealtimeDouble(): FakeRealtimeDouble {
  const events: RecordedRealtimePublish[] = []
  let activeFailure: Error | null = null

  const publish: RealtimePublishFn = async (channel: string, payload: PokerRealtimeEvent): Promise<void> => {
    if (activeFailure !== null) {
      throw activeFailure
    }
    events.push({
      channel,
      payload: structuredClone(payload),
    })
  }

  return {
    publish,
    events,
    setFailure(error: Error | null): void {
      activeFailure = error
    },
    resetEvents(): void {
      events.length = 0
    },
  }
}

export interface MemoryLogSinkDouble {
  readonly sink: LogSink
  readonly warnRaw: string[]
  readonly errorRaw: string[]
  parsedWarnEntries(): StructuredLogEntry[]
  parsedErrorEntries(): StructuredLogEntry[]
  allSerialized(): string
}

export function createMemoryLogSink(): MemoryLogSinkDouble {
  const warnRaw: string[] = []
  const errorRaw: string[] = []

  return {
    sink: {
      warn(serializedEntry: string): void {
        warnRaw.push(serializedEntry)
      },
      error(serializedEntry: string): void {
        errorRaw.push(serializedEntry)
      },
    },
    warnRaw,
    errorRaw,
    parsedWarnEntries(): StructuredLogEntry[] {
      return warnRaw.map((entry) => JSON.parse(entry) as StructuredLogEntry)
    },
    parsedErrorEntries(): StructuredLogEntry[] {
      return errorRaw.map((entry) => JSON.parse(entry) as StructuredLogEntry)
    },
    allSerialized(): string {
      return [...warnRaw, ...errorRaw].join('\n')
    },
  }
}

export function makeHostContext(
  issueId = '10001',
  accountId = '712020:alice-001',
  issueKey: string | undefined = 'SP-101',
): ForgeResolverContext {
  return {
    accountId,
    extension: {
      issue: issueKey !== undefined ? { id: issueId, key: issueKey } : { id: issueId },
    },
  }
}
