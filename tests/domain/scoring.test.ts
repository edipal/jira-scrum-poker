import { describe, expect, it } from 'vitest'
import { calculateScoreSummary, formatAverage, snapToNearestFibonacci } from '../../src/domain/scoring'
import type { DeckCard, FibonacciScore } from '../../src/domain/types'
import { expectPokerDomainError } from '../helpers/domain-errors'

const INVALID_MEAN_INPUTS: readonly { label: string; value: unknown }[] = [
  { label: 'negative zero (-0)', value: -0 },
  { label: 'small negative decimal (-0.001)', value: -0.001 },
  { label: 'negative integer (-1)', value: -1 },
  { label: 'negative large integer (-100)', value: -100 },
  { label: 'NaN', value: Number.NaN },
  { label: 'positive Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'negative Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'numeric string ("5")', value: '5' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
]

describe('calculateScoreSummary zero-vote, question-card, and numeric mean handling (R7)', () => {
  it('includes "0" in both sum and divisor while excluding "?" votes', () => {
    const summary = calculateScoreSummary(['0', '2', '?'])
    expect(summary).toEqual({
      numericVoteCount: 2,
      average: 1,
      formattedAverage: '1',
      recommendedScore: 1,
    })
  })

  it('counts single "0" vote as numeric average 0 and recommendedScore 0', () => {
    const summary = calculateScoreSummary(['0'])
    expect(summary).toEqual({
      numericVoteCount: 1,
      average: 0,
      formattedAverage: '0',
      recommendedScore: 0,
    })
    expect(Object.is(summary.average, 0)).toBe(true)
  })

  it('includes "0" alongside higher cards when computing arithmetic mean', () => {
    const summary = calculateScoreSummary(['0', '8', '?'])
    expect(summary).toEqual({
      numericVoteCount: 2,
      average: 4,
      formattedAverage: '4',
      recommendedScore: 5,
    })
  })

  it('returns all-null score metrics when card list is empty', () => {
    expect(calculateScoreSummary([])).toEqual({
      numericVoteCount: 0,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
    })
  })

  it.each([
    { label: 'single "?" vote', cards: ['?'] as readonly DeckCard[] },
    { label: 'multiple "?" votes', cards: ['?', '?', '?'] as readonly DeckCard[] },
  ])('returns all-null score metrics for $label', ({ cards }) => {
    expect(calculateScoreSummary(cards)).toEqual({
      numericVoteCount: 0,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
    })
  })

  it.each([
    { label: 'non-array null input', input: null },
    { label: 'non-array string input', input: '5' },
    { label: 'array with non-Fibonacci card "4"', input: ['5', '4'] },
    { label: 'array with whitespace-padded card " 5"', input: [' 5'] },
    { label: 'array with null element', input: ['5', null] },
  ])('throws PokerDomainError validation-error in calculateScoreSummary for $label', ({ input }) => {
    expectPokerDomainError(() => calculateScoreSummary(input as readonly DeckCard[]), 'validation-error')
  })
})

describe('Midpoint upward tie-breaking and Fibonacci boundary snapping (R7)', () => {
  it.each<{ mean: number; expected: FibonacciScore }>([
    { mean: 0.5, expected: 1 },
    { mean: 1.5, expected: 2 },
    { mean: 2.5, expected: 3 },
    { mean: 4.0, expected: 5 },
    { mean: 6.5, expected: 8 },
    { mean: 10.5, expected: 13 },
    { mean: 17.0, expected: 21 },
  ])('snaps exact Fibonacci midpoint $mean upward to $expected in snapToNearestFibonacci', ({ mean, expected }) => {
    expect(snapToNearestFibonacci(mean)).toBe(expected)
  })

  it.each<{
    cards: readonly DeckCard[]
    expectedMean: number
    expectedFormatted: string
    expectedScore: FibonacciScore
  }>([
    { cards: ['0', '1'], expectedMean: 0.5, expectedFormatted: '0.5', expectedScore: 1 },
    { cards: ['1', '2'], expectedMean: 1.5, expectedFormatted: '1.5', expectedScore: 2 },
    { cards: ['2', '3'], expectedMean: 2.5, expectedFormatted: '2.5', expectedScore: 3 },
    { cards: ['3', '5'], expectedMean: 4, expectedFormatted: '4', expectedScore: 5 },
    { cards: ['5', '8'], expectedMean: 6.5, expectedFormatted: '6.5', expectedScore: 8 },
    { cards: ['8', '13'], expectedMean: 10.5, expectedFormatted: '10.5', expectedScore: 13 },
    { cards: ['13', '21', '?'], expectedMean: 17, expectedFormatted: '17', expectedScore: 21 },
  ])(
    'rounds midpoint votes $cards upward to $expectedScore in calculateScoreSummary',
    ({ cards, expectedMean, expectedFormatted, expectedScore }) => {
      expect(calculateScoreSummary(cards)).toEqual({
        numericVoteCount: 2,
        average: expectedMean,
        formattedAverage: expectedFormatted,
        recommendedScore: expectedScore,
      })
    },
  )

  it.each<{ mean: number; expected: FibonacciScore }>([
    { mean: 0, expected: 0 },
    { mean: 0.49, expected: 0 },
    { mean: 0.51, expected: 1 },
    { mean: 1, expected: 1 },
    { mean: 1.49, expected: 1 },
    { mean: 1.51, expected: 2 },
    { mean: 2, expected: 2 },
    { mean: 2.49, expected: 2 },
    { mean: 2.51, expected: 3 },
    { mean: 3, expected: 3 },
    { mean: 3.99, expected: 3 },
    { mean: 4.01, expected: 5 },
    { mean: 5, expected: 5 },
    { mean: 6.49, expected: 5 },
    { mean: 6.51, expected: 8 },
    { mean: 8, expected: 8 },
    { mean: 10.49, expected: 8 },
    { mean: 10.51, expected: 13 },
    { mean: 13, expected: 13 },
    { mean: 16.99, expected: 13 },
    { mean: 17.01, expected: 21 },
    { mean: 21, expected: 21 },
    { mean: 25, expected: 21 },
  ])('snaps non-tie boundary mean $mean to $expected in snapToNearestFibonacci', ({ mean, expected }) => {
    const result = snapToNearestFibonacci(mean)
    expect(result).toBe(expected)
    if (expected === 0) {
      expect(Object.is(result, 0)).toBe(true)
    }
  })
})

describe('Display formatting, unrounded-mean snapping precedence, and invalid means (R7)', () => {
  it.each<{ mean: number; expected: string }>([
    { mean: 0, expected: '0' },
    { mean: 0.04, expected: '0' },
    { mean: 0.05, expected: '0.1' },
    { mean: 1.5, expected: '1.5' },
    { mean: 2.54, expected: '2.5' },
    { mean: 2.55, expected: '2.6' },
    { mean: 13 / 3, expected: '4.3' },
    { mean: 14 / 3, expected: '4.7' },
    { mean: 5, expected: '5' },
    { mean: 5.05, expected: '5.1' },
    { mean: 6.49, expected: '6.5' },
    { mean: 9.94, expected: '9.9' },
    { mean: 9.95, expected: '10' },
    { mean: 10.05, expected: '10.1' },
    { mean: 17.15, expected: '17.2' },
    { mean: 21, expected: '21' },
    { mean: 1000, expected: '1000' },
    { mean: 1234.55, expected: '1234.6' },
  ])('formats mean $mean as "$expected" without trailing .0 or grouping separators', ({ mean, expected }) => {
    expect(formatAverage(mean)).toBe(expected)
  })

  it('snaps recommendedScore from exact unrounded mean 6.49 to 5 even though formattedAverage rounds to "6.5"', () => {
    const cards: DeckCard[] = [
      ...Array.from<DeckCard>({ length: 48 }).fill('5'),
      ...Array.from<DeckCard>({ length: 51 }).fill('8'),
      '1',
    ]
    const summary = calculateScoreSummary(cards)
    expect(summary).toEqual({
      numericVoteCount: 100,
      average: 6.49,
      formattedAverage: '6.5',
      recommendedScore: 5,
    })
  })

  it('snaps recommendedScore from exact unrounded mean 1.45 to 1 even though formattedAverage rounds to "1.5"', () => {
    const cards: DeckCard[] = [
      ...Array.from<DeckCard>({ length: 11 }).fill('1'),
      ...Array.from<DeckCard>({ length: 9 }).fill('2'),
    ]
    const summary = calculateScoreSummary(cards)
    expect(summary).toEqual({
      numericVoteCount: 20,
      average: 1.45,
      formattedAverage: '1.5',
      recommendedScore: 1,
    })
  })

  it('computes formattedAverage "4.3" and recommendedScore 5 for ["3", "5", "5"]', () => {
    const summary = calculateScoreSummary(['3', '5', '5'])
    expect(summary.numericVoteCount).toBe(3)
    expect(summary.average).toBeCloseTo(13 / 3, 12)
    expect(summary.formattedAverage).toBe('4.3')
    expect(summary.recommendedScore).toBe(5)
  })

  it.each(INVALID_MEAN_INPUTS)(
    'rejects $label in formatAverage with PokerDomainError validation-error',
    ({ value }) => {
      expectPokerDomainError(() => formatAverage(value as number), 'validation-error')
    },
  )

  it.each(INVALID_MEAN_INPUTS)(
    'rejects $label in snapToNearestFibonacci with PokerDomainError validation-error',
    ({ value }) => {
      expectPokerDomainError(() => snapToNearestFibonacci(value as number), 'validation-error')
    },
  )
})
