import { describe, expect, it } from 'vitest'
import {
  cardToNumericScore,
  FIBONACCI_DECK,
  isNumericDeckCard,
  isValidDeckCard,
  isValidFibonacciScore,
  NUMERIC_FIBONACCI_SCORES,
  validateDeckCard,
  validateFibonacciScore,
} from '../../src/domain/deck'
import { type DeckCard, type FibonacciScore, PokerDomainError, type PokerErrorCode } from '../../src/domain/types'
import { expectPokerDomainError } from '../helpers/domain-errors'

const CANONICAL_DECK: readonly DeckCard[] = ['0', '1', '2', '3', '5', '8', '13', '21', '?']
const CANONICAL_SCORES: readonly FibonacciScore[] = [0, 1, 2, 3, 5, 8, 13, 21]

const INVALID_CARD_INPUTS: readonly { label: string; value: unknown }[] = [
  { label: 'empty string', value: '' },
  { label: 'whitespace-only string', value: '   ' },
  { label: 'leading whitespace-padded card (" 5")', value: ' 5' },
  { label: 'trailing whitespace-padded card ("5 ")', value: '5 ' },
  { label: 'surrounding whitespace-padded card (" 5 ")', value: ' 5 ' },
  { label: 'tab-padded card ("\\t8")', value: '\t8' },
  { label: 'whitespace-padded question card (" ? ")', value: ' ? ' },
  { label: 'negative string ("-1")', value: '-1' },
  { label: 'negative zero string ("-0")', value: '-0' },
  { label: 'plus-prefixed string ("+5")', value: '+5' },
  { label: 'zero-padded string ("05")', value: '05' },
  { label: 'decimal string ("3.5")', value: '3.5' },
  { label: 'trailing-zero decimal string ("5.0")', value: '5.0' },
  { label: 'non-Fibonacci integer ("4")', value: '4' },
  { label: 'non-Fibonacci integer ("6")', value: '6' },
  { label: 'non-Fibonacci integer ("7")', value: '7' },
  { label: 'non-Fibonacci integer ("9")', value: '9' },
  { label: 'non-Fibonacci integer ("12")', value: '12' },
  { label: 'non-Fibonacci integer ("14")', value: '14' },
  { label: 'non-Fibonacci integer ("20")', value: '20' },
  { label: 'non-Fibonacci integer ("22")', value: '22' },
  { label: 'next Fibonacci integer outside deck ("34")', value: '34' },
  { label: 'large integer ("100")', value: '100' },
  { label: 'arbitrary word ("coffee")', value: 'coffee' },
  { label: 'double question mark ("??")', value: '??' },
  { label: 'numeric 0 instead of string', value: 0 },
  { label: 'numeric 5 instead of string', value: 5 },
  { label: 'numeric 21 instead of string', value: 21 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'boolean true', value: true },
  { label: 'array containing valid card', value: ['5'] },
  { label: 'plain object', value: { card: '5' } },
]

const INVALID_SCORE_INPUTS: readonly { label: string; value: unknown }[] = [
  { label: 'negative zero (-0)', value: -0 },
  { label: 'negative integer (-1)', value: -1 },
  { label: 'negative Fibonacci (-5)', value: -5 },
  { label: 'non-Fibonacci integer (4)', value: 4 },
  { label: 'non-Fibonacci integer (6)', value: 6 },
  { label: 'non-Fibonacci integer (7)', value: 7 },
  { label: 'non-Fibonacci integer (9)', value: 9 },
  { label: 'non-Fibonacci integer (12)', value: 12 },
  { label: 'non-Fibonacci integer (14)', value: 14 },
  { label: 'upper neighbor below 21 (20)', value: 20 },
  { label: 'upper neighbor above 21 (22)', value: 22 },
  { label: 'next Fibonacci above deck (34)', value: 34 },
  { label: 'large integer (100)', value: 100 },
  { label: 'decimal midpoint (0.5)', value: 0.5 },
  { label: 'decimal (4.5)', value: 4.5 },
  { label: 'NaN', value: Number.NaN },
  { label: 'positive Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'negative Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'question mark card ("?")', value: '?' },
  { label: 'numeric string ("5")', value: '5' },
  { label: 'numeric zero string ("0")', value: '0' },
  { label: 'empty string ("")', value: '' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'boolean false', value: false },
  { label: 'array [5]', value: [5] },
  { label: 'plain object', value: { score: 5 } },
]

describe('PokerDomainError invariants', () => {
  it.each<{ code: PokerErrorCode; message: string }>([
    { code: 'validation-error', message: 'Card value is invalid' },
    { code: 'invalid-state', message: 'Round is already revealed' },
    { code: 'precondition-failed', message: 'Cannot reveal with zero votes' },
  ])('constructs Error subclass with code "$code" and exact message', ({ code, message }) => {
    const error = new PokerDomainError(code, message)
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(PokerDomainError)
    expect(error.name).toBe('PokerDomainError')
    expect(error.code).toBe(code)
    expect(error.message).toBe(message)
  })
})

describe('Fibonacci deck constants and numeric conversion (R1)', () => {
  it('exposes the exact 9 cards in canonical order via FIBONACCI_DECK', () => {
    expect(Array.isArray(FIBONACCI_DECK)).toBe(true)
    expect(FIBONACCI_DECK).toHaveLength(9)
    expect(FIBONACCI_DECK).toEqual(CANONICAL_DECK)
  })

  it('exposes the exact 8 numeric Fibonacci scores in ascending order via NUMERIC_FIBONACCI_SCORES', () => {
    expect(Array.isArray(NUMERIC_FIBONACCI_SCORES)).toBe(true)
    expect(NUMERIC_FIBONACCI_SCORES).toHaveLength(8)
    expect(NUMERIC_FIBONACCI_SCORES).toEqual(CANONICAL_SCORES)
  })

  it.each<{ card: DeckCard; expected: FibonacciScore | null }>([
    { card: '0', expected: 0 },
    { card: '1', expected: 1 },
    { card: '2', expected: 2 },
    { card: '3', expected: 3 },
    { card: '5', expected: 5 },
    { card: '8', expected: 8 },
    { card: '13', expected: 13 },
    { card: '21', expected: 21 },
    { card: '?', expected: null },
  ])('maps deck card "$card" to $expected in cardToNumericScore', ({ card, expected }) => {
    const result = cardToNumericScore(card)
    expect(result).toBe(expected)
    if (expected === 0) {
      expect(Object.is(result, 0)).toBe(true)
    }
  })

  it.each([
    { label: 'non-Fibonacci card "4"', value: '4' },
    { label: 'whitespace-padded card " 5"', value: ' 5' },
    { label: 'empty string', value: '' },
    { label: 'number 5', value: 5 },
    { label: 'null', value: null },
  ])('throws PokerDomainError validation-error when cardToNumericScore receives $label at runtime', ({ value }) => {
    expectPokerDomainError(() => cardToNumericScore(value as DeckCard), 'validation-error')
  })

  it.each(['0', '1', '2', '3', '5', '8', '13', '21'] as const)(
    'returns true from isNumericDeckCard for numeric card "%s"',
    (card) => {
      expect(isNumericDeckCard(card)).toBe(true)
    },
  )

  it.each([
    { label: 'question card "?"', value: '?' },
    { label: 'empty string', value: '' },
    { label: 'padded numeric card " 5"', value: ' 5' },
    { label: 'non-Fibonacci string "4"', value: '4' },
    { label: 'number 5', value: 5 },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
  ])('returns false from isNumericDeckCard for $label', ({ value }) => {
    expect(isNumericDeckCard(value)).toBe(false)
  })
})

describe('Deck card validation (R1)', () => {
  it.each(CANONICAL_DECK)('accepts canonical deck card "%s" in isValidDeckCard', (card) => {
    expect(isValidDeckCard(card)).toBe(true)
  })

  it.each(CANONICAL_DECK)('returns canonical deck card "%s" from validateDeckCard', (card) => {
    expect(validateDeckCard(card)).toBe(card)
  })

  it.each(INVALID_CARD_INPUTS)('returns false from isValidDeckCard for $label', ({ value }) => {
    expect(isValidDeckCard(value)).toBe(false)
  })

  it.each(INVALID_CARD_INPUTS)(
    'throws PokerDomainError validation-error from validateDeckCard for $label',
    ({ value }) => {
      expectPokerDomainError(() => validateDeckCard(value), 'validation-error')
    },
  )
})

describe('Numeric Fibonacci score validation (R1)', () => {
  it.each(CANONICAL_SCORES)('accepts Fibonacci score %d in isValidFibonacciScore', (score) => {
    expect(isValidFibonacciScore(score)).toBe(true)
  })

  it.each(CANONICAL_SCORES)('returns Fibonacci score %d from validateFibonacciScore', (score) => {
    const validated = validateFibonacciScore(score)
    expect(validated).toBe(score)
    if (score === 0) {
      expect(Object.is(validated, 0)).toBe(true)
    }
  })

  it.each(INVALID_SCORE_INPUTS)('returns false from isValidFibonacciScore for $label', ({ value }) => {
    expect(isValidFibonacciScore(value)).toBe(false)
  })

  it.each(INVALID_SCORE_INPUTS)(
    'throws PokerDomainError validation-error from validateFibonacciScore for $label',
    ({ value }) => {
      expectPokerDomainError(() => validateFibonacciScore(value), 'validation-error')
    },
  )
})
