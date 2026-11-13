import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBackendLogger,
  REDACTED_VALUE,
  REQUIRED_FORGE_SCOPES,
  type StructuredLogEntry,
  sanitizeLogMetadata,
  validatePlatformManifest,
} from '../../src/observability/logger'
import { expectPokerDomainError } from '../helpers/domain-errors'
import { createMemoryLogSink } from '../helpers/forge-doubles'

const REPO_MANIFEST_YAML = readFileSync(new URL('../../manifest.yml', import.meta.url), 'utf8')

class CustomClassMetadata {
  readonly issueKey = 'SP-1'
}

describe('Platform manifest validation and Runs-on-Atlassian boundary (R14)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes frozen REQUIRED_FORGE_SCOPES and REDACTED_VALUE constants', () => {
    expect(REQUIRED_FORGE_SCOPES).toEqual(['storage:app', 'read:jira-work', 'write:jira-work', 'read:jira-user'])
    expect(Object.isFrozen(REQUIRED_FORGE_SCOPES)).toBe(true)
    expect(REDACTED_VALUE).toBe('[REDACTED]')
  })

  it('confirms repository manifest.yml declares jira:issuePanel, Scrum Poker, index.handler, nodejs22.x, 4 exact scopes, and zero egress', () => {
    const result = validatePlatformManifest(REPO_MANIFEST_YAML)
    expect(result).toEqual({
      valid: true,
      scopes: ['storage:app', 'read:jira-work', 'write:jira-work', 'read:jira-user'],
      violations: [],
    })
  })

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'number', value: 42 },
    { label: 'plain object', value: {} },
    { label: 'array', value: [] },
  ])('throws PokerDomainError validation-error when manifestYaml is $label', ({ value }) => {
    expectPokerDomainError(() => validatePlatformManifest(value as unknown as string), 'validation-error')
  })

  it.each([
    {
      label: 'empty string',
      yaml: '',
    },
    {
      label: 'whitespace-only string',
      yaml: '   \n\t  ',
    },
    {
      label: 'external permissions block',
      yaml: `${REPO_MANIFEST_YAML}\n  external:\n    fetch:\n      backend:\n        - api.example.com\n`,
    },
    {
      label: 'https external asset URL',
      yaml: REPO_MANIFEST_YAML.replace('resource:panel-assets;icon.svg', 'https://cdn.example.com/icon.svg'),
    },
    {
      label: 'http URL in manifest',
      yaml: `${REPO_MANIFEST_YAML}\n# see http://example.com\n`,
    },
    {
      label: 'missing jira:issuePanel module',
      yaml: REPO_MANIFEST_YAML.replace('jira:issuePanel:', 'jira:issueContext:'),
    },
    {
      label: 'wrong panel title',
      yaml: REPO_MANIFEST_YAML.replace('title: Scrum Poker', 'title: Other Estimator'),
    },
    {
      label: 'wrong function handler',
      yaml: REPO_MANIFEST_YAML.replace('handler: index.handler', 'handler: other.handler'),
    },
    {
      label: 'wrong Forge runtime version',
      yaml: REPO_MANIFEST_YAML.replace('name: nodejs22.x', 'name: nodejs20.x'),
    },
    {
      label: 'missing required scope read:jira-user',
      yaml: REPO_MANIFEST_YAML.replace('    - read:jira-user\n', ''),
    },
    {
      label: 'extra permission scope',
      yaml: REPO_MANIFEST_YAML.replace('    - read:jira-user', '    - read:jira-user\n    - manage:jira-configuration'),
    },
    {
      label: 'duplicate required scope',
      yaml: REPO_MANIFEST_YAML.replace('    - storage:app', '    - storage:app\n    - storage:app'),
    },
  ])('marks manifest invalid with violation details on $label', ({ yaml }) => {
    const result = validatePlatformManifest(yaml)
    expect(result.valid).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
  })
})

describe('sanitizeLogMetadata prototype validation, depth truncation, and PII/card redaction (R14)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { label: 'null', input: null },
    { label: 'undefined', input: undefined },
    { label: 'string primitive', input: 'issueId=10001' },
    { label: 'number primitive', input: 500 },
    { label: 'boolean primitive', input: false },
    { label: 'Array instance', input: ['SP-1'] },
    { label: 'Date instance', input: new Date('2026-11-13T00:00:00.000Z') },
    { label: 'Error instance', input: new Error('top-level error') },
    { label: 'Map instance', input: new Map([['k', 'v']]) },
    { label: 'Set instance', input: new Set(['v']) },
    { label: 'RegExp instance', input: /secret/ },
    { label: 'Function instance', input: () => ({}) },
    { label: 'custom class instance', input: new CustomClassMetadata() },
  ])('rejects non-plain top-level metadata ($label) with PokerDomainError validation-error', ({ input }) => {
    expectPokerDomainError(() => sanitizeLogMetadata(input), 'validation-error')
  })

  it('accepts null-prototype plain objects and ignores __proto__, constructor, and prototype own properties', () => {
    const nullProtoInput = Object.create(null) as Record<string, unknown>
    nullProtoInput.issueKey = 'SP-7'
    nullProtoInput.card = '13'
    Object.defineProperty(nullProtoInput, '__proto__', {
      value: { injected: true },
      enumerable: true,
    })
    Object.defineProperty(nullProtoInput, 'constructor', {
      value: 'ignored',
      enumerable: true,
    })
    Object.defineProperty(nullProtoInput, 'prototype', {
      value: 'ignored',
      enumerable: true,
    })

    const sanitized = sanitizeLogMetadata(nullProtoInput)
    expect(sanitized).toEqual({
      issueKey: 'SP-7',
      card: '[REDACTED]',
    })
    expect(Object.hasOwn(sanitized, '__proto__')).toBe(false)
    expect(Object.hasOwn(sanitized, 'constructor')).toBe(false)
    expect(Object.hasOwn(sanitized, 'prototype')).toBe(false)
  })

  it('redacts all sensitive vote, card, credential, and email keys case-insensitively across hyphen/underscore variants', () => {
    const sanitized = sanitizeLogMetadata({
      issueId: '10001',
      status: 500,
      card: '8',
      CARDS: ['3', '5'],
      viewerCard: '13',
      viewer_card: '21',
      vote: { card: '5' },
      votes: [{ card: '2' }],
      participants: [{ accountId: 'acc-1' }],
      Authorization: 'token-xyz',
      cookie: 'JSESSIONID=abc',
      'Set-Cookie': 'sid=123',
      token: 'tok_live_1',
      access_token: 'acc_123',
      'refresh-token': 'ref_123',
      apiKey: 'key_123',
      api_key: 'key_456',
      secret: 'shh',
      PASSWORD: 'pw',
      credential: 'cred-1',
      credentials: { user: 'a' },
      email: 'plain-text-without-at',
      emailAddress: 'alice@example.com',
      'email-address': 'bob@example.com',
    })

    expect(sanitized).toEqual({
      issueId: '10001',
      status: 500,
      card: '[REDACTED]',
      CARDS: '[REDACTED]',
      viewerCard: '[REDACTED]',
      viewer_card: '[REDACTED]',
      vote: '[REDACTED]',
      votes: '[REDACTED]',
      participants: '[REDACTED]',
      Authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'Set-Cookie': '[REDACTED]',
      token: '[REDACTED]',
      access_token: '[REDACTED]',
      'refresh-token': '[REDACTED]',
      apiKey: '[REDACTED]',
      api_key: '[REDACTED]',
      secret: '[REDACTED]',
      PASSWORD: '[REDACTED]',
      credential: '[REDACTED]',
      credentials: '[REDACTED]',
      email: '[REDACTED]',
      emailAddress: '[REDACTED]',
      'email-address': '[REDACTED]',
    })
  })

  it('recursively sanitizes nested plain objects and arrays at depth 1..4 and replaces nested containers at depth > 4 with [TRUNCATED]', () => {
    const sanitized = sanitizeLogMetadata({
      rootPrimitive: 'safe-0',
      level1: {
        l1Primitive: 'safe-1',
        level2: {
          l2Email: 'leak@company.example',
          level3: {
            l3Bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
            level4: {
              l4Safe: 'kept-at-depth-4',
              card: { nestedInsideSensitiveAtDepth4: '21' },
              level5Object: { shouldTruncate: true, secretValue: 'hidden' },
              level5Array: ['also-truncated'],
            },
          },
        },
      },
      arrDepth1: [
        [
          [
            [
              'kept-in-depth-4-array',
              'inline-email@test.io',
              { truncatedDepth5ObjInArray: 1 },
              ['truncatedDepth5NestedArray'],
            ],
          ],
        ],
      ],
    })

    expect(sanitized).toEqual({
      rootPrimitive: 'safe-0',
      level1: {
        l1Primitive: 'safe-1',
        level2: {
          l2Email: '[REDACTED]',
          level3: {
            l3Bearer: '[REDACTED]',
            level4: {
              l4Safe: 'kept-at-depth-4',
              card: '[REDACTED]',
              level5Object: '[TRUNCATED]',
              level5Array: '[TRUNCATED]',
            },
          },
        },
      },
      arrDepth1: [[[['kept-in-depth-4-array', '[REDACTED]', '[TRUNCATED]', '[TRUNCATED]']]]],
    })
  })

  it('scrubs nested Error messages, omits Error stack traces, formats Dates, and safely stringifies BigInt values', () => {
    const sensitiveError = new TypeError('Failed for user dev.lead@acme.org')
    const bearerError = new Error('   basic dXNlcjpwYXNz')
    const normalError = new RangeError('Status 503 upstream timeout')
    const validDate = new Date('2026-11-13T09:30:00.000Z')
    const invalidDate = new Date('not-a-valid-date')

    const sanitized = sanitizeLogMetadata({
      sensitiveError,
      bearerError,
      normalError,
      validDate,
      invalidDate,
      counter: 9007199254740993n,
      nullable: null,
      optional: undefined,
      flag: true,
    })

    expect(sanitized).toEqual({
      sensitiveError: { name: 'TypeError', message: '[REDACTED]' },
      bearerError: { name: 'Error', message: '[REDACTED]' },
      normalError: { name: 'RangeError', message: 'Status 503 upstream timeout' },
      validDate: '2026-11-13T09:30:00.000Z',
      invalidDate: 'Invalid Date',
      counter: '9007199254740993',
      nullable: null,
      optional: undefined,
      flag: true,
    })
    expect(() => JSON.stringify(sanitized)).not.toThrow()
  })
})

describe('createBackendLogger structured JSON emission (R14)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits sanitized WARN and ERROR JSON entries with ISO timestamps to an injected LogSink', () => {
    const logDouble = createMemoryLogSink()
    const fixedMs = Date.parse('2026-11-13T10:15:00.000Z')
    const logger = createBackendLogger({
      sink: logDouble.sink,
      now: () => fixedMs,
    })

    logger.warn('realtime.publish_failed', {
      issueKey: 'SP-42',
      viewerCard: '8',
      detail: 'Contact ops@company.org',
    })
    logger.error('jira.update_failed', {
      issueId: '10042',
      status: 500,
      authorization: 'Bearer secret-jwt-token',
    })

    expect(logDouble.parsedWarnEntries()).toEqual<StructuredLogEntry[]>([
      {
        level: 'WARN',
        event: 'realtime.publish_failed',
        timestamp: '2026-11-13T10:15:00.000Z',
        context: {
          issueKey: 'SP-42',
          viewerCard: '[REDACTED]',
          detail: '[REDACTED]',
        },
      },
    ])

    expect(logDouble.parsedErrorEntries()).toEqual<StructuredLogEntry[]>([
      {
        level: 'ERROR',
        event: 'jira.update_failed',
        timestamp: '2026-11-13T10:15:00.000Z',
        context: {
          issueId: '10042',
          status: 500,
          authorization: '[REDACTED]',
        },
      },
    ])

    const rawCombined = logDouble.allSerialized()
    expect(rawCombined).not.toContain('ops@company.org')
    expect(rawCombined).not.toContain('secret-jwt-token')
  })

  it('defaults sink to console.warn and console.error and context to empty object when omitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = createBackendLogger({
      now: () => Date.parse('2026-11-13T11:00:00.000Z'),
    })

    logger.warn('session.notice')
    logger.error('session.failure')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)

    const warnPayload = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as StructuredLogEntry
    const errorPayload = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as StructuredLogEntry

    expect(warnPayload).toEqual({
      level: 'WARN',
      event: 'session.notice',
      timestamp: '2026-11-13T11:00:00.000Z',
      context: {},
    })
    expect(errorPayload).toEqual({
      level: 'ERROR',
      event: 'session.failure',
      timestamp: '2026-11-13T11:00:00.000Z',
      context: {},
    })
  })
})
