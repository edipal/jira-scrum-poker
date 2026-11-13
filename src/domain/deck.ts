import type { DeckCard, FibonacciScore, NumericDeckCard } from './types'

export const FIBONACCI_DECK: readonly DeckCard[] = []

export const NUMERIC_FIBONACCI_SCORES: readonly FibonacciScore[] = []

export function isValidDeckCard(_value: unknown): _value is DeckCard {
  throw new Error('not implemented')
}

export function isNumericDeckCard(_value: unknown): _value is NumericDeckCard {
  throw new Error('not implemented')
}

export function isValidFibonacciScore(_value: unknown): _value is FibonacciScore {
  throw new Error('not implemented')
}

export function cardToNumericScore(_card: DeckCard): FibonacciScore | null {
  throw new Error('not implemented')
}

export function validateDeckCard(_value: unknown): DeckCard {
  throw new Error('not implemented')
}

export function validateFibonacciScore(_value: unknown): FibonacciScore {
  throw new Error('not implemented')
}
