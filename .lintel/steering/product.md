# Product Intent & Principles

**Scrum Poker for Jira** (`scrum-poker-jira`) is a free, ad-free, per-issue planning poker plugin for Jira Cloud built natively on **Atlassian Forge** (`Runs on Atlassian`).

How the system is structured is documented in [architecture.md](architecture.md), what is implemented today is indexed in [../specs/index.md](../specs/index.md), and the delivery roadmap lives in [../../PLAN.md](../../PLAN.md). Rationale for product and technical choices is recorded in [decisions.md](decisions.md).

## 1. Problem & Goal

Agile engineering teams estimating work in Jira Cloud face a frustrating trade-off:
- Commercial Atlassian Marketplace poker apps bill **every licensed user on the entire Jira site** (including PMs, QA, Support, and HR), turning a simple estimation tool for a 10-person dev team into thousands of dollars per year.
- Free standalone web tools force teams into separate browser tabs, display advertisements, gate basic statistics behind subscriptions, and require copying Story Points back into Jira manually.

**Goal:** Provide a fast, zero-setup, completely free and ad-free Scrum Poker panel directly inside every Jira issue ([D-01](decisions.md), [D-02](decisions.md)).
- **Implemented today:** Repository toolchain, Forge `jira:issuePanel` manifest shell, and Lintel QA -> DEV workflow harness.
- **Planned in [`PLAN.md`](../../PLAN.md):** Pure Fibonacci voting & score-snapping domain rules, concurrent per-voter Forge KVS backend & live `@forge/realtime` sync, zero-config Jira Story Points field detection & write-back (with clipboard fallback), and the Light/Dark-aware Custom UI issue panel.

## 2. Target Users & Surface

- **Developers, QA, and Scrum Masters / Product Owners:** Estimate Jira tickets live during backlog refinement or sprint planning directly on the open Jira issue view (`jira:issuePanel`).
- **Jira Organization Administrators:** Install a zero-egress `Runs on Atlassian` Forge app with minimal permissions and zero seat fees ([D-01](decisions.md)).

## 3. Core Product Principles & UX Flow

1. **The Issue *Is* the Room ([D-02](decisions.md)):**
   - There are no external room links, lobby codes, or JQL session wizards to configure.
   - Clicking the **Scrum Poker** button in the Apps bar beneath an issue's title opens the panel on that ticket for everyone viewing it.
2. **Standard Fibonacci Deck ([D-03](decisions.md)):**
   - Fixed deck: `0, 1, 2, 3, 5, 8, 13, 21, ?`.
   - Clicking an unselected card casts/updates the user's vote; clicking the already-selected card withdraws it.
3. **Voter-Only Display & Strict Vote Secrecy ([D-04](decisions.md)):**
   - Only users who have cast a vote appear in the participant list (avoiding background-tab ghosts and non-voting observer clutter).
   - Before reveal, participants see *who* voted (`Display Name ✓`) while card values remain strictly hidden on the backend.
4. **Open, Zero-Friction Controls ([D-05](decisions.md)):**
   - Any team member viewing the issue can click **Show Votes**, **Reset / Re-vote**, or **Set Story Points** (no host-lock bottleneck if a facilitator disconnects).
5. **Nearest-Fibonacci Calculation & Quick Consensus Override ([D-06](decisions.md)):**
   - Revealing votes displays every voter's chosen card (including `?`), computes the arithmetic average of numeric votes (excluding `?`), and snaps the recommended score to the **nearest numeric Fibonacci card** (`0, 1, 2, 3, 5, 8, 13, 21`), rounding **up** on an exact midpoint tie (e.g., `4.0 -> 5`, `1.5 -> 2`).
   - If all votes are `?`, no numeric score is recommended and only **Re-vote** is active.
   - After reveal, clicking any numeric Fibonacci card overrides the target score (`Set Story Points -> X`) so teams can record verbal consensus immediately without re-voting.
6. **Zero-Config Story Points Write-Back with Clipboard Fallback ([D-07](decisions.md)):**
   - On load, the plugin inspects the issue's editable fields (`editmeta`) for `Story Points` or `Story point estimate`.
   - When present, clicking **Set Story Points -> X** writes the value directly to Jira as the acting user (`asUser()`) and refreshes the issue view.
   - When the issue type has no editable Story Points field on its screen, the panel shows a clear inline warning and offers **Copy Score (X)** to copy the value to the clipboard instead.
7. **Clean Post-Save State & 24-Hour Expiry ([D-08](decisions.md)):**
   - Applying Story Points clears the round back to a clean idle state.
   - Abandoned rounds automatically expire after **24 hours** so stale votes never linger into future sprints.
