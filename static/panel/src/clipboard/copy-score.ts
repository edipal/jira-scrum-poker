import type { FibonacciScore } from '../../../../src/domain/types'

export interface ClipboardWriteApiLike {
  writeText(text: string): Promise<void>
}

export interface LegacyCopyDocumentLike {
  readonly body: HTMLElement | null
  createElement(tagName: 'textarea'): HTMLTextAreaElement
  execCommand?(commandId: string): boolean
}

export interface CopyScoreEnv {
  readonly clipboard?: ClipboardWriteApiLike | null
  readonly document?: LegacyCopyDocumentLike | null
}

export type CopyScoreResult =
  | {
      readonly ok: true
      readonly text: string
      readonly method: 'clipboard-api' | 'exec-command'
    }
  | {
      readonly ok: false
      readonly text: string
      readonly message: string
    }

export function formatScoreForClipboard(_score: FibonacciScore): string {
  throw new Error('not implemented')
}

export function copyScoreToClipboard(_score: FibonacciScore, _env?: CopyScoreEnv): Promise<CopyScoreResult> {
  return Promise.reject(new Error('not implemented'))
}
