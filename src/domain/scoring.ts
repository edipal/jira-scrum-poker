import { NUMERIC_FIBONACCI_SCORES, cardToNumericScore, validateDeckCard } from './deck'
import { type DeckCard, type FibonacciScore, PokerDomainError, type ScoreSummary } from './types'

function assertValidMean(mean: unknown): asserts mean is number {
  if (typeof mean !== 'number' || !Number.isFinite(mean) || Object.is(mean, -0) || mean < 0) {
    throw new PokerDomainError('validation-error', 'Mean must be a non-negative finite number')
  }
}

export function formatAverage(mean: number): string {
  assertValidMean(mean)

  const canonical = mean.toString(10)
  const [mantissa = '0', expPart] = canonical.split(/[eE]/)
  const [rawInt = '0', rawFrac = ''] = mantissa.split('.')
  const digits = rawInt + rawFrac
  const decPos = rawInt.length + (expPart !== undefined ? Number.parseInt(expPart, 10) : 0)

  if (decPos <= -2) {
    return '0'
  }

  let intPart: string
  let fracPart: string
  if (decPos <= 0) {
    intPart = '0'
    fracPart = `${'0'.repeat(-decPos)}${digits}`
  } else if (decPos >= digits.length) {
    intPart = `${digits}${'0'.repeat(decPos - digits.length)}`
    fracPart = ''
  } else {
    intPart = digits.slice(0, decPos)
    fracPart = digits.slice(decPos)
  }

  const tenthsChar = fracPart[0]
  const hundredthsChar = fracPart[1]
  const tenths = tenthsChar !== undefined ? Number(tenthsChar) : 0
  const hundredths = hundredthsChar !== undefined ? Number(hundredthsChar) : 0

  const scaledTenths = BigInt(intPart) * 10n + BigInt(tenths) + (hundredths >= 5 ? 1n : 0n)
  const finalInt = scaledTenths / 10n
  const finalTenths = scaledTenths % 10n

  if (finalTenths === 0n) {
    return finalInt.toString(10)
  }
  return `${finalInt.toString(10)}.${finalTenths.toString(10)}`
}

export function snapToNearestFibonacci(mean: number): FibonacciScore {
  assertValidMean(mean)

  let bestScore: FibonacciScore = 0
  let bestDiff = Math.abs(mean)

  for (const candidate of NUMERIC_FIBONACCI_SCORES) {
    const diff = Math.abs(mean - candidate)
    if (diff <= bestDiff) {
      bestDiff = diff
      bestScore = candidate
    }
  }

  return bestScore
}

export function calculateScoreSummary(cards: readonly DeckCard[]): ScoreSummary {
  if (!Array.isArray(cards)) {
    throw new PokerDomainError('validation-error', 'Cards must be an array')
  }

  let numericVoteCount = 0
  let sum = 0

  for (const rawCard of cards) {
    const validatedCard = validateDeckCard(rawCard)
    const numericScore = cardToNumericScore(validatedCard)
    if (numericScore !== null) {
      numericVoteCount += 1
      sum += numericScore
    }
  }

  if (numericVoteCount === 0) {
    return {
      numericVoteCount: 0,
      average: null,
      formattedAverage: null,
      recommendedScore: null,
    }
  }

  const rawAverage = sum / numericVoteCount
  const average = rawAverage === 0 ? 0 : rawAverage

  return {
    numericVoteCount,
    average,
    formattedAverage: formatAverage(average),
    recommendedScore: snapToNearestFibonacci(average),
  }
}
