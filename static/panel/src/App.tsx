import type React from 'react'
import type { FibonacciScore } from '../../../src/domain/types'
import type { PokerClient } from './bridge/poker-client'
import type { CopyScoreEnv, CopyScoreResult } from './clipboard/copy-score'

export type CopyScoreFn = (score: FibonacciScore, env?: CopyScoreEnv) => Promise<CopyScoreResult>

export interface ScrumPokerAppProps {
  readonly client?: PokerClient
  readonly copyScore?: CopyScoreFn
  readonly clipboardEnv?: CopyScoreEnv
}

export function ScrumPokerApp(_props?: ScrumPokerAppProps): React.JSX.Element {
  throw new Error('not implemented')
}
