---
name: forge-testing
description: Vitest and React Testing Library standards for testing pure Scrum Poker rules, Atlassian Forge backend resolvers (KVS, Realtime, Jira REST v3), Custom UI components, and Lintel lock-gate red-phase invariants.
---

# Forge Testing Standards (`forge-testing`)

Authoritative testing guide for QA and QA-Reviewer when authoring test outlines and executable Vitest suites under `tests/`.

---

## 1. Test Group Assignment in `design.md` (`## Test outline`)

All automated verification in this repository—pure domain rule tests, backend resolver tests with mocked Forge SDK boundaries, and Custom UI React component tests under `jsdom`—runs in the **`unit`** test group via `.lintel/scripts/test-unit.sh` (`vitest run`).

When authoring `shared/phase-<N>/design.md` (`## Test outline`):
- Assign every requirement scenario to the `unit` group (`- R<n> unit: <scenario>`).
- Explicitly exempt `integration` and `e2e` with clear rationale:
  - `- integration: none: Forge KVS, Realtime, and Jira REST boundaries run in-process against deterministic SDK doubles in the unit suite`
  - `- e2e: none: Custom UI rendering and bridge interactions run under jsdom and Testing Library in the unit suite`

---

## 2. Deterministic Forge SDK Test Doubles

Never make live network calls or rely on external Jira instances in tests. Mock Forge boundaries deterministically with Vitest (`vi.mock`):

1. **In-Memory `@forge/kvs` Double:**
   - Back `kvs.get`, `kvs.set`, `kvs.delete`, and `kvs.query().where('key', WhereConditions.beginsWith(prefix)).cursor(...).limit(...).getMany()` with an in-memory `Map<string, { value: unknown; options?: unknown }>`.
   - Test **pagination** (e.g., simulating `limit` smaller than voter count with `nextCursor`) and **lazy TTL** (leaving records >24h old in the `Map` to prove application code still rejects expired timestamps even before Forge's background sweep runs).
   - Test **concurrent voting** via `await Promise.all([castVote(userA), castVote(userB), castVote(userC)])` to verify zero lost votes.
2. **Vote Secrecy & `@forge/realtime` Assertions:**
   - Capture every payload passed to `@forge/realtime` `publish(channel, payload)` and every object returned by resolvers while `revealed === false`.
   - Explicitly assert that secret card choices of other voters do not appear anywhere in serialized payloads or responses prior to `revealVotes`.
3. **Jira REST v3 (`@forge/api`) Double:**
   - Mock `api.asUser()` (and verify `api.asApp()` is **not** used for user-attributed Story Points updates) along with the `route` tagged template helper.
   - Cover company-managed (`Story Points`), team-managed (`Story point estimate`), missing/uneditable field (`storyPointsField: null`), and non-2xx Jira error responses.
4. **Custom UI (`@forge/bridge`) & Clipboard Doubles (`jsdom`):**
   - Mock `invoke`, `realtime.subscribe` (capturing the subscriber callback so tests can push simulated live events and verify `unsubscribe` on unmount), `view.theme.enable`, and `view.refresh`.
   - Clean up mounted React trees after each test (`cleanup` from `@testing-library/react`) and reset mocks in `beforeEach`.
   - Test both `navigator.clipboard.writeText` success and fallback copy behavior when `navigator.clipboard` rejects or is unavailable in an iframe.

---

## 3. `lintel lock` Red-Phase Rules

1. **Every Acceptance Test Must Fail Against Unimplemented Stubs:**
   - During `lintel lock`, Lintel runs `.lintel/scripts/test-unit.sh` against Architect's unimplemented stubs and requires the `unit` group to fail (`exit 1`, not `exit 0` and not compile-error `exit 2`).
   - Do not write standalone negative/no-op tests that pass trivially against empty or no-op stubs; always pair negative assertions with a positive behavioural assertion exercising the target contract.
2. **Type-Clean Tests (`exit 2` vs `exit 1`):**
   - `.lintel/scripts/test-unit.sh` runs `tsc --noEmit` first and exits `2` on TypeScript errors (`lock` rejects `exit 2` as broken tests). Always ensure all test suites and shared helpers under `tests/` type-check cleanly under `strict: true` and `noUncheckedIndexedAccess: true`.
