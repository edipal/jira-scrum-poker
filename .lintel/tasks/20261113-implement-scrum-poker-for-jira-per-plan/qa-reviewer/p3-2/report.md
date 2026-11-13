# QA Review Report — Phase 3 Amend (`qa-reviewer/p3-2`)

## Verdict: `approve`

Audited QA's Phase 3 amended acceptance test suite (`qa/p3-2`) against `shared/requirements.md` (`R12`, `R13`, `R14`), `shared/phase-3/design.md` (`## Test outline`), `shared/phase-3/contract.md`, and the Phase 3 stub/implementation boundaries. All three amend fixes resolve genuine test-harness assumptions exposed after stub implementation without weakening any requirement or contract invariant, and both prior minor findings (`QAR-001`, `QAR-002`) have been cleanly resolved.

---

## 1. Amend Cycle Audit

1. **Testing Library internal `setInterval` filtering (`tests/panel/live-sync-and-compliance.test.tsx:44-65, 149` — `R12`):**
   - `@testing-library/dom`'s `waitFor` / `findByTestId` registers `setInterval(checkRealTimersCallback, 50)` internally under real timers once `ScrumPokerApp` renders past the stub throw.
   - QA's `getAppPollingIntervals()` filters out only `handler.name === 'checkRealTimersCallback'` and asserts zero application/client polling intervals both after initial load and after all six multi-panel live synchronization transitions. Any application polling interval still fails the assertion, preserving `R12` ("without polling or full-page reload") at full strength while still failing red against the Phase 3 stubs.
2. **Async default `@forge/bridge` `realtime.subscribe` settlement (`tests/panel/poker-client.test.ts:470-472` — `R12`, `R13`):**
   - Replaced the brittle single-tick `await Promise.resolve()` with `await vi.waitFor(() => expect(defaultBridgeState.subscribeCalls).toHaveLength(1))` to accommodate asynchronous `@forge/bridge` resolution under `subscribeToSessionEvents`'s synchronous cleanup return contract (`contract.md` §1). All channel, event-delivery, and `unsubscribe` assertions remain intact, and the test still fails red on `createPokerClient()` against the stub.
3. **Host `window.__bridge` shim in dynamic `#root` auto-mount test (`tests/panel/scrum-poker-app-voting.test.tsx:128-143, 181` — `R13`):**
   - Added a deterministic `window.__bridge = { callBridge }` host bridge double (with guaranteed `delete hostWindow.__bridge` teardown in `finally`) when dynamically importing `static/panel/src/main.tsx` after `vi.resetModules()` in `jsdom`. Against the Phase 3 stub, `bootstrapIssuePanel` still throws `'not implemented'` synchronously (red); against a spec-compliant implementation, `<ScrumPokerApp />` mounts into `#root` cleanly (green).

---

## 2. Test Outline Coverage Matrix

| Outline Item (`shared/phase-3/design.md`) | Implementing Test Suites & Cases | Status |
| :--- | :--- | :--- |
| **`R12 unit`:** `ScrumPokerApp` and `createPokerClient` subscribe to `'scrum-poker'` on mount; parse object and JSON-string `SESSION_UPDATED` and `points-applied` events (ignoring malformed, double-encoded, error, or card-bearing payloads); re-fetch `getSession` and re-render peer vote, withdrawal, reveal, `targetScore` override (including `0`), and reset without polling/reload; ignore stale out-of-order background `getSession` responses superseded by newer mutations; transition acting and peer panels to cleared idle state invoking `view.refresh` once per panel (deduplicating echoed `points-applied` by `roundId` up to `64` rounds); deterministically call `unsubscribe` on unmount (after `subscribe` resolves and before `subscribe` settles) while suppressing post-unmount events | `tests/panel/poker-client.test.ts` (`parseRealtimeEvent` valid/invalid/boundary/secrecy matrices, `createPokerClient` RPC forwarding, `RangeError`/`TypeError` guards, `'scrum-poker'` subscription, synchronous cleanup suppression, pre-settle `unsubscribe`, `@forge/bridge` defaults) and `tests/panel/live-sync-and-compliance.test.tsx` (two-panel live peer sync against Phase 2 `createPokerResolverHandlers` with `getAppPollingIntervals()` zero-polling assertion, JSON-string & invalid payload filtering, out-of-order background `getSession` + `mutationEpoch` race guards, pre-settle echo + 64-round FIFO capacity boundary `round-1`..`round-65`, post-resolve & pre-settle unmount `unsubscribe` + post-unmount refresh suppression) | **Covered** |
| **`R13 unit`:** `ScrumPokerApp` calls `view.theme.enable` on init; local Light/Dark Atlassian Design System CSS tokens in `styles.css`; renders all 9 deck cards (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`) in canonical order with accurate `aria-pressed` states; casts/updates votes on unpressed cards and calls `withdrawVote` when clicking `viewerCard` during `'voting'`; renders `'Pick a card to start voting'` with `Show Votes` and `Reset` disabled at `0` voters; renders `'<Display Name> ✓'` chips (never leaking cards) with `Show Votes` and `Reset` enabled at `>= 1` voters | `tests/panel/scrum-poker-app-voting.test.tsx` (`view.theme.enable` init & error tolerance, `Loading Scrum Poker…` status, `bootstrapIssuePanel` container validation / non-`StrictMode` mount / `#root` auto-mount, 9-card canonical order & `aria-pressed`, cast `'0'`/`'8'`/`'?'` + toggle `withdrawVote`, `0`-voter disabled controls, `'<Display Name> ✓'` secrecy chips & enabled controls, in-flight button locking & `Reset` error recovery) and `tests/panel/live-sync-and-compliance.test.tsx` (`styles.css` 17 contracted `--ds-*` tokens, `@media (prefers-color-scheme: dark)`, `[data-color-mode="dark"]`, `:focus-visible`) | **Covered** |
| **`R13 unit`:** Revealed-state controls, consensus override, Story Points write-back, and clipboard fallback (`'<Display Name>: <card>'` chips, formatted `Average` & `Recommended`, `'No numeric votes'` + override prompt when all votes are `'?'` with neither save nor copy rendered until `0..21` override selected, `'?'` disabled and active `targetScore` `0..21` marked `aria-pressed="true"`, `'Set Story Points → <targetScore>'` saving `0..21` and showing `'Story Points set to <score>'` on cleared idle panel, preserving revealed votes with alert banner on `'forbidden'`/`'jira-error'`/RPC rejection + initial-load `Retry`, and missing-field warning + `'Copy Score (<targetScore>)'` on `storyPointsField === null` or `'missing-field'` covering `writeText`, hidden `<textarea>` `execCommand('copy')` + DOM cleanup, and manual-copy fallback message with score) | `tests/panel/copy-score.test.ts` (`formatScoreForClipboard` & `copyScoreToClipboard` across `0..21`, `-0`/invalid `RangeError` matrix, `writeText` primary path, read-only `aria-hidden` `<textarea>` + `execCommand('copy')` + `finally` DOM removal, `{ ok: false }` manual message fallback, default `navigator.clipboard`) and `tests/panel/scrum-poker-app-revealed.test.tsx` (`'<Display Name>: <card>'` chips, `Average: 4.3` & `Recommended: 5`, `'?'` disabled, override `13` and `0`, all-`'?'` `No numeric votes` & override prompt with and without `storyPointsField`, `Set Story Points → 0` & `8` + `Story Points set to <score>` banner + clear on next vote, `'forbidden'`/`'jira-error'`/RPC rejection preservation, `'missing-field'` in-place switch, and all 3 clipboard outcomes) + `tests/panel/scrum-poker-app-voting.test.tsx` (initial-load `Retry`) | **Covered** |
| **`R14 unit`:** `validateUiAssetCompliance` and static inspection across `manifest.yml`, `static/panel/index.html`, `static/assets/icon.svg`, `static/panel/src/styles.css`, and all `static/panel/src` TS/TSX modules confirming zero external HTTP/HTTPS URLs (permitting standard W3C SVG/XML namespace URIs), zero protocol-relative external URLs, zero direct `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`sendBeacon` calls, zero backend `@forge/kvs`/`@forge/api`/`@forge/realtime`/`@forge/resolver` imports in frontend code, and zero external avatar `<img>` requests or `console` vote logging during voting | `tests/panel/live-sync-and-compliance.test.tsx` (`validateUiAssetCompliance` `TypeError` checks, W3C XML namespace whitelist, 15 egress/network/backend-SDK violation cases with and without `assetLabel`, static repository scan over `manifest.yml`, `index.html`, `icon.svg`, `styles.css`, and recursive `static/panel/src/**/*.{ts,tsx}` including comment-stripped, line-anchored type-only `src/` import verification) and `tests/panel/scrum-poker-app-voting.test.tsx` (`container.querySelectorAll('img')` empty, no `avatarUrl` in DOM, and `console.log`/`info`/`debug`/`warn`/`error` spies uncalled during voting) | **Covered** |
| **`integration: none`:** Forge KVS, Realtime, and Jira REST boundaries are verified in-process via deterministic SDK doubles in the unit suite | Verified: zero integration test files added or modified | **Respected** |
| **`e2e: none`:** Custom UI workflows and Forge bridge interactions are verified under jsdom and Testing Library in the unit suite | Verified: zero E2E test files added or modified | **Respected** |

---

## 3. Test Script & Build Execution Results

- **`./.lintel/scripts/build.sh`:** **Exit code `0`**
  - `manifest.yml` external egress check passed; `biome lint` and `biome format` checked 36 files cleanly; `tsc --noEmit` succeeded with zero errors; `vite build` bundled `static/panel/` cleanly.
- **`./.lintel/scripts/test-unit.sh`:** **Exit code `0` against workspace implementation (and verified Red-on-Stub against `d7fddc0` stubs)**
  - `tsc --noEmit` passed (`0` compilation errors).
  - Test Files: `14 passed (14)`.
  - Tests: `748 passed (748)` (`615` Phase 1/2 tests + `133` Phase 3 tests across `tests/panel/`).
  - Against the Phase 3 Architect stubs (`d7fddc0`), every new Phase 3 suite fails red (`exit 1`) on behavioral/type assertions with zero stub-placeholder assertions and zero vacuous passes.

---

## 4. Scope & Cleanliness Check

- **QA amend modifications (strictly inside `tests/`):**
  - `tests/panel/copy-score.test.ts`
  - `tests/panel/live-sync-and-compliance.test.tsx`
  - `tests/panel/poker-client.test.ts`
  - `tests/panel/scrum-poker-app-voting.test.tsx`
- **Build / Contract / Config files:** Unmodified (`paths.build` untouched during amend cycle).
- **Post-run working tree cleanliness:** Clean — running `./.lintel/scripts/build.sh` and `./.lintel/scripts/test-unit.sh` left zero untracked artifacts in test or source directories.

---

## 5. Findings Breakdown

- **`QAR-001` (`minor`, `fixed`) — `tests/panel/copy-score.test.ts:11`:**
  - Verified fixed: `vi.unstubAllGlobals()` is now invoked in `afterEach` alongside `vi.restoreAllMocks()`.
- **`QAR-002` (`minor`, `fixed`) — `tests/panel/live-sync-and-compliance.test.tsx:600`:**
  - Verified fixed: block and line comments are stripped first and the `import`/`export` regex is anchored to line starts (`/^\s*(?:import|export)\s+[\s\S]*?from\s+['"][^'"]+['"]/gm`).
