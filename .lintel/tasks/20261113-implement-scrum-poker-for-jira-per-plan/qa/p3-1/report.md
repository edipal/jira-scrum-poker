# QA Acceptance Test Report — Phase 3 (`qa/p3-1`)

## Summary

Implemented the Phase 3 acceptance test suite under `tests/panel/` and shared Custom UI / `@forge/bridge` doubles under `tests/helpers/panel-doubles.ts`, enforcing all Phase 3 requirements (`R12`, `R13`, `R14`), `shared/phase-3/design.md` (`## Test outline`), and `shared/phase-3/contract.md`.

## Coverage Mapped to `## Test outline`

1. **`R12 unit` — Realtime subscription, event parsing, live multi-user sync, epoch race guards, 64-round refresh deduplication, and unmount cleanup**
   - **`tests/panel/poker-client.test.ts`:**
     - Verifies `parseRealtimeEvent` accepts valid object and single-encoded JSON-string `'SESSION_UPDATED'` and `'points-applied'` events across all 8 `FibonacciScore` values (`0..21`), `1`-char and `128`-char `roundId` boundaries, `Object.create(null)` records, and `-0` -> `0` `updatedAt` normalization.
     - Verifies `parseRealtimeEvent` returns `null` (never throwing) on malformed JSON, empty/whitespace strings, double-encoded JSON strings, non-plain objects, error objects, `129`-char or path-character (`/`/`\`/`\0`) `roundId`s, non-finite `updatedAt`, invalid scores (`-0`, `-1`, `4`, `3.5`, `22`, `'?'`), and any vote/card-bearing property (`card`, `cards`, `viewerCard`, `viewer_card`, `viewer-card`, `vote`, `votes`, `participants`).
     - Verifies `createPokerClient` forwards all 7 RPC methods and host `view` methods (`enableTheme`, `refreshIssueView`), defaults to `@forge/bridge` when `deps` are omitted, rejects invalid `castVote` cards and `selectOverrideScore` / `applyStoryPoints` scores with `RangeError` before calling `invoke`, throws `TypeError` synchronously on non-function `subscribeToSessionEvents` listeners, subscribes to `'scrum-poker'`, filters bridge error deliveries, suppresses callbacks synchronously on cleanup, calls `unsubscribe` idempotently both after `subscribe` resolves and when cleaned up before `subscribe` settles, and swallows `subscribe` / `unsubscribe` rejections.
   - **`tests/panel/live-sync-and-compliance.test.tsx`:**
     - Synchronizes two live `<ScrumPokerApp />` panels (`Alice` and `Bob`) end-to-end through `createPokerClient` and Phase 2's real `createPokerResolverHandlers` across peer vote cast (preserving vote secrecy), vote withdrawal, democratic reveal, `targetScore` override (including `0`), round reset, and Story Points save without `setInterval` polling or page reload.
     - Verifies JSON-string realtime handling and suppression of malformed, double-encoded, error, and card-bearing payloads on `'scrum-poker'` without extra `getSession` calls.
     - Verifies out-of-order background `getSession` responses superseded by newer background fetches or direct user mutations (`mutationEpoch`) are ignored.
     - Verifies both acting and peer panels transition to cleared idle state, render `Story Points set to <score>` (including `0`), and invoke `view.refresh` once per panel—deduplicating self-echoed `'points-applied'` events both before and after `applyStoryPoints` settles and across the bounded `64`-round FIFO capacity (`round-1`..`round-64` retained, `round-65` evicts `round-1`).
     - Verifies deterministic `unsubscribe()` invocation on unmount (both after `subscribe` resolves and when unmounted before `subscribe` settles) and suppression of post-unmount state updates and `view.refresh()` calls.

2. **`R13 unit` — Theme initialization, local Light/Dark CSS tokens, 9-card Fibonacci deck, and `'voting'` controls**
   - **`tests/panel/scrum-poker-app-voting.test.tsx` & `tests/panel/live-sync-and-compliance.test.tsx`:**
     - Verifies `ScrumPokerApp` calls `view.theme.enable` (`enableTheme`) on initialization (tolerating rejections gracefully), renders `Loading Scrum Poker…` while initial `getSession` is pending, and renders an `alert` error banner plus `Retry` recovery when initial load fails.
     - Verifies `bootstrapIssuePanel` validates `HTMLElement` (`TypeError` on invalid containers), mounts `<ScrumPokerApp />` without `StrictMode` double-invocation, unmounts cleanly, and auto-mounts into `#root` when `static/panel/src/main.tsx` loads with `#root` present.
     - Verifies `static/panel/src/styles.css` defines all 17 contracted Atlassian Design System tokens (`--ds-surface` through `--ds-text-success`), `@media (prefers-color-scheme: dark)` and `[data-color-mode="dark"]` dark-mode rules, and `:focus-visible` outlines.
     - Verifies all 9 deck cards (`'0'`, `'1'`, `'2'`, `'3'`, `'5'`, `'8'`, `'13'`, `'21'`, `'?'`) render in canonical order with accurate `aria-pressed` states, cast/update votes on unpressed cards, call `withdrawVote` when clicking `viewerCard` (`'0'`, `'8'`, `'?'`), lock buttons while mutations are in flight, render `'Pick a card to start voting'` with `Show Votes` and `Reset` disabled at `0` voters, and render `'<Display Name> ✓'` chips (never leaking cards) with `Show Votes` and `Reset` enabled at `>= 1` voters.

3. **`R13 unit` — `'revealed'` controls, consensus override, Story Points write-back, error atomicity, missing-field mode, and clipboard fallback**
   - **`tests/panel/copy-score.test.ts` & `tests/panel/scrum-poker-app-revealed.test.tsx`:**
     - Verifies `formatScoreForClipboard` and `copyScoreToClipboard` across all 8 valid scores (`0..21`), `RangeError` rejection on invalid inputs (`-0`, negatives, decimals, `NaN`, `Infinity`, non-Fibonacci values), primary `navigator.clipboard.writeText` path, hidden read-only `<textarea>` + `document.execCommand('copy')` fallback with guaranteed `finally` DOM cleanup, and graceful `{ ok: false, text, message }` fallback containing the decimal score.
     - Verifies `'<Display Name>: <card>'` chips, formatted `Average` and `Recommended` display, `'?'` disabled (`aria-pressed="false"`), active `targetScore` card (`0..21`, including `0`) marked `aria-pressed="true"`, and `'No numeric votes'` + override prompt when all votes are `'?'` (with neither `Set Story Points` nor `Copy Score` rendered until an override card `0..21` is selected).
     - Verifies `Set Story Points → <targetScore>` saves scores (`0` and `8`), refreshes the issue view once, renders `Story Points set to <score>` on the cleared idle panel, and clears the confirmation banner on the next vote; preserves revealed votes and `targetScore` with an `alert` banner on `'forbidden'`, `'jira-error'`, or RPC rejection; and displays the inline missing-field warning plus `Copy Score (<targetScore>)` whenever `storyPointsField === null` or `applyStoryPoints` returns `'missing-field'` (covering `Copied!`, `execCommand('copy')` DOM cleanup, and inline manual-copy fallback message).

4. **`R14 unit` — `validateUiAssetCompliance`, static repository inspection, and zero-egress / vote-secrecy enforcement**
   - **`tests/panel/live-sync-and-compliance.test.tsx` & `tests/panel/scrum-poker-app-voting.test.tsx`:**
     - Verifies `validateUiAssetCompliance` enforces string argument types (`TypeError`), permits standard W3C XML namespace URIs (`svg`, `xhtml`, `MathML`, `xlink`) and `@forge/bridge`, and flags any `http://` / `https://` URL, protocol-relative external URL (`//...`), direct browser network call (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`), or backend Forge import (`@forge/kvs`, `@forge/api`, `@forge/realtime`, `@forge/resolver`).
     - Statically inspects `manifest.yml`, `static/panel/index.html`, `static/assets/icon.svg`, `static/panel/src/styles.css`, and every `.ts`/`.tsx` module under `static/panel/src/` confirming zero external egress violations and strictly type-only (`import type` / `export type`) references to `src/`.
     - Confirms zero external `<img>` avatar requests and zero `console` vote logging during `'voting'`.

5. **Exempted Groups (`integration: none`, `e2e: none`)**
   - `integration` and `e2e` are explicitly exempted in `shared/phase-3/design.md` (`## Test outline`).

## Verification Results

- `./.lintel/scripts/build.sh`: **exit `0`** (`biome lint`, `biome format`, `tsc --noEmit`, and `vite build` succeeded cleanly).
- `./.lintel/scripts/test-unit.sh`: **exit `1` (Red-on-Stub)** — TypeScript compiled cleanly (`0` errors), all 9 prior Phase 1 & Phase 2 suites passed (`615` passed), and all 5 new Phase 3 suites failed red against the Architect stubs (`133` failed across `133` new Phase 3 test cases; `0` false-positive passes on stubs).
