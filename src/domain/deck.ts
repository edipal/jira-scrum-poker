import { type DeckCard, type FibonacciScore, type NumericDeckCard, PokerDomainError } from './types'

export const FIBONACCI_DECK: readonly DeckCard[] = Object.freeze([
  '0',
  '1',
  '2',
  '3',
  '5',
  '8',
  '13',
  '21',
  '?',
] as const)

export const NUMERIC_FIBONACCI_SCORES: readonly FibonacciScore[] = Object.freeze([0, 1, 2, 3, 5, 8, 13, 21] as const)

const DECK_CARD_SET: ReadonlySet<string> = new Set<string>(FIBONACCI_DECK)

const NUMERIC_DECK_CARD_SET: ReadonlySet<string> = new Set<string>(['0', '1', '2', '3', '5', '8', '13', '21'])

const FIBONACCI_SCORE_SET: ReadonlySet<number> = new Set<number>(NUMERIC_FIBONACCI_SCORES)

export function isValidDeckCard(value: unknown): value is DeckCard {
  return typeof value === 'string' && DECK_CARD_SET.has(value)
}

export function isNumericDeckCard(value: unknown): value is NumericDeckCard {
  return typeof value === 'string' && NUMERIC_DECK_CARD_SET.has(value)
}

export function isValidFibonacciScore(value: unknown): value is FibonacciScore {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && FIBONACCI_SCORE_SET.has(value)
}

export function validateDeckCard(value: unknown): DeckCard {
  if (!isValidDeckCard(value)) {
    throw new PokerDomainError('validation-error', `Invalid deck card: ${String(value)}`)
  }
  return value
}

export function validateFibonacciScore(value: unknown): FibonacciScore {
  if (!isValidFibonacciScore(value)) {
    throw new PokerDomainError('validation-error', `Invalid Fibonacci score: ${String(value)}`)
  }
  return value
}

export function cardToNumericScore(card: DeckCard): FibonacciScore | null {
  const validated = validateDeckCard(card)
  switch (validated) {
    case '0':
      return 0
    case '1':
      return 1
    case '2':
      return 2
    case '3':
      return 3
    case '5':
      return 5
    case '8':
      return 8
    case '13':
      return 13
    case '21':
      return 21
    case '?':
      return null
  }
}
