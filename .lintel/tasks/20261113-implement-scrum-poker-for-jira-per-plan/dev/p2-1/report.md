# Phase 2 Implementation Report (`dev/p2-1`)

## Summary of Implementation

Implemented all six Phase 2 Forge backend modules under `src/` per `shared/phase-2/contract.md`, `shared/phase-2/design.md`, and `shared/requirements.md` (`R1`–`R6`, `R8`–`R11`, `R14`):

- `src/observability/logger.ts`: Implemented `sanitizeLogMetadata` (strict plain-object prototype check, `depth = 0..4` recursive sanitization with sensitive-key redaction to `REDACTED_VALUE` and `depth > 4` truncation to `'[TRUNCATED]'`, email and `Bearer`/`Basic` credential scrubbing, safe `Error` and `Date` formatting), `createBackendLogger` (structured JSON `WARN`/`ERROR` emitter), and `validatePlatformManifest` (`Runs on Atlassian` zero-egress, module/runtime/handler, and exact 4-scope validator).
- `src/storage/session-store.ts`: Implemented `assertSafeIdentifier`, `buildMetaKey`, `buildVoteKeyPrefix`, `buildVoteKey`, deterministic `BigInt`-backed `nextRoundId`, and `createSessionStore` over `@forge/kvs` with `KVS_TTL_24H`, dual 24-hour expiration filtering, and complete `nextCursor` pagination for `listVoterRecords` and two-phase `deleteRoundVotes`.
- `src/realtime/publisher.ts`: Implemented `createRealtimePublisher` publishing card-free `'SESSION_UPDATED'` and `'points-applied'` events on `'scrum-poker'` with best-effort runtime error logging via `BackendLogger`.
- `src/jira/jira-client.ts`: Implemented `createJiraClient` over `api.asUser().requestJira(route\`...\`)` for `/rest/api/3/myself` (PII-scrubbed voter profile with `'Unknown User'` fallback), `/rest/api/3/issue/{issueId}/editmeta` Story Points field detection (silent `null` degradation on `401`/`403`), and atomic `PUT /rest/api/3/issue/{issueId}` Story Points write-back (`'missing-field'`, `'forbidden'`, `'jira-error'`).
- `src/resolvers/poker-resolvers.ts` & `src/index.ts`: Implemented `extractAuthenticatedContext` (host-context-only `issueId` and `accountId` extraction), `createPokerResolverHandlers` across all 7 RPC handlers (`getSession`, `castVote`, `withdrawVote`, `revealVotes`, `selectOverrideScore`, `resetRound`, `applyStoryPoints`), `registerPokerResolvers`, and `export const handler = resolver.getDefinitions()`.

## Build & Gate Verification

- `./.lintel/scripts/build.sh`: **PASS (`exit 0`)** — zero external egress in `manifest.yml`, `biome lint` clean, `biome format` clean, `tsc --noEmit` strict typecheck clean, and Custom UI Vite bundle built cleanly.
- `./.lintel/bin/lintel check --phase p2`: **8 of 9 test suites passed (`577 passed (577)`, 0 assertion failures)**; 1 test suite failed at module collection time before running tests due to a test-side URL scheme error under JSDOM.

## Suspected test problem

During `./.lintel/bin/lintel check --phase p2`, `unit` exited with code `1` (`577 passed (577)` across 8 passing suites, 0 failed test assertions) with the following collection-time failure reported in stdout:

```text
--- Failing Group: unit (exit 1) ---
Summary: 577 passed (577)
Failures:
  TypeError: The URL must be of scheme file
Tail of output:
  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
   FAIL  tests/backend/observability-and-manifest.test.ts [ tests/backend/observability-and-manifest.test.ts ]
  TypeError: The URL must be of scheme file
   ❯ tests/backend/observability-and-manifest.test.ts:14:28
       12| import { createMemoryLogSink } from '../helpers/forge-doubles'
       13|
       14| const REPO_MANIFEST_YAML = readFileSync(new URL('../../manifest.yml', …
         |                            ^
       15|
       16| class CustomClassMetadata {
```

### Root Cause & Contract Alignment

1. Under Vitest's `jsdom` environment, global `URL` is JSDOM's `URL` constructor rather than Node's `node:url` `URL` (or resolves against JSDOM's `http://` base URL), causing Node 22's `fs.readFileSync(new URL(...))` at top-level module evaluation (line 14 of the test module) to throw `TypeError: The URL must be of scheme file` before any test in that suite executes. (Using `fileURLToPath` from `'node:url'` or `resolve(process.cwd(), 'manifest.yml')` from `'node:path'` or `URL` imported explicitly from `'node:url'` avoids JSDOM's global `URL` mismatch.)
2. Because this `TypeError` occurred during module collection, the suite also exited non-zero (`exit 1`) at `lintel lock` time alongside the unimplemented stubs, masking the module-load error during the red-phase gate.
3. Production module `src/observability/logger.ts` strictly satisfies `R14` (`shared/requirements.md`) and Section 1 of `shared/phase-2/contract.md`: `validatePlatformManifest(manifestYaml: string)` is a pure string validator with zero filesystem or `URL` calls, alongside `sanitizeLogMetadata` and `createBackendLogger`.
