import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validatePlatformManifest } from '../../src/observability/logger'
import { ScrumPokerApp } from '../../static/panel/src/App'
import { createPokerClient, validateUiAssetCompliance } from '../../static/panel/src/bridge/poker-client'
import {
  createDeferred,
  createFakeBridgeDouble,
  createMultiPanelHarness,
  makeIdleVotingSnapshot,
  makeParticipant,
  makeRevealedSnapshot,
  makeVotingSnapshot,
} from '../helpers/panel-doubles'

const REPO_ROOT = fileURLToPath(new NodeURL('../..', import.meta.url))

function listFilesRecursively(dirPath: string): string[] {
  const entries = readdirSync(dirPath, { withFileTypes: true })
  const collected: string[] = []
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      collected.push(...listFilesRecursively(fullPath))
    } else if (entry.isFile()) {
      collected.push(fullPath)
    }
  }
  return collected.sort()
}

describe('Live multi-user synchronization, race guards, refresh deduplication, and unmount cleanup (R12)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('synchronizes two live panels across vote, withdrawal, reveal, targetScore override (including 0), reset, and Story Points save without polling', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const getAppPollingIntervals = () =>
      setIntervalSpy.mock.calls.filter(
        ([handler]) => typeof handler !== 'function' || handler.name !== 'checkRealTimersCallback',
      )
    const harness = createMultiPanelHarness('10099')
    const alicePeer = harness.createPeer('acc-alice', 'Alice')
    const bobPeer = harness.createPeer('acc-bob', 'Bob')

    const aliceContainer = document.createElement('div')
    const bobContainer = document.createElement('div')
    document.body.append(aliceContainer, bobContainer)

    const aliceView = render(<ScrumPokerApp client={alicePeer.client} />, { container: aliceContainer })
    const bobView = render(<ScrumPokerApp client={bobPeer.client} />, { container: bobContainer })

    const aliceUI = within(aliceContainer)
    const bobUI = within(bobContainer)

    await aliceUI.findByTestId('empty-voters-prompt')
    await bobUI.findByTestId('empty-voters-prompt')
    expect(getAppPollingIntervals()).toHaveLength(0)

    // 1. Alice casts '5' -> Bob automatically sees "Alice ✓" without seeing '5'
    fireEvent.click(aliceUI.getByTestId('poker-card-5'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'true')
      expect(aliceUI.getByTestId('poker-card-5')).toBeEnabled()
      expect(bobUI.getByTestId('participant-chip')).toHaveTextContent('Alice ✓')
    })
    expect(bobUI.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'false')
    expect(bobContainer.textContent).not.toContain('Alice: 5')

    // 2. Alice clicks '5' again to withdraw -> Bob automatically returns to empty-voters-prompt
    fireEvent.click(aliceUI.getByTestId('poker-card-5'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
      expect(aliceUI.getByTestId('poker-card-5')).toBeEnabled()
      expect(bobUI.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    })

    // 3. Alice casts '5' and Bob casts '8', then Bob clicks Show Votes -> both see revealed scores
    fireEvent.click(aliceUI.getByTestId('poker-card-5'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'true')
      expect(aliceUI.getByTestId('poker-card-5')).toBeEnabled()
      expect(bobUI.getByTestId('participant-chip')).toHaveTextContent('Alice ✓')
    })
    fireEvent.click(bobUI.getByTestId('poker-card-8'))
    await waitFor(() => {
      expect(bobUI.getByTestId('poker-card-8')).toHaveAttribute('aria-pressed', 'true')
      expect(bobUI.getByTestId('show-votes-button')).toBeEnabled()
      expect(aliceUI.getAllByTestId('participant-chip')).toHaveLength(2)
    })

    fireEvent.click(bobUI.getByTestId('show-votes-button'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('recommended-score')).toHaveTextContent('Recommended: 8')
      expect(aliceUI.getByTestId('poker-card-0')).toBeEnabled()
      expect(bobUI.getByTestId('recommended-score')).toHaveTextContent('Recommended: 8')
      expect(bobUI.getByTestId('revote-button')).toBeEnabled()
    })
    expect(aliceUI.getAllByTestId('participant-chip').map((el) => el.textContent)).toEqual(['Alice: 5', 'Bob: 8'])

    // 4. Alice overrides targetScore to 0 -> Bob automatically renders Set Story Points → 0 and card '0' pressed
    fireEvent.click(aliceUI.getByTestId('poker-card-0'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 0')
      expect(aliceUI.getByTestId('revote-button')).toBeEnabled()
      expect(bobUI.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 0')
      expect(bobUI.getByTestId('revote-button')).toBeEnabled()
    })
    expect(bobUI.getByTestId('poker-card-0')).toHaveAttribute('aria-pressed', 'true')

    // 5. Bob clicks Re-vote -> both reset to clean voting state
    fireEvent.click(bobUI.getByTestId('revote-button'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
      expect(aliceUI.getByTestId('poker-card-13')).toBeEnabled()
      expect(bobUI.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
      expect(bobUI.getByTestId('poker-card-13')).toBeEnabled()
    })

    // 6. New round: Alice votes '13', reveals, and clicks Set Story Points → 13
    // Both panels transition to cleared idle state, show confirmation, and invoke view.refresh ONCE per panel
    fireEvent.click(aliceUI.getByTestId('poker-card-13'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('show-votes-button')).toBeEnabled()
      expect(bobUI.getByTestId('participant-chip')).toHaveTextContent('Alice ✓')
    })
    fireEvent.click(aliceUI.getByTestId('show-votes-button'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 13')
      expect(aliceUI.getByTestId('apply-story-points-button')).toBeEnabled()
      expect(bobUI.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 13')
    })

    fireEvent.click(aliceUI.getByTestId('apply-story-points-button'))
    await waitFor(() => {
      expect(aliceUI.getByTestId('points-applied-banner')).toHaveTextContent('Story Points set to 13')
      expect(bobUI.getByTestId('points-applied-banner')).toHaveTextContent('Story Points set to 13')
      expect(alicePeer.bridge.refreshCalls).toBe(1)
      expect(bobPeer.bridge.refreshCalls).toBe(1)
    })
    expect(aliceUI.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    expect(bobUI.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    expect(getAppPollingIntervals()).toHaveLength(0)

    aliceView.unmount()
    bobView.unmount()
    aliceContainer.remove()
    bobContainer.remove()
  })

  it('handles JSON-string realtime payloads and ignores malformed, double-encoded, error, or card-bearing events without calling getSession', async () => {
    let currentSession = makeIdleVotingSnapshot({ roundId: 'round-1' })
    const bridge = createFakeBridgeDouble({
      onInvoke: async (functionKey) => {
        if (functionKey === 'getSession') {
          return currentSession
        }
        return currentSession
      },
    })
    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    render(<ScrumPokerApp client={client} />)
    await screen.findByTestId('empty-voters-prompt')
    expect(bridge.invokeCalls).toHaveLength(1)

    // Emit invalid/secret-bearing payloads -> zero additional getSession calls
    act(() => {
      bridge.emitRawRealtime('{malformed-json')
      bridge.emitRawRealtime(
        JSON.stringify(JSON.stringify({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100 })),
      )
      bridge.emitRawRealtime({ error: 'channel-error' })
      bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100, card: '5' })
      bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100 }, new Error('sdk error'))
    })
    expect(bridge.invokeCalls).toHaveLength(1)

    // Valid JSON-string SESSION_UPDATED triggers background getSession and updates UI
    currentSession = makeVotingSnapshot({
      roundId: 'round-1',
      viewerCard: null,
      participants: [makeParticipant('acc-bob', 'Bob', null)],
    })
    act(() => {
      bridge.emitRawRealtime(JSON.stringify({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 200 }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('participant-chip')).toHaveTextContent('Bob ✓')
    })

    // Valid JSON-string points-applied (score 0) transitions to cleared idle state, shows banner, and calls view.refresh once
    currentSession = makeIdleVotingSnapshot({ roundId: 'round-2' })
    act(() => {
      bridge.emitRawRealtime(JSON.stringify({ type: 'points-applied', roundId: 'round-2', score: 0, updatedAt: 300 }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('points-applied-banner')).toHaveTextContent('Story Points set to 0')
    })
    expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    expect(bridge.refreshCalls).toBe(1)

    // Returning tab to foreground (visibilitychange -> 'visible') re-syncs session if a realtime event was dropped
    currentSession = makeVotingSnapshot({
      roundId: 'round-2',
      viewerCard: null,
      participants: [makeParticipant('acc-charlie', 'Charlie', null)],
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('participant-chip')).toHaveTextContent('Charlie ✓')
    })
  })

  it('ignores stale out-of-order background getSession responses superseded by newer user mutations or newer background fetches', async () => {
    const staleBgFetch1 = createDeferred<ReturnType<typeof makeVotingSnapshot>>()
    const newerBgFetch2 = createDeferred<ReturnType<typeof makeVotingSnapshot>>()
    const staleBgBeforeMutation = createDeferred<ReturnType<typeof makeVotingSnapshot>>()

    let getSessionCallCount = 0
    const bridge = createFakeBridgeDouble({
      onInvoke: async (functionKey, payload) => {
        if (functionKey === 'getSession') {
          getSessionCallCount += 1
          if (getSessionCallCount === 1) {
            return makeIdleVotingSnapshot({ roundId: 'round-1' })
          }
          if (getSessionCallCount === 2) {
            return await staleBgFetch1.promise
          }
          if (getSessionCallCount === 3) {
            return await newerBgFetch2.promise
          }
          return await staleBgBeforeMutation.promise
        }
        if (functionKey === 'castVote') {
          return makeVotingSnapshot({
            roundId: 'round-1',
            viewerCard: (payload?.card ?? '8') as '8',
            participants: [makeParticipant('acc-bob', 'Bob', null), makeParticipant('acc-alice', 'Alice', null)],
          })
        }
        return makeIdleVotingSnapshot()
      },
    })
    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    render(<ScrumPokerApp client={client} />)
    await screen.findByTestId('empty-voters-prompt')

    // Part A: Background fetch #2 resolves before slower background fetch #1
    act(() => {
      bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 100 })
      bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 200 })
    })
    expect(getSessionCallCount).toBe(3)

    await act(async () => {
      newerBgFetch2.resolve(
        makeVotingSnapshot({
          roundId: 'round-1',
          viewerCard: null,
          participants: [makeParticipant('acc-bob', 'Bob', null)],
        }),
      )
      await newerBgFetch2.promise
    })
    expect(screen.getByTestId('participant-chip')).toHaveTextContent('Bob ✓')

    // Now older fetch #1 resolves with 0 participants -> must be ignored!
    await act(async () => {
      staleBgFetch1.resolve(makeIdleVotingSnapshot({ roundId: 'round-1', participants: [] }))
      await staleBgFetch1.promise
    })
    expect(screen.getByTestId('participant-chip')).toHaveTextContent('Bob ✓')

    // Part B: Background fetch #3 starts BEFORE user clicks card '8', and resolves AFTER castVote('8') finishes
    act(() => {
      bridge.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-1', updatedAt: 300 })
    })
    expect(getSessionCallCount).toBe(4)

    fireEvent.click(screen.getByTestId('poker-card-8'))
    await waitFor(() => {
      expect(screen.getByTestId('poker-card-8')).toHaveAttribute('aria-pressed', 'true')
    })

    // Stale background fetch #3 resolves with viewerCard: null -> must NOT overwrite viewerCard: '8'!
    await act(async () => {
      staleBgBeforeMutation.resolve(
        makeVotingSnapshot({
          roundId: 'round-1',
          viewerCard: null,
          participants: [makeParticipant('acc-bob', 'Bob', null)],
        }),
      )
      await staleBgBeforeMutation.promise
    })
    expect(screen.getByTestId('poker-card-8')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByTestId('participant-chip')).toHaveLength(2)
  })

  it('deduplicates echoed points-applied events when echo arrives before applyStoryPoints settles and across the 64-round FIFO capacity', async () => {
    const applyGate = createDeferred<{
      readonly ok: true
      readonly appliedScore: 5
      readonly fieldName: string
      readonly session: ReturnType<typeof makeIdleVotingSnapshot>
    }>()

    let currentSession = makeRevealedSnapshot({
      roundId: 'round-0',
      recommendedScore: 5,
      targetScore: 5,
    })

    const bridge = createFakeBridgeDouble({
      onInvoke: async (functionKey) => {
        if (functionKey === 'getSession') {
          return currentSession
        }
        if (functionKey === 'applyStoryPoints') {
          return await applyGate.promise
        }
        return currentSession
      },
    })
    const client = createPokerClient({
      invoke: bridge.invoke,
      subscribe: bridge.subscribe,
      view: bridge.view,
    })

    render(<ScrumPokerApp client={client} />)
    const applyButton = await screen.findByTestId('apply-story-points-button')

    // Start applyStoryPoints, and deliver self-echoed 'points-applied' for 'round-1' BEFORE applyGate settles
    currentSession = makeIdleVotingSnapshot({ roundId: 'round-1' })
    fireEvent.click(applyButton)
    act(() => {
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-1', score: 5, updatedAt: 1_000 })
    })

    await waitFor(() => {
      expect(bridge.refreshCalls).toBe(1)
    })

    // Now settle applyStoryPoints with the same roundId 'round-1' -> refreshCalls must remain 1!
    await act(async () => {
      applyGate.resolve({
        ok: true,
        appliedScore: 5,
        fieldName: 'Story Points',
        session: makeIdleVotingSnapshot({ roundId: 'round-1' }),
      })
      await applyGate.promise
    })
    expect(bridge.refreshCalls).toBe(1)
    expect(screen.getByTestId('points-applied-banner')).toHaveTextContent('Story Points set to 5')

    // Push rounds round-2 through round-64 (bringing total tracked rounds to exactly 64: round-1..round-64)
    for (let i = 2; i <= 64; i += 1) {
      const roundId = `round-${i}`
      currentSession = makeIdleVotingSnapshot({ roundId })
      await act(async () => {
        bridge.emitRawRealtime({ type: 'points-applied', roundId, score: 3, updatedAt: 1_000 + i })
      })
    }
    expect(bridge.refreshCalls).toBe(64)

    // Re-emitting any of round-1..round-64 must be deduplicated (still 64 refreshes)
    await act(async () => {
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-1', score: 5, updatedAt: 2_000 })
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-32', score: 3, updatedAt: 2_001 })
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-64', score: 3, updatedAt: 2_002 })
    })
    expect(bridge.refreshCalls).toBe(64)

    // Emitting 65th distinct round ('round-65') increments refreshCalls to 65 and evicts oldest ('round-1') FIFO
    currentSession = makeIdleVotingSnapshot({ roundId: 'round-65' })
    await act(async () => {
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-65', score: 8, updatedAt: 3_000 })
    })
    expect(bridge.refreshCalls).toBe(65)

    // 'round-2' is still retained in the 64-entry window (deduplicated), whereas evicted 'round-1' is processed fresh
    await act(async () => {
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-2', score: 3, updatedAt: 3_001 })
    })
    expect(bridge.refreshCalls).toBe(65)

    await act(async () => {
      bridge.emitRawRealtime({ type: 'points-applied', roundId: 'round-1', score: 5, updatedAt: 3_002 })
    })
    expect(bridge.refreshCalls).toBe(66)
  })

  it('calls unsubscribe deterministically on unmount (both after subscribe resolves and before subscribe settles) and suppresses post-unmount updates', async () => {
    // Case A: Unmounted after subscribe resolves while an applyStoryPoints RPC is still in flight
    const pendingApply = createDeferred<{
      readonly ok: true
      readonly appliedScore: 8
      readonly fieldName: string
      readonly session: ReturnType<typeof makeIdleVotingSnapshot>
    }>()
    const bridgeA = createFakeBridgeDouble({
      onInvoke: async (functionKey) => {
        if (functionKey === 'getSession') {
          return makeRevealedSnapshot({ recommendedScore: 8, targetScore: 8 })
        }
        if (functionKey === 'applyStoryPoints') {
          return await pendingApply.promise
        }
        return makeIdleVotingSnapshot()
      },
    })
    const clientA = createPokerClient({
      invoke: bridgeA.invoke,
      subscribe: bridgeA.subscribe,
      view: bridgeA.view,
    })

    const viewA = render(<ScrumPokerApp client={clientA} />)
    const applyBtn = await screen.findByTestId('apply-story-points-button')
    await Promise.resolve()

    fireEvent.click(applyBtn)
    const invokeCountAtUnmount = bridgeA.invokeCalls.length

    viewA.unmount()
    await waitFor(() => {
      expect(bridgeA.subscribers[0]?.unsubscribeCalls).toBe(1)
    })

    // Post-unmount realtime events and late applyStoryPoints resolution must NOT trigger getSession or view.refresh
    await act(async () => {
      bridgeA.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-late', updatedAt: 5_000 })
      bridgeA.emitRawRealtime({ type: 'points-applied', roundId: 'round-late', score: 8, updatedAt: 5_001 })
      pendingApply.resolve({
        ok: true,
        appliedScore: 8,
        fieldName: 'Story Points',
        session: makeIdleVotingSnapshot({ roundId: 'round-late' }),
      })
      await pendingApply.promise
    })
    expect(bridgeA.invokeCalls).toHaveLength(invokeCountAtUnmount)
    expect(bridgeA.refreshCalls).toBe(0)

    // Case B: Unmounted BEFORE realtime.subscribe settles
    const subscribeGate = createDeferred<void>()
    const bridgeB = createFakeBridgeDouble({ subscribeGate })
    const clientB = createPokerClient({
      invoke: bridgeB.invoke,
      subscribe: bridgeB.subscribe,
      view: bridgeB.view,
    })

    const viewB = render(<ScrumPokerApp client={clientB} />)
    expect(bridgeB.subscribers).toHaveLength(1)
    const invokesBeforeUnmountB = bridgeB.invokeCalls.length

    viewB.unmount()

    // Emit event while subscribe is still settling -> suppressed
    bridgeB.emitRawRealtime({ type: 'SESSION_UPDATED', roundId: 'round-early', updatedAt: 6_000 })
    expect(bridgeB.invokeCalls).toHaveLength(invokesBeforeUnmountB)

    await act(async () => {
      subscribeGate.resolve()
      await subscribeGate.promise
    })
    await waitFor(() => {
      expect(bridgeB.subscribers[0]?.unsubscribeCalls).toBe(1)
    })
  })
})

describe('Local Light/Dark CSS tokens and Runs on Atlassian zero-egress compliance (R13, R14)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defines all contracted Atlassian Design System Light/Dark CSS tokens and focus styles in static/panel/src/styles.css', () => {
    const cssSource = readFileSync(join(REPO_ROOT, 'static/panel/src/styles.css'), 'utf8')

    const requiredTokens = [
      '--ds-surface',
      '--ds-surface-raised',
      '--ds-text',
      '--ds-text-subtle',
      '--ds-text-inverse',
      '--ds-border',
      '--ds-border-focused',
      '--ds-background-neutral',
      '--ds-background-selected',
      '--ds-text-selected',
      '--ds-background-brand-bold',
      '--ds-background-warning',
      '--ds-text-warning',
      '--ds-background-danger',
      '--ds-text-danger',
      '--ds-background-success',
      '--ds-text-success',
    ]

    for (const token of requiredTokens) {
      expect(cssSource).toContain(token)
    }

    expect(cssSource).toMatch(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/)
    expect(cssSource).toMatch(/\[data-color-mode=["']dark["']\]/)
    expect(cssSource).toContain(':focus-visible')
    expect(validateUiAssetCompliance(cssSource, 'static/panel/src/styles.css')).toEqual({
      valid: true,
      violations: [],
    })
  })

  it('validates argument types, permits standard W3C XML namespaces, and detects external URLs, protocol-relative assets, network APIs, and backend SDKs in validateUiAssetCompliance', () => {
    expect(() => validateUiAssetCompliance(null as unknown as string)).toThrow(TypeError)
    expect(() => validateUiAssetCompliance('<div />', 123 as unknown as string)).toThrow(TypeError)

    const compliantSvgAndBridgeSource = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<foreignObject xmlns="http://www.w3.org/1999/xhtml"><math xmlns="http://www.w3.org/1998/Math/MathML" /></foreignObject>',
      '</svg>',
      "import { invoke, realtime, view } from '@forge/bridge'",
    ].join('\n')

    expect(validateUiAssetCompliance(compliantSvgAndBridgeSource, 'icon.svg')).toEqual({
      valid: true,
      violations: [],
    })

    const failingCases = [
      { label: 'https stylesheet URL', snippet: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2" />' },
      { label: 'http API URL', snippet: 'const endpoint = "http://external.example.com/v1/poker"' },
      { label: 'protocol-relative script src', snippet: '<script src="//cdn.example.com/tracker.js"></script>' },
      { label: 'protocol-relative link href', snippet: "<link href='//cdn.example.com/theme.css' />" },
      { label: 'protocol-relative CSS url()', snippet: '.card { background-image: url(//cdn.example.com/bg.png); }' },
      { label: 'protocol-relative CSS @import', snippet: '@import "//cdn.example.com/base.css";' },
      { label: 'direct fetch() call', snippet: "await fetch('/api/session')" },
      { label: 'XMLHttpRequest instantiation', snippet: 'const xhr = new XMLHttpRequest()' },
      { label: 'WebSocket connection', snippet: "const ws = new WebSocket('wss://live.example.com')" },
      { label: 'EventSource stream', snippet: "const sse = new EventSource('/events')" },
      { label: 'navigator.sendBeacon telemetry', snippet: "navigator.sendBeacon('/analytics', 'x')" },
      { label: 'backend @forge/kvs import', snippet: "import { kvs } from '@forge/kvs'" },
      { label: 'backend @forge/api import', snippet: "import api from '@forge/api'" },
      { label: 'backend @forge/realtime import', snippet: "import { publish } from '@forge/realtime'" },
      { label: 'backend @forge/resolver import', snippet: "import Resolver from '@forge/resolver'" },
    ]

    for (const tc of failingCases) {
      const labeled = validateUiAssetCompliance(tc.snippet, 'panel-check.tsx')
      expect(labeled.valid, `expected violation for ${tc.label}`).toBe(false)
      expect(labeled.violations.length).toBeGreaterThan(0)
      expect(labeled.violations[0]?.startsWith('panel-check.tsx: ')).toBe(true)

      const unlabeled = validateUiAssetCompliance(tc.snippet)
      expect(unlabeled.valid).toBe(false)
      expect(unlabeled.violations.length).toBeGreaterThan(0)
    }
  })

  it('confirms manifest.yml, index.html, icon.svg, styles.css, and all static/panel/src TS/TSX modules have zero external egress and zero runtime src/ imports', () => {
    const manifestYaml = readFileSync(join(REPO_ROOT, 'manifest.yml'), 'utf8')
    expect(validatePlatformManifest(manifestYaml)).toEqual({
      valid: true,
      scopes: ['storage:app', 'read:jira-work', 'write:jira-work', 'read:jira-user'],
      violations: [],
    })

    const staticAssetPaths = [
      join(REPO_ROOT, 'static/panel/index.html'),
      join(REPO_ROOT, 'static/assets/icon.svg'),
      join(REPO_ROOT, 'static/panel/src/styles.css'),
    ]
    const frontendModulePaths = listFilesRecursively(join(REPO_ROOT, 'static/panel/src')).filter(
      (filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'),
    )
    expect(frontendModulePaths.length).toBeGreaterThanOrEqual(4)

    for (const fullPath of [...staticAssetPaths, ...frontendModulePaths]) {
      const relPath = relative(REPO_ROOT, fullPath)
      const content = readFileSync(fullPath, 'utf8')
      expect(validateUiAssetCompliance(content, relPath)).toEqual({
        valid: true,
        violations: [],
      })
    }

    // Verify frontend TS/TSX files import from src/ strictly via erased `import type` / `export type`
    for (const fullPath of frontendModulePaths) {
      const relPath = relative(REPO_ROOT, fullPath)
      const content = readFileSync(fullPath, 'utf8')
      const strippedComments = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      const importStatements = strippedComments.match(/^\s*(?:import|export)\s+[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? []
      for (const stmt of importStatements) {
        const trimmedStmt = stmt.trim()
        if (trimmedStmt.includes('/src/') || /from\s+['"](?:\.\.\/)+src\//.test(trimmedStmt)) {
          expect(trimmedStmt, `${relPath} must use type-only imports from src/`).toMatch(/^(?:import|export)\s+type\b/)
        }
      }
    }
  })
})
