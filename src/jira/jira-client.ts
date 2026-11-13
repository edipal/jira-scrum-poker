import type { Route } from '@forge/api'
import type { FibonacciScore, StoryPointsFieldInfo } from '../domain/types'
import type { BackendLogger } from '../observability/logger'

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

export function createJiraClient(_deps?: CreateJiraClientDeps): JiraClient {
  throw new Error('not implemented')
}
