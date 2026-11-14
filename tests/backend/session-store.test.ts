import { describe, expect, it } from 'vitest'
import { SESSION_TTL_MS } from '../../src/domain/session-view'
import type { RoundMeta, VoteRecord } from '../../src/domain/types'
import {
  assertSafeIdentifier,
  buildMetaKey,
  buildRoundActivityKey,
  buildRoundClosedKey,
  buildRoundOverrideKey,
  buildRoundStatusKey,
  buildVoteKey,
  buildVoteKeyPrefix,
  createSessionStore,
  KVS_QUERY_LIMIT,
  KVS_TTL_24H,
  nextRoundId,
} from '../../src/storage/session-store'
import { expectAsyncPokerDomainError, expectPokerDomainError } from '../helpers/domain-errors'
import { createInMemoryKvsDouble } from '../helpers/forge-doubles'

describe('Session store identifier guards, key builders, and round progression (R2, R4, R9)', () => {
  it('exposes KVS_TTL_24H = 24 HOURS and KVS_QUERY_LIMIT = 100', () => {
    expect(KVS_TTL_24H).toEqual({ ttl: { value: 24, unit: 'HOURS' } })
    expect(KVS_QUERY_LIMIT).toBe(100)
  })

  it.each([
    { label: 'single-character identifier', value: 'a' },
    { label: 'numeric Jira issue ID string', value: '10001' },
    { label: 'Jira issue key', value: 'PROJ-42' },
    { label: 'colon-delimited Atlassian accountId', value: '712020:abcdef01-2345-6789-abcd-ef0123456789' },
    { label: 'exact 128-character upper boundary', value: 'x'.repeat(128) },
  ])('accepts valid identifier ($label) via assertSafeIdentifier', ({ value }) => {
    expect(assertSafeIdentifier(value, 'accountId')).toBe(value)
  })

  it.each([
    { label: 'empty string', value: '' },
    { label: 'whitespace-only string', value: '   ' },
    { label: 'leading space', value: ' 10001' },
    { label: 'trailing space', value: '10001 ' },
    { label: 'tab prefix', value: '\t10001' },
    { label: 'newline suffix', value: '10001\n' },
    { label: '129-character overlong identifier (max + 1)', value: 'x'.repeat(129) },
    { label: 'forward slash path separator', value: '100/01' },
    { label: 'backslash path separator', value: '100\\01' },
    { label: 'null byte character', value: '100\x00abc' },
    { label: 'numeric value instead of string', value: 10001 },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'plain object', value: { id: '10001' } },
  ])('rejects invalid identifier ($label) with PokerDomainError validation-error referencing label', ({ value }) => {
    const err = expectPokerDomainError(() => assertSafeIdentifier(value, 'issueId'), 'validation-error')
    expect(err.message).toContain('issueId')
  })

  it('constructs isolated KVS metadata and per-voter keys and rejects unsafe segments', () => {
    expect(buildMetaKey('10042')).toBe('poker:10042:meta')
    expect(buildVoteKeyPrefix('10042', 'round-3')).toBe('poker:10042:round-3:vote:')
    expect(buildVoteKey('10042', 'round-3', '712020:user-9')).toBe('poker:10042:round-3:vote:712020:user-9')

    expectPokerDomainError(() => buildMetaKey('bad/id'), 'validation-error')
    expectPokerDomainError(() => buildVoteKeyPrefix('10042', ' round-1'), 'validation-error')
    expectPokerDomainError(() => buildVoteKey('10042', 'round-1', 'bad\\acc'), 'validation-error')
  })

  it.each([
    { previous: undefined, expected: 'round-1', label: 'undefined -> round-1' },
    { previous: null, expected: 'round-1', label: 'null -> round-1' },
    { previous: 'round-1', expected: 'round-2', label: 'round-1 -> round-2' },
    { previous: 'round-99', expected: 'round-100', label: 'round-99 -> round-100' },
    { previous: 'r-2', expected: 'r-3', label: 'r-2 -> r-3' },
    {
      previous: 'round-9007199254740993',
      expected: 'round-9007199254740994',
      label: 'BigInt precision beyond MAX_SAFE_INTEGER',
    },
    { previous: 'custom', expected: 'custom-2', label: 'non-numbered identifier appends -2' },
    { previous: 'round-0', expected: 'round-0-2', label: 'zero suffix appends -2' },
  ])('computes deterministic nextRoundId ($label)', ({ previous, expected }) => {
    expect(nextRoundId(previous)).toBe(expected)
  })

  it.each(['', '   ', ' round-1', 'round/1'])(
    'rejects invalid previousRoundId "%s" in nextRoundId with validation-error',
    (invalidRoundId) => {
      expectPokerDomainError(() => nextRoundId(invalidRoundId), 'validation-error')
    },
  )
})

describe('SessionStore round metadata, voter records, 24h TTL, and pagination (R2, R3, R4, R9)', () => {
  it('persists and reads RoundMeta with 24-hour TTL and returns null when absent or malformed in KVS', async () => {
    const kvsDouble = createInMemoryKvsDouble()
    const store = createSessionStore(kvsDouble.client)

    expect(await store.getRoundMeta('10001')).toBeNull()

    const validMeta: RoundMeta = {
      roundId: 'round-1',
      status: 'revealed',
      overrideScore: 8,
      updatedAt: 5_000_000,
    }
    await store.setRoundMeta('10001', validMeta)

    expect(kvsDouble.getSetOptions('poker:10001:meta')).toEqual(KVS_TTL_24H)
    expect(await store.getRoundMeta('10001')).toEqual(validMeta)

    // Malformed metadata in KVS safely degrades to null
    kvsDouble.seedRaw('poker:10002:meta', {
      roundId: 'round-1',
      status: 'corrupted-status',
      overrideScore: 4,
      updatedAt: 5_000_000,
    })
    expect(await store.getRoundMeta('10002')).toBeNull()

    await expectAsyncPokerDomainError(
      () =>
        store.setRoundMeta('10001', {
          roundId: 'round-1',
          status: 'revealed',
          overrideScore: 4 as unknown as RoundMeta['overrideScore'],
          updatedAt: 5_000_000,
        }),
      'validation-error',
    )
  })

  it('persists, normalizes, reads, and deletes isolated VoterRecords with 24-hour TTL', async () => {
    const kvsDouble = createInMemoryKvsDouble()
    const store = createSessionStore(kvsDouble.client)

    expect(await store.getVoterRecord('10001', 'round-1', '712020:alice')).toBeNull()

    await store.setVoterRecord('10001', 'round-1', {
      accountId: '712020:alice',
      displayName: '   ',
      avatarUrl: '  https://avatar.atlassian.example/alice.png  ',
      card: '13',
      votedAt: 10_000,
    })

    const expectedKey = 'poker:10001:round-1:vote:712020:alice'
    expect(kvsDouble.getSetOptions(expectedKey)).toEqual(KVS_TTL_24H)
    expect(await store.getVoterRecord('10001', 'round-1', '712020:alice')).toEqual<VoteRecord>({
      accountId: '712020:alice',
      displayName: 'Unknown User',
      avatarUrl: 'https://avatar.atlassian.example/alice.png',
      card: '13',
      votedAt: 10_000,
    })

    await store.deleteVoterRecord('10001', 'round-1', '712020:alice')
    expect(await store.getVoterRecord('10001', 'round-1', '712020:alice')).toBeNull()

    // Malformed voter record in KVS returns null
    kvsDouble.seedRaw('poker:10001:round-1:vote:712020:bad', {
      accountId: '712020:bad',
      displayName: 'Bad Card Voter',
      card: '99',
      votedAt: 10_000,
    })
    expect(await store.getVoterRecord('10001', 'round-1', '712020:bad')).toBeNull()
  })

  it('enforces exact 24-hour expiry boundary on listVoterRecords (86_399_999 ms active, negative skew active, >= 86_400_000 ms expired)', async () => {
    const kvsDouble = createInMemoryKvsDouble()
    const store = createSessionStore(kvsDouble.client)
    const nowMs = 100_000_000

    kvsDouble.seedVoteRecord('10001', 'round-1', {
      accountId: 'acc-just-active',
      displayName: 'Active Boundary Voter',
      avatarUrl: null,
      card: '3',
      votedAt: nowMs - (SESSION_TTL_MS - 1), // elapsed = 86_399_999 ms
    })
    kvsDouble.seedVoteRecord('10001', 'round-1', {
      accountId: 'acc-clock-skew',
      displayName: 'Future Skew Voter',
      avatarUrl: null,
      card: '5',
      votedAt: nowMs + 500, // negative elapsed = -500 ms
    })
    kvsDouble.seedVoteRecord('10001', 'round-1', {
      accountId: 'acc-exact-expired',
      displayName: 'Exact Expired Voter',
      avatarUrl: null,
      card: '8',
      votedAt: nowMs - SESSION_TTL_MS, // elapsed = 86_400_000 ms
    })
    kvsDouble.seedVoteRecord('10001', 'round-1', {
      accountId: 'acc-older-expired',
      displayName: 'Older Expired Voter',
      avatarUrl: null,
      card: '13',
      votedAt: nowMs - SESSION_TTL_MS - 10_000,
    })
    // Unrelated round and issue records must not leak
    kvsDouble.seedVoteRecord('10001', 'round-2', {
      accountId: 'acc-other-round',
      displayName: 'Other Round',
      avatarUrl: null,
      card: '21',
      votedAt: nowMs,
    })
    kvsDouble.seedVoteRecord('10002', 'round-1', {
      accountId: 'acc-other-issue',
      displayName: 'Other Issue',
      avatarUrl: null,
      card: '1',
      votedAt: nowMs,
    })

    const activeRecords = await store.listVoterRecords('10001', 'round-1', nowMs)
    expect(activeRecords.map((v) => v.accountId).sort()).toEqual(['acc-clock-skew', 'acc-just-active'])

    await expectAsyncPokerDomainError(() => store.listVoterRecords('10001', 'round-1', Number.NaN), 'validation-error')
  })

  it('paginates >100 voter records across all nextCursor pages in listVoterRecords and deletes 100% in deleteRoundVotes without mid-scan cursor truncation', async () => {
    const kvsDouble = createInMemoryKvsDouble()
    const store = createSessionStore(kvsDouble.client)
    const nowMs = 50_000_000

    for (let i = 1; i <= 125; i += 1) {
      const padded = String(i).padStart(3, '0')
      kvsDouble.seedVoteRecord('10001', 'round-1', {
        accountId: `712020:voter-${padded}`,
        displayName: `Voter ${padded}`,
        avatarUrl: null,
        card: i % 2 === 0 ? '5' : '8',
        votedAt: nowMs - 1_000 + i,
      })
    }
    // Keep a vote in round-2 on the same issue to verify scoped deletion
    kvsDouble.seedVoteRecord('10001', 'round-2', {
      accountId: '712020:next-round-voter',
      displayName: 'Next Round Voter',
      avatarUrl: null,
      card: '3',
      votedAt: nowMs,
    })

    const loaded = await store.listVoterRecords('10001', 'round-1', nowMs)
    expect(loaded).toHaveLength(125)

    const queryOpsDuringRead = kvsDouble.operations.filter((op) => op.op === 'query')
    expect(queryOpsDuringRead.length).toBeGreaterThanOrEqual(2)

    kvsDouble.resetOperations()
    const deletedCount = await store.deleteRoundVotes('10001', 'round-1')
    expect(deletedCount).toBe(125)
    expect(kvsDouble.keysWithPrefix('poker:10001:round-1:vote:')).toHaveLength(0)
    expect(kvsDouble.keysWithPrefix('poker:10001:round-2:vote:')).toHaveLength(1)

    // Verify all query pages completed before the first delete operation ran
    const firstDeleteIdx = kvsDouble.operations.findIndex((op) => op.op === 'delete')
    const lastQueryIdx = kvsDouble.operations.map((op) => op.op).lastIndexOf('query')
    expect(lastQueryIdx).toBeGreaterThanOrEqual(1)
    expect(firstDeleteIdx).toBeGreaterThan(lastQueryIdx)
  })

  it('maintains monotonic per-round status, override, activity, and closed tombstones even if base meta is overwritten', async () => {
    const kvsDouble = createInMemoryKvsDouble()
    const store = createSessionStore(kvsDouble.client)

    expect(buildRoundStatusKey('10042', 'round-1')).toBe('poker:10042:round-1:status')
    expect(buildRoundOverrideKey('10042', 'round-1')).toBe('poker:10042:round-1:override')
    expect(buildRoundActivityKey('10042', 'round-1')).toBe('poker:10042:round-1:activity')
    expect(buildRoundClosedKey('10042', 'round-1')).toBe('poker:10042:round-1:closed')

    await store.initializeRound('10042', 'round-1', 1_000)
    await store.touchRoundActivity('10042', 'round-1', 2_000)
    expect(await store.getRoundMeta('10042')).toEqual({
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 2_000,
    })

    await store.markRoundRevealed('10042', 'round-1', 3_000)
    await store.setRoundOverride('10042', 'round-1', 13, 4_000)

    // Even if a delayed writer overwrites raw poker:10042:meta back to voting/null, per-round keys preserve revealed + override
    kvsDouble.seedRoundMeta('10042', {
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 1_500,
    })
    expect(await store.getRoundMeta('10042')).toEqual({
      roundId: 'round-1',
      status: 'revealed',
      overrideScore: 13,
      updatedAt: 4_000,
    })

    // Advancing round-1 -> round-2 writes round-1:closed so stale round-1 meta writes still resolve to round-2
    await store.advanceRound('10042', 'round-1', 'round-2', 5_000)
    kvsDouble.seedRoundMeta('10042', {
      roundId: 'round-1',
      status: 'voting',
      overrideScore: null,
      updatedAt: 1_500,
    })
    expect(await store.getRoundMeta('10042')).toEqual({
      roundId: 'round-2',
      status: 'voting',
      overrideScore: null,
      updatedAt: 5_000,
    })
  })
})
