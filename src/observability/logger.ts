import { PokerDomainError } from '../domain/types'

export const REQUIRED_FORGE_SCOPES: readonly string[] = Object.freeze([
  'storage:app',
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
] as const)

export const REDACTED_VALUE = '[REDACTED]'

const TRUNCATED_VALUE = '[TRUNCATED]'

const MAX_SANITIZE_DEPTH = 4

const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const SENSITIVE_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'card',
  'cards',
  'viewercard',
  'vote',
  'votes',
  'participants',
  'authorization',
  'cookie',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'password',
  'credential',
  'credentials',
  'email',
  'emailaddress',
])

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

const CREDENTIAL_PREFIX_PATTERN = /^\s*(Bearer|Basic)\s+\S+/i

export type LogLevel = 'WARN' | 'ERROR'

export interface StructuredLogEntry {
  readonly level: LogLevel
  readonly event: string
  readonly timestamp: string
  readonly context: Readonly<Record<string, unknown>>
}

export interface LogSink {
  readonly warn: (serializedEntry: string) => void
  readonly error: (serializedEntry: string) => void
}

export interface BackendLogger {
  warn(event: string, context?: Readonly<Record<string, unknown>>): void
  error(event: string, context?: Readonly<Record<string, unknown>>): void
}

export interface CreateBackendLoggerOptions {
  readonly sink?: LogSink
  readonly now?: () => number
}

export interface ManifestValidationResult {
  readonly valid: boolean
  readonly scopes: readonly string[]
  readonly violations: readonly string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  return SENSITIVE_NORMALIZED_KEYS.has(normalized)
}

function sanitizeStringValue(value: string): string {
  if (CREDENTIAL_PREFIX_PATTERN.test(value)) {
    return REDACTED_VALUE
  }
  if (value.includes('@') && EMAIL_PATTERN.test(value)) {
    return REDACTED_VALUE
  }
  return value
}

function sanitizeNestedValue(value: unknown, parentDepth: number): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }

  if (typeof value === 'string') {
    return sanitizeStringValue(value)
  }

  if (isPlainObject(value)) {
    const childDepth = parentDepth + 1
    if (childDepth > MAX_SANITIZE_DEPTH) {
      return TRUNCATED_VALUE
    }
    return sanitizePlainObjectAtDepth(value, childDepth)
  }

  if (Array.isArray(value)) {
    const childDepth = parentDepth + 1
    if (childDepth > MAX_SANITIZE_DEPTH) {
      return TRUNCATED_VALUE
    }
    return value.map((item: unknown) => sanitizeNestedValue(item, childDepth))
  }

  if (value instanceof Error) {
    return {
      name: sanitizeStringValue(value.name),
      message: sanitizeStringValue(value.message),
    }
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date'
  }

  return sanitizeStringValue(String(value))
}

function sanitizePlainObjectAtDepth(source: Record<string, unknown>, depth: number): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, rawVal] of Object.entries(source)) {
    if (RESERVED_OBJECT_KEYS.has(key)) {
      continue
    }
    if (isSensitiveKey(key)) {
      sanitized[key] = REDACTED_VALUE
      continue
    }
    sanitized[key] = sanitizeNestedValue(rawVal, depth)
  }

  return sanitized
}

export function sanitizeLogMetadata(metadata: unknown): Record<string, unknown> {
  if (!isPlainObject(metadata)) {
    throw new PokerDomainError('validation-error', 'Log metadata must be a plain object')
  }
  return sanitizePlainObjectAtDepth(metadata, 0)
}

const DEFAULT_LOG_SINK: LogSink = {
  warn: (serializedEntry: string) => {
    console.warn(serializedEntry)
  },
  error: (serializedEntry: string) => {
    console.error(serializedEntry)
  },
}

export function createBackendLogger(options?: CreateBackendLoggerOptions): BackendLogger {
  const sink = options?.sink ?? DEFAULT_LOG_SINK
  const now = options?.now ?? (() => Date.now())

  function emit(level: LogLevel, event: string, context: Readonly<Record<string, unknown>> = {}): void {
    const sanitizedContext = sanitizeLogMetadata(context)
    const timestampDate = new Date(now())
    const timestamp = Number.isFinite(timestampDate.getTime()) ? timestampDate.toISOString() : new Date(0).toISOString()

    const entry: StructuredLogEntry = {
      level,
      event,
      timestamp,
      context: sanitizedContext,
    }

    const serialized = JSON.stringify(entry)
    if (level === 'WARN') {
      sink.warn(serialized)
    } else {
      sink.error(serialized)
    }
  }

  return {
    warn(event: string, context: Readonly<Record<string, unknown>> = {}): void {
      emit('WARN', event, context)
    },
    error(event: string, context: Readonly<Record<string, unknown>> = {}): void {
      emit('ERROR', event, context)
    },
  }
}

function stripYamlComment(line: string): string {
  let quoteChar: "'" | '"' | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoteChar !== null) {
      if (ch === '\\' && quoteChar === '"') {
        i += 1
        continue
      }
      if (ch === quoteChar) {
        quoteChar = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quoteChar = ch
      continue
    }
    if (ch === '#') {
      const prev = i > 0 ? line[i - 1] : ' '
      if (prev === ' ' || prev === '\t') {
        return line.slice(0, i)
      }
    }
  }
  return line
}

function getLineIndent(line: string): number {
  let indent = 0
  while (indent < line.length && (line[indent] === ' ' || line[indent] === '\t')) {
    indent += 1
  }
  return indent
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1)
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function extractPermissionsScopes(uncommentedLines: readonly string[]): {
  readonly foundScopesBlock: boolean
  readonly scopes: readonly string[]
} {
  for (let i = 0; i < uncommentedLines.length; i += 1) {
    const line = uncommentedLines[i]
    if (line === undefined || line.trim().length === 0) {
      continue
    }
    const permIndent = getLineIndent(line)
    if (!/^\s*permissions\s*:\s*$/.test(line)) {
      continue
    }

    for (let j = i + 1; j < uncommentedLines.length; j += 1) {
      const childLine = uncommentedLines[j]
      if (childLine === undefined || childLine.trim().length === 0) {
        continue
      }
      const childIndent = getLineIndent(childLine)
      if (childIndent <= permIndent) {
        break
      }

      const inlineMatch = /^\s*scopes\s*:\s*\[(.*)\]\s*$/.exec(childLine)
      if (inlineMatch !== null) {
        const inner = inlineMatch[1] ?? ''
        if (inner.trim().length === 0) {
          return { foundScopesBlock: true, scopes: [] }
        }
        const parsed = inner
          .split(',')
          .map((item) => unquoteYamlScalar(item))
          .filter((item) => item.length > 0)
        return { foundScopesBlock: true, scopes: parsed }
      }

      if (/^\s*scopes\s*:\s*$/.test(childLine)) {
        const scopesIndent = childIndent
        const extracted: string[] = []

        for (let k = j + 1; k < uncommentedLines.length; k += 1) {
          const itemLine = uncommentedLines[k]
          if (itemLine === undefined || itemLine.trim().length === 0) {
            continue
          }
          const itemIndent = getLineIndent(itemLine)
          if (itemIndent < scopesIndent) {
            break
          }
          const seqMatch = /^\s*-\s*(.+?)\s*$/.exec(itemLine)
          if (itemIndent === scopesIndent && seqMatch === null) {
            break
          }
          if (seqMatch !== null) {
            const rawScope = seqMatch[1]
            if (rawScope !== undefined) {
              extracted.push(unquoteYamlScalar(rawScope))
            }
          } else {
            break
          }
        }

        return { foundScopesBlock: true, scopes: extracted }
      }
    }
  }

  return { foundScopesBlock: false, scopes: [] }
}

function hasNodejs22Runtime(uncommentedLines: readonly string[], uncommentedYaml: string): boolean {
  if (/runtime\s*:\s*\{\s*name\s*:\s*(?:['"]nodejs22\.x['"]|nodejs22\.x)\s*\}/.test(uncommentedYaml)) {
    return true
  }

  for (let i = 0; i < uncommentedLines.length; i += 1) {
    const line = uncommentedLines[i]
    if (line === undefined || line.trim().length === 0) {
      continue
    }
    if (!/^\s*runtime\s*:\s*$/.test(line)) {
      continue
    }
    const runtimeIndent = getLineIndent(line)
    for (let j = i + 1; j < uncommentedLines.length; j += 1) {
      const childLine = uncommentedLines[j]
      if (childLine === undefined || childLine.trim().length === 0) {
        continue
      }
      if (getLineIndent(childLine) <= runtimeIndent) {
        break
      }
      if (/^\s*name\s*:\s*(?:['"]nodejs22\.x['"]|nodejs22\.x)\s*$/.test(childLine)) {
        return true
      }
    }
  }

  return false
}

export function validatePlatformManifest(manifestYaml: string): ManifestValidationResult {
  if (typeof manifestYaml !== 'string') {
    throw new PokerDomainError('validation-error', 'Manifest YAML must be a string')
  }

  const violations: string[] = []

  if (manifestYaml.trim().length === 0) {
    violations.push('Manifest YAML must not be empty')
  }

  const uncommentedLines = manifestYaml.split(/\r?\n/).map((line) => stripYamlComment(line))
  const uncommentedYaml = uncommentedLines.join('\n')

  if (/^\s*external\s*:/m.test(manifestYaml) || /\bexternal\s*:/m.test(uncommentedYaml)) {
    violations.push('Manifest must not declare external egress permissions')
  }

  if (/https?:\/\//i.test(manifestYaml)) {
    violations.push('Manifest must not contain external http:// or https:// URLs')
  }

  if (!/^\s*jira:issuePanel\s*:/m.test(uncommentedYaml)) {
    violations.push('Manifest must declare module jira:issuePanel')
  }

  if (!/^\s*(?:-\s+)?title\s*:\s*(?:['"]Scrum Poker['"]|Scrum Poker)\s*$/m.test(uncommentedYaml)) {
    violations.push('Manifest must declare title: Scrum Poker')
  }

  if (!/^\s*(?:-\s+)?handler\s*:\s*(?:['"]index\.handler['"]|index\.handler)\s*$/m.test(uncommentedYaml)) {
    violations.push('Manifest must declare function handler: index.handler')
  }

  if (!hasNodejs22Runtime(uncommentedLines, uncommentedYaml)) {
    violations.push('Manifest must declare runtime name: nodejs22.x')
  }

  const { foundScopesBlock, scopes } = extractPermissionsScopes(uncommentedLines)
  if (!foundScopesBlock) {
    violations.push('Manifest must declare permissions.scopes')
  }

  const requiredSet = new Set<string>(REQUIRED_FORGE_SCOPES)
  const seenScopes = new Set<string>()
  const duplicateScopes = new Set<string>()
  const extraScopes: string[] = []

  for (const scope of scopes) {
    if (seenScopes.has(scope)) {
      duplicateScopes.add(scope)
    }
    seenScopes.add(scope)
    if (!requiredSet.has(scope)) {
      extraScopes.push(scope)
    }
  }

  const missingScopes = REQUIRED_FORGE_SCOPES.filter((reqScope) => !seenScopes.has(reqScope))

  if (missingScopes.length > 0) {
    violations.push(`Manifest is missing required scopes: ${missingScopes.join(', ')}`)
  }
  if (duplicateScopes.size > 0) {
    violations.push(`Manifest contains duplicate scopes: ${Array.from(duplicateScopes).join(', ')}`)
  }
  if (extraScopes.length > 0) {
    violations.push(`Manifest contains unexpected scopes: ${extraScopes.join(', ')}`)
  }

  return {
    valid: violations.length === 0,
    scopes,
    violations,
  }
}
