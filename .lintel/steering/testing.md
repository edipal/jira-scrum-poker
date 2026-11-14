# Testing

## Test Groups

- **Unit (`unit` — `.lintel/scripts/test-unit.sh`):**
  - Runs `tsc --noEmit` (exiting `2` on compile errors) followed by `vitest run` (`jsdom` environment) across all suites under `tests/`.
  - Covers all three architectural layers in-process:
    1. **Pure Domain Rules:** Fibonacci deck validation, numeric mean calculation, nearest-Fibonacci snapping with upward tie-breaking, `?`-only rounds, 24-hour expiry evaluation, pre-reveal vote redaction, and `editmeta` Story Points field matching.
    2. **Forge Backend Resolvers:** `@forge/resolver` handlers tested against deterministic in-memory doubles for `@forge/kvs`, `@forge/realtime`, and `@forge/api` (`asUser().requestJira`), including concurrent `Promise.all` voting, KVS cursor pagination, vote secrecy before reveal, and Story Points write-back / error handling.
    3. **Custom UI Components:** React 19 panel views tested with `@testing-library/react` against mocked `@forge/bridge` (`invoke`, `realtime.subscribe`, `view.theme.enable`, `view.refresh`) and clipboard APIs.
- **Integration (`integration`) & End-to-End (`e2e`):**
  - Configured with `"required": false` in `.lintel/config.jsonc` because Forge cloud runtimes execute inside Atlassian's hosted environment rather than local containers.
  - In every `shared/phase-<N>/design.md` (`## Test outline`), assign all requirement scenarios to `unit` and include explicit exemptions:
    - `- integration: none: Forge KVS, Realtime, and Jira REST boundaries are verified in-process via deterministic SDK doubles in the unit suite`
    - `- e2e: none: Custom UI workflows and Forge bridge interactions are verified under jsdom and Testing Library in the unit suite`

## Fixtures and Test Data

- **Location:** Store shared synthetic fixtures, mock Jira `editmeta` payloads, user profile builders, and in-memory Forge SDK doubles in helper modules under `tests/helpers/` (without test file suffixes so Vitest treats them as support modules rather than standalone suites).
- **Synthetic Data Hygiene:** Use realistic Jira Cloud shapes (`accountId`, `displayName`, avatar URLs, `customfield_10016` for company-managed `Story Points`, `customfield_10026` for team-managed `Story point estimate`) with zero real customer hostnames, emails, or tokens.

## Helpers

- **In-Memory `@forge/kvs` Harness:** Simulates `get`, `set` (recording `ttl` options), `delete`, and paginated `query().where('key', WhereConditions.beginsWith(...)).cursor(...).limit(...).getMany()` so tests verify both multi-page cursor loops and application-level 24-hour `updatedAt` expiration prior to lazy TTL deletion.
- **`@forge/bridge` & Realtime Harness:** Captures `realtime.subscribe` callbacks so UI tests can push live `SESSION_UPDATED` events and assert `unsubscribe` cleanup on component unmount.
- **Lintel `lock` Red-Phase Discipline:** Architect phase stubs must throw `new Error('not implemented')`, and every QA acceptance test must exercise positive target behaviour so `.lintel/scripts/test-unit.sh` exits `1` (red) during `lintel lock` before DEV implements the phase.
