import { describe, expect, it } from 'vitest'
import {
  createIdleSessionSnapshot,
  FALLBACK_DISPLAY_NAME,
  isRoundExpired,
  normalizeDisplayName,
  projectSessionSnapshot,
  SESSION_TTL_MS,
} from '../../src/domain/session-view'
import type {
  FibonacciScore,
  ProjectSessionParams,
  RoundMeta,
  RoundStatus,
  StoryPointsFieldInfo,
  VoteRecord,
} from '../../src/domain/types'
import { expectPokerDomainError } from '../helpers/domain-errors'

const SAMPLE_FIELD: StoryPointsFieldInfo = {
  fieldId: 'customfield_10016',
  fieldName: 'Story Points',
}

const INVALID_CANONICAL_IDS: readonly { label: string; value: unknown }[] = [
  { label: 'empty string ("")', value: '' },
  { label: 'spaces-only string ("   ")', value: '   ' },
  { label: 'tab/newline whitespace ("\\t\\n")', value: '\t\n' },
  { label: 'leading space (" acc-1")', value: ' acc-1' },
  { label: 'trailing space ("acc-1 ")', value: 'acc-1 ' },
  { label: 'surrounding spaces (" acc-1 ")', value: ' acc-1 ' },
  { label: 'leading tab ("\\tacc-1")', value: '\tacc-1' },
  { label: 'number (123)', value: 123 },
]

const NON_FINITE_NUMBERS: readonly { label: string; value: unknown }[] = [
  { label: 'NaN', value: Number.NaN },
  { label: 'positive Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'negative Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'numeric string ("1000")', value: '1000' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
]

function makeActiveMeta(overrides: Partial<RoundMeta> = {}): RoundMeta {
  return {
    roundId: 'round-1',
    status: 'voting',
    overrideScore: null,
    updatedAt: 1_000_000,
    ...overrides,
  }
}

describe('Session view constants and display name normalization (R5, R9)', () => {
  it('exposes exact 24-hour SESSION_TTL_MS of 86_400_000 ms', () => {
    expect(SESSION_TTL_MS).toBe(86_400_000)
  })

  it('exposes FALLBACK_DISPLAY_NAME as "Unknown User"', () => {
    expect(FALLBACK_DISPLAY_NAME).toBe('Unknown User')
  })

  it.each([
    { input: 'Alice Lovelace', expected: 'Alice Lovelace', label: 'canonical display name' },
    { input: '  Grace Hopper \t', expected: 'Grace Hopper', label: 'whitespace-padded display name' },
    { input: '', expected: 'Unknown User', label: 'empty string' },
    { input: '   ', expected: 'Unknown User', label: 'spaces-only string' },
    { input: '\t\n ', expected: 'Unknown User', label: 'tab and newline whitespace' },
    { input: null, expected: 'Unknown User', label: 'null' },
    { input: undefined, expected: 'Unknown User', label: 'undefined' },
  ])('normalizes $label to "$expected" via normalizeDisplayName', ({ input, expected }) => {
    expect(normalizeDisplayName(input)).toBe(expected)
  })
})

describe('projectSessionSnapshot vote secrecy and voter-only projection during voting (R5)', () => {
  it('omits non-voting viewer from participants, redacts all participant cards, and sets viewerCard to null', () => {
    const votes: readonly VoteRecord[] = [
      {
        accountId: 'acc-a',
        displayName: 'Alice',
        avatarUrl: 'https://avatar.example/alice.png',
        card: '3',
        votedAt: 1_000,
      },
      {
        accountId: 'acc-b',
        displayName: 'Bob',
        avatarUrl: null,
        card: '13',
        votedAt: 2_000,
      },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'voting', updatedAt: 2_000 }),
      votes,
      viewerAccountId: 'acc-observer',
      storyPointsField: SAMPLE_FIELD,
      nowMs: 5_000,
    })

    expect(snapshot).toEqual({
      roundId: 'round-1',
      status: 'voting',
      participants: [
        {
          accountId: 'acc-a',
          displayName: 'Alice',
          avatarUrl: 'https://avatar.example/alice.png',
          hasVoted: true,
          card: null,
        },
        {
          accountId: 'acc-b',
          displayName: 'Bob',
          avatarUrl: null,
          hasVoted: true,
          card: null,
        },
      ],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: SAMPLE_FIELD,
    })
    expect(JSON.stringify(snapshot)).not.toContain('"13"')
    expect(JSON.stringify(snapshot)).not.toContain('"3"')
  })

  it('exposes viewerCard solely for the voting viewer while keeping every participant card null and scores omitted', () => {
    const votes: readonly VoteRecord[] = [
      {
        accountId: 'acc-a',
        displayName: 'Alice',
        card: '5',
        votedAt: 1_000,
      },
      {
        accountId: 'acc-b',
        displayName: 'Bob',
        card: '21',
        votedAt: 2_000,
      },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'voting', overrideScore: 8, updatedAt: 2_000 }),
      votes,
      viewerAccountId: 'acc-a',
      storyPointsField: null,
      nowMs: 3_000,
    })

    expect(snapshot.viewerCard).toBe('5')
    expect(snapshot.participants).toEqual([
      {
        accountId: 'acc-a',
        displayName: 'Alice',
        avatarUrl: null,
        hasVoted: true,
        card: null,
      },
      {
        accountId: 'acc-b',
        displayName: 'Bob',
        avatarUrl: null,
        hasVoted: true,
        card: null,
      },
    ])
    expect(snapshot.average).toBeNull()
    expect(snapshot.formattedAverage).toBeNull()
    expect(snapshot.recommendedScore).toBeNull()
    expect(snapshot.targetScore).toBeNull()
    expect(JSON.stringify(snapshot)).not.toContain('"21"')
  })
})

describe('projectSessionSnapshot deterministic ordering, deduplication, and profile normalization (R5)', () => {
  it('orders participants by ascending votedAt and breaks timestamp ties by ascending UTF-16 accountId without mutating input', () => {
    const votes: VoteRecord[] = [
      { accountId: 'acc-z', displayName: 'Zoe', card: '8', votedAt: 2_000 },
      { accountId: 'acc-c', displayName: 'Cara', card: '3', votedAt: 3_000 },
      { accountId: 'acc-a', displayName: 'Ada', card: '1', votedAt: 2_000 },
      { accountId: 'acc-B', displayName: 'Ben', card: '2', votedAt: 2_000 },
      { accountId: 'acc-first', displayName: 'Finn', card: '5', votedAt: 1_000 },
    ]
    const originalOrder = votes.map((vote) => vote.accountId)

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'revealed', updatedAt: 3_000 }),
      votes,
      viewerAccountId: 'acc-observer',
      storyPointsField: null,
      nowMs: 4_000,
    })

    expect(votes.map((vote) => vote.accountId)).toEqual(originalOrder)
    expect(snapshot.participants.map((participant) => participant.accountId)).toEqual([
      'acc-first',
      'acc-B',
      'acc-a',
      'acc-z',
      'acc-c',
    ])
  })

  it('deduplicates repeated accountId entries keeping the highest votedAt regardless of array order', () => {
    const votes: readonly VoteRecord[] = [
      { accountId: 'acc-a', displayName: 'Alice Latest', card: '13', votedAt: 3_000 },
      { accountId: 'acc-b', displayName: 'Bob', card: '5', votedAt: 2_000 },
      { accountId: 'acc-a', displayName: 'Alice Stale', card: '2', votedAt: 1_000 },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'revealed', updatedAt: 3_000 }),
      votes,
      viewerAccountId: 'acc-a',
      storyPointsField: null,
      nowMs: 3_500,
    })

    expect(snapshot.viewerCard).toBe('13')
    expect(snapshot.participants).toEqual([
      {
        accountId: 'acc-b',
        displayName: 'Bob',
        avatarUrl: null,
        hasVoted: true,
        card: '5',
      },
      {
        accountId: 'acc-a',
        displayName: 'Alice Latest',
        avatarUrl: null,
        hasVoted: true,
        card: '13',
      },
    ])
    expect(snapshot.average).toBe(9)
    expect(snapshot.recommendedScore).toBe(8)
  })

  it('retains the later array element when duplicate accountId entries share an exact votedAt timestamp', () => {
    const votes: readonly VoteRecord[] = [
      { accountId: 'acc-a', displayName: 'First Write', card: '3', votedAt: 1_500 },
      { accountId: 'acc-a', displayName: 'Second Write', card: '8', votedAt: 1_500 },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'revealed', updatedAt: 1_500 }),
      votes,
      viewerAccountId: 'acc-a',
      storyPointsField: null,
      nowMs: 2_000,
    })

    expect(snapshot.viewerCard).toBe('8')
    expect(snapshot.participants).toHaveLength(1)
    expect(snapshot.participants[0]).toEqual({
      accountId: 'acc-a',
      displayName: 'Second Write',
      avatarUrl: null,
      hasVoted: true,
      card: '8',
    })
  })

  it('normalizes blank/whitespace displayName to FALLBACK_DISPLAY_NAME and trims/nullifies avatarUrl', () => {
    const votes: readonly VoteRecord[] = [
      {
        accountId: 'acc-1',
        displayName: '',
        avatarUrl: '  https://avatar.example/1.png  ',
        card: '5',
        votedAt: 1_000,
      },
      {
        accountId: 'acc-2',
        displayName: '   \t ',
        avatarUrl: '   ',
        card: '8',
        votedAt: 2_000,
      },
      {
        accountId: 'acc-3',
        displayName: '  Dana  ',
        avatarUrl: '',
        card: '3',
        votedAt: 3_000,
      },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'voting', updatedAt: 3_000 }),
      votes,
      viewerAccountId: 'acc-1',
      storyPointsField: null,
      nowMs: 4_000,
    })

    expect(snapshot.participants).toEqual([
      {
        accountId: 'acc-1',
        displayName: 'Unknown User',
        avatarUrl: 'https://avatar.example/1.png',
        hasVoted: true,
        card: null,
      },
      {
        accountId: 'acc-2',
        displayName: 'Unknown User',
        avatarUrl: null,
        hasVoted: true,
        card: null,
      },
      {
        accountId: 'acc-3',
        displayName: 'Dana',
        avatarUrl: null,
        hasVoted: true,
        card: null,
      },
    ])
  })
})

describe('projectSessionSnapshot revealed scores and targetScore override resolution (R5, R7)', () => {
  it('exposes every voter card including "?" and defaults targetScore to recommendedScore when overrideScore is null', () => {
    const votes: readonly VoteRecord[] = [
      { accountId: 'acc-1', displayName: 'User 1', card: '0', votedAt: 1_000 },
      { accountId: 'acc-2', displayName: 'User 2', card: '2', votedAt: 1_100 },
      { accountId: 'acc-3', displayName: 'User 3', card: '?', votedAt: 1_200 },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'revealed', overrideScore: null, updatedAt: 1_500 }),
      votes,
      viewerAccountId: 'acc-3',
      storyPointsField: SAMPLE_FIELD,
      nowMs: 2_000,
    })

    expect(snapshot).toEqual({
      roundId: 'round-1',
      status: 'revealed',
      participants: [
        { accountId: 'acc-1', displayName: 'User 1', avatarUrl: null, hasVoted: true, card: '0' },
        { accountId: 'acc-2', displayName: 'User 2', avatarUrl: null, hasVoted: true, card: '2' },
        { accountId: 'acc-3', displayName: 'User 3', avatarUrl: null, hasVoted: true, card: '?' },
      ],
      viewerCard: '?',
      average: 1,
      formattedAverage: '1',
      recommendedScore: 1,
      targetScore: 1,
      storyPointsField: SAMPLE_FIELD,
    })
  })

  it.each<{ overrideScore: FibonacciScore }>([{ overrideScore: 0 }, { overrideScore: 8 }, { overrideScore: 21 }])(
    'sets targetScore to meta.overrideScore ($overrideScore) including 0 while preserving recommendedScore',
    ({ overrideScore }) => {
      const votes: readonly VoteRecord[] = [
        { accountId: 'acc-1', displayName: 'User 1', card: '3', votedAt: 1_000 },
        { accountId: 'acc-2', displayName: 'User 2', card: '8', votedAt: 1_100 },
      ]

      const snapshot = projectSessionSnapshot({
        meta: makeActiveMeta({ status: 'revealed', overrideScore, updatedAt: 1_500 }),
        votes,
        viewerAccountId: 'acc-1',
        storyPointsField: SAMPLE_FIELD,
        nowMs: 2_000,
      })

      expect(snapshot.average).toBe(5.5)
      expect(snapshot.formattedAverage).toBe('5.5')
      expect(snapshot.recommendedScore).toBe(5)
      expect(snapshot.targetScore).toBe(overrideScore)
    },
  )

  it('sets average, formattedAverage, recommendedScore, and targetScore to null when all revealed votes are "?" and no override is set', () => {
    const votes: readonly VoteRecord[] = [
      { accountId: 'acc-1', displayName: 'User 1', card: '?', votedAt: 1_000 },
      { accountId: 'acc-2', displayName: 'User 2', card: '?', votedAt: 1_100 },
    ]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'revealed', overrideScore: null, updatedAt: 1_500 }),
      votes,
      viewerAccountId: 'acc-1',
      storyPointsField: null,
      nowMs: 2_000,
    })

    expect(snapshot.participants.map((p) => p.card)).toEqual(['?', '?'])
    expect(snapshot.average).toBeNull()
    expect(snapshot.formattedAverage).toBeNull()
    expect(snapshot.recommendedScore).toBeNull()
    expect(snapshot.targetScore).toBeNull()
  })

  it('allows numeric overrideScore (including 0) to populate targetScore on an all-"?" revealed round', () => {
    const votes: readonly VoteRecord[] = [{ accountId: 'acc-1', displayName: 'User 1', card: '?', votedAt: 1_000 }]

    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ status: 'revealed', overrideScore: 0, updatedAt: 1_500 }),
      votes,
      viewerAccountId: 'acc-1',
      storyPointsField: SAMPLE_FIELD,
      nowMs: 2_000,
    })

    expect(snapshot.average).toBeNull()
    expect(snapshot.formattedAverage).toBeNull()
    expect(snapshot.recommendedScore).toBeNull()
    expect(snapshot.targetScore).toBe(0)
  })
})

describe('24-hour expiration boundary and idle session projection (R9)', () => {
  it.each([
    { label: 'negative clock skew (-500 ms)', updatedAt: 1_000_000, nowMs: 999_500, expected: false },
    { label: 'zero elapsed (0 ms)', updatedAt: 1_000_000, nowMs: 1_000_000, expected: false },
    { label: '1 ms before 24h boundary (86_399_999 ms)', updatedAt: 1_000_000, nowMs: 87_399_999, expected: false },
    { label: 'exact 24h boundary (86_400_000 ms)', updatedAt: 1_000_000, nowMs: 87_400_000, expected: true },
    { label: '1 ms past 24h boundary (86_400_001 ms)', updatedAt: 1_000_000, nowMs: 87_400_001, expected: true },
    { label: '48 hours elapsed', updatedAt: 1_000_000, nowMs: 173_800_000, expected: true },
  ])('evaluates isRoundExpired for $label as $expected', ({ updatedAt, nowMs, expected }) => {
    expect(isRoundExpired(updatedAt, nowMs)).toBe(expected)
  })

  it('creates default clean idle voting snapshot via createIdleSessionSnapshot with no arguments', () => {
    expect(createIdleSessionSnapshot()).toEqual({
      roundId: null,
      status: 'voting',
      participants: [],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: null,
    })
  })

  it('creates clean idle voting snapshot via createIdleSessionSnapshot preserving storyPointsField and roundId', () => {
    expect(createIdleSessionSnapshot(SAMPLE_FIELD, 'round-fresh')).toEqual({
      roundId: 'round-fresh',
      status: 'voting',
      participants: [],
      viewerCard: null,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
      storyPointsField: SAMPLE_FIELD,
    })
  })

  it.each([
    { label: '1 ms before 24h expiry (elapsed 86_399_999 ms)', nowMs: 87_399_999 },
    { label: 'negative clock skew (nowMs < updatedAt)', nowMs: 999_500 },
  ])('keeps round active in projectSessionSnapshot at $label', ({ nowMs }) => {
    const snapshot = projectSessionSnapshot({
      meta: makeActiveMeta({ roundId: 'round-live', status: 'revealed', overrideScore: 8, updatedAt: 1_000_000 }),
      votes: [{ accountId: 'acc-1', displayName: 'Alice', card: '5', votedAt: 1_000_000 }],
      viewerAccountId: 'acc-1',
      storyPointsField: SAMPLE_FIELD,
      nowMs,
    })

    expect(snapshot.roundId).toBe('round-live')
    expect(snapshot.status).toBe('revealed')
    expect(snapshot.participants).toHaveLength(1)
    expect(snapshot.viewerCard).toBe('5')
    expect(snapshot.targetScore).toBe(8)
  })

  it('projects meta === null as a clean idle voting snapshot even if stale votes are supplied', () => {
    const snapshot = projectSessionSnapshot({
      meta: null,
      votes: [{ accountId: 'acc-1', displayName: 'Alice', card: '5', votedAt: 1_000_000 }],
      viewerAccountId: 'acc-1',
      storyPointsField: SAMPLE_FIELD,
      nowMs: 1_005_000,
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
      storyPointsField: SAMPLE_FIELD,
    })
  })

  it.each<{ label: string; status: RoundStatus; nowMs: number }>([
    { label: 'voting round at exact 86_400_000 ms', status: 'voting', nowMs: 87_400_000 },
    { label: 'revealed round at exact 86_400_000 ms', status: 'revealed', nowMs: 87_400_000 },
    { label: 'revealed round past 86_400_000 ms', status: 'revealed', nowMs: 90_000_000 },
  ])(
    'projects expired $label as a clean idle voting snapshot with 0 participants and viewerCard null',
    ({ status, nowMs }) => {
      const snapshot = projectSessionSnapshot({
        meta: makeActiveMeta({ roundId: 'round-old', status, overrideScore: 13, updatedAt: 1_000_000 }),
        votes: [
          { accountId: 'acc-1', displayName: 'Alice', card: '5', votedAt: 1_000_000 },
          { accountId: 'acc-2', displayName: 'Bob', card: '8', votedAt: 1_000_000 },
        ],
        viewerAccountId: 'acc-1',
        storyPointsField: SAMPLE_FIELD,
        nowMs,
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
        storyPointsField: SAMPLE_FIELD,
      })
    },
  )
})

describe('Timestamp and canonical identifier validation in session-view (R9)', () => {
  it.each(NON_FINITE_NUMBERS)('rejects non-finite updatedAt ($label) in isRoundExpired', ({ value }) => {
    expectPokerDomainError(() => isRoundExpired(value as number, 1_000_000), 'validation-error')
  })

  it.each(NON_FINITE_NUMBERS)('rejects non-finite nowMs ($label) in isRoundExpired', ({ value }) => {
    expectPokerDomainError(() => isRoundExpired(1_000_000, value as number), 'validation-error')
  })

  it.each(INVALID_CANONICAL_IDS)(
    'rejects invalid non-null roundId ($label) in createIdleSessionSnapshot',
    ({ value }) => {
      expectPokerDomainError(() => createIdleSessionSnapshot(null, value as string), 'validation-error')
    },
  )

  it.each([...INVALID_CANONICAL_IDS, { label: 'null', value: null }, { label: 'undefined', value: undefined }])(
    'rejects invalid viewerAccountId ($label) in projectSessionSnapshot',
    ({ value }) => {
      expectPokerDomainError(
        () =>
          projectSessionSnapshot({
            meta: null,
            votes: [],
            viewerAccountId: value as string,
            storyPointsField: null,
            nowMs: 1_000_000,
          }),
        'validation-error',
      )
    },
  )

  it.each(NON_FINITE_NUMBERS)('rejects non-finite nowMs ($label) in projectSessionSnapshot', ({ value }) => {
    expectPokerDomainError(
      () =>
        projectSessionSnapshot({
          meta: null,
          votes: [],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: value as number,
        }),
      'validation-error',
    )
  })

  it.each(NON_FINITE_NUMBERS)('rejects non-finite meta.updatedAt ($label) in projectSessionSnapshot', ({ value }) => {
    expectPokerDomainError(
      () =>
        projectSessionSnapshot({
          meta: makeActiveMeta({ updatedAt: value as number }),
          votes: [],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
      'validation-error',
    )
  })

  it.each([...INVALID_CANONICAL_IDS, { label: 'null', value: null }])(
    'rejects invalid active meta.roundId ($label) in projectSessionSnapshot',
    ({ value }) => {
      expectPokerDomainError(
        () =>
          projectSessionSnapshot({
            meta: makeActiveMeta({ roundId: value as string, updatedAt: 1_000_000 }),
            votes: [],
            viewerAccountId: 'acc-1',
            storyPointsField: null,
            nowMs: 1_005_000,
          }),
        'validation-error',
      )
    },
  )

  it.each([...INVALID_CANONICAL_IDS, { label: 'null', value: null }])(
    'rejects invalid vote.accountId ($label) in projectSessionSnapshot',
    ({ value }) => {
      expectPokerDomainError(
        () =>
          projectSessionSnapshot({
            meta: makeActiveMeta({ updatedAt: 1_000_000 }),
            votes: [{ accountId: value as string, displayName: 'Alice', card: '5', votedAt: 1_000_000 }],
            viewerAccountId: 'acc-1',
            storyPointsField: null,
            nowMs: 1_005_000,
          }),
        'validation-error',
      )
    },
  )

  it.each([
    {
      label: 'null params',
      invoke: () => projectSessionSnapshot(null as unknown as ProjectSessionParams),
    },
    {
      label: 'invalid meta.status ("idle")',
      invoke: () =>
        projectSessionSnapshot({
          meta: makeActiveMeta({ status: 'idle' as RoundStatus }),
          votes: [],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
    },
    {
      label: 'invalid meta.overrideScore (4)',
      invoke: () =>
        projectSessionSnapshot({
          meta: makeActiveMeta({ status: 'revealed', overrideScore: 4 as FibonacciScore }),
          votes: [],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
    },
    {
      label: 'invalid meta.overrideScore (-0)',
      invoke: () =>
        projectSessionSnapshot({
          meta: makeActiveMeta({ status: 'revealed', overrideScore: -0 as FibonacciScore }),
          votes: [],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
    },
    {
      label: 'non-array votes',
      invoke: () =>
        projectSessionSnapshot({
          meta: makeActiveMeta(),
          votes: null as unknown as readonly VoteRecord[],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
    },
    {
      label: 'invalid vote.card ("4")',
      invoke: () =>
        projectSessionSnapshot({
          meta: makeActiveMeta(),
          votes: [{ accountId: 'acc-1', displayName: 'Alice', card: '4' as '3', votedAt: 1_000_000 }],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
    },
    {
      label: 'non-finite vote.votedAt (NaN)',
      invoke: () =>
        projectSessionSnapshot({
          meta: makeActiveMeta(),
          votes: [{ accountId: 'acc-1', displayName: 'Alice', card: '5', votedAt: Number.NaN }],
          viewerAccountId: 'acc-1',
          storyPointsField: null,
          nowMs: 1_005_000,
        }),
    },
  ])('rejects $label in projectSessionSnapshot with PokerDomainError validation-error', ({ invoke }) => {
    expectPokerDomainError(invoke, 'validation-error')
  })
})
