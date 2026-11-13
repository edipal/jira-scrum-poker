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

const VALID_FIBONACCI_SCORES: ReadonlySet<number> = new Set<number>([0, 1, 2, 3, 5, 8, 13, 21])

export function formatScoreForClipboard(score: FibonacciScore): string {
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    Object.is(score, -0) ||
    !VALID_FIBONACCI_SCORES.has(score)
  ) {
    throw new RangeError('Score must be a valid Fibonacci score (0, 1, 2, 3, 5, 8, 13, or 21)')
  }
  return String(score)
}

export async function copyScoreToClipboard(score: FibonacciScore, env?: CopyScoreEnv): Promise<CopyScoreResult> {
  const text = formatScoreForClipboard(score)

  const clipboard: ClipboardWriteApiLike | null | undefined =
    env !== undefined && env !== null && 'clipboard' in env
      ? env.clipboard
      : typeof navigator !== 'undefined'
        ? navigator.clipboard
        : null

  const doc: LegacyCopyDocumentLike | null | undefined =
    env !== undefined && env !== null && 'document' in env
      ? env.document
      : typeof document !== 'undefined'
        ? (document as LegacyCopyDocumentLike)
        : null

  if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return {
        ok: true,
        text,
        method: 'clipboard-api',
      }
    } catch {
      // Fall through to legacy hidden textarea execCommand path
    }
  }

  if (doc !== null && doc !== undefined && doc.body !== null && doc.body !== undefined) {
    if (typeof doc.execCommand === 'function') {
      let textarea: HTMLTextAreaElement | null = null
      let appended = false
      try {
        textarea = doc.createElement('textarea')
        textarea.value = text
        textarea.readOnly = true
        if (typeof textarea.setAttribute === 'function') {
          textarea.setAttribute('aria-hidden', 'true')
        }
        if (textarea.style !== undefined && textarea.style !== null) {
          textarea.style.position = 'fixed'
          textarea.style.top = '-9999px'
          textarea.style.left = '-9999px'
          textarea.style.opacity = '0'
          textarea.style.pointerEvents = 'none'
        }
        doc.body.appendChild(textarea)
        appended = true
        if (typeof textarea.focus === 'function') {
          textarea.focus()
        }
        if (typeof textarea.select === 'function') {
          textarea.select()
        }
        const copied = doc.execCommand('copy')
        if (copied === true) {
          return {
            ok: true,
            text,
            method: 'exec-command',
          }
        }
      } catch {
        // Fall through to inline manual-copy fallback message
      } finally {
        if (appended && textarea !== null) {
          try {
            if (textarea.parentNode !== null && textarea.parentNode !== undefined) {
              textarea.parentNode.removeChild(textarea)
            } else if (typeof textarea.remove === 'function') {
              textarea.remove()
            } else if (typeof doc.body.removeChild === 'function') {
              doc.body.removeChild(textarea)
            }
          } catch {
            // Ignore cleanup errors on synthetic DOM doubles
          }
        }
      }
    }
  }

  return {
    ok: false,
    text,
    message: `Clipboard unavailable — copy score manually: ${text}`,
  }
}
