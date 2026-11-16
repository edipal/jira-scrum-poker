# Project Structure

## Directories and Modules

```text
jira-scrum-poker/
├── .github/workflows/ci.yml     # GitHub Actions CI pipeline (build, lint, typecheck, unit suite)
├── manifest.yml                 # Atlassian Forge manifest (jira:issueContext, resources, 4 scopes)
├── PLAN.md                      # Phased feature delivery roadmap for Lintel tasks
├── package.json                 # Dependencies and lint/format/typecheck/build/test scripts
├── tsconfig.json                # Strict TypeScript configuration across backend, UI, and tests
├── biome.json                   # Biome linter and formatter configuration (2-space, 120-col)
├── vite.config.ts               # Vite bundler config for Custom UI (root: static/panel, base: ./)
├── src/                         # Forge backend runtime (Node.js 22; no DOM imports)
│   ├── index.ts                 # Forge resolver entry point (registers resolvers and exports `handler`)
│   ├── domain/                  # Pure, stateless Scrum Poker rules (zero @forge/* or React imports)
│   │   ├── types.ts             # Domain types, SessionSnapshot, RoundMeta, VoteRecord, PokerDomainError
│   │   ├── deck.ts              # FIBONACCI_DECK, NUMERIC_FIBONACCI_SCORES, and card/score validators
│   │   ├── scoring.ts           # Numeric mean, half-up display formatting, and nearest-Fibonacci snapping
│   │   ├── session-view.ts      # 24-hour expiry check, voter sorting, and vote-secrecy projection
│   │   └── jira-fields.ts       # Zero-config Jira `editmeta` Story Points field detector
│   ├── storage/
│   │   └── session-store.ts     # Per-voter @forge/kvs repository, 24h TTL, and cursor-paginated queries
│   ├── jira/
│   │   └── jira-client.ts       # User-scoped @forge/api client (`/myself`, `/editmeta`, Story Points `PUT`)
│   ├── realtime/
│   │   └── publisher.ts         # @forge/realtime channel publisher (`scrum-poker`)
│   ├── observability/
│   │   └── logger.ts            # Structured JSON logger with secret/vote redaction + manifest validator
│   └── resolvers/
│       └── poker-resolvers.ts   # Authenticated host context guard and 7 RPC resolver handlers
├── static/
│   ├── assets/
│   │   └── icon.svg             # Local SVG icon referenced by jira:issueContext in manifest.yml
│   └── panel/                   # Forge Custom UI frontend (browser iframe; no @forge/kvs or @forge/api)
│       ├── index.html           # Custom UI HTML entry point
│       ├── src/                 # React 19 components, CSS tokens, bridge client, and clipboard fallback
│       │   ├── main.tsx         # Root mount (`bootstrapIssuePanel`) and stylesheet import
│       │   ├── App.tsx          # `ScrumPokerApp` interactive voting, reveal, override, and apply/copy UI
│       │   ├── styles.css       # Local Light/Dark CSS custom-property tokens (`--ds-*`)
│       │   ├── bridge/
│       │   │   └── poker-client.ts  # Lazy-loaded @forge/bridge RPC/realtime/theme client & zero-egress check
│       │   └── clipboard/
│       │       └── copy-score.ts    # `navigator.clipboard.writeText` + hidden `<textarea>` fallback
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

- **Pure domain logic & shared types (`src/domain/`):** Place pure, deterministic Scrum Poker rules (Fibonacci deck constants, numeric average and nearest-card snapping, 24-hour expiry checks, vote-redaction projections, Jira `editmeta` field detection) in focused modules under `src/domain/` with zero `@forge/*`, React, or DOM imports. Shared TypeScript types (`SessionSnapshot`, `PokerRealtimeEvent`, `ApplyStoryPointsResult`, etc.) are imported strictly via `import type` from `static/panel/src/`.
- **Forge backend resolvers, adapters & observability (`src/storage/`, `src/jira/`, `src/realtime/`, `src/observability/`, `src/resolvers/`, `src/index.ts`):** Place `@forge/kvs` storage repositories under `src/storage/`, `@forge/api` Jira REST clients under `src/jira/`, `@forge/realtime` publishers under `src/realtime/`, structured redacting logging and manifest compliance checks under `src/observability/`, and RPC handlers under `src/resolvers/`, registered onto the `Resolver` instance exported as `handler` from `src/index.ts`.
- **Custom UI components, bridge client & clipboard helpers (`static/panel/src/`):** Place React UI components (`App.tsx`), CSS custom-property styles (`styles.css`), `@forge/bridge` wrappers and UI zero-egress compliance checks (`bridge/`), and clipboard helpers (`clipboard/`) under `static/panel/src/`. Never import Node-only Forge packages (`@forge/kvs`, `@forge/api`, `@forge/realtime`, `@forge/resolver`) or runtime values from `src/` inside `static/panel/src/`.
- **Tests & SDK doubles (`tests/`):** Place unit suites under `tests/` and reusable in-memory Forge SDK fakes or fixture builders under `tests/helpers/` (without test file suffixes so Vitest treats them as support modules rather than standalone suites).

## Naming Conventions

- **Files:** Use `kebab-case.ts` for pure modules, backend adapters, bridge clients, and clipboard helpers (e.g., `scoring.ts`, `session-view.ts`, `jira-fields.ts`, `poker-client.ts`), `PascalCase.tsx` for React components (`App.tsx`), and `main.tsx` for the Vite entry point.
- **Functions & Variables:** `camelCase`; boolean predicates start with `is`, `has`, `can`, or `should`.
- **Types, Interfaces & Components:** `PascalCase`; constants use `UPPER_SNAKE_CASE` (e.g., `FIBONACCI_DECK`, `SESSION_TTL_MS`, `POKER_REALTIME_CHANNEL`).
