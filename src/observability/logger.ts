export const REQUIRED_FORGE_SCOPES: readonly string[] = Object.freeze([
  'storage:app',
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
] as const)

export const REDACTED_VALUE = '[REDACTED]'

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

export function sanitizeLogMetadata(_metadata: unknown): Record<string, unknown> {
  throw new Error('not implemented')
}

export function createBackendLogger(_options?: CreateBackendLoggerOptions): BackendLogger {
  throw new Error('not implemented')
}

export function validatePlatformManifest(_manifestYaml: string): ManifestValidationResult {
  throw new Error('not implemented')
}
