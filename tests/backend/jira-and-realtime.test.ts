import { describe, expect, it } from 'vitest'
import type { FibonacciScore } from '../../src/domain/types'
import { createJiraClient } from '../../src/jira/jira-client'
import { createBackendLogger } from '../../src/observability/logger'
import { createRealtimePublisher, POKER_REALTIME_CHANNEL } from '../../src/realtime/publisher'
import { expectAsyncPokerDomainError } from '../helpers/domain-errors'
import {
  createFakeJiraDouble,
  createFakeRealtimeDouble,
  createMemoryLogSink,
  jsonJiraResponse,
  malformedJsonJiraResponse,
} from '../helpers/forge-doubles'

describe('Realtime publisher channel events, redaction, and best-effort resilience (R5, R11, R14)', () => {
  it('exposes POKER_REALTIME_CHANNEL as "scrum-poker" and publishes card-free, PII-free events', async () => {
    expect(POKER_REALTIME_CHANNEL).toBe('scrum-poker')

    const realtimeDouble = createFakeRealtimeDouble()
    const logDouble = createMemoryLogSink()
    const logger = createBackendLogger({ sink: logDouble.sink, now: () => 1_700_000_000_000 })
    const publisher = createRealtimePublisher({ publish: realtimeDouble.publish, logger })

    await publisher.publishSessionUpdated('round-2', 25_000)
    await publisher.publishPointsApplied('round-3', 0, 30_000)
    await publisher.publishPointsApplied('round-4', 13, 35_000)

    expect(realtimeDouble.events).toEqual([
      {
        channel: 'scrum-poker',
        payload: {
          type: 'SESSION_UPDATED',
          roundId: 'round-2',
          updatedAt: 25_000,
        },
      },
      {
        channel: 'scrum-poker',
        payload: {
          type: 'points-applied',
          roundId: 'round-3',
          score: 0,
          updatedAt: 30_000,
        },
      },
      {
        channel: 'scrum-poker',
        payload: {
          type: 'points-applied',
          roundId: 'round-4',
          score: 13,
          updatedAt: 35_000,
        },
      },
    ])

    for (const published of realtimeDouble.events) {
      const keys = Object.keys(published.payload)
      expect(keys).not.toContain('card')
      expect(keys).not.toContain('cards')
      expect(keys).not.toContain('viewerCard')
      expect(keys).not.toContain('participants')
      expect(keys).not.toContain('accountId')
      expect(keys).not.toContain('emailAddress')
    }
    expect(logDouble.warnRaw).toHaveLength(0)
    expect(logDouble.errorRaw).toHaveLength(0)
  })

  it('rejects invalid roundId, non-finite updatedAt, or non-Fibonacci score with validation-error', async () => {
    const realtimeDouble = createFakeRealtimeDouble()
    const logDouble = createMemoryLogSink()
    const logger = createBackendLogger({ sink: logDouble.sink, now: () => 1_000 })
    const publisher = createRealtimePublisher({ publish: realtimeDouble.publish, logger })

    await expectAsyncPokerDomainError(() => publisher.publishSessionUpdated('', 1_000), 'validation-error')
    await expectAsyncPokerDomainError(
      () => publisher.publishSessionUpdated('round-1', Number.POSITIVE_INFINITY),
      'validation-error',
    )
    await expectAsyncPokerDomainError(() => publisher.publishPointsApplied('bad/id', 5, 1_000), 'validation-error')
    await expectAsyncPokerDomainError(
      () => publisher.publishPointsApplied('round-1', 4 as unknown as FibonacciScore, 1_000),
      'validation-error',
    )
    await expectAsyncPokerDomainError(
      () => publisher.publishPointsApplied('round-1', 5, Number.NaN),
      'validation-error',
    )
    expect(realtimeDouble.events).toHaveLength(0)
  })

  it('degrades gracefully when @forge/realtime publish rejects, logging a redacted WARN entry without rethrowing', async () => {
    const realtimeDouble = createFakeRealtimeDouble()
    realtimeDouble.setFailure(new Error('Bearer leaked-secret-token rejected for user@company.io'))
    const logDouble = createMemoryLogSink()
    const logger = createBackendLogger({ sink: logDouble.sink, now: () => Date.parse('2026-11-13T12:00:00.000Z') })
    const publisher = createRealtimePublisher({ publish: realtimeDouble.publish, logger })

    await expect(publisher.publishSessionUpdated('round-1', 10_000)).resolves.toBeUndefined()
    await expect(publisher.publishPointsApplied('round-2', 8, 20_000)).resolves.toBeUndefined()

    const warnEntries = logDouble.parsedWarnEntries()
    expect(warnEntries).toHaveLength(2)
    expect(warnEntries[0]?.event).toBe('realtime.publish_failed')
    expect(warnEntries[1]?.event).toBe('realtime.publish_failed')

    const serializedLogs = logDouble.allSerialized()
    expect(serializedLogs).not.toContain('leaked-secret-token')
    expect(serializedLogs).not.toContain('user@company.io')
  })
})

describe('JiraClient current-user profile lookup and PII stripping (R5, R14)', () => {
  it('fetches /rest/api/3/myself, normalizes displayName, applies avatarUrl priority order, and strips emailAddress', async () => {
    const logDouble = createMemoryLogSink()
    const logger = createBackendLogger({ sink: logDouble.sink, now: () => 1_000 })

    // Priority 1: top-level avatarUrl; strips emailAddress
    const jiraTopAvatar = createFakeJiraDouble({
      onMyself: () =>
        jsonJiraResponse(200, {
          accountId: '712020:u1',
          displayName: '  Ada Lovelace  ',
          emailAddress: 'ada.private@example.com',
          avatarUrl: '  https://avatar.example/top.png  ',
          avatarUrls: { '24x24': 'https://avatar.example/24.png' },
        }),
    })
    const clientTop = createJiraClient({ requestAsUser: jiraTopAvatar.requestAsUser, logger })
    const profileTop = await clientTop.getCurrentUserProfile()
    expect(profileTop).toEqual({
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://avatar.example/top.png',
    })
    expect(JSON.stringify(profileTop)).not.toContain('ada.private@example.com')

    // Priority 2..5: avatarUrls['24x24'] -> ['32x32'] -> ['48x48'] -> ['16x16'] -> null
    const avatarMatrix: readonly {
      label: string
      avatarUrls: Record<string, string>
      expected: string | null
    }[] = [
      {
        label: '24x24 preferred over 32x32/48x48/16x16',
        avatarUrls: {
          '24x24': 'https://avatar.example/24.png',
          '32x32': 'https://avatar.example/32.png',
          '48x48': 'https://avatar.example/48.png',
          '16x16': 'https://avatar.example/16.png',
        },
        expected: 'https://avatar.example/24.png',
      },
      {
        label: '32x32 fallback when 24x24 is blank',
        avatarUrls: {
          '24x24': '   ',
          '32x32': 'https://avatar.example/32.png',
          '48x48': 'https://avatar.example/48.png',
        },
        expected: 'https://avatar.example/32.png',
      },
      {
        label: '48x48 fallback when 24x24 and 32x32 are absent',
        avatarUrls: {
          '48x48': 'https://avatar.example/48.png',
          '16x16': 'https://avatar.example/16.png',
        },
        expected: 'https://avatar.example/48.png',
      },
      {
        label: '16x16 fallback when larger sizes are absent',
        avatarUrls: {
          '16x16': 'https://avatar.example/16.png',
        },
        expected: 'https://avatar.example/16.png',
      },
      {
        label: 'null when all avatar fields are blank',
        avatarUrls: {
          '16x16': '   ',
        },
        expected: null,
      },
    ]

    for (const scenario of avatarMatrix) {
      const jiraDouble = createFakeJiraDouble({
        onMyself: () =>
          jsonJiraResponse(200, {
            displayName: '   ',
            emailAddress: 'hidden@example.com',
            avatarUrls: scenario.avatarUrls,
          }),
      })
      const client = createJiraClient({ requestAsUser: jiraDouble.requestAsUser, logger })
      expect(await client.getCurrentUserProfile()).toEqual({
        displayName: 'Unknown User',
        avatarUrl: scenario.expected,
      })
    }
  })

  it.each([
    {
      label: 'HTTP 500 error',
      responder: () => jsonJiraResponse(500, { errorMessages: ['Internal failure'] }),
    },
    {
      label: 'HTTP 403 forbidden',
      responder: () => jsonJiraResponse(403, { errorMessages: ['Forbidden'] }),
    },
    {
      label: 'malformed JSON body',
      responder: () => malformedJsonJiraResponse(200),
    },
    {
      label: 'network transport error with sensitive email/token',
      responder: () => {
        throw new Error('Bearer secret-xyz failed for alice@acme.org')
      },
    },
  ])(
    'falls back to Unknown User and logs redacted WARN when /rest/api/3/myself fails ($label)',
    async ({ responder }) => {
      const logDouble = createMemoryLogSink()
      const logger = createBackendLogger({ sink: logDouble.sink, now: () => 2_000 })
      const jiraDouble = createFakeJiraDouble({ onMyself: responder })
      const client = createJiraClient({ requestAsUser: jiraDouble.requestAsUser, logger })

      const profile = await client.getCurrentUserProfile()
      expect(profile).toEqual({
        displayName: 'Unknown User',
        avatarUrl: null,
      })
      expect(logDouble.parsedWarnEntries().length).toBeGreaterThanOrEqual(1)
      expect(logDouble.parsedWarnEntries()[0]?.event).toBe('jira.myself_failed')
      expect(logDouble.allSerialized()).not.toContain('secret-xyz')
      expect(logDouble.allSerialized()).not.toContain('alice@acme.org')
    },
  )
})

describe('JiraClient Story Points editmeta detection and atomic PUT write-back (R10, R11, R14)', () => {
  it('detects Story Points with tier precedence and lexicographical fieldId tie-breaking via GET editmeta', async () => {
    const logDouble = createMemoryLogSink()
    const logger = createBackendLogger({ sink: logDouble.sink, now: () => 3_000 })

    // Story Points takes precedence over Story point estimate, and customfield_10010 beats customfield_10020
    const jiraPrecedence = createFakeJiraDouble({
      onEditMeta: () =>
        jsonJiraResponse(200, {
          fields: {
            customfield_10001: {
              name: 'Story point estimate',
              schema: { type: 'number' },
              operations: ['set'],
            },
            customfield_10020: {
              name: '  story points ',
              schema: { type: 'number' },
              operations: ['set'],
            },
            customfield_10010: {
              name: 'Story Points',
              schema: { type: 'number' },
              operations: ['set'],
            },
          },
        }),
    })
    const clientPrecedence = createJiraClient({ requestAsUser: jiraPrecedence.requestAsUser, logger })
    expect(await clientPrecedence.getEditableStoryPointsField('10001')).toEqual({
      fieldId: 'customfield_10010',
      fieldName: 'Story Points',
    })
    expect(jiraPrecedence.calls).toHaveLength(1)
    expect(jiraPrecedence.calls[0]?.path).toBe('/rest/api/3/issue/10001/editmeta')

    // Team-managed Story point estimate when Story Points is absent or non-editable
    const jiraTeamManaged = createFakeJiraDouble({
      onEditMeta: () =>
        jsonJiraResponse(200, {
          fields: {
            customfield_10016: {
              name: 'Story Points',
              schema: { type: 'number' },
              operations: [], // read-only
            },
            customfield_10026: {
              name: '  Story point estimate  ',
              schema: { type: 'number' },
              operations: ['set'],
            },
          },
        }),
    })
    const clientTeam = createJiraClient({ requestAsUser: jiraTeamManaged.requestAsUser, logger })
    expect(await clientTeam.getEditableStoryPointsField('10001')).toEqual({
      fieldId: 'customfield_10026',
      fieldName: 'Story point estimate',
    })
  })

  it('returns null silently on 401/403 editmeta and returns null with WARN on 404/500/malformed/transport/non-matching', async () => {
    for (const status of [401, 403]) {
      const logDouble = createMemoryLogSink()
      const logger = createBackendLogger({ sink: logDouble.sink, now: () => 4_000 })
      const jiraDouble = createFakeJiraDouble({
        onEditMeta: () => jsonJiraResponse(status, { errorMessages: ['No edit permission'] }),
      })
      const client = createJiraClient({ requestAsUser: jiraDouble.requestAsUser, logger })

      expect(await client.getEditableStoryPointsField('10001')).toBeNull()
      expect(logDouble.warnRaw).toHaveLength(0)
      expect(logDouble.errorRaw).toHaveLength(0)
    }

    const faultCases: readonly {
      label: string
      responder: () => ReturnType<typeof jsonJiraResponse>
      expectsWarn: boolean
    }[] = [
      { label: '404', responder: () => jsonJiraResponse(404, {}), expectsWarn: true },
      { label: '500', responder: () => jsonJiraResponse(500, {}), expectsWarn: true },
      { label: 'malformed JSON', responder: () => malformedJsonJiraResponse(200), expectsWarn: true },
      {
        label: 'transport failure',
        responder: () => {
          throw new Error('Socket hang up for user@example.com')
        },
        expectsWarn: true,
      },
      {
        label: 'non-matching string Story Points field',
        responder: () =>
          jsonJiraResponse(200, {
            fields: {
              customfield_10099: {
                name: 'Story Points',
                schema: { type: 'string' },
                operations: ['set'],
              },
              customfield_10100: {
                name: 'Story Points Legacy',
                schema: { type: 'number' },
                operations: ['set'],
              },
            },
          }),
        expectsWarn: false,
      },
    ]

    for (const fault of faultCases) {
      const logDouble = createMemoryLogSink()
      const logger = createBackendLogger({ sink: logDouble.sink, now: () => 4_000 })
      const jiraDouble = createFakeJiraDouble({ onEditMeta: fault.responder })
      const client = createJiraClient({ requestAsUser: jiraDouble.requestAsUser, logger })

      expect(await client.getEditableStoryPointsField('10001')).toBeNull()
      if (fault.expectsWarn) {
        expect(logDouble.parsedWarnEntries().length).toBeGreaterThanOrEqual(1)
        expect(logDouble.parsedWarnEntries()[0]?.event).toBe('jira.editmeta_failed')
        expect(logDouble.allSerialized()).not.toContain('user@example.com')
      }
    }

    const jiraInvalid = createFakeJiraDouble()
    const clientInvalid = createJiraClient({ requestAsUser: jiraInvalid.requestAsUser })
    await expectAsyncPokerDomainError(() => clientInvalid.getEditableStoryPointsField('100/01'), 'validation-error')
    expect(jiraInvalid.calls).toHaveLength(0)
  })

  it('writes Story Points (including 0) via PUT /rest/api/3/issue/{issueId} and maps missing-field, forbidden, and jira-error outcomes', async () => {
    const logDouble = createMemoryLogSink()
    const logger = createBackendLogger({ sink: logDouble.sink, now: () => 5_000 })

    // Invalid inputs fail fast with zero HTTP calls
    const jiraGuard = createFakeJiraDouble()
    const clientGuard = createJiraClient({ requestAsUser: jiraGuard.requestAsUser, logger })
    await expectAsyncPokerDomainError(() => clientGuard.updateStoryPoints(' ', 5), 'validation-error')
    await expectAsyncPokerDomainError(
      () => clientGuard.updateStoryPoints('10001', 4 as unknown as FibonacciScore),
      'validation-error',
    )
    expect(jiraGuard.calls).toHaveLength(0)

    // Happy path with score 0 and score 8
    for (const score of [0, 8] as const) {
      const jiraOk = createFakeJiraDouble()
      const clientOk = createJiraClient({ requestAsUser: jiraOk.requestAsUser, logger })
      const outcome = await clientOk.updateStoryPoints('10001', score)

      expect(outcome).toEqual({
        ok: true,
        appliedScore: score,
        fieldId: 'customfield_10016',
        fieldName: 'Story Points',
      })
      expect(jiraOk.calls).toHaveLength(2)
      expect(jiraOk.calls[0]?.method).toBe('GET')
      expect(jiraOk.calls[0]?.path).toBe('/rest/api/3/issue/10001/editmeta')
      expect(jiraOk.calls[1]?.method).toBe('PUT')
      expect(jiraOk.calls[1]?.path).toBe('/rest/api/3/issue/10001')
      expect(JSON.parse(String(jiraOk.calls[1]?.body))).toEqual({
        fields: { customfield_10016: score },
      })
    }

    // Missing editable field -> missing-field with zero PUT calls
    const jiraMissing = createFakeJiraDouble({
      onEditMeta: () => jsonJiraResponse(200, { fields: {} }),
    })
    const clientMissing = createJiraClient({ requestAsUser: jiraMissing.requestAsUser, logger })
    const missingOutcome = await clientMissing.updateStoryPoints('10001', 5)
    expect(missingOutcome).toMatchObject({
      ok: false,
      reason: 'missing-field',
      score: 5,
    })
    if (!missingOutcome.ok) {
      expect(missingOutcome.message.trim().length).toBeGreaterThan(0)
    }
    expect(jiraMissing.calls).toHaveLength(1)

    // 401/403 on editmeta -> forbidden (zero PUT calls)
    for (const status of [401, 403]) {
      const jiraForbiddenMeta = createFakeJiraDouble({
        onEditMeta: () => jsonJiraResponse(status, { errorMessages: ['Forbidden'] }),
      })
      const clientForbiddenMeta = createJiraClient({ requestAsUser: jiraForbiddenMeta.requestAsUser, logger })
      const res = await clientForbiddenMeta.updateStoryPoints('10001', 13)
      expect(res).toMatchObject({ ok: false, reason: 'forbidden', score: 13 })
      expect(jiraForbiddenMeta.calls).toHaveLength(1)
    }

    // 401/403 on PUT -> forbidden
    for (const status of [401, 403]) {
      const jiraForbiddenPut = createFakeJiraDouble({
        onPutIssue: () => jsonJiraResponse(status, { errorMessages: ['No Edit Issues permission'] }),
      })
      const clientForbiddenPut = createJiraClient({ requestAsUser: jiraForbiddenPut.requestAsUser, logger })
      const res = await clientForbiddenPut.updateStoryPoints('10001', 13)
      expect(res).toMatchObject({ ok: false, reason: 'forbidden', score: 13 })
      expect(jiraForbiddenPut.calls).toHaveLength(2)
    }

    // 400 / 404 / 500 / transport error on PUT -> jira-error + redacted ERROR log
    for (const putFailure of [
      () => jsonJiraResponse(400, { errorMessages: ['Field validation failed'] }),
      () => jsonJiraResponse(404, { errorMessages: ['Issue not found'] }),
      () => jsonJiraResponse(500, { errorMessages: ['Database error for admin@acme.org'] }),
      () => {
        throw new Error('Bearer secret-put-token connection reset')
      },
    ]) {
      const putLog = createMemoryLogSink()
      const putLogger = createBackendLogger({ sink: putLog.sink, now: () => 6_000 })
      const jiraErr = createFakeJiraDouble({ onPutIssue: putFailure })
      const clientErr = createJiraClient({ requestAsUser: jiraErr.requestAsUser, logger: putLogger })
      const res = await clientErr.updateStoryPoints('10001', 21)

      expect(res).toMatchObject({ ok: false, reason: 'jira-error', score: 21 })
      if (!res.ok) {
        expect(res.message.trim().length).toBeGreaterThan(0)
      }
      expect(putLog.parsedErrorEntries().length).toBeGreaterThanOrEqual(1)
      expect(putLog.allSerialized()).not.toContain('secret-put-token')
      expect(putLog.allSerialized()).not.toContain('admin@acme.org')
    }
  })
})
