# QA Phase 3 Amend Report (`qa/p3-2`)

## Evaluation of `dev` `## Suspected test problem` & Test Fixes Applied

Evaluated `dev`'s report objectively against `shared/requirements.md` (`R12`, `R13`, `R14`) and `shared/phase-3/contract.md`. All three failures arose from genuine test-harness assumptions rather than contract or implementation defects, and have been fixed inside `tests/panel/`:

1. **False-positive `setInterval` spy collision with `@testing-library/dom`'s `waitFor` (`tests/panel/live-sync-and-compliance.test.tsx`, `R12`):**
   - **Root cause:** `@testing-library/dom`'s `waitFor` (invoked internally by `findByTestId`) unconditionally schedules `setInterval(checkRealTimersCallback, 50)` under real timers. During `lintel lock`, `ScrumPokerApp` threw synchronously on `render()` before `findByTestId` ran; once implemented, `findByTestId` invoked `setInterval` twice with `checkRealTimersCallback`.
   - **Fix:** Filtered `setIntervalSpy.mock.calls` to exclude Testing Library's internal `checkRealTimersCallback` (`getAppPollingIntervals()`) and asserted zero application/client polling intervals both after initial load and after all six multi-panel live synchronization transitions.

2. **Single-microtask timing assumption on async `@forge/bridge` `realtime.subscribe` delegation (`tests/panel/poker-client.test.ts`, `R12`/`R13`):**
   - **Root cause:** In `defaults to @forge/bridge invoke, realtime.subscribe, view.theme.enable, and view.refresh when deps are omitted`, `subscribeToSessionEvents` returns the synchronous `cleanup: () => Promise<void>` callback (`contract.md` §1) while initiating `realtime.subscribe` asynchronously. Waiting only a single microtask (`await Promise.resolve()`) checked `defaultBridgeState.subscribeCalls` before the async dynamic `@forge/bridge` delegation settled.
   - **Fix:** Replaced `await Promise.resolve()` with `await vi.waitFor(() => expect(defaultBridgeState.subscribeCalls).toHaveLength(1))` before inspecting channel arguments and delivering synthetic channel events.

3. **Unmocked `window.__bridge` host shim during dynamic ESM `#root` auto-mount (`tests/panel/scrum-poker-app-voting.test.tsx`, `R13`):**
   - **Root cause:** When dynamically re-evaluating `static/panel/src/main.tsx` after `vi.resetModules()` with `#root` present in `document`, externalized CommonJS `@forge/bridge` loaded through Node's native ESM translator (`@forge/bridge/out/bridge.js:10` `getCallBridge`), which throws `BridgeAPIError: Unable to establish a connection with the Custom UI bridge` in `jsdom` unless `window.__bridge.callBridge` is present.
   - **Fix:** Installed a deterministic `window.__bridge = { callBridge }` host bridge double for the `#root` auto-mount test and cleaned up `delete hostWindow.__bridge` in `finally`.

## Open Review Findings Addressed

- **QAR-001 (`fixed`):** Moved `vi.unstubAllGlobals()` into `afterEach` in `tests/panel/copy-score.test.ts` alongside `vi.restoreAllMocks()` so global `navigator` stubs are restored unconditionally.
- **QAR-002 (`fixed`):** Stripped block and single-line comments before matching `import`/`export` statements and anchored `/^\s*(?:import|export)\s+[\s\S]*?from\s+['"][^'"]+['"]/gm` to line starts in `tests/panel/live-sync-and-compliance.test.tsx`.

## Requirement & Test Outline Coverage (`R12`–`R14`)

- **R12 (`unit` — `tests/panel/poker-client.test.ts`, `tests/panel/live-sync-and-compliance.test.tsx`):**
  - Verifies `ScrumPokerApp` and `createPokerClient` subscribe to `'scrum-poker'` on mount, parse both object and single-encoded JSON-string `SESSION_UPDATED` and `'points-applied'` events (rejecting malformed, double-encoded, error, and card/vote-bearing payloads), re-fetch `getSession` and re-render peer vote, withdrawal, reveal, `targetScore` override (including `0`), and reset transitions with zero polling intervals, ignore stale out-of-order background `getSession` responses superseded by newer fetches or user mutations, transition acting and peer panels to cleared idle state while calling `view.refresh` once per panel per round across the 64-round FIFO deduplication window, and deterministically call `unsubscribe` on unmount (both after and before `subscribe` settles) while suppressing post-unmount updates.
- **R13 (`unit` — `tests/panel/scrum-poker-app-voting.test.tsx`, `tests/panel/scrum-poker-app-revealed.test.tsx`, `tests/panel/copy-score.test.ts`, `tests/panel/live-sync-and-compliance.test.tsx`):**
  - Verifies `view.theme.enable` initialization, local Light/Dark Atlassian Design System CSS tokens in `static/panel/src/styles.css`, all 9 Fibonacci cards (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`) in canonical order with accurate `aria-pressed` states, cast/update/withdraw interactions during `'voting'`, 0-voter empty prompt + disabled controls, `>= 1` voter `<Display Name> ✓` chips (never leaking cards or external avatars), revealed `<Display Name>: <card>` chips, formatted `Average` and `Recommended`, `'?'`-only `"No numeric votes"` + override prompt, post-reveal numeric overrides (`0..21`) with `'?'` disabled, `Set Story Points → <targetScore>` (`0..21`) with `Story Points set to <score>` confirmation, error banner preservation on `'forbidden'`/`'jira-error'`/RPC rejection plus initial-load `Retry`, and missing-field warning + `Copy Score (<targetScore>)` across `navigator.clipboard.writeText`, hidden `<textarea>` `execCommand('copy')` fallback with DOM cleanup, and manual-copy fallback message.
- **R14 (`unit` — `tests/panel/live-sync-and-compliance.test.tsx`, `tests/panel/scrum-poker-app-voting.test.tsx`):**
  - Verifies `validateUiAssetCompliance` and static inspection across `manifest.yml`, `static/panel/index.html`, `static/assets/icon.svg`, `static/panel/src/styles.css`, and all `static/panel/src/**/*.{ts,tsx}` modules confirm zero external HTTP/HTTPS URLs (allowing standard W3C XML namespaces), zero protocol-relative URLs, zero direct `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`sendBeacon` calls, zero backend `@forge/*` imports or runtime `src/` imports, and zero external avatar requests or console vote logging during voting.
- **integration (`none`) / e2e (`none`):** Exempted per `shared/phase-3/design.md`.

## Verification Results

- `./.lintel/scripts/test-unit.sh`: **exit `0`** (`14 passed (14)`, `748 passed (748)`)
- `./.lintel/scripts/build.sh`: **exit `0`** (`biome lint`, `biome format`, `tsc --noEmit`, `vite build` clean)
