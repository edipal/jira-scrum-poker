import type { ProjectSessionParams, SessionSnapshot, StoryPointsFieldInfo } from './types'

export const SESSION_TTL_MS: number = 0

export const FALLBACK_DISPLAY_NAME: string = ''

export function isRoundExpired(_updatedAt: number, _nowMs: number): boolean {
  throw new Error('not implemented')
}

export function normalizeDisplayName(_displayName: string | null | undefined): string {
  throw new Error('not implemented')
}

export function createIdleSessionSnapshot(
  _storyPointsField: StoryPointsFieldInfo | null = null,
  _roundId: string | null = null,
): SessionSnapshot {
  throw new Error('not implemented')
}

export function projectSessionSnapshot(_params: ProjectSessionParams): SessionSnapshot {
  throw new Error('not implemented')
}
