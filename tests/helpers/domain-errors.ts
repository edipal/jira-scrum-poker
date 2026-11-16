import { expect } from 'vitest'
import { PokerDomainError, type PokerErrorCode } from '../../src/domain/types'

export function expectPokerDomainError(fn: () => unknown, expectedCode: PokerErrorCode): PokerDomainError {
  let caught: unknown
  let didThrow = false
  try {
    fn()
  } catch (error) {
    didThrow = true
    caught = error
  }

  expect(didThrow).toBe(true)
  expect(caught).toBeInstanceOf(Error)
  expect(caught).toBeInstanceOf(PokerDomainError)

  const domainError = caught as PokerDomainError
  expect(domainError.code).toBe(expectedCode)
  expect(domainError.name).toBe('PokerDomainError')
  expect(domainError.message.trim().length).toBeGreaterThan(0)
  return domainError
}

export async function expectAsyncPokerDomainError(
  fn: () => Promise<unknown>,
  expectedCode: PokerErrorCode,
): Promise<PokerDomainError> {
  let caught: unknown
  let didThrow = false
  try {
    await fn()
  } catch (error) {
    didThrow = true
    caught = error
  }

  expect(didThrow).toBe(true)
  expect(caught).toBeInstanceOf(Error)
  expect(caught).toBeInstanceOf(PokerDomainError)

  const domainError = caught as PokerDomainError
  expect(domainError.code).toBe(expectedCode)
  expect(domainError.name).toBe('PokerDomainError')
  expect(domainError.message.trim().length).toBeGreaterThan(0)
  return domainError
}
