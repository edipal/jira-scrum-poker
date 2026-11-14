# Tech Stack

## Stack and Versions

- **Languages:** TypeScript `^5.8.2` (`strict: true`, `noUncheckedIndexedAccess: true`), HTML5 / CSS.
- **Backend Runtime:** Atlassian Forge Node.js runtime (`nodejs22.x` in `manifest.yml`); local development uses Node.js 22 (`fnm`).
- **Frontend Framework & Bundler:** React `^19.0.0` (`react-dom` `^19.0.0`) bundled as a Forge Custom UI static asset with Vite `^6.2.0` (`@vitejs/plugin-react`).

## Main Libraries

- **`@forge/resolver` (`^1.6.0`):** Defines backend RPC handlers invoked by the Custom UI panel.
- **`@forge/kvs` (`^1.0.0`):** Forge Key-Value Store (`kvs.get`, `kvs.set` with `ttl`, `kvs.delete`, and `WhereConditions.beginsWith` prefix queries) for ephemeral per-issue voting state.
- **`@forge/realtime` (`^1.0.0`):** Publishes live issue-scoped channel events from backend resolvers.
- **`@forge/api` (`^6.0.0`):** Calls Jira Cloud REST API v3 via `api.asUser().requestJira(route\`...\`)` to inspect `editmeta`, read user profile metadata, and update Story Points.
- **`@forge/bridge` (`^5.0.0`):** Custom UI client bridge (`invoke`, `realtime.subscribe`, `view.theme.enable`, `view.refresh`).
- **`vitest` (`^3.0.8`), `jsdom` (`^26.0.0`), `@testing-library/react` (`^16.2.0`), `@testing-library/jest-dom` (`^6.6.3`):** Headless unit and UI component test runner.
- **`@biomejs/biome` (`2.5.15`):** Repository linter and formatter.

## Build and Run

- **Lintel Build & Static Gate:** `./.lintel/scripts/build.sh` — verifies `manifest.yml` has zero external egress, runs `biome lint`, `biome format`, `tsc --noEmit`, and builds the Custom UI bundle (`vite build` -> `static/panel/build/`).
- **Lintel Unit Test Gate:** Configured unit runner under `.lintel/scripts/` — runs `tsc --noEmit` followed by `vitest run` across `tests/`.
- **Interactive NPM Scripts:**
  - `npm run check` — runs lint, format check, typecheck, and Custom UI build.
  - `npm run format` — formats source and test files with Biome (`biome format --write`).
  - `npm test` — runs Vitest once (`vitest run`).
- **Deploying / Previewing on Jira Cloud (outside Lintel gates):** Requires Atlassian Forge CLI (`forge register`, `forge deploy`, `forge install --site <site>.atlassian.net --product jira`).
