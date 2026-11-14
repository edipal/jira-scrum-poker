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

- **Resolver Boundaries:** Validate incoming `payload` values (e.g., ensuring cast cards belong to `0, 1, 2, 3, 5, 8, 13, 21, '?'` and Story Points scores are finite non-negative numbers) before reading/writing KVS or calling Jira. Reject invalid inputs with clear, actionable error messages.
- **Graceful Jira Field Fallback ([D-07](decisions.md)):** Missing or uneditable Story Points fields on an issue's `editmeta` are an expected workflow state, not a crash—return `{ storyPointsField: null }` so the UI shows the inline warning and **Copy Score** button.
- **Jira API Failures:** Check `response.ok` on every `requestJira` call; surface HTTP status and Jira error messages cleanly to the panel without clearing the revealed votes if saving Story Points fails (allowing the user to retry or copy the score).

## Logging

- **Minimal & Safe Logging:** Use `console.warn` / `console.error` in backend resolvers only for unexpected KVS, Realtime, or Jira REST errors, including contextual identifiers (`issueKey`, HTTP `status`) rather than raw payloads.
- **Secrecy Invariant:** Never log cast card values while `revealed === false`, and never log user credentials, tokens, or personal email addresses.

## API Style

- **Strict Vote Secrecy:** While `revealed === false`, resolver responses and `@forge/realtime` payloads must never include other participants' card selections—only `{ accountId, displayName, avatarUrl }` for voters who have cast a card, plus the requesting user's own `myVote`.
- **User-Scoped Jira Calls:** Always call `api.asUser().requestJira(...)` for issue `editmeta` checks, current-user lookups, and Story Points `PUT` updates so Jira permissions and issue audit history reflect the acting user.
- **Zero External Egress (`Runs on Atlassian`, [D-01](decisions.md)):** Never add external URLs, CDNs, fonts, analytics, or `permissions.external` entries to `manifest.yml` or `static/panel/`.
- **Documentation Hygiene:** Cite architectural/product decisions by stable ID (`D-01`..`D-09` in [decisions.md](decisions.md)), and never write literal test filenames in `.lintel/steering/`, `.lintel/specs/`, or `.agents/skills/`.
