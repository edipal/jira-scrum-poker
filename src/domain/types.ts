export type NumericDeckCard = '0' | '1' | '2' | '3' | '5' | '8' | '13' | '21'

export type QuestionCard = '?'

export type DeckCard = NumericDeckCard | QuestionCard

export type FibonacciScore = 0 | 1 | 2 | 3 | 5 | 8 | 13 | 21

export type RoundStatus = 'voting' | 'revealed'

export type PokerErrorCode = 'validation-error' | 'invalid-state' | 'precondition-failed'

export class PokerDomainError extends Error {
  readonly code: PokerErrorCode

  constructor(_code: PokerErrorCode, _message: string) {
    super('not implemented')
    this.code = _code
    throw new Error('not implemented')
  }
}

export interface StoryPointsFieldInfo {
  readonly fieldId: string
  readonly fieldName: string
}

export interface RoundMeta {
  readonly roundId: string
  readonly status: RoundStatus
  readonly overrideScore: FibonacciScore | null
  readonly updatedAt: number
}

export interface VoteRecord {
  readonly accountId: string
  readonly displayName: string
  readonly avatarUrl?: string | null
  readonly card: DeckCard
  readonly votedAt: number
}

export interface ParticipantView {
  readonly accountId: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly hasVoted: true
  readonly card: DeckCard | null
}

export interface ScoreSummary {
  readonly numericVoteCount: number
  readonly average: number | null
  readonly formattedAverage: string | null
  readonly recommendedScore: FibonacciScore | null
}

export interface SessionSnapshot {
  readonly roundId: string | null
  readonly status: RoundStatus
  readonly participants: readonly ParticipantView[]
  readonly viewerCard: DeckCard | null
  readonly average: number | null
  readonly formattedAverage: string | null
  readonly recommendedScore: FibonacciScore | null
  readonly targetScore: FibonacciScore | null
  readonly storyPointsField: StoryPointsFieldInfo | null
}

export interface ProjectSessionParams {
  readonly meta: RoundMeta | null
  readonly votes: readonly VoteRecord[]
  readonly viewerAccountId: string
  readonly storyPointsField: StoryPointsFieldInfo | null
  readonly nowMs: number
}
