import api, { type Route, assumeTrustedRoute, route } from '@forge/api'
import { validateFibonacciScore } from '../domain/deck'
import { detectStoryPointsField } from '../domain/jira-fields'
import { FALLBACK_DISPLAY_NAME, normalizeDisplayName } from '../domain/session-view'
import type { FibonacciScore, StoryPointsFieldInfo } from '../domain/types'
import { type BackendLogger, REDACTED_VALUE, createBackendLogger, sanitizeLogMetadata } from '../observability/logger'
import { assertSafeIdentifier } from '../storage/session-store'

const AVATAR_SIZE_PREFERENCE = ['24x24', '32x32', '48x48', '16x16'] as const

export interface VoterProfile {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export type ApplyStoryPointsFailureReason = 'missing-field' | 'forbidden' | 'jira-error'

export type JiraWriteStoryPointsOutcome =
  | {
      readonly ok: true
      readonly appliedScore: FibonacciScore
      readonly fieldId: string
      readonly fieldName: string
    }
  | {
      readonly ok: false
      readonly reason: ApplyStoryPointsFailureReason
      readonly score: FibonacciScore
      readonly message: string
    }

export interface JiraResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface JiraRequestInit {
  readonly method?: 'GET' | 'PUT'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export type JiraRequester = (path: Route | string, init?: JiraRequestInit) => Promise<JiraResponseLike>

export interface CreateJiraClientDeps {
  readonly requestAsUser?: JiraRequester
  readonly logger?: BackendLogger
}

export interface JiraClient {
  getCurrentUserProfile(): Promise<VoterProfile>
  getEditableStoryPointsField(issueId: string): Promise<StoryPointsFieldInfo | null>
  updateStoryPoints(issueId: string, score: FibonacciScore): Promise<JiraWriteStoryPointsOutcome>
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pickTrimmedNonEmptyString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return null
}

function extractAvatarUrl(body: Record<string, unknown>): string | null {
  const topLevel = pickTrimmedNonEmptyString(body.avatarUrl)
  if (topLevel !== null) {
    return topLevel
  }

  const avatarUrls = body.avatarUrls
  if (isNonNullObject(avatarUrls)) {
    for (const sizeKey of AVATAR_SIZE_PREFERENCE) {
      const candidate = pickTrimmedNonEmptyString(avatarUrls[sizeKey])
      if (candidate !== null) {
        return candidate
      }
    }
  }

  return null
}

function scrubMessageText(raw: string): string {
  const sanitized = sanitizeLogMetadata({ msg: raw.trim() }).msg
  if (typeof sanitized === 'string' && sanitized.length > 0 && sanitized !== REDACTED_VALUE) {
    return sanitized
  }
  return ''
}

async function extractJiraErrorMessage(response: JiraResponseLike, fallback: string): Promise<string> {
  try {
    const body = await response.json()
    if (!isNonNullObject(body)) {
      return fallback
    }

    const messages: string[] = []

    if (Array.isArray(body.errorMessages)) {
      for (const item of body.errorMessages) {
        if (typeof item === 'string') {
          const cleaned = scrubMessageText(item)
          if (cleaned.length > 0) {
            messages.push(cleaned)
          }
        }
      }
    }

    if (isNonNullObject(body.errors)) {
      for (const errText of Object.values(body.errors)) {
        if (typeof errText === 'string') {
          const cleaned = scrubMessageText(errText)
          if (cleaned.length > 0) {
            messages.push(cleaned)
          }
        }
      }
    }

    if (messages.length > 0) {
      return messages.join('; ')
    }
  } catch {
    return fallback
  }

  return fallback
}

const defaultRequestAsUser: JiraRequester = (path, init) => {
  const routePath = typeof path === 'string' ? assumeTrustedRoute(path) : path
  if (init === undefined) {
    return api.asUser().requestJira(routePath)
  }
  return api.asUser().requestJira(routePath, {
    method: init.method,
    headers: init.headers !== undefined ? { ...init.headers } : undefined,
    body: init.body,
  })
}

export function createJiraClient(deps?: CreateJiraClientDeps): JiraClient {
  const requestAsUser = deps?.requestAsUser ?? defaultRequestAsUser
  const logger = deps?.logger ?? createBackendLogger()

  return {
    async getCurrentUserProfile(): Promise<VoterProfile> {
      let response: JiraResponseLike
      try {
        response = await requestAsUser(route`/rest/api/3/myself`, {
          headers: { Accept: 'application/json' },
        })
      } catch (error: unknown) {
        logger.warn('jira.myself_failed', { error })
        return { displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null }
      }

      if (!response.ok) {
        logger.warn('jira.myself_failed', { status: response.status })
        return { displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null }
      }

      try {
        const body = await response.json()
        if (!isNonNullObject(body)) {
          logger.warn('jira.myself_failed', { status: response.status })
          return { displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null }
        }

        const rawDisplayName = typeof body.displayName === 'string' ? body.displayName : null
        return {
          displayName: normalizeDisplayName(rawDisplayName),
          avatarUrl: extractAvatarUrl(body),
        }
      } catch (error: unknown) {
        logger.warn('jira.myself_failed', { status: response.status, error })
        return { displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null }
      }
    },

    async getEditableStoryPointsField(issueId: string): Promise<StoryPointsFieldInfo | null> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')

      let response: JiraResponseLike
      try {
        response = await requestAsUser(route`/rest/api/3/issue/${validIssueId}/editmeta`, {
          headers: { Accept: 'application/json' },
        })
      } catch (error: unknown) {
        logger.warn('jira.editmeta_failed', { issueId: validIssueId, error })
        return null
      }

      if (response.status === 401 || response.status === 403) {
        return null
      }

      if (!response.ok) {
        logger.warn('jira.editmeta_failed', { issueId: validIssueId, status: response.status })
        return null
      }

      try {
        const editMetaJson = await response.json()
        return detectStoryPointsField(editMetaJson)
      } catch (error: unknown) {
        logger.warn('jira.editmeta_failed', { issueId: validIssueId, status: response.status, error })
        return null
      }
    },

    async updateStoryPoints(issueId: string, score: FibonacciScore): Promise<JiraWriteStoryPointsOutcome> {
      const validIssueId = assertSafeIdentifier(issueId, 'issueId')
      const validScore = validateFibonacciScore(score)

      let editMetaResponse: JiraResponseLike
      try {
        editMetaResponse = await requestAsUser(route`/rest/api/3/issue/${validIssueId}/editmeta`, {
          headers: { Accept: 'application/json' },
        })
      } catch (error: unknown) {
        logger.error('jira.editmeta_write_check_failed', { issueId: validIssueId, error })
        return {
          ok: false,
          reason: 'jira-error',
          score: validScore,
          message: 'Failed to inspect editable Jira fields due to a transport error.',
        }
      }

      if (editMetaResponse.status === 401 || editMetaResponse.status === 403) {
        return {
          ok: false,
          reason: 'forbidden',
          score: validScore,
          message: 'You do not have permission to edit Story Points on this Jira issue.',
        }
      }

      if (!editMetaResponse.ok) {
        const fallback = `Failed to inspect editable Jira fields (HTTP ${editMetaResponse.status}).`
        const message = await extractJiraErrorMessage(editMetaResponse, fallback)
        logger.error('jira.editmeta_write_check_failed', {
          issueId: validIssueId,
          status: editMetaResponse.status,
        })
        return {
          ok: false,
          reason: 'jira-error',
          score: validScore,
          message,
        }
      }

      let editMetaJson: unknown
      try {
        editMetaJson = await editMetaResponse.json()
      } catch (error: unknown) {
        logger.error('jira.editmeta_write_check_failed', {
          issueId: validIssueId,
          status: editMetaResponse.status,
          error,
        })
        return {
          ok: false,
          reason: 'jira-error',
          score: validScore,
          message: 'Received malformed metadata while inspecting editable Jira fields.',
        }
      }

      const detectedField = detectStoryPointsField(editMetaJson)
      if (detectedField === null) {
        return {
          ok: false,
          reason: 'missing-field',
          score: validScore,
          message: 'No editable Story Points field is available on this issue screen.',
        }
      }

      let putResponse: JiraResponseLike
      try {
        putResponse = await requestAsUser(route`/rest/api/3/issue/${validIssueId}`, {
          method: 'PUT',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              [detectedField.fieldId]: validScore,
            },
          }),
        })
      } catch (error: unknown) {
        logger.error('jira.update_story_points_failed', { issueId: validIssueId, error })
        return {
          ok: false,
          reason: 'jira-error',
          score: validScore,
          message: 'Failed to update Story Points in Jira due to a transport error.',
        }
      }

      if (putResponse.ok) {
        return {
          ok: true,
          appliedScore: validScore,
          fieldId: detectedField.fieldId,
          fieldName: detectedField.fieldName,
        }
      }

      if (putResponse.status === 401 || putResponse.status === 403) {
        const fallback = 'You do not have permission to update Story Points on this Jira issue.'
        const message = await extractJiraErrorMessage(putResponse, fallback)
        return {
          ok: false,
          reason: 'forbidden',
          score: validScore,
          message,
        }
      }

      const fallback = `Failed to update Story Points in Jira (HTTP ${putResponse.status}).`
      const message = await extractJiraErrorMessage(putResponse, fallback)
      logger.error('jira.update_story_points_failed', {
        issueId: validIssueId,
        status: putResponse.status,
      })
      return {
        ok: false,
        reason: 'jira-error',
        score: validScore,
        message,
      }
    },
  }
}
