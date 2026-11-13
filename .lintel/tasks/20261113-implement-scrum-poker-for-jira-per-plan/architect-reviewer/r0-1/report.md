# Architect Review Report — Round `r0-1` (Phase 1 Design & Plan)

## Verdict: `changes`

One `major` finding (`ARC-01`) and one `minor` clarity note (`ARC-02`) were identified in Phase 1's contract/design. All other checklist areas—phase planning, requirement coverage, test outline syntax and partitioning, deterministic clock seams, and TypeScript code stubs—are clean and verified.

---

## Deep Verification Summary

### 1. Phase Plan (`shared/plan.md`) — PASS
- **Syntax & Headings:** Three sequential phases (`## Phase 1: ...`, `## Phase 2: ...`, `## Phase 3: ...`) each include a valid `Requirements:` line referencing active IDs from `shared/requirements.md`.
- **Complete Requirement Coverage:** Every requirement `R1`–`R14` is allocated cleanly across Phases 1–3 (`Phase 1`: `R1, R5, R7, R9, R10`; `Phase 2`: `R1, R2, R3, R4, R5, R6, R8, R9, R10, R11, R14`; `Phase 3`: `R12, R13, R14`).
- **Decomposition Quality:** Phases align with `PLAN.md` and `.lintel/steering/architecture.md`: pure domain rules (`src/domain/`) -> Forge resolvers, per-voter KVS storage, Realtime & Jira REST adapters (`src/`) -> React 19 Custom UI issue panel (`static/panel/src/`).

### 2. Phase 1 Design & Test Outline (`shared/phase-1/design.md`) — CHANGES NEEDED (`ARC-01`)
- **Architectural & Security Alignment:** `src/domain/` forms a clean 5-module DAG with zero `@forge/*`, React, or DOM imports, strict allowlist input validation, prototype-pollution key filtering in `detectStoryPointsField`, explicit `nowMs` injection, and pre-reveal vote redaction.
- **`## Test outline` Verification:**
  - Every bullet strictly matches `- R<n> <group>: <what>` or `- <group>: none: <reason>`, with zero literal test filenames.
  - All 5 Phase 1 requirements (`R1`, `R5`, `R7`, `R9`, `R10`) have thorough `unit` scenarios covering happy paths, boundaries, midpoint ties, clock skew, and error rejections.
  - All configured test groups (`unit`, `integration`, `e2e`) are accounted for (`support` is excluded), and the `integration: none` and `e2e: none` justifications match `.lintel/steering/testing.md` and Phase 1's pure stateless scope.
- **Defect (`ARC-01`):** Line 44 repeats the broken `Math.round((mean + Number.EPSILON) * 10) / 10` rounding formula (see Section 3 below).

### 3. Phase 1 Contract (`shared/phase-1/contract.md`) — CHANGES NEEDED (`ARC-01`, `ARC-02`)
- **Sections & Seams:** Contains all required sections (`## Signatures`, `## External interfaces`, `## UI hooks`, `## Data`, `## Stub files`), `readonly` interfaces, typed `PokerDomainError` invariants, and explicit `nowMs: number` clock injection.
- **Open Findings:**
  - **`ARC-01` (`major` — `formatAverage` broken `Number.EPSILON` formula):**
    - `contract.md` (`### 3. src/domain/scoring.ts`) specifies: *"Rounds `mean` half-up to `1` decimal place (`Math.round((mean + Number.EPSILON) * 10) / 10`)"*.
    - In IEEE-754 binary64, `Number.EPSILON` (`2^-52`) equals 1 ULP only on `[1, 2)`. On `[2, 4)` 1 ULP is `2 * Number.EPSILON`, on `[4, 8)` `4 * Number.EPSILON`, on `[8, 16)` `8 * Number.EPSILON`, and on `[16, 32)` `16 * Number.EPSILON`. Adding `Number.EPSILON` fails to overcome binary representation rounding for legitimate Scrum Poker vote means ending in `.x5`, such as `51 / 20 = 2.55` (`'2.5'` instead of `'2.6'`), `101 / 20 = 5.05` (`'5'` instead of `'5.1'`), `201 / 20 = 10.05` (`'10'` instead of `'10.1'`), and `343 / 20 = 17.15` (`'17.1'` instead of `'17.2'`), while also nudging values in `(0, 1)` strictly below `0.05` upward.
    - Because QA tests against R7's standard half-up rounding rule while DEV implements against `contract.md`, keeping this contradictory formula risks a post-lock failure. Remove the `Number.EPSILON` formula from `contract.md` and `design.md` and define `formatAverage(mean)` as half-up rounding to at most `1` fractional digit on `mean`'s canonical decimal representation (`Number.prototype.toString` decimal value, e.g., via `Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1, roundingMode: 'halfExpand', useGrouping: false })` or decimal exponent shifting `${mean}e1`), omitting trailing `.0`.
  - **`ARC-02` (`minor` — string whitespace validation wording in `projectSessionSnapshot`):**
    - Line 188 validates `viewerAccountId` with `viewerAccountId.trim().length > 0` (accepting surrounding whitespace) and line 194 matches `vote.accountId === params.viewerAccountId` (exact match), whereas line 191 describes `meta.roundId` and `vote.accountId` as *"a non-empty trimmed string"*. Clarify whether whitespace-padded identifiers (`' acc-1 '`, `' round-1 '`) are accepted via `.trim().length > 0` or rejected via `s.trim().length > 0 && s === s.trim()` consistently across `viewerAccountId`, `meta.roundId`, and `vote.accountId`.

### 4. Code Stubs & Repository Gate Verification — PASS
- **Files Inspected:** `src/domain/types.ts`, `src/domain/deck.ts`, `src/domain/scoring.ts`, `src/domain/session-view.ts`, `src/domain/jira-fields.ts`.
- `git status` and `./.lintel/bin/lintel diff` confirm only the 5 listed stub files were added under `src/domain/` with zero unauthorized modifications.
- `./.lintel/scripts/build.sh` exited `0` (zero external egress check, Biome lint, Biome format check, `tsc --noEmit`, and Vite Custom UI build all pass).
- Every stub function and constructor throws `new Error('not implemented')`, and exported constants use neutral empty placeholders (`[]`, `0`, `''`) with zero premature business logic.
