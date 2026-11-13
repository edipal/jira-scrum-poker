import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrumPokerApp } from '../../static/panel/src/App'
import type { LegacyCopyDocumentLike } from '../../static/panel/src/clipboard/copy-score'
import {
  createMockPokerClient,
  makeIdleVotingSnapshot,
  makeParticipant,
  makeRevealedSnapshot,
  makeVotingSnapshot,
} from '../helpers/panel-doubles'

describe('ScrumPokerApp revealed-state controls, consensus override, write-back, and clipboard fallback (R13)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    for (const node of Array.from(document.querySelectorAll('textarea'))) {
      node.remove()
    }
  })

  it('renders "<Display Name>: <card>" chips, formatted Average and Recommended, disables "?", and updates targetScore override (including 0)', async () => {
    const mock = createMockPokerClient(
      makeRevealedSnapshot({
        participants: [
          makeParticipant('acc-alice', 'Alice', '3'),
          makeParticipant('acc-bob', 'Bob', '5'),
          makeParticipant('acc-cara', 'Cara', '5'),
          makeParticipant('acc-dan', 'Dan', '?'),
        ],
        average: 13 / 3,
        formattedAverage: '4.3',
        recommendedScore: 5,
        targetScore: 5,
      }),
    )

    mock.selectOverrideScore
      .mockResolvedValueOnce(
        makeRevealedSnapshot({
          participants: [
            makeParticipant('acc-alice', 'Alice', '3'),
            makeParticipant('acc-bob', 'Bob', '5'),
            makeParticipant('acc-cara', 'Cara', '5'),
            makeParticipant('acc-dan', 'Dan', '?'),
          ],
          average: 13 / 3,
          formattedAverage: '4.3',
          recommendedScore: 5,
          targetScore: 13,
        }),
      )
      .mockResolvedValueOnce(
        makeRevealedSnapshot({
          participants: [
            makeParticipant('acc-alice', 'Alice', '3'),
            makeParticipant('acc-bob', 'Bob', '5'),
            makeParticipant('acc-cara', 'Cara', '5'),
            makeParticipant('acc-dan', 'Dan', '?'),
          ],
          average: 13 / 3,
          formattedAverage: '4.3',
          recommendedScore: 5,
          targetScore: 0,
        }),
      )

    render(<ScrumPokerApp client={mock.client} />)

    const list = await screen.findByTestId('participant-list')
    const chips = within(list).getAllByTestId('participant-chip')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Alice: 3', 'Bob: 5', 'Cara: 5', 'Dan: ?'])

    expect(screen.getByTestId('average-score')).toHaveTextContent('Average: 4.3')
    expect(screen.getByTestId('recommended-score')).toHaveTextContent('Recommended: 5')
    expect(screen.queryByTestId('no-numeric-votes')).toBeNull()

    expect(screen.getByTestId('poker-card-question')).toBeDisabled()
    expect(screen.getByTestId('poker-card-question')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('poker-card-13')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 5')
    expect(screen.getByTestId('revote-button')).toHaveTextContent('Re-vote')

    // Click override card 13
    fireEvent.click(screen.getByTestId('poker-card-13'))
    await waitFor(() => {
      expect(screen.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 13')
    })
    expect(mock.selectOverrideScore).toHaveBeenNthCalledWith(1, 13)
    expect(screen.getByTestId('poker-card-13')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('poker-card-5')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('recommended-score')).toHaveTextContent('Recommended: 5')

    // Click override card 0 (zero-value fidelity check)
    fireEvent.click(screen.getByTestId('poker-card-0'))
    await waitFor(() => {
      expect(screen.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 0')
    })
    expect(mock.selectOverrideScore).toHaveBeenNthCalledWith(2, 0)
    expect(screen.getByTestId('poker-card-0')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('poker-card-13')).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders "No numeric votes" and override prompt when all votes are "?" with neither Set Story Points nor Copy Score until 0..21 is selected', async () => {
    const allQuestionWithField = makeRevealedSnapshot({
      participants: [makeParticipant('acc-alice', 'Alice', '?'), makeParticipant('acc-bob', 'Bob', '?')],
      viewerCard: '?',
      average: null,
      formattedAverage: null,
      recommendedScore: null,
      targetScore: null,
    })
    const mockWithField = createMockPokerClient(allQuestionWithField)
    mockWithField.selectOverrideScore.mockResolvedValueOnce({
      ...allQuestionWithField,
      targetScore: 0,
    })

    const { unmount } = render(<ScrumPokerApp client={mockWithField.client} />)

    await screen.findByTestId('no-numeric-votes')
    expect(screen.getByTestId('no-numeric-votes')).toHaveTextContent('No numeric votes')
    expect(screen.getByTestId('override-prompt')).toHaveTextContent(
      'Select any numeric card (0–21) to set or copy a score.',
    )
    expect(screen.queryByTestId('average-score')).toBeNull()
    expect(screen.queryByTestId('recommended-score')).toBeNull()
    expect(screen.queryByTestId('apply-story-points-button')).toBeNull()
    expect(screen.queryByTestId('copy-score-button')).toBeNull()
    expect(screen.getByTestId('revote-button')).toBeEnabled()
    expect(screen.getByTestId('poker-card-question')).toBeDisabled()

    // Selecting numeric override 0 activates Set Story Points → 0 and removes override-prompt
    fireEvent.click(screen.getByTestId('poker-card-0'))
    await waitFor(() => {
      expect(screen.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 0')
    })
    expect(screen.getByTestId('poker-card-0')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('no-numeric-votes')).toHaveTextContent('No numeric votes')
    expect(screen.queryByTestId('override-prompt')).toBeNull()

    unmount()

    // Repeat when storyPointsField is null -> activates Copy Score (2) once card 2 is selected
    const allQuestionMissingField = {
      ...allQuestionWithField,
      storyPointsField: null,
    }
    const mockMissingField = createMockPokerClient(allQuestionMissingField)
    mockMissingField.selectOverrideScore.mockResolvedValueOnce({
      ...allQuestionMissingField,
      targetScore: 2,
    })

    render(<ScrumPokerApp client={mockMissingField.client} />)

    await screen.findByTestId('missing-field-warning')
    expect(screen.queryByTestId('apply-story-points-button')).toBeNull()
    expect(screen.queryByTestId('copy-score-button')).toBeNull()
    expect(screen.getByTestId('override-prompt')).toHaveTextContent(
      'Select any numeric card (0–21) to set or copy a score.',
    )

    fireEvent.click(screen.getByTestId('poker-card-2'))
    await waitFor(() => {
      expect(screen.getByTestId('copy-score-button')).toHaveTextContent('Copy Score (2)')
    })
    expect(screen.queryByTestId('apply-story-points-button')).toBeNull()
  })

  it.each([{ score: 0 as const }, { score: 8 as const }])(
    'saves score $score via Set Story Points, refreshes issue view once, shows confirmation on cleared idle panel, and clears banner on next vote',
    async ({ score }) => {
      const mock = createMockPokerClient(
        makeRevealedSnapshot({
          participants: [makeParticipant('acc-alice', 'Alice', String(score) as '0' | '8')],
          viewerCard: String(score) as '0' | '8',
          average: score,
          formattedAverage: String(score),
          recommendedScore: score,
          targetScore: score,
        }),
      )
      mock.applyStoryPoints.mockResolvedValueOnce({
        ok: true,
        appliedScore: score,
        fieldName: 'Story Points',
        session: makeIdleVotingSnapshot({ roundId: `round-saved-${score}`, participants: [] }),
      })
      mock.castVote.mockResolvedValueOnce(
        makeVotingSnapshot({
          roundId: `round-saved-${score}`,
          viewerCard: '3',
          participants: [makeParticipant('acc-alice', 'Alice', null)],
        }),
      )

      render(<ScrumPokerApp client={mock.client} />)

      const applyBtn = await screen.findByTestId('apply-story-points-button')
      expect(applyBtn).toHaveTextContent(`Set Story Points → ${score}`)

      fireEvent.click(applyBtn)

      const banner = await screen.findByTestId('points-applied-banner')
      expect(banner).toHaveAttribute('role', 'status')
      expect(banner).toHaveTextContent(`Story Points set to ${score}`)
      expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
      expect(mock.applyStoryPoints).toHaveBeenCalledWith(score)
      expect(mock.refreshIssueView).toHaveBeenCalledTimes(1)

      // Casting a new vote clears the post-save confirmation banner
      fireEvent.click(screen.getByTestId('poker-card-3'))
      await waitFor(() => {
        expect(screen.getByTestId('poker-card-3')).toHaveAttribute('aria-pressed', 'true')
      })
      expect(screen.queryByTestId('points-applied-banner')).toBeNull()
    },
  )

  it('preserves revealed votes and targetScore and displays alert banner on "forbidden", "jira-error", or applyStoryPoints RPC rejection', async () => {
    const initialRevealed = makeRevealedSnapshot({
      participants: [makeParticipant('acc-alice', 'Alice', '8'), makeParticipant('acc-bob', 'Bob', '8')],
      average: 8,
      formattedAverage: '8',
      recommendedScore: 8,
      targetScore: 8,
    })
    const mock = createMockPokerClient(initialRevealed)
    mock.applyStoryPoints
      .mockResolvedValueOnce({
        ok: false,
        reason: 'forbidden',
        score: 8,
        message: 'You do not have permission to edit Story Points on this Jira issue.',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'jira-error',
        score: 8,
        message: 'Failed to update Story Points in Jira (HTTP 500).',
      })
      .mockRejectedValueOnce(new Error('Bridge network timeout'))

    render(<ScrumPokerApp client={mock.client} />)
    await screen.findByTestId('apply-story-points-button')

    // 1. 'forbidden'
    fireEvent.click(screen.getByTestId('apply-story-points-button'))
    expect(await screen.findByTestId('error-banner')).toHaveTextContent(
      'You do not have permission to edit Story Points on this Jira issue.',
    )
    expect(screen.getByTestId('error-banner')).toHaveAttribute('role', 'alert')
    expect(screen.getAllByTestId('participant-chip').map((el) => el.textContent)).toEqual(['Alice: 8', 'Bob: 8'])
    expect(screen.getByTestId('apply-story-points-button')).toHaveTextContent('Set Story Points → 8')
    expect(mock.refreshIssueView).not.toHaveBeenCalled()

    // 2. 'jira-error'
    fireEvent.click(screen.getByTestId('apply-story-points-button'))
    await waitFor(() => {
      expect(screen.getByTestId('error-banner')).toHaveTextContent('Failed to update Story Points in Jira (HTTP 500).')
    })
    expect(screen.getAllByTestId('participant-chip').map((el) => el.textContent)).toEqual(['Alice: 8', 'Bob: 8'])
    expect(mock.refreshIssueView).not.toHaveBeenCalled()

    // 3. RPC rejection
    fireEvent.click(screen.getByTestId('apply-story-points-button'))
    await waitFor(() => {
      expect(screen.getByTestId('error-banner')).toHaveTextContent('Bridge network timeout')
    })
    expect(screen.getAllByTestId('participant-chip').map((el) => el.textContent)).toEqual(['Alice: 8', 'Bob: 8'])
    expect(mock.refreshIssueView).not.toHaveBeenCalled()
  })

  it('switches immediately in place to missing-field warning + Copy Score (<targetScore>) when applyStoryPoints returns "missing-field"', async () => {
    const mock = createMockPokerClient(
      makeRevealedSnapshot({
        participants: [makeParticipant('acc-alice', 'Alice', '5')],
        average: 5,
        formattedAverage: '5',
        recommendedScore: 5,
        targetScore: 5,
      }),
    )
    mock.applyStoryPoints.mockResolvedValueOnce({
      ok: false,
      reason: 'missing-field',
      score: 5,
      message: 'No editable Story Points field is available on this issue screen.',
    })

    const writeText = vi.fn(async (_text: string): Promise<void> => {})

    render(
      <ScrumPokerApp
        client={mock.client}
        clipboardEnv={{
          clipboard: { writeText },
          document: null,
        }}
      />,
    )

    const applyBtn = await screen.findByTestId('apply-story-points-button')
    expect(applyBtn).toHaveTextContent('Set Story Points → 5')

    fireEvent.click(applyBtn)

    const warning = await screen.findByTestId('missing-field-warning')
    expect(warning).toHaveAttribute('role', 'note')
    expect(warning).toHaveTextContent('No editable Story Points field is available on this issue screen.')
    expect(screen.queryByTestId('apply-story-points-button')).toBeNull()

    const copyBtn = screen.getByTestId('copy-score-button')
    expect(copyBtn).toHaveTextContent('Copy Score (5)')
    expect(screen.getAllByTestId('participant-chip').map((el) => el.textContent)).toEqual(['Alice: 5'])
    expect(mock.refreshIssueView).not.toHaveBeenCalled()

    fireEvent.click(copyBtn)
    expect(await screen.findByTestId('copy-feedback')).toHaveTextContent('Copied!')
    expect(writeText).toHaveBeenCalledWith('5')
  })

  it('renders missing-field warning when storyPointsField is null and covers clipboard writeText, execCommand textarea fallback + DOM cleanup, and manual-copy error fallback', async () => {
    const missingFieldRevealed = makeRevealedSnapshot({
      participants: [makeParticipant('acc-alice', 'Alice', '5'), makeParticipant('acc-bob', 'Bob', '8')],
      average: 6.5,
      formattedAverage: '6.5',
      recommendedScore: 8,
      targetScore: 5,
      storyPointsField: null,
    })

    // 1. Primary navigator.clipboard.writeText success + clear feedback on override
    const writeTextSuccess = vi.fn(async (_text: string): Promise<void> => {})
    const mock1 = createMockPokerClient(missingFieldRevealed)
    mock1.selectOverrideScore.mockResolvedValueOnce({
      ...missingFieldRevealed,
      targetScore: 0,
    })

    const { unmount: unmount1 } = render(
      <ScrumPokerApp
        client={mock1.client}
        clipboardEnv={{
          clipboard: { writeText: writeTextSuccess },
          document: null,
        }}
      />,
    )

    expect(await screen.findByTestId('missing-field-warning')).toHaveTextContent(
      'No editable Story Points field is available on this issue screen.',
    )
    expect(screen.queryByTestId('apply-story-points-button')).toBeNull()
    const copyBtn1 = screen.getByTestId('copy-score-button')
    expect(copyBtn1).toHaveTextContent('Copy Score (5)')

    fireEvent.click(copyBtn1)
    const feedback1 = await screen.findByTestId('copy-feedback')
    expect(feedback1).toHaveAttribute('role', 'status')
    expect(feedback1).toHaveTextContent('Copied!')
    expect(writeTextSuccess).toHaveBeenCalledWith('5')
    expect(screen.getAllByTestId('participant-chip').map((el) => el.textContent)).toEqual(['Alice: 5', 'Bob: 8'])

    // Overriding targetScore to 0 clears Copied! feedback and updates button to Copy Score (0)
    fireEvent.click(screen.getByTestId('poker-card-0'))
    await waitFor(() => {
      expect(screen.getByTestId('copy-score-button')).toHaveTextContent('Copy Score (0)')
    })
    expect(screen.queryByTestId('copy-feedback')).toBeNull()
    unmount1()

    // 2. Hidden textarea execCommand('copy') fallback when writeText rejects, with DOM cleanup
    const execCommandSpy = vi.fn((cmd: string): boolean => cmd === 'copy')
    const legacyDoc: LegacyCopyDocumentLike = {
      body: document.body,
      createElement: (tag) => document.createElement(tag),
      execCommand: execCommandSpy,
    }
    const mock2 = createMockPokerClient({ ...missingFieldRevealed, targetScore: 0 })
    const { unmount: unmount2 } = render(
      <ScrumPokerApp
        client={mock2.client}
        clipboardEnv={{
          clipboard: {
            writeText: async () => {
              throw new Error('Blocked by sandboxed iframe policy')
            },
          },
          document: legacyDoc,
        }}
      />,
    )

    const copyBtn2 = await screen.findByTestId('copy-score-button')
    expect(copyBtn2).toHaveTextContent('Copy Score (0)')
    fireEvent.click(copyBtn2)

    expect(await screen.findByTestId('copy-feedback')).toHaveTextContent('Copied!')
    expect(execCommandSpy).toHaveBeenCalledWith('copy')
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
    unmount2()

    // 3. Inline manual-copy fallback message containing numeric score when both clipboard paths fail, cleared on Re-vote
    const mock3 = createMockPokerClient(missingFieldRevealed)
    mock3.resetRound.mockResolvedValueOnce(makeIdleVotingSnapshot({ storyPointsField: null }))

    render(
      <ScrumPokerApp
        client={mock3.client}
        clipboardEnv={{
          clipboard: null,
          document: {
            body: document.body,
            createElement: (tag) => document.createElement(tag),
            execCommand: () => false,
          },
        }}
      />,
    )

    fireEvent.click(await screen.findByTestId('copy-score-button'))
    const fallbackAlert = await screen.findByTestId('copy-fallback-message')
    expect(fallbackAlert).toHaveAttribute('role', 'alert')
    expect(fallbackAlert.textContent).toContain('5')
    expect(document.body.querySelectorAll('textarea')).toHaveLength(0)
    expect(screen.getAllByTestId('participant-chip')).toHaveLength(2)

    fireEvent.click(screen.getByTestId('revote-button'))
    await waitFor(() => {
      expect(screen.getByTestId('empty-voters-prompt')).toHaveTextContent('Pick a card to start voting')
    })
    expect(screen.queryByTestId('copy-fallback-message')).toBeNull()
  })
})
