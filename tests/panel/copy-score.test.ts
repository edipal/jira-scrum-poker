import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FibonacciScore } from '../../src/domain/types'
import {
  copyScoreToClipboard,
  formatScoreForClipboard,
  type LegacyCopyDocumentLike,
} from '../../static/panel/src/clipboard/copy-score'

describe('formatScoreForClipboard and copyScoreToClipboard (R13)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const node of Array.from(document.querySelectorAll('textarea'))) {
      node.remove()
    }
  })

  it.each([
    { score: 0 as const, expected: '0' },
    { score: 1 as const, expected: '1' },
    { score: 2 as const, expected: '2' },
    { score: 3 as const, expected: '3' },
    { score: 5 as const, expected: '5' },
    { score: 8 as const, expected: '8' },
    { score: 13 as const, expected: '13' },
    { score: 21 as const, expected: '21' },
  ])('formats valid FibonacciScore $score to exact decimal text "$expected"', ({ score, expected }) => {
    expect(formatScoreForClipboard(score)).toBe(expected)
  })

  it.each([
    -0,
    -1,
    4,
    6,
    7,
    10,
    22,
    3.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '5',
    '?',
    null,
    undefined,
  ])(
    'rejects invalid score (%j) with RangeError in both formatScoreForClipboard and copyScoreToClipboard',
    async (badScore) => {
      expect(() => formatScoreForClipboard(badScore as unknown as FibonacciScore)).toThrow(RangeError)
      await expect(copyScoreToClipboard(badScore as unknown as FibonacciScore)).rejects.toThrow(RangeError)
    },
  )

  it.each([0, 5, 21] as const)(
    'copies score %d via clipboard.writeText ("clipboard-api") without appending a fallback textarea',
    async (score) => {
      const writeText = vi.fn(async (_text: string): Promise<void> => {})
      const execCommand = vi.fn((): boolean => true)
      const createElement = vi.fn((tagName: 'textarea'): HTMLTextAreaElement => document.createElement(tagName))
      const docSpy: LegacyCopyDocumentLike = {
        body: document.body,
        createElement,
        execCommand,
      }

      const result = await copyScoreToClipboard(score, {
        clipboard: { writeText },
        document: docSpy,
      })

      expect(result).toEqual({
        ok: true,
        text: String(score),
        method: 'clipboard-api',
      })
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith(String(score))
      expect(execCommand).not.toHaveBeenCalled()
      expect(createElement).not.toHaveBeenCalled()
      expect(document.querySelectorAll('textarea')).toHaveLength(0)
    },
  )

  it('falls back to a read-only hidden textarea + document.execCommand("copy") when clipboard.writeText rejects and cleans up the DOM node', async () => {
    const writeText = vi.fn(async (): Promise<void> => {
      throw new DOMException('Clipboard write blocked in iframe', 'NotAllowedError')
    })

    let observedTextareaDuringCopy: {
      inBody: boolean
      value: string
      readOnly: boolean
      ariaHidden: string | null
      focusedCalled: boolean
      selectCalled: boolean
    } | null = null

    let focusCalled = false
    let selectCalled = false

    const docDouble: LegacyCopyDocumentLike = {
      body: document.body,
      createElement(tagName: 'textarea'): HTMLTextAreaElement {
        const textarea = document.createElement(tagName)
        const origFocus = textarea.focus.bind(textarea)
        const origSelect = textarea.select.bind(textarea)
        textarea.focus = () => {
          focusCalled = true
          origFocus()
        }
        textarea.select = () => {
          selectCalled = true
          origSelect()
        }
        return textarea
      },
      execCommand(commandId: string): boolean {
        expect(commandId).toBe('copy')
        const textarea = document.body.querySelector('textarea')
        observedTextareaDuringCopy = {
          inBody: textarea !== null,
          value: textarea?.value ?? '',
          readOnly: textarea?.readOnly ?? false,
          ariaHidden: textarea?.getAttribute('aria-hidden') ?? null,
          focusedCalled: focusCalled,
          selectCalled,
        }
        return true
      },
    }

    const result = await copyScoreToClipboard(8, {
      clipboard: { writeText },
      document: docDouble,
    })

    expect(result).toEqual({
      ok: true,
      text: '8',
      method: 'exec-command',
    })
    expect(observedTextareaDuringCopy).toEqual({
      inBody: true,
      value: '8',
      readOnly: true,
      ariaHidden: 'true',
      focusedCalled: true,
      selectCalled: true,
    })
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('cleans up the fallback textarea in finally and resolves ok: false with score in message when execCommand returns false or throws', async () => {
    const falseDoc: LegacyCopyDocumentLike = {
      body: document.body,
      createElement: (tag) => document.createElement(tag),
      execCommand: () => false,
    }

    const falseResult = await copyScoreToClipboard(0, {
      clipboard: null,
      document: falseDoc,
    })
    expect(falseResult.ok).toBe(false)
    expect(falseResult.text).toBe('0')
    if (!falseResult.ok) {
      expect(falseResult.message.length).toBeGreaterThan(0)
      expect(falseResult.message).toContain('0')
    }
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)

    const throwingDoc: LegacyCopyDocumentLike = {
      body: document.body,
      createElement: (tag) => document.createElement(tag),
      execCommand: () => {
        throw new Error('execCommand unsupported')
      },
    }

    const throwResult = await copyScoreToClipboard(13, {
      clipboard: null,
      document: throwingDoc,
    })
    expect(throwResult.ok).toBe(false)
    expect(throwResult.text).toBe('13')
    if (!throwResult.ok) {
      expect(throwResult.message.length).toBeGreaterThan(0)
      expect(throwResult.message).toContain('13')
    }
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('resolves ok: false without throwing when both clipboard and document.body / execCommand are unavailable', async () => {
    const noDomResult = await copyScoreToClipboard(5, {
      clipboard: null,
      document: null,
    })
    expect(noDomResult.ok).toBe(false)
    expect(noDomResult.text).toBe('5')
    if (!noDomResult.ok) {
      expect(noDomResult.message).toContain('5')
    }

    const nullBodyResult = await copyScoreToClipboard(3, {
      clipboard: null,
      document: {
        body: null,
        createElement: (tag) => document.createElement(tag),
        execCommand: () => true,
      },
    })
    expect(nullBodyResult.ok).toBe(false)
    expect(nullBodyResult.text).toBe('3')
    if (!nullBodyResult.ok) {
      expect(nullBodyResult.message).toContain('3')
    }
  })

  it('uses global navigator.clipboard when env is omitted', async () => {
    const writeText = vi.fn(async (_text: string): Promise<void> => {})
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    })

    const result = await copyScoreToClipboard(21)
    expect(result).toEqual({
      ok: true,
      text: '21',
      method: 'clipboard-api',
    })
    expect(writeText).toHaveBeenCalledWith('21')
    vi.unstubAllGlobals()
  })
})
