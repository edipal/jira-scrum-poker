# Project Structure

## Directories and Modules

```text
scrum-poker/
├── manifest.yml                 # Atlassian Forge manifest (jira:issuePanel, resources, 4 scopes)
├── PLAN.md                      # Phased feature delivery roadmap for Lintel tasks
├── package.json                 # Dependencies and lint/format/typecheck/build/test scripts
├── tsconfig.json                # Strict TypeScript configuration across backend, UI, and tests
├── biome.json                   # Biome linter and formatter configuration (2-space, 120-col)
├── vite.config.ts               # Vite bundler config for Custom UI (root: static/panel, base: ./)
├── src/                         # Forge backend runtime (Node.js 22; no DOM imports)
│   └── index.ts                 # Forge resolver entry point (exports `handler`)
├── static/
│   ├── assets/
│   │   └── icon.svg             # Local SVG icon referenced by jira:issuePanel in manifest.yml
│   └── panel/                   # Forge Custom UI frontend (browser iframe; no @forge/kvs or @forge/api)
│       ├── index.html           # Custom UI HTML entry point
│       ├── src/                 # React components, hooks, and @forge/bridge client wrappers
│       │   └── main.tsx         # React root mount and view.theme.enable() bootstrap
│       └── build/               # Vite production bundle output (gitignored)
├── tests/                       # Automated Vitest unit suites and shared SDK test doubles
├── .agents/
│   ├── agents/                  # Canonical Lintel persona wrappers (lintel-<role>.md)
│   ├── plugins/lintel/          # Vendored Lintel workflow engine
│   └── skills/                  # Project skills (atlassian-forge, forge-testing)
└── .lintel/
    ├── config.jsonc             # Lintel path classes, test groups, skills, steering, and models
    ├── scripts/                 # Lintel gate scripts (setup, build, unit runner, teardown)
    ├── specs/                   # Living behavioural specifications (index.md + domain areas)
    └── steering/                # Project steering documents
```

## Where New Code Goes

- **Pure domain logic & shared types (`src/`):** Place pure, deterministic Scrum Poker rules (Fibonacci deck constants, numeric average and nearest-card snapping, 24-hour expiry checks, vote-redaction projections, Jira `editmeta` field detection) in focused modules under `src/`. Shared TypeScript types for RPC payloads/responses may be imported as types (`import type`) by `static/panel/src/`.
- **Forge backend resolvers & adapters (`src/`):** Place `@forge/kvs` storage repositories, `@forge/api` Jira REST clients, and `@forge/realtime` publishers under `src/`, wired into the `Resolver` instance exported as `handler` from `src/index.ts`.
- **Custom UI components & bridge hooks (`static/panel/src/`):** Place React UI components, state hooks, `@forge/bridge` wrappers, and clipboard helpers under `static/panel/src/`. Never import Node-only Forge packages (`@forge/kvs`, `@forge/api`, `@forge/realtime`, `@forge/resolver`) from `static/panel/src/`.
- **Tests & SDK doubles (`tests/`):** Place unit suites under `tests/` and reusable in-memory Forge SDK fakes or fixture builders under `tests/helpers/` (classified under `support` when excluded from test-file globs, or imported without test suffixes).

## Naming Conventions

- **Files:** Use `kebab-case.ts` for pure modules, adapters, and hooks (e.g., `poker-math.ts`, `story-points.ts`), and `PascalCase.tsx` (or `kebab-case.tsx`) consistently for React components under `static/panel/src/`.
- **Functions & Variables:** `camelCase`; boolean predicates start with `is`, `has`, `can`, or `should`.
- **Types, Interfaces & Components:** `PascalCase`; constants use `UPPER_SNAKE_CASE` (e.g., `FIBONACCI_DECK`, `SESSION_TTL_MS`).
