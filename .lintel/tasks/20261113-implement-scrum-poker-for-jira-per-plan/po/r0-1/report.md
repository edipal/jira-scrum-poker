# PO Specification Report (`r0-1`)

## Summary

Authored complete, stack-neutral behavioural requirements (`R1`–`R14`) in `shared/requirements.md` covering all Scrum Poker for Jira capabilities defined in `PLAN.md`, `.lintel/specs/index.md`, and `.lintel/steering/` (`D-01` through `D-09`):

- **R1–R2:** Standard 9-card Fibonacci deck (`0, 1, 2, 3, 5, 8, 13, 21, ?`), strict input/score validation, and per-issue session isolation anchored to authenticated host context.
- **R3–R5:** Hidden-state vote casting, updating, and withdrawal, concurrent per-participant vote isolation, >100-voter pagination completeness, strict pre-reveal vote secrecy, and voter-only deterministic participant projection.
- **R6–R9:** Democratic vote reveal (with 0-vote rejection and idempotent repeat reveal), numeric mean & nearest-Fibonacci snapping (upward midpoint tie-breaking on unrounded mean, `0` included, `'?'` excluded, all-`'?'` handling), shared post-reveal consensus target score override, round reset, and exact 24-hour (`86,400,000` ms) inactivity expiration.
- **R10–R11:** Dynamic zero-config Story Points field detection (`Story Points` and `Story point estimate` precedence and schema/operation checks) and user-attributed Story Points write-back with full round preservation on missing-field, forbidden, or upstream errors.
- **R12–R14:** Live issue-scoped session synchronization, automatic host issue view refresh on Story Points save, Light/Dark theme synchronization, accessible deck/action UI with missing-field warning and clipboard copy fallback, and strict zero-egress `Runs on Atlassian` permission boundaries.
