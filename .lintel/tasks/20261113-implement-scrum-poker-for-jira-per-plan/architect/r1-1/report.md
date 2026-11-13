# Architect Report (`r1-1`): Phase 2 Design, Contract, and Code Stubs

## Summary

- **Plan Status (`shared/plan.md`):** Preserved `shared/plan.md` unchanged (Phase 1 delivered and byte-for-byte intact; Phase 2 covers `R1, R2, R3, R4, R5, R6, R8, R9, R10, R11, R14`; Phase 3 covers `R12, R13, R14`).
- **Phase 2 Deliverables Created:**
  - `shared/phase-2/design.md`: Component DAG, minimal structural SDK port seams, control flow, concurrency/pagination invariants, trust boundaries, operability/resilience rules, and a complete `## Test outline` covering all 11 Phase 2 requirements plus `integration: none` and `e2e: none`.
  - `shared/phase-2/contract.md`: Complete TypeScript signatures, behaviour and error invariants, external Forge/Jira interfaces, data invariants, and `## Stub files`.
  - **Code Stubs (`src/`):** Created `src/observability/logger.ts`, `src/storage/session-store.ts`, `src/realtime/publisher.ts`, `src/jira/jira-client.ts`, `src/resolvers/poker-resolvers.ts`, and updated `src/index.ts`. All Phase 1 modules under `src/domain/` remain untouched.

## Key Architectural Decisions

1. **Minimal Structural SDK Ports & Injectable Clock:**
   - `SessionStore` (`KvsClientLike`), `RealtimePublisher` (`RealtimePublishFn`), `JiraClient` (`JiraRequester`), `BackendLogger` (`LogSink`), and `PokerResolverHandlers` (`PokerBackendDeps` with `now: () => number`) accept optional narrow structural ports whose defaults bind to `@forge/kvs`, `@forge/realtime`, `@forge/api` (`api.asUser().requestJira`), `@forge/resolver`, and `() => Date.now()`. Verified type compatibility directly against all installed `@forge/*` v1–v6 declarations via `tsc --noEmit`.
2. **Zero Lost Votes Under Concurrent Initialization & Multi-Page Pagination (`R4`, `R9`):**
   - Per-voter KVS keys (`poker:${issueId}:${roundId}:vote:${accountId}`) eliminate shared-array lost updates, while deterministic `nextRoundId` progression (`null -> 'round-1'`, `'round-N' -> 'round-(N+1)'`) prevents concurrent initial votes on an idle or expired issue from splitting across random round IDs.
   - `listVoterRecords` and `deleteRoundVotes` exhaust all `@forge/kvs` `nextCursor` pages (`.limit(100)`), collecting all keys across pages before deleting in `deleteRoundVotes` so index-offset cursors cannot shift mid-scan.
3. **Trust-Boundary Validation, Secrecy & Failure Atomicity (`R1`, `R2`, `R5`, `R11`, `R14`):**
   - `extractAuthenticatedContext` derives `issueId` and `accountId` strictly from Forge's authenticated `context` (permitting colon-delimited Atlassian `accountId`s while blocking untrimmed, blank, overlong, or path-separator strings) and ignores spoofed `payload` identifiers.
   - `applyStoryPoints` verifies an active `'revealed'` round before calling Jira, writes via `PUT /rest/api/3/issue/${issueId}` as the acting user, clears the round and emits `'points-applied'` only on `2xx`, and preserves the `'revealed'` round, votes, and `targetScore` intact on `'missing-field'`, `'forbidden'` (`401`/`403`), or `'jira-error'`.
   - `sanitizeLogMetadata` / `createBackendLogger` and `validatePlatformManifest` enforce redacted structured diagnostics and `Runs on Atlassian` zero-egress compliance.

## Verification

- Executed `./.lintel/scripts/build.sh`: `manifest.yml` zero-egress check, `biome lint`, `biome format`, `tsc --noEmit`, and `vite build` all passed with exit code `0`.
