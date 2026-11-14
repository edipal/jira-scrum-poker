---
name: atlassian-forge
description: Atlassian Forge architecture, verified SDK type signatures (@forge/kvs, @forge/resolver, @forge/realtime, @forge/api, @forge/bridge), zero-egress Runs on Atlassian rules, concurrent KVS vote isolation, and Jira Story Points field detection.
---

# Atlassian Forge Architecture & SDK Rules (`atlassian-forge`)

Authoritative reference for designing and implementing the Jira Cloud `jira:issuePanel` Scrum Poker app under `manifest.yml`, `src/`, and `static/panel/src/`.

---

## 1. Runtime Boundaries & `Runs on Atlassian` Compliance

1. **Two Isolated Runtimes:**
   - **Backend (`src/`):** Executes inside Atlassian Forge's Node.js 22 serverless runtime (`nodejs22.x`). Has access to `@forge/resolver`, `@forge/kvs`, `@forge/realtime`, and `@forge/api`, and **no** DOM globals (`window`, `document`, `navigator`).
   - **Frontend (`static/panel/src/`):** Bundled by Vite (`vite.config.ts`, `base: './'`) into `static/panel/build/` and rendered inside Jira's sandboxed Custom UI iframe. Communicates with the backend and host exclusively through `@forge/bridge` (`invoke`, `realtime`, `view`). Never import `@forge/kvs`, `@forge/api`, `@forge/realtime`, or `@forge/resolver` inside `static/panel/src/`.
2. **Zero External Egress (`Runs on Atlassian`):**
   - `manifest.yml` must **never** declare `permissions.external` (`fetch`, `images`, `scripts`, `styles`, `frames`, etc.), and `.lintel/scripts/build.sh` fails if `external:` appears in `manifest.yml`.
   - Permitted scopes in `manifest.yml` are strictly: `storage:app`, `read:jira-work`, `write:jira-work`, and `read:jira-user`.

---

## 2. Verified Forge SDK Imports & Type Signatures

Always use the exact v2+ modular Forge packages installed in `package.json` (never legacy `@forge/api` `storage` or `startsWith`):

### A. Backend Resolver (`@forge/resolver`)
```ts
import Resolver from '@forge/resolver'

const resolver = new Resolver()

resolver.define('getSession', async ({ payload, context }) => {
  const issueId = String(context.extension.issue.id)
  const issueKey = String(context.extension.issue.key)
  const accountId = String(context.accountId)
  // ...
})

export const handler = resolver.getDefinitions()
```

### B. Key-Value Storage (`@forge/kvs`)
```ts
import { kvs, WhereConditions } from '@forge/kvs'

const TTL_24H = { ttl: { value: 24, unit: 'HOURS' as const } }

await kvs.set(key, record, TTL_24H)
const item = await kvs.get<RoundMeta>(metaKey)
await kvs.delete(key)

// Always paginate cursor when reading prefix keys so >10 voters are never truncated:
let cursor: string | undefined
const rows: VoteRecord[] = []
do {
  let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100)
  if (cursor) q = q.cursor(cursor)
  const page = await q.getMany<VoteRecord>()
  for (const r of page.results) rows.push(r.value)
  cursor = page.nextCursor
} while (cursor)
```

### C. Backend Realtime Publishing (`@forge/realtime`)
```ts
import { publish } from '@forge/realtime'

// Context-scoped automatically to the current Jira issue panel instance:
await publish('scrum-poker', { type: 'SESSION_UPDATED', roundId })
```

### D. Jira REST API v3 (`@forge/api`)
Always execute user-facing reads and issue field mutations via `api.asUser()` so Jira enforces project/issue permissions and records the acting user in issue history:
```ts
import api, { route } from '@forge/api'

const editMetaRes = await api.asUser().requestJira(
  route`/rest/api/3/issue/${issueIdOrKey}/editmeta`,
  { headers: { Accept: 'application/json' } },
)
```

### E. Frontend Custom UI Bridge (`@forge/bridge`)
```ts
import { invoke, realtime, view } from '@forge/bridge'

// Enable Jira Light / Dark theme CSS tokens on startup:
await view.theme.enable()

// Invoke backend resolver:
const session = await invoke<SessionView>('getSession')

// Subscribe to live issue-scoped events:
const subPromise = realtime.subscribe('scrum-poker', (payload) => {
  // handle live update
})
// Cleanup on unmount:
void subPromise.then((sub) => sub.unsubscribe())

// Refresh host Jira issue view after updating Story Points:
await view.refresh()
```

---

## 3. Domain & Security Invariants

1. **Per-Voter Key Isolation (Zero Lost Votes):**
   - Never store multiple users' votes in a single shared KVS JSON array/map (`get` -> mutate -> `set` drops concurrent clicks).
   - Store round metadata under `poker:${issueId}:meta` (`{ roundId, revealed, updatedAt }`) and each participant's vote under `poker:${issueId}:${roundId}:vote:${accountId}` (`{ accountId, displayName, avatarUrl, card, votedAt }`).
   - Incrementing `roundId` (or resetting `meta`) atomically invalidates prior round votes in O(1) without race conditions.
2. **Strict 24-Hour Expiry (Dual Guard):**
   - Forge KVS sweeps expired keys lazily (up to 48 hours after TTL expiry).
   - Every write must pass `{ ttl: { value: 24, unit: 'HOURS' } }` **and** every read must discard rounds/votes whose `updatedAt` / `votedAt` is older than `24 * 60 * 60 * 1000` ms.
3. **Backend Vote Secrecy Before Reveal:**
   - While `revealed === false`, backend resolver responses and `@forge/realtime` payloads **must never** contain any voter's chosen card value (not even obfuscated—only `{ accountId, displayName, avatarUrl }` for voters who have cast a card, plus the caller's own `myVote` in their direct `invoke` response).
4. **Zero-Config Story Points Field Detection & Fallback:**
   - Inspect `fields` from `GET /rest/api/3/issue/${issueIdOrKey}/editmeta`.
   - Match an editable numeric field (`schema.type === 'number'`) whose `schema.custom` is `com.pyxis.greenhopper.jira:jsw-story-points` or whose normalized `name` matches `story points` or `story point estimate` (preferring exact `Story Points`, then `Story point estimate`).
   - When found, `Set Story Points` writes `{ fields: { [fieldId]: score } }` via `PUT /rest/api/3/issue/${issueIdOrKey}` using `api.asUser()`, then clears the round.
   - When absent, return `{ storyPointsField: null }` so the UI renders an inline warning and switches the primary action to **Copy Score** (using `navigator.clipboard.writeText` with a hidden `<textarea>` + `document.execCommand('copy')` fallback for restricted iframe contexts).
5. **Architect Stub Conventions:**
   - Separate pure domain logic (deck validation, average & nearest-Fibonacci rounding with upward tie-breaking, expiry checks, `editmeta` field matching) at the top of modules or in dedicated pure modules under `src/` so both backend and unit suites can exercise them cleanly.
   - During the Architect phase, unimplemented stub functions must throw `new Error('not implemented')` (never return fake passing values) so QA's acceptance suite fails red at `lintel lock`.
