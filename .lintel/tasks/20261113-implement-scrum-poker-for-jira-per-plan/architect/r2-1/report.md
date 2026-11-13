# Architect Report — Phase 3 (`r2-1`)

## Summary

Designed and stubbed **Phase 3: Custom UI Jira Issue Panel, Live Synchronization, Score Override, and Clipboard Fallback** (`Requirements: R12, R13, R14`), keeping `shared/plan.md` unchanged from the approved plan and establishing narrow, deterministic seams across the React 19 Custom UI layer (`static/panel/src/`).

## Architectural Decisions

1. **Strict Custom UI / Backend Runtime Isolation (`conventions.md`, `atlassian-forge`, `R14`):**
   - Frontend modules under `static/panel/src/` import runtime values strictly from `react`, `react-dom/client`, `@forge/bridge`, and sibling `static/panel/src/` modules, referencing `src/` exclusively via erased `import type` declarations so zero backend packages (`@forge/kvs`, `@forge/api`, `@forge/realtime`, `@forge/resolver`) can enter the Vite browser bundle.
   - `validateUiAssetCompliance` provides a deterministic zero-egress validator across HTML, SVG, CSS, and TS/TSX source files (allowing standard W3C XML namespace URIs such as `static/assets/icon.svg`'s `http://www.w3.org/2000/svg` while flagging external URLs, protocol-relative URLs, direct browser network calls, and backend Forge imports).

2. **Injectable Bridge & Clipboard Ports (`node-design`, `R12`, `R13`):**
   - `createPokerClient(deps)` wraps `@forge/bridge` (`invoke`, `realtime.subscribe`, `view.theme.enable`, `view.refresh`) and validates outbound card/score arguments with `RangeError` before invoking backend resolvers.
   - `subscribeToSessionEvents(onEvent)` subscribes to `'scrum-poker'`, parses object or JSON-string events via `parseRealtimeEvent` (actively rejecting malformed, double-encoded, or vote/card-bearing payloads), and returns an idempotent `() => Promise<void>` cleanup function that synchronously suppresses late events on unmount and awaits `subscription.unsubscribe()` even when unmounted before `subscribe` resolves.
   - `copyScoreToClipboard(score, env)` formats `0..21` via `formatScoreForClipboard`, tries `navigator.clipboard.writeText`, falls back to an off-screen `<textarea>` + `document.execCommand('copy')` with guaranteed `finally` DOM cleanup, and returns a structured `{ ok: false, text, message }` fallback if both mechanisms fail.

3. **Race-Safe UI Synchronization & Deduplicated Host Refresh (`R12`, `R13`):**
   - `ScrumPokerApp` enables host theming (`enableTheme`), subscribes to `'scrum-poker'`, and loads `getSession` on mount, using a monotonic `mutationEpoch` guard so stale background `getSession` responses never overwrite newer user mutations.
   - `handledPointsAppliedRoundIds` (bounded FIFO set of max `64` entries) deduplicates `roundId` between the acting user's `applyStoryPoints` response and echoed `'points-applied'` channel events so every open panel transitions to the cleared idle state, displays `Story Points set to <score>`, and calls `view.refresh()` once per applied round.
   - `bootstrapIssuePanel` mounts `<ScrumPokerApp />` via `createRoot` without `StrictMode` double-effect replay, and `static/panel/src/main.tsx` auto-mounts only when `#root` exists in `document`.

## Deliverables & Stub Files Verified

- `.lintel/tasks/20261113-implement-scrum-poker-for-jira-per-plan/shared/plan.md` (unchanged; Phases 1–2 preserved byte-for-byte, Phase 3 covers `R12, R13, R14`)
- `.lintel/tasks/20261113-implement-scrum-poker-for-jira-per-plan/shared/phase-3/design.md`
- `.lintel/tasks/20261113-implement-scrum-poker-for-jira-per-plan/shared/phase-3/contract.md`
- Code stubs (verified via `./.lintel/scripts/build.sh` exit `0` and `./.lintel/scripts/test-unit.sh` exit `0` across all 615 baseline Phase 1–2 tests):
  - `static/panel/src/bridge/poker-client.ts`
  - `static/panel/src/clipboard/copy-score.ts`
  - `static/panel/src/styles.css`
  - `static/panel/src/App.tsx`
  - `static/panel/src/main.tsx`
