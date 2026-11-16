# Conventions

## Code Style

- **Linting & Formatting (`biome.json`):**
  - Enforced by `.lintel/scripts/build.sh` via `./node_modules/.bin/biome lint` and `./node_modules/.bin/biome format`.
  - Formatting rules: `2`-space indentation, `120` line width, single quotes (`'`), `semicolons: "asNeeded"`, `trailingCommas: "all"`, `arrowParentheses: "always"`.
  - Linter rules: Biome `recommended` preset plus `nursery/noFloatingPromises: "error"`. Always `await` promises or explicitly mark intentional fire-and-forget cleanup calls with `void`.
  - Run `npm run format` after editing `.ts`, `.tsx`, or `.json` files.
- **TypeScript Strictness (`tsconfig.json`):**
  - `strict: true` and `noUncheckedIndexedAccess: true` are enabled repository-wide. Avoid `any`; narrow external JSON payloads (such as Jira REST responses and KVS records) with explicit runtime type guards.
- **Runtime Boundary Hygiene:**
  - Backend code (`src/`) must not reference DOM globals (`window`, `document`, `navigator`).
  - Frontend code (`static/panel/src/`) must only import `@forge/bridge`, `react`, `react-dom`, local frontend modules, or `import type` definitions from `src/`.

## Error Handling

- **Resolver Boundaries:** Extract `issueId` and caller `accountId` exclusively from Forge's authenticated host context (`extractAuthenticatedContext` in `src/resolvers/poker-resolvers.ts`, ignoring any client-supplied identifiers) and validate incoming `payload` values (`validateDeckCard`, `validateFibonacciScore`) before performing any KVS, Realtime, or Jira I/O. Reject contract violations and invalid state transitions via `PokerDomainError` (`code: 'validation-error' | 'invalid-state' | 'precondition-failed'`).
- **Graceful Jira Field Fallback ([D-07](decisions.md)):** Missing, non-numeric, read-only, or `401`/`403`-inaccessible Story Points fields during `getSession` are an expected workflow state, not a crash—return `storyPointsField: null` so the UI shows the inline warning and **Copy Score** button.
- **Atomic Jira Write-Back Outcomes ([D-10](decisions.md)):** Check `response.ok` on every `requestJira` call; `applyStoryPoints` maps missing fields (`'missing-field'`), authorization denials (`401`/`403` -> `'forbidden'`), and Jira/transport failures (`'jira-error'`) into a discriminated `{ ok: false, reason, score, message }` union without mutating KVS or clearing revealed votes so teammates can retry or copy the score.

## Logging

- **Structured & Redacted Backend Logging:** Emit backend diagnostics through `createBackendLogger` / `sanitizeLogMetadata` (`src/observability/logger.ts`), which serializes `WARN` / `ERROR` JSON entries (`level`, `event`, `timestamp`, `context`) with contextual identifiers (`issueId`, HTTP `status`) rather than raw payloads.
- **Secrecy & PII Invariant:** Never log cast card values (`card`, `cards`, `viewerCard`, `vote`, `votes`, `participants`), credentials (`Bearer`/`Basic`, tokens, cookies, secrets), or email addresses (`'[REDACTED]'`), and discard `emailAddress` immediately when parsing `/rest/api/3/myself`.

## API Style

- **Strict Vote Secrecy:** While `status === 'voting'`, resolver responses set `card: null` (`hasVoted: true`) on every `ParticipantView` (exposing only the caller's own pick in `SessionSnapshot.viewerCard`), and `@forge/realtime` payloads on channel `'scrum-poker'` carry only `{ type, roundId, updatedAt, score? }` (additionally enforced on the client by `parseRealtimeEvent`).
- **User-Scoped Jira Calls:** Always call `api.asUser().requestJira(...)` for issue `editmeta` checks, current-user lookups (`/rest/api/3/myself`), and Story Points `PUT` updates so Jira permissions and issue audit history reflect the acting user.
- **Zero External Egress (`Runs on Atlassian`, [D-01](decisions.md)):** Never add external URLs, CDNs, fonts, analytics, direct browser network calls (`fetch`, `XMLHttpRequest`, `WebSocket`), or `permissions.external` entries to `manifest.yml` or `static/` (verified programmatically by `validatePlatformManifest`, `validateUiAssetCompliance`, and `.lintel/scripts/build.sh`).
- **Documentation Hygiene:** Cite architectural/product decisions by stable ID (`D-01`..`D-10` in [decisions.md](decisions.md)), and never write literal test filenames in `.lintel/steering/`, `.lintel/specs/`, or `.agents/skills/`.
