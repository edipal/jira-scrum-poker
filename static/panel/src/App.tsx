import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeckCard, FibonacciScore, SessionSnapshot } from '../../../src/domain/types'
import { PANEL_DECK_CARDS, type PokerClient, type PokerRealtimeEvent, createPokerClient } from './bridge/poker-client'
import { type CopyScoreEnv, type CopyScoreResult, copyScoreToClipboard } from './clipboard/copy-score'

export type CopyScoreFn = (score: FibonacciScore, env?: CopyScoreEnv) => Promise<CopyScoreResult>

export interface ScrumPokerAppProps {
  readonly client?: PokerClient
  readonly copyScore?: CopyScoreFn
  readonly clipboardEnv?: CopyScoreEnv
}

type CopyNoticeState =
  | {
      readonly kind: 'copied'
    }
  | {
      readonly kind: 'fallback'
      readonly message: string
    }

const MAX_HANDLED_ROUND_IDS = 64

const themeInitByClient = new WeakMap<PokerClient, Promise<void>>()

export function ensureThemeEnabled(client: PokerClient): Promise<void> {
  const existing = themeInitByClient.get(client)
  if (existing !== undefined) {
    return existing
  }
  let pending: Promise<void>
  try {
    pending = Promise.resolve(client.enableTheme()).catch(() => {})
  } catch {
    pending = Promise.resolve()
  }
  themeInitByClient.set(client, pending)
  return pending
}

function recordHandledRoundId(handledSet: Set<string>, roundId: string): boolean {
  if (handledSet.has(roundId)) {
    return false
  }
  if (handledSet.size >= MAX_HANDLED_ROUND_IDS) {
    const oldest = handledSet.values().next()
    if (!oldest.done) {
      handledSet.delete(oldest.value)
    }
  }
  handledSet.add(roundId)
  return true
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return err
  }
  return 'An unexpected error occurred while communicating with Jira.'
}

export function ScrumPokerApp(props?: ScrumPokerAppProps): React.JSX.Element {
  const client = useMemo(() => props?.client ?? createPokerClient(), [props?.client])
  const copyScore = props?.copyScore ?? copyScoreToClipboard
  const clipboardEnv = props?.clipboardEnv

  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [appliedConfirmationScore, setAppliedConfirmationScore] = useState<FibonacciScore | null>(null)
  const [copyStatus, setCopyStatus] = useState<CopyNoticeState | null>(null)

  const mountedRef = useRef<boolean>(true)
  const sessionRef = useRef<SessionSnapshot | null>(null)
  const isMutatingRef = useRef<boolean>(false)
  const mutationEpochRef = useRef<number>(0)
  const latestFetchIdRef = useRef<number>(0)
  const handledPointsAppliedRoundIdsRef = useRef<Set<string>>(new Set<string>())

  const updateSession = useCallback((nextSession: SessionSnapshot): void => {
    sessionRef.current = nextSession
    setSession(nextSession)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void ensureThemeEnabled(client)

    const refreshSessionInBackground = async (): Promise<void> => {
      const fetchId = ++latestFetchIdRef.current
      const epochAtStart = mutationEpochRef.current

      try {
        const nextSnapshot = await client.getSession()
        if (!mountedRef.current) {
          return
        }
        if (
          isMutatingRef.current ||
          epochAtStart !== mutationEpochRef.current ||
          fetchId !== latestFetchIdRef.current
        ) {
          return
        }

        const prevSnapshot = sessionRef.current
        updateSession(nextSnapshot)
        setIsInitialLoading(false)

        if (nextSnapshot.status !== 'revealed' || nextSnapshot.targetScore !== prevSnapshot?.targetScore) {
          setCopyStatus(null)
        }
        if (nextSnapshot.participants.length > 0 || nextSnapshot.status === 'revealed') {
          setAppliedConfirmationScore(null)
        }
      } catch {
        // Ignore transient background refresh errors without disrupting active state
      }
    }

    const handleRealtimeEvent = (event: PokerRealtimeEvent): void => {
      if (!mountedRef.current) {
        return
      }

      if (event.type === 'SESSION_UPDATED') {
        void refreshSessionInBackground()
        return
      }

      if (event.type === 'points-applied') {
        setAppliedConfirmationScore(event.score)
        setCopyStatus(null)
        setErrorMessage(null)

        if (recordHandledRoundId(handledPointsAppliedRoundIdsRef.current, event.roundId)) {
          void refreshSessionInBackground()
          void client.refreshIssueView().catch(() => {})
        }
      }
    }

    const unsubscribe = client.subscribeToSessionEvents(handleRealtimeEvent)

    const handleVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refreshSessionInBackground()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    const loadInitial = async (): Promise<void> => {
      const fetchId = ++latestFetchIdRef.current
      const epochAtStart = mutationEpochRef.current
      setIsInitialLoading(true)
      setErrorMessage(null)

      try {
        const initialSnapshot = await client.getSession()
        if (!mountedRef.current) {
          return
        }
        if (epochAtStart !== mutationEpochRef.current || fetchId !== latestFetchIdRef.current) {
          return
        }
        updateSession(initialSnapshot)
        setIsInitialLoading(false)
      } catch (err: unknown) {
        if (!mountedRef.current) {
          return
        }
        if (epochAtStart !== mutationEpochRef.current || fetchId !== latestFetchIdRef.current) {
          return
        }
        setErrorMessage(extractErrorMessage(err))
        setIsInitialLoading(false)
      }
    }

    void loadInitial()

    return () => {
      mountedRef.current = false
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      void unsubscribe()
    }
  }, [client, updateSession])

  const handleRetryLoad = async (): Promise<void> => {
    if (isMutatingRef.current) {
      return
    }
    const fetchId = ++latestFetchIdRef.current
    const epochAtStart = mutationEpochRef.current
    setIsInitialLoading(true)
    setErrorMessage(null)

    try {
      const snapshot = await client.getSession()
      if (!mountedRef.current) {
        return
      }
      if (epochAtStart !== mutationEpochRef.current || fetchId !== latestFetchIdRef.current) {
        return
      }
      updateSession(snapshot)
      setIsInitialLoading(false)
    } catch (err: unknown) {
      if (!mountedRef.current) {
        return
      }
      if (epochAtStart !== mutationEpochRef.current || fetchId !== latestFetchIdRef.current) {
        return
      }
      setErrorMessage(extractErrorMessage(err))
      setIsInitialLoading(false)
    }
  }

  const runSessionMutation = async (operation: () => Promise<SessionSnapshot>): Promise<void> => {
    if (isMutatingRef.current) {
      return
    }
    isMutatingRef.current = true
    mutationEpochRef.current += 1
    setIsSubmitting(true)
    setErrorMessage(null)
    setAppliedConfirmationScore(null)
    setCopyStatus(null)

    try {
      const nextSnapshot = await operation()
      mutationEpochRef.current += 1
      if (!mountedRef.current) {
        return
      }
      updateSession(nextSnapshot)
    } catch (err: unknown) {
      mutationEpochRef.current += 1
      if (!mountedRef.current) {
        return
      }
      setErrorMessage(extractErrorMessage(err))
    } finally {
      isMutatingRef.current = false
      if (mountedRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  const handleCardClick = (card: DeckCard): void => {
    const currentSession = sessionRef.current
    if (currentSession === null || isMutatingRef.current) {
      return
    }

    if (currentSession.status === 'voting') {
      if (currentSession.viewerCard === card) {
        void runSessionMutation(() => client.withdrawVote())
      } else {
        void runSessionMutation(() => client.castVote(card))
      }
      return
    }

    if (card === '?') {
      return
    }

    const score = Number(card) as FibonacciScore
    void runSessionMutation(() => client.selectOverrideScore(score))
  }

  const handleRevealVotes = (): void => {
    const currentSession = sessionRef.current
    if (currentSession === null || currentSession.status !== 'voting' || currentSession.participants.length === 0) {
      return
    }
    void runSessionMutation(() => client.revealVotes())
  }

  const handleResetRound = (): void => {
    const currentSession = sessionRef.current
    if (currentSession === null) {
      return
    }
    if (currentSession.status === 'voting' && currentSession.participants.length === 0) {
      return
    }
    void runSessionMutation(() => client.resetRound())
  }

  const handleApplyStoryPoints = async (): Promise<void> => {
    const currentSession = sessionRef.current
    if (
      currentSession === null ||
      currentSession.status !== 'revealed' ||
      currentSession.targetScore === null ||
      isMutatingRef.current
    ) {
      return
    }

    const targetScore = currentSession.targetScore
    isMutatingRef.current = true
    mutationEpochRef.current += 1
    setIsSubmitting(true)
    setErrorMessage(null)
    setAppliedConfirmationScore(null)
    setCopyStatus(null)

    try {
      const result = await client.applyStoryPoints(targetScore)
      mutationEpochRef.current += 1
      if (!mountedRef.current) {
        return
      }

      if (result.ok) {
        updateSession(result.session)
        setAppliedConfirmationScore(result.appliedScore)

        const roundId = result.session.roundId
        if (roundId === null || recordHandledRoundId(handledPointsAppliedRoundIdsRef.current, roundId)) {
          await client.refreshIssueView().catch(() => {})
        }
        return
      }

      if (result.reason === 'missing-field') {
        const latestSession = sessionRef.current ?? currentSession
        updateSession({
          ...latestSession,
          storyPointsField: null,
        })
        return
      }

      setErrorMessage(
        result.message.trim().length > 0 ? result.message : 'Failed to update Story Points on this Jira issue.',
      )
    } catch (err: unknown) {
      mutationEpochRef.current += 1
      if (!mountedRef.current) {
        return
      }
      setErrorMessage(extractErrorMessage(err))
    } finally {
      isMutatingRef.current = false
      if (mountedRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  const handleCopyScore = async (): Promise<void> => {
    const currentSession = sessionRef.current
    if (
      currentSession === null ||
      currentSession.status !== 'revealed' ||
      currentSession.targetScore === null ||
      isMutatingRef.current
    ) {
      return
    }

    const targetScore = currentSession.targetScore
    const scoreText = String(targetScore)
    setCopyStatus(null)
    setErrorMessage(null)

    try {
      const result = await copyScore(targetScore, clipboardEnv)
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setCopyStatus({ kind: 'copied' })
      } else {
        const message =
          result.message.trim().length > 0 && result.message.includes(scoreText)
            ? result.message
            : `Clipboard unavailable — copy score manually: ${scoreText}`
        setCopyStatus({ kind: 'fallback', message })
      }
    } catch {
      if (!mountedRef.current) {
        return
      }
      setCopyStatus({
        kind: 'fallback',
        message: `Clipboard unavailable — copy score manually: ${scoreText}`,
      })
    }
  }

  if (session === null) {
    return (
      <section className="sp-panel" aria-label="Scrum Poker" data-testid="scrum-poker-panel">
        {isInitialLoading ? (
          <div className="sp-loading" role="status" data-testid="panel-loading">
            Loading Scrum Poker…
          </div>
        ) : (
          <>
            {errorMessage !== null && (
              <div className="sp-banner sp-banner-error" role="alert" data-testid="error-banner">
                {errorMessage}
              </div>
            )}
            <div className="sp-actions">
              <button
                type="button"
                className="sp-button sp-button-secondary"
                data-testid="retry-load-button"
                onClick={() => {
                  void handleRetryLoad()
                }}
              >
                Retry
              </button>
            </div>
          </>
        )}
      </section>
    )
  }

  const showPointsAppliedBanner =
    session.status === 'voting' && session.participants.length === 0 && appliedConfirmationScore !== null

  const showMissingFieldWarning = session.status === 'revealed' && session.storyPointsField === null

  return (
    <section className="sp-panel" aria-label="Scrum Poker" data-testid="scrum-poker-panel">
      {errorMessage !== null && (
        <div className="sp-banner sp-banner-error" role="alert" data-testid="error-banner">
          {errorMessage}
        </div>
      )}

      {showPointsAppliedBanner && (
        <div
          className="sp-banner sp-banner-success"
          role="status"
          aria-live="polite"
          data-testid="points-applied-banner"
        >
          Story Points set to {appliedConfirmationScore}
        </div>
      )}

      {showMissingFieldWarning && (
        <div className="sp-banner sp-banner-warning" role="note" data-testid="missing-field-warning">
          No editable Story Points field is available on this issue screen.
        </div>
      )}

      {/* biome-ignore lint/a11y/useSemanticElements: Contract specifies div with explicit role="group" */}
      <div className="sp-deck" role="group" aria-label="Estimation cards" data-testid="deck-cards">
        {PANEL_DECK_CARDS.map((card) => {
          const isQuestion = card === '?'
          const isPressed =
            session.status === 'voting'
              ? session.viewerCard === card
              : !isQuestion && session.targetScore !== null && String(session.targetScore) === card
          const isDisabled = session.status === 'revealed' ? isQuestion || isSubmitting : isSubmitting
          const testId = isQuestion ? 'poker-card-question' : `poker-card-${card}`

          return (
            <button
              key={card}
              type="button"
              className={`sp-card${isPressed ? ' sp-card-selected' : ''}`}
              data-testid={testId}
              data-card={card}
              aria-pressed={isPressed}
              disabled={isDisabled}
              onClick={() => {
                handleCardClick(card)
              }}
            >
              {card}
            </button>
          )
        })}
      </div>

      {session.status === 'voting' && session.participants.length === 0 ? (
        <p className="sp-empty-prompt" data-testid="empty-voters-prompt">
          Pick a card to start voting
        </p>
      ) : (
        <ul className="sp-participants" aria-label="Participants" data-testid="participant-list">
          {session.participants.map((participant) => (
            <li key={participant.accountId} className="sp-participant-chip" data-testid="participant-chip">
              {session.status === 'voting'
                ? `${participant.displayName} ✓`
                : `${participant.displayName}: ${participant.card ?? '?'}`}
            </li>
          ))}
        </ul>
      )}

      {session.status === 'revealed' && (
        <div className="sp-score-summary" data-testid="score-summary">
          {session.recommendedScore !== null && session.formattedAverage !== null ? (
            <>
              <span className="sp-metric" data-testid="average-score">
                Average: <strong>{session.formattedAverage}</strong>
              </span>
              <span className="sp-metric" data-testid="recommended-score">
                Recommended: <strong>{session.recommendedScore}</strong>
              </span>
            </>
          ) : (
            <>
              <span className="sp-no-numeric" data-testid="no-numeric-votes">
                No numeric votes
              </span>
              {session.targetScore === null && (
                <p className="sp-override-prompt" data-testid="override-prompt">
                  Select any numeric card (0–21) to set or copy a score.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="sp-actions" data-testid="panel-actions">
        {session.status === 'voting' ? (
          <>
            <button
              type="button"
              className="sp-button sp-button-primary"
              data-testid="show-votes-button"
              disabled={session.participants.length === 0 || isSubmitting}
              onClick={handleRevealVotes}
            >
              Show Votes
            </button>
            <button
              type="button"
              className="sp-button sp-button-secondary"
              data-testid="reset-round-button"
              disabled={session.participants.length === 0 || isSubmitting}
              onClick={handleResetRound}
            >
              Reset
            </button>
          </>
        ) : (
          <>
            {session.storyPointsField !== null && session.targetScore !== null && (
              <button
                type="button"
                className="sp-button sp-button-primary"
                data-testid="apply-story-points-button"
                disabled={isSubmitting}
                onClick={() => {
                  void handleApplyStoryPoints()
                }}
              >
                Set Story Points → {session.targetScore}
              </button>
            )}
            {session.storyPointsField === null && session.targetScore !== null && (
              <button
                type="button"
                className="sp-button sp-button-primary"
                data-testid="copy-score-button"
                disabled={isSubmitting}
                onClick={() => {
                  void handleCopyScore()
                }}
              >
                Copy Score ({session.targetScore})
              </button>
            )}
            <button
              type="button"
              className="sp-button sp-button-secondary"
              data-testid="revote-button"
              disabled={isSubmitting}
              onClick={handleResetRound}
            >
              Re-vote
            </button>
            {copyStatus?.kind === 'copied' && (
              <span className="sp-copy-feedback" role="status" aria-live="polite" data-testid="copy-feedback">
                Copied!
              </span>
            )}
            {copyStatus?.kind === 'fallback' && (
              <span className="sp-copy-fallback" role="alert" data-testid="copy-fallback-message">
                {copyStatus.message}
              </span>
            )}
          </>
        )}
      </div>
    </section>
  )
}
