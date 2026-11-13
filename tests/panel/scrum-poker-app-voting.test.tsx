import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrumPokerApp } from '../../static/panel/src/App'
import { createPokerClient, PANEL_DECK_CARDS } from '../../static/panel/src/bridge/poker-client'
import { bootstrapIssuePanel } from '../../static/panel/src/main'
import {
  createDeferred,
  createFakeBridgeDouble,
  createMockPokerClient,
  makeIdleVotingSnapshot,
  makeParticipant,
  makeRevealedSnapshot,
  makeVotingSnapshot,
} from '../helpers/panel-doubles'

describe('ScrumPokerApp initialization, theme sync, bootstrap, and voting controls (R13, R14)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    document.getElementById('root')?.remove()
  })

  it('calls view.theme.enable on initialization and renders Loading Scrum Poker… until initial getSession resolves', async () => {
    const initialLoadGate = createDeferred<ReturnType<typeof makeIdleVotingSnapshot>>()
    const bridge = createFakeBridgeDouble({
      onInvoke: async (functionKey) => {
        if (functionKey === 'getSession') {
          return await initialLoadGate.promise
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

    expect(bridge.enableThemeCalls).toBe(1)
    expect(screen.getByTestId('scrum-poker-panel')).toHaveAttribute('aria-label', 'Scrum Poker')
    expect(screen.getByTestId('panel-loading')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('panel-loading')).toHaveTextContent('Loading Scrum Poker…')

    await act(async () => {
      initialLoadGate.resolve(makeIdleVotingSnapshot())
      await initialLoadGate.promise
    })

    expect(screen.queryByTestId('panel-loading')).toBeNull()
    expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
  })

  it('swallows view.theme.enable errors gracefully and recovers via Retry when initial getSession rejects', async () => {
    let getSessionAttempts = 0
    const bridge = createFakeBridgeDouble({
      enableThemeError: new Error('theme bridge unavailable'),
      onInvoke: async (functionKey) => {
        if (functionKey === 'getSession') {
          getSessionAttempts += 1
          if (getSessionAttempts === 1) {
            throw new Error('Temporary session load failure')
          }
          return makeIdleVotingSnapshot()
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

    const alertBanner = await screen.findByTestId('error-banner')
    expect(alertBanner).toHaveAttribute('role', 'alert')
    expect(alertBanner).toHaveTextContent('Temporary session load failure')

    const retryButton = screen.getByTestId('retry-load-button')
    expect(retryButton).toHaveTextContent('Retry')

    fireEvent.click(retryButton)

    await waitFor(() => {
      expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    })
    expect(getSessionAttempts).toBe(2)
    expect(screen.queryByTestId('error-banner')).toBeNull()
    expect(screen.queryByTestId('retry-load-button')).toBeNull()
  })

  it('validates container in bootstrapIssuePanel, mounts without StrictMode double-effects, and cleans up on root.unmount()', async () => {
    expect(() => bootstrapIssuePanel(null as unknown as HTMLElement)).toThrow(TypeError)
    expect(() => bootstrapIssuePanel(document.createTextNode('x') as unknown as HTMLElement)).toThrow(TypeError)

    const mock = createMockPokerClient(makeIdleVotingSnapshot())
    const container = document.createElement('div')
    document.body.appendChild(container)

    const root = bootstrapIssuePanel(container, { client: mock.client })

    await waitFor(() => {
      expect(within(container).getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    })

    expect(mock.enableTheme).toHaveBeenCalledTimes(1)
    expect(mock.getSession).toHaveBeenCalledTimes(1)
    expect(mock.subscribeToSessionEvents).toHaveBeenCalledTimes(1)

    act(() => {
      root.unmount()
    })
    await waitFor(() => {
      expect(mock.unsubscribeCalls).toBe(1)
    })
    container.remove()
  })

  it('auto-mounts into #root when static/panel/src/main.tsx loads in a document containing #root', async () => {
    const actualReact = await import('react')
    const actualReactDomClient = await import('react-dom/client')
    let mountedRoot: ReturnType<typeof actualReactDomClient.createRoot> | null = null

    const hostWindow = window as Window & {
      __bridge?: {
        callBridge: (action: string, payload?: unknown) => Promise<unknown>
      }
    }
    const callBridge = vi.fn(async (action: string): Promise<unknown> => {
      if (action === 'invoke') {
        return makeIdleVotingSnapshot()
      }
      if (action === 'subscribeRealtime' || action === 'subscribe') {
        return { unsubscribe: async () => {} }
      }
      return undefined
    })
    hostWindow.__bridge = { callBridge }

    vi.resetModules()
    vi.doMock('react', () => actualReact)
    vi.doMock('react-dom/client', () => ({
      ...actualReactDomClient,
      createRoot: (container: Element | DocumentFragment) => {
        mountedRoot = actualReactDomClient.createRoot(container)
        return mountedRoot
      },
    }))
    vi.doMock('@forge/bridge', () => ({
      invoke: async () => makeIdleVotingSnapshot(),
      realtime: {
        subscribe: async () => ({ unsubscribe: async () => {} }),
      },
      view: {
        refresh: async () => {},
        theme: { enable: async () => {} },
      },
    }))

    const rootDiv = document.createElement('div')
    rootDiv.id = 'root'
    document.body.appendChild(rootDiv)

    try {
      await import('../../static/panel/src/main')

      await waitFor(() => {
        expect(within(rootDiv).getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
      })
    } finally {
      if (mountedRoot !== null) {
        act(() => {
          mountedRoot?.unmount()
        })
      }
      rootDiv.remove()
      delete hostWindow.__bridge
      vi.doUnmock('@forge/bridge')
      vi.doUnmock('react-dom/client')
      vi.doUnmock('react')
    }
  })

  it('renders all 9 Fibonacci deck cards in exact canonical order with accurate aria-pressed states and 0-voter disabled controls', async () => {
    const mock = createMockPokerClient(makeIdleVotingSnapshot({ viewerCard: null, participants: [] }))
    render(<ScrumPokerApp client={mock.client} />)

    await screen.findByTestId('empty-voters-prompt')

    const deckGroup = screen.getByTestId('deck-cards')
    expect(deckGroup).toHaveAttribute('role', 'group')
    expect(deckGroup).toHaveAttribute('aria-label', 'Estimation cards')

    const buttons = within(deckGroup).getAllByRole('button')
    expect(buttons).toHaveLength(9)
    expect(buttons.map((btn) => btn.textContent)).toEqual([...PANEL_DECK_CARDS])
    expect(buttons.map((btn) => btn.getAttribute('data-card'))).toEqual([...PANEL_DECK_CARDS])
    expect(buttons.map((btn) => btn.getAttribute('data-testid'))).toEqual([
      'poker-card-0',
      'poker-card-1',
      'poker-card-2',
      'poker-card-3',
      'poker-card-5',
      'poker-card-8',
      'poker-card-13',
      'poker-card-21',
      'poker-card-question',
    ])
    for (const btn of buttons) {
      expect(btn).toHaveAttribute('aria-pressed', 'false')
      expect(btn).toBeEnabled()
    }

    expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    expect(screen.queryByTestId('participant-list')).toBeNull()
    expect(screen.getByTestId('show-votes-button')).toBeDisabled()
    expect(screen.getByTestId('show-votes-button')).toHaveTextContent('Show Votes')
    expect(screen.getByTestId('reset-round-button')).toBeDisabled()
    expect(screen.getByTestId('reset-round-button')).toHaveTextContent('Reset')
  })

  it('casts and updates votes on unpressed cards (including "0" and "?") and calls withdrawVote when clicking viewerCard during voting', async () => {
    const mock = createMockPokerClient(makeIdleVotingSnapshot())

    mock.castVote
      .mockResolvedValueOnce(
        makeVotingSnapshot({
          viewerCard: '0',
          participants: [makeParticipant('acc-alice', 'Alice', null)],
        }),
      )
      .mockResolvedValueOnce(
        makeVotingSnapshot({
          viewerCard: '8',
          participants: [makeParticipant('acc-alice', 'Alice', null)],
        }),
      )
      .mockResolvedValueOnce(
        makeVotingSnapshot({
          viewerCard: '?',
          participants: [makeParticipant('acc-alice', 'Alice', null)],
        }),
      )
    mock.withdrawVote.mockResolvedValueOnce(makeIdleVotingSnapshot({ roundId: 'round-1', participants: [] }))

    render(<ScrumPokerApp client={mock.client} />)
    await screen.findByTestId('empty-voters-prompt')

    // 1. Cast '0'
    fireEvent.click(screen.getByTestId('poker-card-0'))
    await waitFor(() => {
      expect(screen.getByTestId('poker-card-0')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(mock.castVote).toHaveBeenNthCalledWith(1, '0')
    expect(screen.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'false')

    // 2. Update vote to '8'
    fireEvent.click(screen.getByTestId('poker-card-8'))
    await waitFor(() => {
      expect(screen.getByTestId('poker-card-8')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(mock.castVote).toHaveBeenNthCalledWith(2, '8')
    expect(screen.getByTestId('poker-card-0')).toHaveAttribute('aria-pressed', 'false')

    // 3. Update vote to '?'
    fireEvent.click(screen.getByTestId('poker-card-question'))
    await waitFor(() => {
      expect(screen.getByTestId('poker-card-question')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(mock.castVote).toHaveBeenNthCalledWith(3, '?')
    expect(screen.getByTestId('poker-card-8')).toHaveAttribute('aria-pressed', 'false')

    // 4. Click active '?' card -> withdraws vote instead of casting
    fireEvent.click(screen.getByTestId('poker-card-question'))
    await waitFor(() => {
      expect(screen.getByTestId('poker-card-question')).toHaveAttribute('aria-pressed', 'false')
    })
    expect(mock.withdrawVote).toHaveBeenCalledTimes(1)
    expect(mock.castVote).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
  })

  it('renders "<Display Name> ✓" chips at >= 1 voters without leaking cards, avatars, or console logs, and enables Show Votes and Reset', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Even if a participant record carries avatarUrl or an unexpected card property in voting, UI must render strictly "<Display Name> ✓"
    const initialVoting = makeVotingSnapshot({
      viewerCard: '5',
      participants: [
        {
          accountId: 'acc-alice',
          displayName: 'Alice Rivera',
          avatarUrl: 'https://avatar.atlassian.example/alice.png',
          hasVoted: true,
          card: '5',
        },
        {
          accountId: 'acc-bob',
          displayName: 'Bob Chen',
          avatarUrl: 'https://avatar.atlassian.example/bob.png',
          hasVoted: true,
          card: '13',
        },
      ],
    })

    const mock = createMockPokerClient(initialVoting)
    mock.revealVotes.mockResolvedValueOnce(
      makeRevealedSnapshot({
        participants: [makeParticipant('acc-alice', 'Alice Rivera', '5'), makeParticipant('acc-bob', 'Bob Chen', '13')],
        average: 9,
        formattedAverage: '9',
        recommendedScore: 8,
        targetScore: 8,
      }),
    )

    const { container } = render(<ScrumPokerApp client={mock.client} />)
    const list = await screen.findByTestId('participant-list')
    expect(list).toHaveAttribute('aria-label', 'Participants')
    expect(screen.queryByTestId('empty-voters-prompt')).toBeNull()

    const chips = within(list).getAllByTestId('participant-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Alice Rivera ✓', 'Bob Chen ✓'])
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.innerHTML).not.toContain('avatar.atlassian.example')

    expect(screen.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'true')
    const showVotesButton = screen.getByTestId('show-votes-button')
    const resetButton = screen.getByTestId('reset-round-button')
    expect(showVotesButton).toBeEnabled()
    expect(resetButton).toBeEnabled()

    // Verify zero console vote logging during voting
    expect(logSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(debugSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    // Trigger Show Votes -> transitions to revealed
    fireEvent.click(showVotesButton)
    await waitFor(() => {
      expect(screen.getByTestId('recommended-score')).toHaveTextContent('Recommended: 8')
    })
    expect(mock.revealVotes).toHaveBeenCalledTimes(1)
  })

  it('locks buttons while a mutation is in flight, invokes resetRound on Reset, and surfaces alert banner on mutation rejection', async () => {
    const castGate = createDeferred<ReturnType<typeof makeVotingSnapshot>>()
    const mock = createMockPokerClient(
      makeVotingSnapshot({
        viewerCard: null,
        participants: [makeParticipant('acc-bob', 'Bob', null)],
      }),
    )
    mock.castVote.mockImplementationOnce(() => castGate.promise)
    mock.resetRound
      .mockRejectedValueOnce(new Error('Reset RPC failed'))
      .mockResolvedValueOnce(makeIdleVotingSnapshot({ roundId: 'round-2' }))

    render(<ScrumPokerApp client={mock.client} />)
    await screen.findByTestId('participant-list')

    fireEvent.click(screen.getByTestId('poker-card-3'))
    expect(screen.getByTestId('poker-card-3')).toBeDisabled()
    expect(screen.getByTestId('show-votes-button')).toBeDisabled()
    expect(screen.getByTestId('reset-round-button')).toBeDisabled()

    // Rapid second click while in-flight does not duplicate RPC call
    fireEvent.click(screen.getByTestId('poker-card-5'))
    expect(mock.castVote).toHaveBeenCalledTimes(1)

    await act(async () => {
      castGate.resolve(
        makeVotingSnapshot({
          viewerCard: '3',
          participants: [makeParticipant('acc-bob', 'Bob', null), makeParticipant('acc-alice', 'Alice', null)],
        }),
      )
      await castGate.promise
    })

    expect(screen.getByTestId('poker-card-3')).toBeEnabled()
    expect(screen.getByTestId('poker-card-3')).toHaveAttribute('aria-pressed', 'true')

    // First Reset rejects -> displays alert banner while preserving voting state
    fireEvent.click(screen.getByTestId('reset-round-button'))
    const alertBanner = await screen.findByTestId('error-banner')
    expect(alertBanner).toHaveAttribute('role', 'alert')
    expect(alertBanner).toHaveTextContent('Reset RPC failed')
    expect(screen.getAllByTestId('participant-chip')).toHaveLength(2)

    // Second Reset succeeds -> clears alert banner and resets round to 0 voters
    fireEvent.click(screen.getByTestId('reset-round-button'))
    await waitFor(() => {
      expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    })
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })
})
