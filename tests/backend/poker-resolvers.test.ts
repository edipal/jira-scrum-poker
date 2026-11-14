import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIBONACCI_DECK, NUMERIC_FIBONACCI_SCORES } from '../../src/domain/deck'
import { SESSION_TTL_MS } from '../../src/domain/session-view'
import type { DeckCard, FibonacciScore, RoundMeta, VoteRecord } from '../../src/domain/types'
import { createJiraClient, type JiraClient } from '../../src/jira/jira-client'
import { createBackendLogger } from '../../src/observability/logger'
import { createRealtimePublisher } from '../../src/realtime/publisher'
import {
  createPokerResolverHandlers,
  extractAuthenticatedContext,
  type ForgeResolverRequest,
  RESOLVER_KEYS,
  type ResolverRegistryLike,
  registerPokerResolvers,
} from '../../src/resolvers/poker-resolvers'
import { createSessionStore, KVS_TTL_24H } from '../../src/storage/session-store'
import { expectAsyncPokerDomainError } from '../helpers/domain-errors'
import {
  COMPANY_MANAGED_STORY_POINTS_EDITMETA,
  createFakeJiraDouble,
  createFakeRealtimeDouble,
  createInMemoryKvsDouble,
  createMemoryLogSink,
  createTtlAwareKvsDouble,
  type FakeJiraRouterConfig,
  jsonJiraResponse,
  makeHostContext,
  malformedJsonJiraResponse,
} from '../helpers/forge-doubles'

class NonPlainPayload {
  readonly card = '5'
  readonly score = 5
}

interface SeedVoteEntry {
  readonly issueId?: string
  readonly roundId?: string
  readonly vote: VoteRecord
}

interface HarnessOptions {
  readonly initialNowMs?: number
  readonly seedMetas?: readonly { issueId: string; meta: RoundMeta }[]
  readonly seedVotes?: readonly SeedVoteEntry[]
  readonly jiraConfig?: FakeJiraRouterConfig
  readonly realtimeFailure?: Error | null
}

function createBackendTestHarness(options: HarnessOptions = {}) {
  let currentNowMs = options.initialNowMs ?? 10_000_000
  const kvsDouble = createInMemoryKvsDouble()
  const logDouble = createMemoryLogSink()
  const realtimeDouble = createFakeRealtimeDouble()
  const jiraDouble = createFakeJiraDouble(options.jiraConfig)

  if (options.seedMetas !== undefined) {
    for (const item of options.seedMetas) {
      kvsDouble.seedRoundMeta(item.issueId, item.meta)
    }
  }
  if (options.seedVotes !== undefined) {
    for (const entry of options.seedVotes) {
      kvsDouble.seedVoteRecord(entry.issueId ?? '10001', entry.roundId ?? 'round-1', entry.vote)
    }
  }
  if (options.realtimeFailure !== undefined) {
    realtimeDouble.setFailure(options.realtimeFailure)
  }

  const logger = createBackendLogger({
    sink: logDouble.sink,
    now: () => currentNowMs,
  })
  const store = createSessionStore(kvsDouble.client)
  const rawJira = createJiraClient({
    requestAsUser: jiraDouble.requestAsUser,
    logger,
  })

  const jiraCallCounts = {
    getCurrentUserProfile: 0,
    getEditableStoryPointsField: 0,
    updateStoryPoints: 0,
  }

  const jira: JiraClient = {
    async getCurrentUserProfile() {
      jiraCallCounts.getCurrentUserProfile += 1
      return await rawJira.getCurrentUserProfile()
    },
    async getEditableStoryPointsField(issueId: string) {
      jiraCallCounts.getEditableStoryPointsField += 1
      return await rawJira.getEditableStoryPointsField(issueId)
    },
    async updateStoryPoints(issueId: string, score: FibonacciScore) {
      jiraCallCounts.updateStoryPoints += 1
      return await rawJira.updateStoryPoints(issueId, score)
    },
  }

  const realtime = createRealtimePublisher({
    publish: realtimeDouble.publish,
    logger,
  })

  const handlers = createPokerResolverHandlers({
    store,
    jira,
    realtime,
    logger,
    now: () => currentNowMs,
  })

  return {
    handlers,
    store,
    jira,
    realtime,
    logger,
    kvsDouble,
    jiraDouble,
    jiraCallCounts,
    realtimeDouble,
    logDouble,
    getNowMs(): number {
      return currentNowMs
    },
    setNowMs(nextMs: number): void {
      currentNowMs = nextMs
    },
    advanceMs(deltaMs: number): void {
      currentNowMs += deltaMs
    },
    resetCounters(): void {
      kvsDouble.resetOperations()
      jiraDouble.resetCalls()
      realtimeDouble.resetEvents()
      jiraCallCounts.getCurrentUserProfile = 0
      jiraCallCounts.getEditableStoryPointsField = 0
      jiraCallCounts.updateStoryPoints = 0
    },
  }
}

describe('R1: Deck card and numeric Fibonacci score validation at resolver boundaries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(FIBONACCI_DECK)('castVote accepts canonical deck card "%s" and persists with 24h TTL', async (card) => {
    const harness = createBackendTestHarness()
    const snapshot = await harness.handlers.castVote({
      context: makeHostContext('10001', '712020:voter-1'),
      payload: { card },
    })

    expect(snapshot.status).toBe('voting')
    expect(snapshot.roundId).toBe('round-1')
    expect(snapshot.viewerCard).toBe(card)
    expect(snapshot.participants).toHaveLength(1)
    expect(snapshot.participants[0]?.card).toBeNull()
    expect(harness.kvsDouble.getSetOptions('poker:10001:round-1:vote:712020:voter-1')).toEqual(KVS_TTL_24H)
  })

  it('castVote accepts null-prototype plain object payloads', async () => {
    const harness = createBackendTestHarness()
    const payload = Object.create(null) as Record<string, unknown>
    payload.card = '5'

    const snapshot = await harness.handlers.castVote({
      context: makeHostContext('10001', '712020:voter-null-proto'),
      payload,
    })
    expect(snapshot.viewerCard).toBe('5')
  })

  it.each([
    { label: 'empty string', payload: { card: '' } },
    { label: 'spaces-only string', payload: { card: '   ' } },
    { label: 'leading whitespace (" 5")', payload: { card: ' 5' } },
    { label: 'trailing whitespace ("5 ")', payload: { card: '5 ' } },
    { label: 'surrounding whitespace (" 5 ")', payload: { card: ' 5 ' } },
    { label: 'negative string ("-1")', payload: { card: '-1' } },
    { label: 'decimal string ("3.5")', payload: { card: '3.5' } },
    { label: 'non-Fibonacci integer ("4")', payload: { card: '4' } },
    { label: 'non-Fibonacci integer ("6")', payload: { card: '6' } },
    { label: 'next Fibonacci outside deck ("34")', payload: { card: '34' } },
    { label: 'arbitrary word ("coffee")', payload: { card: 'coffee' } },
    { label: 'card null', payload: { card: null } },
    { label: 'card undefined', payload: { card: undefined } },
    { label: 'numeric 5 instead of string', payload: { card: 5 } },
    { label: 'empty object missing card', payload: {} },
    { label: 'missing payload (undefined)', payload: undefined },
    { label: 'null payload', payload: null },
    { label: 'array payload', payload: ['5'] },
    { label: 'primitive string payload', payload: '5' },
    { label: 'Date instance payload', payload: new Date() },
    { label: 'class instance payload', payload: new NonPlainPayload() },
  ])(
    'castVote rejects invalid input ($label) with validation-error before any KVS or Jira I/O',
    async ({ payload }) => {
      const harness = createBackendTestHarness()

      await expectAsyncPokerDomainError(
        () =>
          harness.handlers.castVote({
            context: makeHostContext('10001', '712020:voter-1'),
            payload,
          }),
        'validation-error',
      )

      expect(harness.kvsDouble.operations).toHaveLength(0)
      expect(harness.jiraDouble.calls).toHaveLength(0)
      expect(harness.realtimeDouble.events).toHaveLength(0)
    },
  )

  it.each(NUMERIC_FIBONACCI_SCORES)(
    'selectOverrideScore and applyStoryPoints accept numeric Fibonacci score %i on revealed round',
    async (score) => {
      const overrideHarness = createBackendTestHarness({
        seedMetas: [
          {
            issueId: '10001',
            meta: { roundId: 'round-1', status: 'revealed', overrideScore: null, updatedAt: 10_000_000 },
          },
        ],
        seedVotes: [
          {
            vote: {
              accountId: '712020:alice',
              displayName: 'Alice',
              avatarUrl: null,
              card: '5',
              votedAt: 9_999_000,
            },
          },
        ],
      })

      const overridden = await overrideHarness.handlers.selectOverrideScore({
        context: makeHostContext('10001', '712020:alice'),
        payload: { score },
      })
      expect(overridden.targetScore).toBe(score)
      expect(overridden.recommendedScore).toBe(5)

      const applyHarness = createBackendTestHarness({
        seedMetas: [
          {
            issueId: '10002',
            meta: { roundId: 'round-1', status: 'revealed', overrideScore: score, updatedAt: 10_000_000 },
          },
        ],
        seedVotes: [
          {
            issueId: '10002',
            vote: {
              accountId: '712020:alice',
              displayName: 'Alice',
              avatarUrl: null,
              card: '5',
              votedAt: 9_999_000,
            },
          },
        ],
      })

      const applied = await applyHarness.handlers.applyStoryPoints({
        context: makeHostContext('10002', '712020:alice'),
        payload: { score },
      })
      expect(applied).toMatchObject({
        ok: true,
        appliedScore: score,
        fieldName: 'Story Points',
      })
    },
  )

  it.each([
    { label: 'negative zero (-0)', payload: { score: -0 } },
    { label: 'negative integer (-1)', payload: { score: -1 } },
    { label: 'non-Fibonacci integer (4)', payload: { score: 4 } },
    { label: 'decimal (4.5)', payload: { score: 4.5 } },
    { label: 'above max deck score (22)', payload: { score: 22 } },
    { label: 'NaN', payload: { score: Number.NaN } },
    { label: 'positive Infinity', payload: { score: Number.POSITIVE_INFINITY } },
    { label: 'negative Infinity', payload: { score: Number.NEGATIVE_INFINITY } },
    { label: 'question mark ("?")', payload: { score: '?' } },
    { label: 'numeric string ("5")', payload: { score: '5' } },
    { label: 'numeric string ("0")', payload: { score: '0' } },
    { label: 'score null', payload: { score: null } },
    { label: 'score undefined', payload: { score: undefined } },
    { label: 'empty payload object', payload: {} },
    { label: 'missing payload', payload: undefined },
    { label: 'null payload', payload: null },
    { label: 'array payload', payload: [5] },
    { label: 'class instance payload', payload: new NonPlainPayload() },
  ])(
    'selectOverrideScore and applyStoryPoints reject invalid score ($label) with validation-error, zero Jira/KVS calls, and intact state',
    async ({ payload }) => {
      const initialMeta: RoundMeta = {
        roundId: 'round-1',
        status: 'revealed',
        overrideScore: 8,
        updatedAt: 10_000_000,
      }
      const initialVote: VoteRecord = {
        accountId: '712020:alice',
        displayName: 'Alice',
        avatarUrl: null,
        card: '5',
        votedAt: 9_999_000,
      }

      const harness = createBackendTestHarness({
        seedMetas: [{ issueId: '10001', meta: initialMeta }],
        seedVotes: [{ issueId: '10001', roundId: 'round-1', vote: initialVote }],
      })

      await expectAsyncPokerDomainError(
        () =>
          harness.handlers.selectOverrideScore({
            context: makeHostContext('10001', '712020:alice'),
            payload,
          }),
        'validation-error',
      )
      await expectAsyncPokerDomainError(
        () =>
          harness.handlers.applyStoryPoints({
            context: makeHostContext('10001', '712020:alice'),
            payload,
          }),
        'validation-error',
      )

      expect(harness.kvsDouble.operations).toHaveLength(0)
      expect(harness.jiraDouble.calls).toHaveLength(0)
      expect(harness.realtimeDouble.events).toHaveLength(0)
      expect(harness.kvsDouble.readRaw('poker:10001:meta')).toEqual(initialMeta)
      expect(harness.kvsDouble.readRaw('poker:10001:round-1:vote:712020:alice')).toEqual(initialVote)
    },
  )
})

describe('R2: Authenticated host context isolation, spoofing defense, and idle uninitialized snapshots', () => {
  it('validates extractAuthenticatedContext including colon-delimited Atlassian accountIds and issueKey normalization', () => {
    expect(
      extractAuthenticatedContext({
        accountId: '712020:98765432-abcd-ef01-2345-6789abcdef01',
        extension: { issue: { id: '10099', key: '  SP-99  ' } },
      }),
    ).toEqual({
      issueId: '10099',
      issueKey: 'SP-99',
      accountId: '712020:98765432-abcd-ef01-2345-6789abcdef01',
    })

    const nullProtoCtx = Object.create(null) as Record<string, unknown>
    nullProtoCtx.accountId = '557058:user-1'
    nullProtoCtx.extension = { issue: { id: '10100', key: '   ' } }
    expect(extractAuthenticatedContext(nullProtoCtx)).toEqual({
      issueId: '10100',
      issueKey: null,
      accountId: '557058:user-1',
    })
  })

  it.each([
    { label: 'undefined context', context: undefined },
    { label: 'null context', context: null },
    { label: 'array context', context: [] },
    { label: 'Date context', context: new Date() },
    { label: 'missing accountId', context: { extension: { issue: { id: '10001' } } } },
    { label: 'blank accountId', context: { accountId: '   ', extension: { issue: { id: '10001' } } } },
    { label: 'whitespace-padded accountId', context: { accountId: ' acc-1', extension: { issue: { id: '10001' } } } },
    {
      label: 'overlong 129-char accountId',
      context: { accountId: 'a'.repeat(129), extension: { issue: { id: '10001' } } },
    },
    { label: 'slash in accountId', context: { accountId: 'acc/1', extension: { issue: { id: '10001' } } } },
    { label: 'backslash in accountId', context: { accountId: 'acc\\1', extension: { issue: { id: '10001' } } } },
    { label: 'missing extension', context: { accountId: '712020:u1' } },
    { label: 'missing issue.id', context: { accountId: '712020:u1', extension: { issue: {} } } },
    { label: 'numeric issue.id', context: { accountId: '712020:u1', extension: { issue: { id: 10001 } } } },
    { label: 'blank issue.id', context: { accountId: '712020:u1', extension: { issue: { id: '' } } } },
    {
      label: 'whitespace-padded issue.id',
      context: { accountId: '712020:u1', extension: { issue: { id: '10001 ' } } },
    },
    {
      label: 'overlong 129-char issue.id',
      context: { accountId: '712020:u1', extension: { issue: { id: '1'.repeat(129) } } },
    },
    {
      label: 'path traversal slash in issue.id',
      context: { accountId: '712020:u1', extension: { issue: { id: '../10002' } } },
    },
    {
      label: 'null byte in issue.id',
      context: { accountId: '712020:u1', extension: { issue: { id: '100\x0001' } } },
    },
  ])(
    'all 7 resolver handlers reject invalid host context ($label) with validation-error and zero KVS or Jira I/O',
    async ({ context }) => {
      const harness = createBackendTestHarness()
      const badCtx = context as ForgeResolverRequest['context']

      await expectAsyncPokerDomainError(() => harness.handlers.getSession({ context: badCtx }), 'validation-error')
      await expectAsyncPokerDomainError(
        () => harness.handlers.castVote({ context: badCtx, payload: { card: '5' } }),
        'validation-error',
      )
      await expectAsyncPokerDomainError(() => harness.handlers.withdrawVote({ context: badCtx }), 'validation-error')
      await expectAsyncPokerDomainError(() => harness.handlers.revealVotes({ context: badCtx }), 'validation-error')
      await expectAsyncPokerDomainError(
        () => harness.handlers.selectOverrideScore({ context: badCtx, payload: { score: 5 } }),
        'validation-error',
      )
      await expectAsyncPokerDomainError(() => harness.handlers.resetRound({ context: badCtx }), 'validation-error')
      await expectAsyncPokerDomainError(
        () => harness.handlers.applyStoryPoints({ context: badCtx, payload: { score: 5 } }),
        'validation-error',
      )

      expect(harness.kvsDouble.operations).toHaveLength(0)
      expect(harness.jiraDouble.calls).toHaveLength(0)
      expect(harness.realtimeDouble.events).toHaveLength(0)
    },
  )

  it('returns an idle voting snapshot with 0 participants and null card/score fields on uninitialized issues with zero KVS writes', async () => {
    const harness = createBackendTestHarness()
    const snapshot = await harness.handlers.getSession({
      context: makeHostContext('20001', '712020:viewer-1'),
    })

    expect(snapshot).toEqual({
      roundId: null,
      status: 'voting',
      participants: [],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: {
        fieldId: 'customfield_10016',
        fieldName: 'Story Points',
      },
    })
    expect(harness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)
  })

  it('scopes all 7 handlers strictly to context.extension.issue.id and context.accountId while ignoring spoofed payload fields across Issue A vs Issue B', async () => {
    const harness = createBackendTestHarness()
    const ctxIssueA = makeHostContext('issue-A', '712020:alice', 'SP-1')
    const ctxIssueB = makeHostContext('issue-B', '712020:bob', 'SP-2')

    // Cast vote on Issue A
    await harness.handlers.castVote({
      context: ctxIssueA,
      payload: { card: '13' },
    })

    // 1. getSession on Issue B ignores spoofed Issue A / Alice in payload
    const sessionBInitial = await harness.handlers.getSession({
      context: ctxIssueB,
      payload: { issueId: 'issue-A', issueKey: 'SP-1', accountId: '712020:alice' },
    })
    expect(sessionBInitial.participants).toHaveLength(0)
    expect(sessionBInitial.viewerCard).toBeNull()

    // 2. castVote on Issue B with spoofed Issue A / Alice records under Issue B / Bob
    const sessionBAfterVote = await harness.handlers.castVote({
      context: ctxIssueB,
      payload: { card: '3', issueId: 'issue-A', accountId: '712020:alice' },
    })
    expect(sessionBAfterVote.viewerCard).toBe('3')
    expect(sessionBAfterVote.participants.map((p) => p.accountId)).toEqual(['712020:bob'])

    // 3. withdrawVote on Issue B with spoofed Issue A leaves Alice's vote on Issue A untouched
    await harness.handlers.withdrawVote({
      context: ctxIssueB,
      payload: { issueId: 'issue-A', accountId: '712020:alice' },
    })
    const checkIssueA = await harness.handlers.getSession({ context: ctxIssueA })
    expect(checkIssueA.viewerCard).toBe('13')
    expect(checkIssueA.participants).toHaveLength(1)

    // Re-cast on Issue B, then test revealVotes, selectOverrideScore, applyStoryPoints, and resetRound with spoofed payloads
    await harness.handlers.castVote({
      context: ctxIssueB,
      payload: { card: '5', issueId: 'issue-A', accountId: '712020:alice' },
    })
    const revealedB = await harness.handlers.revealVotes({
      context: ctxIssueB,
      payload: { issueId: 'issue-A', accountId: '712020:alice' },
    })
    expect(revealedB.status).toBe('revealed')
    expect(revealedB.recommendedScore).toBe(5)

    const overriddenB = await harness.handlers.selectOverrideScore({
      context: ctxIssueB,
      payload: { score: 8, issueId: 'issue-A', accountId: '712020:alice' },
    })
    expect(overriddenB.targetScore).toBe(8)

    const appliedB = await harness.handlers.applyStoryPoints({
      context: ctxIssueB,
      payload: { score: 8, issueId: 'issue-A', accountId: '712020:alice' },
    })
    expect(appliedB.ok).toBe(true)
    expect(harness.jiraDouble.calls.some((c) => c.method === 'PUT' && c.path === '/rest/api/3/issue/issue-B')).toBe(
      true,
    )
    expect(harness.jiraDouble.calls.some((c) => c.method === 'PUT' && c.path === '/rest/api/3/issue/issue-A')).toBe(
      false,
    )

    await harness.handlers.resetRound({
      context: ctxIssueB,
      payload: { issueId: 'issue-A', accountId: '712020:alice' },
    })

    // Issue A must remain in 'voting' with Alice's '13' completely intact
    const finalIssueA = await harness.handlers.getSession({ context: ctxIssueA })
    expect(finalIssueA.status).toBe('voting')
    expect(finalIssueA.viewerCard).toBe('13')
    expect(finalIssueA.participants).toHaveLength(1)
  })

  it('registers all 7 RESOLVER_KEYS via registerPokerResolvers and returns the resolver instance', () => {
    expect(Object.keys(RESOLVER_KEYS).sort()).toEqual([
      'applyStoryPoints',
      'castVote',
      'getSession',
      'resetRound',
      'revealVotes',
      'selectOverrideScore',
      'withdrawVote',
    ])

    const defined = new Map<string, (req: ForgeResolverRequest) => Promise<unknown>>()
    const fakeRegistry: ResolverRegistryLike = {
      define(key, cb) {
        defined.set(key, cb)
        return fakeRegistry
      },
    }

    const harness = createBackendTestHarness()
    const returned = registerPokerResolvers(fakeRegistry, {
      store: harness.store,
      jira: harness.jira,
      realtime: harness.realtime,
      logger: harness.logger,
      now: harness.getNowMs,
    })

    expect(returned).toBe(fakeRegistry)
    expect(Array.from(defined.keys()).sort()).toEqual(Object.values(RESOLVER_KEYS).sort())
  })
})

describe('R3: Voting, updating, withdrawing, toggle-off, individual vote expiry, and revealed-round rejection', () => {
  it('records an initial vote, updates card (5 -> 8), removes via withdrawVote, and toggles off same active card with zero profile fetches', async () => {
    const harness = createBackendTestHarness()
    const ctx = makeHostContext('10001', '712020:alice')

    // 1. Initial vote '5'
    const s1 = await harness.handlers.castVote({ context: ctx, payload: { card: '5' } })
    expect(s1.status).toBe('voting')
    expect(s1.participants).toHaveLength(1)
    expect(s1.viewerCard).toBe('5')
    expect(harness.kvsDouble.getSetOptions('poker:10001:meta')).toEqual(KVS_TTL_24H)
    expect(harness.kvsDouble.getSetOptions('poker:10001:round-1:vote:712020:alice')).toEqual(KVS_TTL_24H)

    // 2. Update vote '5' -> '8' keeping 1 participant and reusing stored profile (zero /myself calls)
    harness.advanceMs(5_000)
    harness.resetCounters()
    const s2 = await harness.handlers.castVote({ context: ctx, payload: { card: '8' } })
    expect(s2.participants).toHaveLength(1)
    expect(s2.viewerCard).toBe('8')
    expect(harness.jiraCallCounts.getCurrentUserProfile).toBe(0)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)

    // 3. Toggle off by re-selecting active card '8' (zero getCurrentUserProfile calls on toggle-off)
    harness.advanceMs(5_000)
    harness.resetCounters()
    const s3 = await harness.handlers.castVote({ context: ctx, payload: { card: '8' } })
    expect(s3.status).toBe('voting')
    expect(s3.participants).toHaveLength(0)
    expect(s3.viewerCard).toBeNull()
    expect(harness.jiraCallCounts.getCurrentUserProfile).toBe(0)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)
    expect(harness.realtimeDouble.events).toHaveLength(1)

    // 4. Cast '3' and remove via explicit withdrawVote
    harness.advanceMs(5_000)
    await harness.handlers.castVote({ context: ctx, payload: { card: '3' } })
    harness.advanceMs(5_000)
    const s4 = await harness.handlers.withdrawVote({ context: ctx })
    expect(s4.status).toBe('voting')
    expect(s4.participants).toHaveLength(0)
    expect(s4.viewerCard).toBeNull()
  })

  it('treats stored voter record as active only when !isRoundExpired(vote.votedAt, nowMs) in castVote and withdrawVote', async () => {
    const nowMs = 100_000_000
    // Round meta is active (Peer Bob voted 1s ago), while Alice's stored vote '5' expired exactly at 86_400_000 ms
    const harness = createBackendTestHarness({
      initialNowMs: nowMs,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: nowMs - 1_000 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:alice',
            displayName: 'Alice',
            avatarUrl: null,
            card: '5',
            votedAt: nowMs - SESSION_TTL_MS, // expired!
          },
        },
        {
          vote: {
            accountId: '712020:bob',
            displayName: 'Bob',
            avatarUrl: null,
            card: '8',
            votedAt: nowMs - 1_000, // active
          },
        },
      ],
    })

    // 1. withdrawVote by unvoted User C or expired-vote User Alice is idempotent without mutating meta, deleting keys, or publishing realtime
    for (const callerId of ['712020:charlie-unvoted', '712020:alice']) {
      harness.resetCounters()
      const snap = await harness.handlers.withdrawVote({
        context: makeHostContext('10001', callerId),
      })
      expect(snap.viewerCard).toBeNull()
      expect(snap.participants.map((p) => p.accountId)).toEqual(['712020:bob'])
      expect(harness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)
      expect(harness.realtimeDouble.events).toHaveLength(0)
      expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)
    }

    // 2. castVote('5') by Alice overwrites her expired '5' record rather than toggling off!
    const afterOverwrite = await harness.handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '5' },
    })
    expect(afterOverwrite.viewerCard).toBe('5')
    expect(afterOverwrite.participants.map((p) => p.accountId)).toEqual(['712020:bob', '712020:alice'])

    // 3. withdrawVote on idle or expired round is idempotent with zero KVS writes and zero realtime events
    const idleHarness = createBackendTestHarness({ initialNowMs: nowMs })
    const idleWithdraw = await idleHarness.handlers.withdrawVote({
      context: makeHostContext('99999', '712020:alice'),
    })
    expect(idleWithdraw.roundId).toBeNull()
    expect(idleWithdraw.participants).toHaveLength(0)
    expect(idleHarness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)
    expect(idleHarness.realtimeDouble.events).toHaveLength(0)
  })

  it('rejects castVote and withdrawVote during an active revealed round with invalid-state and zero Jira calls', async () => {
    const harness = createBackendTestHarness({
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'revealed', overrideScore: null, updatedAt: 10_000_000 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:alice',
            displayName: 'Alice',
            avatarUrl: null,
            card: '5',
            votedAt: 9_999_000,
          },
        },
      ],
    })

    await expectAsyncPokerDomainError(
      () =>
        harness.handlers.castVote({
          context: makeHostContext('10001', '712020:bob'),
          payload: { card: '8' },
        }),
      'invalid-state',
    )
    await expectAsyncPokerDomainError(
      () =>
        harness.handlers.withdrawVote({
          context: makeHostContext('10001', '712020:alice'),
        }),
      'invalid-state',
    )

    expect(harness.jiraDouble.calls).toHaveLength(0)
    expect(harness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)
    expect(harness.realtimeDouble.events).toHaveLength(0)
  })
})

describe('R4: Concurrent Promise.all voting isolation and >100-voter KVS cursor pagination', () => {
  const FIVE_CONCURRENT_VOTES: readonly { accountId: string; card: DeckCard }[] = [
    { accountId: '712020:v1', card: '1' },
    { accountId: '712020:v2', card: '2' },
    { accountId: '712020:v3', card: '5' },
    { accountId: '712020:v4', card: '8' },
    { accountId: '712020:v5', card: '?' },
  ]

  it('persists 5 simultaneous Promise.all votes on an active voting round with zero lost updates', async () => {
    const harness = createBackendTestHarness({
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: 10_000_000 },
        },
      ],
    })

    await Promise.all(
      FIVE_CONCURRENT_VOTES.map(({ accountId, card }) =>
        harness.handlers.castVote({
          context: makeHostContext('10001', accountId),
          payload: { card },
        }),
      ),
    )

    const revealed = await harness.handlers.revealVotes({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(revealed.participants).toHaveLength(5)
    expect(revealed.participants.map((p) => ({ accountId: p.accountId, card: p.card }))).toEqual(FIVE_CONCURRENT_VOTES)
  })

  it('persists 5 simultaneous Promise.all first votes on an idle issue and on an expired round via deterministic nextRoundId', async () => {
    // Case A: Idle issue (null -> 'round-1')
    const idleHarness = createBackendTestHarness()
    await Promise.all(
      FIVE_CONCURRENT_VOTES.map(({ accountId, card }) =>
        idleHarness.handlers.castVote({
          context: makeHostContext('10001', accountId),
          payload: { card },
        }),
      ),
    )
    const idleSession = await idleHarness.handlers.getSession({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(idleSession.roundId).toBe('round-1')
    expect(idleSession.participants).toHaveLength(5)

    // Case B: Expired round ('round-4' -> 'round-5') discarding stale round-4 votes
    const nowMs = 100_000_000
    const expiredHarness = createBackendTestHarness({
      initialNowMs: nowMs,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-4', status: 'revealed', overrideScore: 13, updatedAt: nowMs - SESSION_TTL_MS },
        },
      ],
      seedVotes: [
        {
          roundId: 'round-4',
          vote: {
            accountId: '712020:stale-voter',
            displayName: 'Stale Voter',
            avatarUrl: null,
            card: '21',
            votedAt: nowMs - SESSION_TTL_MS,
          },
        },
      ],
    })

    await Promise.all(
      FIVE_CONCURRENT_VOTES.map(({ accountId, card }) =>
        expiredHarness.handlers.castVote({
          context: makeHostContext('10001', accountId),
          payload: { card },
        }),
      ),
    )

    const freshSession = await expiredHarness.handlers.getSession({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(freshSession.roundId).toBe('round-5')
    expect(freshSession.participants).toHaveLength(5)
    expect(expiredHarness.kvsDouble.keysWithPrefix('poker:10001:round-4:vote:')).toHaveLength(0)
  })

  it('persists concurrent peer vote update (3 -> 5), withdrawal, and new vote (13) without lost updates', async () => {
    const harness = createBackendTestHarness({
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: 10_000_000 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:user-a',
            displayName: 'User A',
            avatarUrl: null,
            card: '3',
            votedAt: 9_998_000,
          },
        },
        {
          vote: {
            accountId: '712020:user-b',
            displayName: 'User B',
            avatarUrl: null,
            card: '8',
            votedAt: 9_999_000,
          },
        },
      ],
    })

    await Promise.all([
      harness.handlers.castVote({
        context: makeHostContext('10001', '712020:user-a'),
        payload: { card: '5' },
      }),
      harness.handlers.withdrawVote({
        context: makeHostContext('10001', '712020:user-b'),
      }),
      harness.handlers.castVote({
        context: makeHostContext('10001', '712020:user-c'),
        payload: { card: '13' },
      }),
    ])

    const revealed = await harness.handlers.revealVotes({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(revealed.participants.map((p) => ({ accountId: p.accountId, card: p.card }))).toEqual([
      { accountId: '712020:user-a', card: '5' },
      { accountId: '712020:user-c', card: '13' },
    ])
  })

  it('retrieves 100% of 125 voters across KVS cursor pages on getSession/revealVotes and deletes 100% on resetRound and applyStoryPoints', async () => {
    const nowMs = 20_000_000
    const votes125: SeedVoteEntry[] = Array.from({ length: 125 }, (_, index) => {
      const n = index + 1
      const id = String(n).padStart(3, '0')
      return {
        issueId: '10001',
        roundId: 'round-1',
        vote: {
          accountId: `712020:member-${id}`,
          displayName: `Member ${id}`,
          avatarUrl: null,
          card: '5',
          votedAt: nowMs - 5_000 + n,
        },
      }
    })

    // 1. getSession + revealVotes + resetRound on 125 voters
    const resetHarness = createBackendTestHarness({
      initialNowMs: nowMs,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: nowMs - 100 },
        },
      ],
      seedVotes: votes125,
    })

    const votingSnap = await resetHarness.handlers.getSession({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(votingSnap.participants).toHaveLength(125)

    const revealedSnap = await resetHarness.handlers.revealVotes({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(revealedSnap.participants).toHaveLength(125)
    expect(revealedSnap.average).toBe(5)
    expect(revealedSnap.recommendedScore).toBe(5)

    const afterReset = await resetHarness.handlers.resetRound({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(afterReset.roundId).toBe('round-2')
    expect(afterReset.participants).toHaveLength(0)
    expect(resetHarness.kvsDouble.keysWithPrefix('poker:10001:round-1:vote:')).toHaveLength(0)

    // 2. applyStoryPoints cleanup across 125 voters
    const applyHarness = createBackendTestHarness({
      initialNowMs: nowMs,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'revealed', overrideScore: null, updatedAt: nowMs - 100 },
        },
      ],
      seedVotes: votes125,
    })

    const applyResult = await applyHarness.handlers.applyStoryPoints({
      context: makeHostContext('10001', '712020:member-001'),
      payload: { score: 5 },
    })
    expect(applyResult.ok).toBe(true)
    expect(applyHarness.kvsDouble.keysWithPrefix('poker:10001:round-1:vote:')).toHaveLength(0)
  })
})

describe('R5: Voter-only projection, deterministic ordering, Unknown User fallback, vote secrecy, and realtime PII omission', () => {
  it('orders active voters by votedAt then accountId, redacts peer cards during voting, exposes viewerCard only to voter, and omits cards/PII from realtime', async () => {
    const nowMs = 50_000_000
    const harness = createBackendTestHarness({
      initialNowMs: nowMs,
      jiraConfig: {
        onMyself: () =>
          jsonJiraResponse(200, {
            displayName: '   ',
            emailAddress: 'secret.email@acme.example',
            avatarUrls: {},
          }),
      },
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: nowMs - 500 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:acc-z',
            displayName: 'Zara',
            avatarUrl: null,
            card: '13',
            votedAt: 1_000,
          },
        },
        {
          vote: {
            accountId: '712020:acc-a',
            displayName: 'Alice',
            avatarUrl: 'https://avatar.example/a.png',
            card: '3',
            votedAt: 1_000,
          },
        },
      ],
    })

    // Third voter casts '21' at nowMs with blank /rest/api/3/myself displayName -> 'Unknown User'
    const charlieSnap = await harness.handlers.castVote({
      context: makeHostContext('10001', '712020:acc-c'),
      payload: { card: '21' },
    })
    expect(charlieSnap.viewerCard).toBe('21')
    expect(
      charlieSnap.participants.map((p) => ({ accountId: p.accountId, name: p.displayName, card: p.card })),
    ).toEqual([
      { accountId: '712020:acc-a', name: 'Alice', card: null },
      { accountId: '712020:acc-z', name: 'Zara', card: null },
      { accountId: '712020:acc-c', name: 'Unknown User', card: null },
    ])

    // Alice sees viewerCard = '3', while all participants[i].card remain null (never exposing '13' or '21')
    const aliceSnap = await harness.handlers.getSession({
      context: makeHostContext('10001', '712020:acc-a'),
    })
    expect(aliceSnap.viewerCard).toBe('3')
    expect(aliceSnap.participants.every((p) => p.card === null)).toBe(true)

    // Non-voting observer is absent from participants and sees zero card values anywhere in serialized snapshot
    const observerSnap = await harness.handlers.getSession({
      context: makeHostContext('10001', '712020:observer'),
    })
    expect(observerSnap.viewerCard).toBeNull()
    expect(observerSnap.participants).toHaveLength(3)
    const serializedObserver = JSON.stringify(observerSnap)
    expect(serializedObserver).not.toContain('"13"')
    expect(serializedObserver).not.toContain('"21"')
    expect(serializedObserver).not.toContain('"3"')
    expect(serializedObserver).not.toContain('secret.email@acme.example')

    // Realtime payload contains zero card values or PII
    expect(harness.realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: {
          type: 'SESSION_UPDATED',
          roundId: 'round-1',
          updatedAt: nowMs,
        },
      },
    ])
    expect(JSON.stringify(harness.realtimeDouble.events)).not.toContain('secret.email@acme.example')
    expect(JSON.stringify(harness.realtimeDouble.events)).not.toContain('"21"')
  })
})

describe('R6: Open democratic revealVotes transition, 0-vote/idle/reset rejection, and idempotent repeat reveal', () => {
  it('allows a non-voting observer to reveal votes, computing average/recommendedScore/targetScore and publishing SESSION_UPDATED', async () => {
    const harness = createBackendTestHarness({
      initialNowMs: 20_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: 19_990_000 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:alice',
            displayName: 'Alice',
            avatarUrl: null,
            card: '3',
            votedAt: 19_991_000,
          },
        },
        {
          vote: {
            accountId: '712020:bob',
            displayName: 'Bob',
            avatarUrl: null,
            card: '5',
            votedAt: 19_992_000,
          },
        },
        {
          vote: {
            accountId: '712020:charlie',
            displayName: 'Charlie',
            avatarUrl: null,
            card: '?',
            votedAt: 19_993_000,
          },
        },
      ],
    })

    const revealed = await harness.handlers.revealVotes({
      context: makeHostContext('10001', '712020:non-voting-observer'),
    })

    expect(revealed.status).toBe('revealed')
    expect(revealed.participants.map((p) => ({ accountId: p.accountId, card: p.card }))).toEqual([
      { accountId: '712020:alice', card: '3' },
      { accountId: '712020:bob', card: '5' },
      { accountId: '712020:charlie', card: '?' },
    ])
    expect(revealed.average).toBe(4)
    expect(revealed.formattedAverage).toBe('4')
    expect(revealed.recommendedScore).toBe(5)
    expect(revealed.targetScore).toBe(5)
    expect(harness.kvsDouble.readRaw('poker:10001:meta')).toEqual({
      roundId: 'round-1',
      status: 'revealed',
      overrideScore: null,
      updatedAt: 20_000_000,
    })
    expect(harness.realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 20_000_000 },
      },
    ])
  })

  it('rejects revealVotes on idle, 0-vote voting, reset, and all-votes-expired rounds with precondition-failed and zero Jira calls', async () => {
    const nowMs = 100_000_000

    // 1. Idle uninitialized issue
    const idleHarness = createBackendTestHarness({ initialNowMs: nowMs })
    await expectAsyncPokerDomainError(
      () => idleHarness.handlers.revealVotes({ context: makeHostContext('10001', '712020:u1') }),
      'precondition-failed',
    )
    expect(idleHarness.jiraDouble.calls).toHaveLength(0)

    // 2. Active voting round with 0 votes (or after resetRound)
    const zeroVotesHarness = createBackendTestHarness({
      initialNowMs: nowMs,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-2', status: 'voting', overrideScore: null, updatedAt: nowMs - 1_000 },
        },
      ],
    })
    await expectAsyncPokerDomainError(
      () => zeroVotesHarness.handlers.revealVotes({ context: makeHostContext('10001', '712020:u1') }),
      'precondition-failed',
    )
    expect(zeroVotesHarness.jiraDouble.calls).toHaveLength(0)

    // 3. Active voting round whose only stored vote record has expired (votedAt <= nowMs - 86_400_000)
    const expiredVoteOnlyHarness = createBackendTestHarness({
      initialNowMs: nowMs,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: nowMs - 1_000 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:stale',
            displayName: 'Stale',
            avatarUrl: null,
            card: '5',
            votedAt: nowMs - SESSION_TTL_MS,
          },
        },
      ],
    })
    await expectAsyncPokerDomainError(
      () => expiredVoteOnlyHarness.handlers.revealVotes({ context: makeHostContext('10001', '712020:u1') }),
      'precondition-failed',
    )
    expect(expiredVoteOnlyHarness.jiraDouble.calls).toHaveLength(0)
  })

  it('handles repeat/concurrent revealVotes on an active revealed round idempotently while preserving targetScore override and making zero KVS writes', async () => {
    const harness = createBackendTestHarness({
      initialNowMs: 30_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'revealed', overrideScore: 13, updatedAt: 29_995_000 },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:alice',
            displayName: 'Alice',
            avatarUrl: null,
            card: '5',
            votedAt: 29_990_000,
          },
        },
      ],
    })

    const [r1, r2] = await Promise.all([
      harness.handlers.revealVotes({ context: makeHostContext('10001', '712020:alice') }),
      harness.handlers.revealVotes({ context: makeHostContext('10001', '712020:bob') }),
    ])

    expect(r1.status).toBe('revealed')
    expect(r1.recommendedScore).toBe(5)
    expect(r1.targetScore).toBe(13)
    expect(r2.targetScore).toBe(13)
    expect(harness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)
    expect(harness.realtimeDouble.events).toHaveLength(0)
  })
})

describe('R8: Post-reveal consensus override via selectOverrideScore', () => {
  it('allows any viewer to override targetScore on numeric and all-"?" revealed rounds while preserving votes and recommendedScore', async () => {
    // 1. Numeric votes ['3', '8'] -> average = 5.5, recommendedScore = 5, overridden to 8 by non-voting observer
    const numericHarness = createBackendTestHarness({
      initialNowMs: 40_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'revealed', overrideScore: null, updatedAt: 39_990_000 },
        },
      ],
      seedVotes: [
        {
          vote: { accountId: '712020:a', displayName: 'A', avatarUrl: null, card: '3', votedAt: 39_980_000 },
        },
        {
          vote: { accountId: '712020:b', displayName: 'B', avatarUrl: null, card: '8', votedAt: 39_985_000 },
        },
      ],
    })

    const updatedNumeric = await numericHarness.handlers.selectOverrideScore({
      context: makeHostContext('10001', '712020:observer'),
      payload: { score: 8 },
    })
    expect(updatedNumeric.targetScore).toBe(8)
    expect(updatedNumeric.recommendedScore).toBe(5)
    expect(updatedNumeric.average).toBe(5.5)
    expect(updatedNumeric.formattedAverage).toBe('5.5')
    expect(updatedNumeric.participants.map((p) => p.card)).toEqual(['3', '8'])
    expect(numericHarness.realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: { type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 40_000_000 },
      },
    ])

    // Subsequent peer getSession observes shared targetScore = 8 while recommendedScore remains 5
    const peerView = await numericHarness.handlers.getSession({
      context: makeHostContext('10001', '712020:a'),
    })
    expect(peerView.targetScore).toBe(8)
    expect(peerView.recommendedScore).toBe(5)

    // 2. All-'?' revealed round -> average & recommendedScore stay null when overridden to 3 or 0
    const questionHarness = createBackendTestHarness({
      initialNowMs: 40_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'revealed', overrideScore: null, updatedAt: 39_990_000 },
        },
      ],
      seedVotes: [
        {
          vote: { accountId: '712020:a', displayName: 'A', avatarUrl: null, card: '?', votedAt: 39_980_000 },
        },
        {
          vote: { accountId: '712020:b', displayName: 'B', avatarUrl: null, card: '?', votedAt: 39_985_000 },
        },
      ],
    })

    const overrideToThree = await questionHarness.handlers.selectOverrideScore({
      context: makeHostContext('10001', '712020:a'),
      payload: { score: 3 },
    })
    expect(overrideToThree.targetScore).toBe(3)
    expect(overrideToThree.average).toBeNull()
    expect(overrideToThree.formattedAverage).toBeNull()
    expect(overrideToThree.recommendedScore).toBeNull()

    const overrideToZero = await questionHarness.handlers.selectOverrideScore({
      context: makeHostContext('10001', '712020:b'),
      payload: { score: 0 },
    })
    expect(overrideToZero.targetScore).toBe(0)
    expect(overrideToZero.average).toBeNull()
    expect(overrideToZero.recommendedScore).toBeNull()
  })

  it('rejects selectOverrideScore on idle, voting, or expired rounds with invalid-state and zero Jira calls', async () => {
    const nowMs = 100_000_000
    const scenarios: readonly { label: string; meta: RoundMeta | null }[] = [
      { label: 'idle uninitialized', meta: null },
      {
        label: 'active voting round',
        meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: nowMs - 5_000 },
      },
      {
        label: 'expired revealed round',
        meta: { roundId: 'round-1', status: 'revealed', overrideScore: null, updatedAt: nowMs - SESSION_TTL_MS },
      },
    ]

    for (const scenario of scenarios) {
      const harness = createBackendTestHarness({
        initialNowMs: nowMs,
        seedMetas: scenario.meta !== null ? [{ issueId: '10001', meta: scenario.meta }] : [],
      })

      await expectAsyncPokerDomainError(
        () =>
          harness.handlers.selectOverrideScore({
            context: makeHostContext('10001', '712020:alice'),
            payload: { score: 8 },
          }),
        'invalid-state',
      )
      expect(harness.jiraDouble.calls).toHaveLength(0)
      expect(harness.realtimeDouble.events).toHaveLength(0)
    }
  })
})

describe('R9: Round reset (Re-vote) and exact 24-hour inactivity expiration boundaries', () => {
  it('resetRound writes fresh voting roundId before deleting prior-round votes and publishes SESSION_UPDATED', async () => {
    const harness = createBackendTestHarness({
      initialNowMs: 60_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-3', status: 'revealed', overrideScore: 13, updatedAt: 59_990_000 },
        },
      ],
      seedVotes: [
        {
          roundId: 'round-3',
          vote: { accountId: '712020:alice', displayName: 'Alice', avatarUrl: null, card: '8', votedAt: 59_980_000 },
        },
        {
          roundId: 'round-3',
          vote: { accountId: '712020:bob', displayName: 'Bob', avatarUrl: null, card: '13', votedAt: 59_985_000 },
        },
      ],
    })

    const resetSnap = await harness.handlers.resetRound({
      context: makeHostContext('10001', '712020:observer'),
    })

    expect(resetSnap).toEqual({
      roundId: 'round-4',
      status: 'voting',
      participants: [],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: {
        fieldId: 'customfield_10016',
        fieldName: 'Story Points',
      },
    })
    expect(harness.kvsDouble.keysWithPrefix('poker:10001:round-3:vote:')).toHaveLength(0)
    expect(harness.realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: { type: 'SESSION_UPDATED', roundId: 'round-4', updatedAt: 60_000_000 },
      },
    ])

    // Meta set must occur before vote deletion so concurrent readers observe round-4 immediately
    const metaSetIdx = harness.kvsDouble.operations.findIndex((op) => op.op === 'set' && op.key === 'poker:10001:meta')
    const firstDeleteIdx = harness.kvsDouble.operations.findIndex((op) => op.op === 'delete')
    expect(metaSetIdx).toBeGreaterThanOrEqual(0)
    expect(firstDeleteIdx).toBeGreaterThan(metaSetIdx)
  })

  it('keeps rounds active at 86_399_999 ms elapsed and under negative clock skew, and expires at >= 86_400_000 ms without extending updatedAt', async () => {
    const baseUpdatedAt = 1_000_000
    const harness = createBackendTestHarness({
      initialNowMs: baseUpdatedAt + SESSION_TTL_MS - 1, // 87_399_999 (elapsed = 86_399_999 ms)
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'revealed', overrideScore: 8, updatedAt: baseUpdatedAt },
        },
      ],
      seedVotes: [
        {
          vote: {
            accountId: '712020:alice',
            displayName: 'Alice',
            avatarUrl: null,
            card: '5',
            votedAt: baseUpdatedAt,
          },
        },
      ],
    })

    // 1. Active at 86_399_999 ms
    const activeBoundary = await harness.handlers.getSession({
      context: makeHostContext('10001', '712020:alice'),
    })
    expect(activeBoundary.status).toBe('revealed')
    expect(activeBoundary.targetScore).toBe(8)
    expect(activeBoundary.participants).toHaveLength(1)

    // 2. Active under minor negative clock skew (nowMs < updatedAt)
    harness.setNowMs(999_500)
    const skewActive = await harness.handlers.getSession({
      context: makeHostContext('10001', '712020:alice'),
    })
    expect(skewActive.status).toBe('revealed')
    expect(skewActive.participants).toHaveLength(1)

    // 3. Expired at exact 86_400_000 ms boundary
    harness.setNowMs(baseUpdatedAt + SESSION_TTL_MS) // 87_400_000
    harness.resetCounters()
    const expiredRead = await harness.handlers.getSession({
      context: makeHostContext('10001', '712020:alice'),
    })
    expect(expiredRead).toEqual({
      roundId: null,
      status: 'voting',
      participants: [],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: {
        fieldId: 'customfield_10016',
        fieldName: 'Story Points',
      },
    })
    // Must perform zero KVS writes so updatedAt is never extended on read
    expect(harness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)

    // 4. revealVotes, selectOverrideScore, and applyStoryPoints reject expired round with zero Jira calls
    harness.resetCounters()
    await expectAsyncPokerDomainError(
      () => harness.handlers.revealVotes({ context: makeHostContext('10001', '712020:alice') }),
      'precondition-failed',
    )
    await expectAsyncPokerDomainError(
      () =>
        harness.handlers.selectOverrideScore({
          context: makeHostContext('10001', '712020:alice'),
          payload: { score: 5 },
        }),
      'invalid-state',
    )
    await expectAsyncPokerDomainError(
      () =>
        harness.handlers.applyStoryPoints({
          context: makeHostContext('10001', '712020:alice'),
          payload: { score: 5 },
        }),
      'invalid-state',
    )
    expect(harness.jiraDouble.calls).toHaveLength(0)

    // 5. castVote on expired round starts fresh round-2 with only new voter C and sweeps stale round-1 votes
    const freshAfterExpiry = await harness.handlers.castVote({
      context: makeHostContext('10001', '712020:charlie'),
      payload: { card: '2' },
    })
    expect(freshAfterExpiry.roundId).toBe('round-2')
    expect(freshAfterExpiry.status).toBe('voting')
    expect(freshAfterExpiry.viewerCard).toBe('2')
    expect(freshAfterExpiry.participants.map((p) => p.accountId)).toEqual(['712020:charlie'])
    expect(harness.kvsDouble.keysWithPrefix('poker:10001:round-1:vote:')).toHaveLength(0)
  })
})

describe('R10: Story Points field population across all 6 SessionSnapshot handlers and graceful editmeta fallback', () => {
  it('populates snapshot.storyPointsField exactly once per non-throwing call across all 6 SessionSnapshot-returning handlers', async () => {
    const harness = createBackendTestHarness()
    const ctx = makeHostContext('10001', '712020:alice')
    const expectedField = { fieldId: 'customfield_10016', fieldName: 'Story Points' }

    // 1. getSession
    harness.resetCounters()
    const sGet = await harness.handlers.getSession({ context: ctx })
    expect(sGet.storyPointsField).toEqual(expectedField)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)

    // 2. castVote
    harness.resetCounters()
    const sCast = await harness.handlers.castVote({ context: ctx, payload: { card: '5' } })
    expect(sCast.storyPointsField).toEqual(expectedField)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)

    // 3. revealVotes
    harness.resetCounters()
    const sReveal = await harness.handlers.revealVotes({ context: ctx })
    expect(sReveal.storyPointsField).toEqual(expectedField)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)

    // 4. selectOverrideScore
    harness.resetCounters()
    const sOverride = await harness.handlers.selectOverrideScore({ context: ctx, payload: { score: 8 } })
    expect(sOverride.storyPointsField).toEqual(expectedField)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)

    // 5. resetRound
    harness.resetCounters()
    const sReset = await harness.handlers.resetRound({ context: ctx })
    expect(sReset.storyPointsField).toEqual(expectedField)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)

    // 6. withdrawVote (after casting in new round)
    await harness.handlers.castVote({ context: ctx, payload: { card: '3' } })
    harness.resetCounters()
    const sWithdraw = await harness.handlers.withdrawVote({ context: ctx })
    expect(sWithdraw.storyPointsField).toEqual(expectedField)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(1)
  })

  it.each([
    { label: '403 read-only viewer', responder: () => jsonJiraResponse(403, {}) },
    { label: '401 unauthenticated', responder: () => jsonJiraResponse(401, {}) },
    { label: '500 Jira error', responder: () => jsonJiraResponse(500, {}) },
    { label: 'malformed JSON', responder: () => malformedJsonJiraResponse(200) },
    {
      label: 'transport exception',
      responder: () => {
        throw new Error('editmeta network timeout')
      },
    },
    { label: 'empty fields map', responder: () => jsonJiraResponse(200, { fields: {} }) },
  ])(
    'returns storyPointsField: null without failing any of the 6 SessionSnapshot handlers when editmeta fails ($label)',
    async ({ responder }) => {
      const harness = createBackendTestHarness({
        jiraConfig: { onEditMeta: responder },
      })
      const ctx = makeHostContext('10001', '712020:alice')

      expect((await harness.handlers.getSession({ context: ctx })).storyPointsField).toBeNull()
      expect((await harness.handlers.castVote({ context: ctx, payload: { card: '5' } })).storyPointsField).toBeNull()
      expect((await harness.handlers.revealVotes({ context: ctx })).storyPointsField).toBeNull()
      expect(
        (await harness.handlers.selectOverrideScore({ context: ctx, payload: { score: 8 } })).storyPointsField,
      ).toBeNull()
      expect((await harness.handlers.resetRound({ context: ctx })).storyPointsField).toBeNull()
      expect((await harness.handlers.withdrawVote({ context: ctx })).storyPointsField).toBeNull()
    },
  )
})

describe('R11: User-attributed applyStoryPoints write-back, failure atomicity, and post-commit realtime resilience', () => {
  it('rejects applyStoryPoints on idle, voting, or expired rounds with invalid-state before calling Jira', async () => {
    const nowMs = 100_000_000
    const nonRevealedStates: readonly (RoundMeta | null)[] = [
      null,
      { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: nowMs - 1_000 },
      { roundId: 'round-1', status: 'revealed', overrideScore: 5, updatedAt: nowMs - SESSION_TTL_MS },
    ]

    for (const meta of nonRevealedStates) {
      const harness = createBackendTestHarness({
        initialNowMs: nowMs,
        seedMetas: meta !== null ? [{ issueId: '10001', meta }] : [],
      })

      await expectAsyncPokerDomainError(
        () =>
          harness.handlers.applyStoryPoints({
            context: makeHostContext('10001', '712020:alice'),
            payload: { score: 5 },
          }),
        'invalid-state',
      )
      expect(harness.jiraDouble.calls).toHaveLength(0)
      expect(harness.jiraCallCounts.updateStoryPoints).toBe(0)
      expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(0)
    }
  })

  it('writes score (including 0) via PUT /rest/api/3/issue/{issueId}, clears round, publishes points-applied, and avoids duplicate editmeta calls', async () => {
    const harness = createBackendTestHarness({
      initialNowMs: 70_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-2', status: 'revealed', overrideScore: 0, updatedAt: 69_990_000 },
        },
      ],
      seedVotes: [
        {
          roundId: 'round-2',
          vote: { accountId: '712020:alice', displayName: 'Alice', avatarUrl: null, card: '0', votedAt: 69_980_000 },
        },
      ],
    })

    const result = await harness.handlers.applyStoryPoints({
      context: makeHostContext('10001', '712020:alice'),
      payload: { score: 0 },
    })

    expect(result).toEqual({
      ok: true,
      appliedScore: 0,
      fieldName: 'Story Points',
      session: {
        roundId: 'round-3',
        status: 'voting',
        participants: [],
        viewerCard: null,
        average: null,
        formattedAverage: null,
        recommendedScore: null,
        targetScore: null,
        storyPointsField: {
          fieldId: 'customfield_10016',
          fieldName: 'Story Points',
        },
      },
    })

    expect(harness.jiraCallCounts.updateStoryPoints).toBe(1)
    expect(harness.jiraCallCounts.getEditableStoryPointsField).toBe(0)
    expect(harness.kvsDouble.keysWithPrefix('poker:10001:round-2:vote:')).toHaveLength(0)
    expect(harness.realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: {
          type: 'points-applied',
          roundId: 'round-3',
          score: 0,
          updatedAt: 70_000_000,
        },
      },
    ])
  })

  it.each<{
    label: string
    jiraConfig: FakeJiraRouterConfig
    expectedReason: 'missing-field' | 'forbidden' | 'jira-error'
  }>([
    {
      label: 'missing Story Points field on issue screen',
      jiraConfig: { onEditMeta: () => jsonJiraResponse(200, { fields: {} }) },
      expectedReason: 'missing-field',
    },
    {
      label: 'HTTP 403 forbidden on PUT issue',
      jiraConfig: {
        onEditMeta: () => jsonJiraResponse(200, COMPANY_MANAGED_STORY_POINTS_EDITMETA),
        onPutIssue: () => jsonJiraResponse(403, { errorMessages: ['User lacks Edit Issues permission'] }),
      },
      expectedReason: 'forbidden',
    },
    {
      label: 'HTTP 401 unauthorized on editmeta',
      jiraConfig: { onEditMeta: () => jsonJiraResponse(401, { errorMessages: ['Unauthorized'] }) },
      expectedReason: 'forbidden',
    },
    {
      label: 'HTTP 500 error on PUT issue',
      jiraConfig: {
        onEditMeta: () => jsonJiraResponse(200, COMPANY_MANAGED_STORY_POINTS_EDITMETA),
        onPutIssue: () => jsonJiraResponse(500, { errorMessages: ['Jira server failure'] }),
      },
      expectedReason: 'jira-error',
    },
    {
      label: 'HTTP 400 validation failure on PUT issue',
      jiraConfig: {
        onEditMeta: () => jsonJiraResponse(200, COMPANY_MANAGED_STORY_POINTS_EDITMETA),
        onPutIssue: () => jsonJiraResponse(400, { errors: { customfield_10016: 'Field cannot be set' } }),
      },
      expectedReason: 'jira-error',
    },
    {
      label: 'network transport failure on PUT issue',
      jiraConfig: {
        onEditMeta: () => jsonJiraResponse(200, COMPANY_MANAGED_STORY_POINTS_EDITMETA),
        onPutIssue: () => {
          throw new Error('ECONNRESET writing Story Points')
        },
      },
      expectedReason: 'jira-error',
    },
  ])(
    'leaves revealed round, votes, and targetScore completely intact when applyStoryPoints fails ($label)',
    async ({ jiraConfig, expectedReason }) => {
      const seededMeta: RoundMeta = {
        roundId: 'round-1',
        status: 'revealed',
        overrideScore: 8,
        updatedAt: 80_000_000,
      }
      const seededVote: VoteRecord = {
        accountId: '712020:alice',
        displayName: 'Alice',
        avatarUrl: null,
        card: '5',
        votedAt: 79_990_000,
      }

      const harness = createBackendTestHarness({
        initialNowMs: 80_005_000,
        seedMetas: [{ issueId: '10001', meta: seededMeta }],
        seedVotes: [{ issueId: '10001', roundId: 'round-1', vote: seededVote }],
        jiraConfig,
      })

      const outcome = await harness.handlers.applyStoryPoints({
        context: makeHostContext('10001', '712020:alice'),
        payload: { score: 8 },
      })

      expect(outcome).toMatchObject({
        ok: false,
        reason: expectedReason,
        score: 8,
      })
      if (!outcome.ok) {
        expect(outcome.message.trim().length).toBeGreaterThan(0)
      }

      // Zero KVS writes/deletes and zero realtime publishes on failure
      expect(harness.kvsDouble.operations.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(0)
      expect(harness.realtimeDouble.events).toHaveLength(0)
      expect(harness.kvsDouble.readRaw('poker:10001:meta')).toEqual(seededMeta)
      expect(harness.kvsDouble.readRaw('poker:10001:round-1:vote:712020:alice')).toEqual(seededVote)
    },
  )

  it('degrades gracefully when @forge/realtime publish rejects after applyStoryPoints and castVote commits', async () => {
    const harness = createBackendTestHarness({
      initialNowMs: 90_000_000,
      realtimeFailure: new Error('Transient Forge realtime outage for ops@acme.io'),
    })
    const ctx = makeHostContext('10001', '712020:alice')

    const castSnap = await harness.handlers.castVote({
      context: ctx,
      payload: { card: '21' },
    })
    expect(castSnap.viewerCard).toBe('21')
    expect(harness.logDouble.allSerialized()).not.toContain('"21"')
    expect(harness.logDouble.allSerialized()).not.toContain('ops@acme.io')

    const revealedSnap = await harness.handlers.revealVotes({ context: ctx })
    expect(revealedSnap.status).toBe('revealed')

    const applied = await harness.handlers.applyStoryPoints({
      context: ctx,
      payload: { score: 8 },
    })
    expect(applied.ok).toBe(true)

    expect(harness.logDouble.parsedWarnEntries().length).toBeGreaterThanOrEqual(3)
    expect(harness.logDouble.allSerialized()).not.toContain('ops@acme.io')
  })
})

describe('Monotonic round transitions under gated Jira & KVS interleaving (race regression)', () => {
  function createDeferredGate() {
    let release!: () => void
    let notifyArrived!: () => void
    const gatePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrivedPromise = new Promise<void>((resolve) => {
      notifyArrived = resolve
    })
    return {
      arrivedPromise,
      async waitAtGate(): Promise<void> {
        notifyArrived()
        await gatePromise
      },
      release(): void {
        release()
      },
    }
  }

  it('prevents an in-flight castVote (paused on Jira or gated KVS set) from reverting revealVotes', async () => {
    // Subcase A: Alice paused on /myself + /editmeta while Bob reveals votes
    const jiraGate = createDeferredGate()
    let gateMyself = false
    const jiraRaceHarness = createBackendTestHarness({
      initialNowMs: 20_000_000,
      seedMetas: [
        {
          issueId: '10001',
          meta: { roundId: 'round-1', status: 'voting', overrideScore: null, updatedAt: 19_990_000 },
        },
      ],
      seedVotes: [
        {
          vote: { accountId: '712020:bob', displayName: 'Bob', avatarUrl: null, card: '5', votedAt: 19_991_000 },
        },
      ],
      jiraConfig: {
        onMyself: async () => {
          if (gateMyself) {
            await jiraGate.waitAtGate()
          }
          return jsonJiraResponse(200, { accountId: '712020:alice', displayName: 'Alice', avatarUrls: {} })
        },
      },
    })

    gateMyself = true
    const aliceCastDuringJira = jiraRaceHarness.handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '8' },
    })
    await jiraGate.arrivedPromise

    const bobReveal = await jiraRaceHarness.handlers.revealVotes({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(bobReveal.status).toBe('revealed')
    expect(bobReveal.recommendedScore).toBe(5)

    gateMyself = false
    jiraGate.release()
    const aliceResultA = await aliceCastDuringJira
    expect(aliceResultA.status).toBe('revealed')

    const afterJiraRace = await jiraRaceHarness.handlers.getSession({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(afterJiraRace.status).toBe('revealed')
    expect(afterJiraRace.recommendedScore).toBe(5)

    // Subcase B: Adversarial gated KVS double pauses Alice's vote/activity KVS set while Bob reveals votes
    const kvsSetGate = createDeferredGate()
    let gateAliceKvsSet = false
    const baseKvs = createInMemoryKvsDouble()
    baseKvs.seedRoundMeta('10001', {
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 19_990_000,
    })
    baseKvs.seedVoteRecord('10001', 'round-1', {
      accountId: '712020:bob',
      displayName: 'Bob',
      avatarUrl: null,
      card: '5',
      votedAt: 19_991_000,
    })

    const gatedClient = {
      ...baseKvs.client,
      async set<T = unknown>(key: string, value: T, options?: Parameters<typeof baseKvs.client.set>[2]) {
        if (gateAliceKvsSet && (key.includes(':vote:712020:alice') || key.endsWith(':activity'))) {
          gateAliceKvsSet = false
          await kvsSetGate.waitAtGate()
        }
        await baseKvs.client.set(key, value, options)
      },
    }

    const store = createSessionStore(gatedClient)
    const jira = createJiraClient({ requestAsUser: createFakeJiraDouble().requestAsUser })
    const realtime = createRealtimePublisher({ publish: createFakeRealtimeDouble().publish })
    const handlers = createPokerResolverHandlers({
      store,
      jira,
      realtime,
      now: () => 20_000_000,
    })

    gateAliceKvsSet = true
    const aliceCastGatedKvs = handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '13' },
    })
    await kvsSetGate.arrivedPromise

    const revealedDuringGate = await handlers.revealVotes({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(revealedDuringGate.status).toBe('revealed')

    kvsSetGate.release()
    const aliceResultB = await aliceCastGatedKvs
    expect(aliceResultB.status).toBe('revealed')

    const afterKvsGate = await handlers.getSession({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(afterKvsGate.status).toBe('revealed')
  })

  it('prevents an in-flight castVote (both active-round and initial idle-round) from reverting resetRound', async () => {
    const kvsSetGate = createDeferredGate()
    let gateInitialMetaSet = false
    const baseKvs = createInMemoryKvsDouble()

    const gatedClient = {
      ...baseKvs.client,
      async set<T = unknown>(key: string, value: T, options?: Parameters<typeof baseKvs.client.set>[2]) {
        if (gateInitialMetaSet && key === 'poker:10001:meta') {
          gateInitialMetaSet = false
          await kvsSetGate.waitAtGate()
        }
        await baseKvs.client.set(key, value, options)
      },
    }

    let nowMs = 30_000_000
    const store = createSessionStore(gatedClient)
    const jira = createJiraClient({ requestAsUser: createFakeJiraDouble().requestAsUser })
    const realtime = createRealtimePublisher({ publish: createFakeRealtimeDouble().publish })
    const handlers = createPokerResolverHandlers({
      store,
      jira,
      realtime,
      now: () => nowMs,
    })

    // Alice starts initial castVote on idle issue; her write to poker:10001:meta (round-1) is gated
    gateInitialMetaSet = true
    const aliceInitialCast = handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '8' },
    })
    await kvsSetGate.arrivedPromise

    // Meanwhile Bob casts on round-1 and resets the round to round-2
    nowMs += 1_000
    await handlers.castVote({
      context: makeHostContext('10001', '712020:bob'),
      payload: { card: '5' },
    })
    nowMs += 1_000
    const resetSnap = await handlers.resetRound({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(resetSnap.roundId).toBe('round-2')

    // Release Alice's stale round-1 meta set; round-1:closed tombstone keeps session on round-2 with 0 votes
    kvsSetGate.release()
    const aliceSnap = await aliceInitialCast
    expect(aliceSnap.roundId).toBe('round-2')
    expect(aliceSnap.status).toBe('voting')
    expect(aliceSnap.participants).toHaveLength(0)

    const finalSnap = await handlers.getSession({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(finalSnap.roundId).toBe('round-2')
    expect(finalSnap.status).toBe('voting')
    expect(finalSnap.participants).toHaveLength(0)
  })

  it('prevents an in-flight withdrawVote from reverting revealVotes or clearing selectOverrideScore', async () => {
    const kvsGate = createDeferredGate()
    let gateActivityWrite = false
    const baseKvs = createInMemoryKvsDouble()
    baseKvs.seedRoundMeta('10001', {
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 40_000_000,
    })
    baseKvs.seedVoteRecord('10001', 'round-1', {
      accountId: '712020:alice',
      displayName: 'Alice',
      avatarUrl: null,
      card: '3',
      votedAt: 39_990_000,
    })
    baseKvs.seedVoteRecord('10001', 'round-1', {
      accountId: '712020:bob',
      displayName: 'Bob',
      avatarUrl: null,
      card: '8',
      votedAt: 39_995_000,
    })

    const gatedClient = {
      ...baseKvs.client,
      async set<T = unknown>(key: string, value: T, options?: Parameters<typeof baseKvs.client.set>[2]) {
        if (gateActivityWrite && key.endsWith(':activity')) {
          gateActivityWrite = false
          await kvsGate.waitAtGate()
        }
        await baseKvs.client.set(key, value, options)
      },
    }

    const store = createSessionStore(gatedClient)
    const jira = createJiraClient({ requestAsUser: createFakeJiraDouble().requestAsUser })
    const realtime = createRealtimePublisher({ publish: createFakeRealtimeDouble().publish })
    const handlers = createPokerResolverHandlers({
      store,
      jira,
      realtime,
      now: () => 40_010_000,
    })

    gateActivityWrite = true
    const withdrawPromise = handlers.withdrawVote({
      context: makeHostContext('10001', '712020:alice'),
    })
    await kvsGate.arrivedPromise

    await handlers.revealVotes({ context: makeHostContext('10001', '712020:bob') })
    const overridden = await handlers.selectOverrideScore({
      context: makeHostContext('10001', '712020:bob'),
      payload: { score: 13 },
    })
    expect(overridden.status).toBe('revealed')
    expect(overridden.targetScore).toBe(13)

    kvsGate.release()
    const withdrawResult = await withdrawPromise
    expect(withdrawResult.status).toBe('revealed')
    expect(withdrawResult.targetScore).toBe(13)

    const finalSession = await handlers.getSession({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(finalSession.status).toBe('revealed')
    expect(finalSession.targetScore).toBe(13)
  })

  it('isolates fresh sessions after partial/lazy KVS TTL eviction (both monotonic round-3 allocation and forced round-1 reuse)', async () => {
    let nowMs = 10_000_000
    const ttlKvs = createTtlAwareKvsDouble({ now: () => nowMs })
    const store = createSessionStore(ttlKvs.client)
    const jira = createJiraClient({ requestAsUser: createFakeJiraDouble().requestAsUser })
    const realtimeDouble = createFakeRealtimeDouble()
    const realtime = createRealtimePublisher({ publish: realtimeDouble.publish })
    const handlers = createPokerResolverHandlers({
      store,
      jira,
      realtime,
      now: () => nowMs,
    })

    // Prior cycle: Alice votes round-1 -> reset to round-2 -> Alice & Bob vote -> reveal & override round-2
    await handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '5' },
    })
    nowMs += 1_000
    const resetSnap = await handlers.resetRound({
      context: makeHostContext('10001', '712020:alice'),
    })
    expect(resetSnap.roundId).toBe('round-2')

    nowMs += 1_000
    await handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '8' },
    })
    await handlers.castVote({
      context: makeHostContext('10001', '712020:bob'),
      payload: { card: '13' },
    })
    nowMs += 1_000
    await handlers.revealVotes({
      context: makeHostContext('10001', '712020:bob'),
    })
    await handlers.selectOverrideScore({
      context: makeHostContext('10001', '712020:bob'),
      payload: { score: 21 },
    })

    // Subcase A: Lazy KVS sweep evicts ONLY poker:10001:meta while :seq, :closed, :status, :override, and votes remain
    ttlKvs.evictKey('poker:10001:meta')
    nowMs += 5_000

    const charlieNewSession = await handlers.castVote({
      context: makeHostContext('10001', '712020:charlie'),
      payload: { card: '3' },
    })
    expect(charlieNewSession.roundId).toBe('round-3')
    expect(charlieNewSession.status).toBe('voting')
    expect(charlieNewSession.viewerCard).toBe('3')
    expect(charlieNewSession.participants.map((p) => p.accountId)).toEqual(['712020:charlie'])

    // Subcase B: Even if BOTH poker:10001:meta AND poker:10001:seq are evicted (forcing round-1 reuse while
    // round-1:closed -> round-2, round-2:status = revealed, and a lingering round-1 vote still exist),
    // session-epoch isolation prevents redirecting to round-2 or deleting the new vote
    ttlKvs.seedRaw('poker:10001:round-1:vote:712020:ghost', {
      accountId: '712020:ghost',
      displayName: 'Ghost Voter',
      avatarUrl: null,
      card: '21',
      votedAt: nowMs,
    })
    ttlKvs.evictKey('poker:10001:meta')
    ttlKvs.evictKey('poker:10001:seq')
    nowMs += 5_000

    const danaForcedReuse = await handlers.castVote({
      context: makeHostContext('10001', '712020:dana'),
      payload: { card: '2' },
    })
    expect(danaForcedReuse.roundId).toBe('round-1')
    expect(danaForcedReuse.status).toBe('voting')
    expect(danaForcedReuse.viewerCard).toBe('2')
    expect(danaForcedReuse.participants.map((p) => p.accountId)).toEqual(['712020:dana'])
  })

  it('keeps voting session alive in TTL-aware KVS when a vote is cast at t0 + 23h59m and expires 24h after the last vote', async () => {
    const t0 = 50_000_000
    let nowMs = t0
    const ttlKvs = createTtlAwareKvsDouble({ now: () => nowMs })
    const store = createSessionStore(ttlKvs.client)
    const jira = createJiraClient({ requestAsUser: createFakeJiraDouble().requestAsUser })
    const realtime = createRealtimePublisher({ publish: createFakeRealtimeDouble().publish })
    const handlers = createPokerResolverHandlers({
      store,
      jira,
      realtime,
      now: () => nowMs,
    })

    // Alice opens round-1 at t0
    await handlers.castVote({
      context: makeHostContext('10001', '712020:alice'),
      payload: { card: '3' },
    })

    // Bob casts a vote at t0 + 23h59m (refreshing poker:10001:meta 24h TTL)
    const bobVoteAt = t0 + SESSION_TTL_MS - 60_000
    nowMs = bobVoteAt
    const afterBobVote = await handlers.castVote({
      context: makeHostContext('10001', '712020:bob'),
      payload: { card: '8' },
    })
    expect(afterBobVote.participants).toHaveLength(2)

    // At t0 + 24h01m (past initial meta TTL, 2m after Bob's vote), session stays active with Bob's vote
    nowMs = t0 + SESSION_TTL_MS + 60_000
    const activePastInitialTtl = await handlers.getSession({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(activePastInitialTtl.roundId).toBe('round-1')
    expect(activePastInitialTtl.status).toBe('voting')
    expect(activePastInitialTtl.viewerCard).toBe('8')
    expect(activePastInitialTtl.participants.map((p) => p.accountId)).toEqual(['712020:bob'])

    // At 24h after Bob's last vote, session expires cleanly to idle
    nowMs = bobVoteAt + SESSION_TTL_MS
    const expiredAfterLastVote = await handlers.getSession({
      context: makeHostContext('10001', '712020:bob'),
    })
    expect(expiredAfterLastVote.roundId).toBeNull()
    expect(expiredAfterLastVote.participants).toEqual([])
  })

  it('uses the authoritative RoundMeta returned by advanceRound in resetRound and applyStoryPoints under concurrent chaining', async () => {
    const baseKvs = createInMemoryKvsDouble()
    const store = createSessionStore(baseKvs.client)
    const jira = createJiraClient({ requestAsUser: createFakeJiraDouble().requestAsUser })
    const realtimeDouble = createFakeRealtimeDouble()
    const realtime = createRealtimePublisher({ publish: realtimeDouble.publish })
    const nowMs = 80_000_000
    const handlers = createPokerResolverHandlers({
      store,
      jira,
      realtime,
      now: () => nowMs,
    })

    // 1. resetRound when round-2 is already closed forward to round-3
    baseKvs.seedRoundMeta('10001', {
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: nowMs - 1_000,
    })
    baseKvs.seedRaw('poker:10001:round-2:closed', {
      nextRoundId: 'round-3',
      closedAt: nowMs,
    })

    const resetResult = await handlers.resetRound({
      context: makeHostContext('10001', '712020:alice'),
    })
    expect(resetResult.roundId).toBe('round-3')
    expect(realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: { type: 'SESSION_UPDATED', roundId: 'round-3', updatedAt: nowMs },
      },
    ])

    // 2. applyStoryPoints when round-4 is already closed forward to round-5
    realtimeDouble.resetEvents()
    baseKvs.seedRoundMeta('10002', {
      roundId: 'round-3',
      status: 'revealed',
      overrideScore: 8,
      updatedAt: nowMs - 1_000,
    })
    baseKvs.seedRaw('poker:10002:round-4:closed', {
      nextRoundId: 'round-5',
      closedAt: nowMs,
    })

    const applyResult = await handlers.applyStoryPoints({
      context: makeHostContext('10002', '712020:alice'),
      payload: { score: 8 },
    })
    expect(applyResult.ok).toBe(true)
    if (applyResult.ok) {
      expect(applyResult.session.roundId).toBe('round-5')
    }
    expect(realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: { type: 'points-applied', roundId: 'round-5', score: 8, updatedAt: nowMs },
      },
    ])
  })
})
