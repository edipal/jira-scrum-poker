# Scrum Poker for Jira

A free, ad-free, fast **Scrum Poker** estimation plugin for **Jira Cloud**, built natively on **Atlassian Forge** (`Runs on Atlassian`) with zero external data egress.

## Highlights

- **Zero Ads & Zero Per-Seat Fees:** Runs entirely inside your Jira Cloud tenant on Atlassian's free Forge compute & KVS tier.
- **Runs on Atlassian (Zero Egress):** All votes, participant names, and Story Points updates stay inside Atlassian Cloud (`storage:app`, `read:jira-work`, `write:jira-work`, `read:jira-user`).
- **Inline Issue Panel:** Opens directly beneath the issue summary from the Jira Apps bar and remembers its open/closed state per issue.
- **Standard Fibonacci Deck:** `0, 1, 2, 3, 5, 8, 13, 21, ?` with hidden voter indicators (`Name ✓`), simultaneous reveal, arithmetic mean, and nearest-Fibonacci snapping (rounding up on exact midpoints).
- **Zero-Setup Story Points Write-Back:** Automatically detects `Story Points` or `Story point estimate` on the issue's edit screen, supports one-click post-reveal score overrides, and falls back to a warning + **Copy Score** button if neither field is on the screen.
- **Concurrent-Safe & Self-Expiring:** Uses isolated per-voter Forge KVS keys (`poker:{issueId}:{roundId}:vote:{accountId}`) with `@forge/realtime` live sync and automatic 24-hour expiration for unfinished rounds.

## Documentation & Lintel Harness

This repository uses the **Lintel** multi-agent engineering harness (`PO -> Architect -> QA -> DEV`):

- **Implementation Roadmap:** [`PLAN.md`](PLAN.md)
- **Living Specifications:** [`.lintel/specs/index.md`](.lintel/specs/index.md)
- **Steering Documents:**
  - [`product.md`](.lintel/steering/product.md) — product scope and UX rules
  - [`architecture.md`](.lintel/steering/architecture.md) — Custom UI + Forge resolver boundaries, KVS layout, and realtime sync
  - [`decisions.md`](.lintel/steering/decisions.md) — recorded product & architectural decisions (`D-01`..`D-09`)
  - [`tech.md`](.lintel/steering/tech.md), [`structure.md`](.lintel/steering/structure.md), [`conventions.md`](.lintel/steering/conventions.md), [`testing.md`](.lintel/steering/testing.md)

## Local Verification

```sh
# Install dependencies
npm install

# Lint, format-check, typecheck, build Custom UI bundle, and verify zero external egress in manifest.yml
./.lintel/scripts/build.sh

# Run unit & component test suite
./.lintel/scripts/test-unit.sh

# Check Lintel harness health
./.lintel/bin/lintel doctor
```

## Deploying to Your Jira Cloud Site (Atlassian Forge CLI)

1. Install the Forge CLI globally if not yet installed (`npm install -g @forge/cli`) and sign in (`forge login`).
2. Register your own app ID once (updates `app.id` in `manifest.yml`):
   ```sh
   forge register
   ```
3. Build the Custom UI panel, deploy, and install onto your Jira Cloud site:
   ```sh
   npm run build:ui
   forge deploy
   forge install --site <your-site>.atlassian.net --product jira
   ```
