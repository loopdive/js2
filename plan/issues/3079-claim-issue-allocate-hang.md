---
id: 3079
title: "claim-issue.mjs --allocate hangs/times out under load — O(N) git cat-file per reservation + unbounded gh scan"
status: done
completed: 2026-07-07
sprint: current
created: 2026-07-07
updated: 2026-07-07
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: tooling
goal: infra
related: [2531, 2943, 2974]
---

# #3079 — `claim-issue.mjs --allocate` hangs under load (blocks issue filing for the whole team)

## Problem

`node scripts/claim-issue.mjs --allocate` (and `--allocate --dry-run`) routinely
took **>60s** and appeared to hang under container load, blocking issue filing
for the whole team (the canonical, collision-proof id reservation path per
#2531). It was widely assumed to be the open-PR `gh` scan, but empirical tracing
showed **two independent causes**, and the dominant one was NOT the gh scan.

## Root cause (measured, not assumed)

**Primary — `idsFromAssignRef` spawned O(N) `git cat-file` subprocesses.** The
`issue-assignments` reservation ref holds one `<id>.json` per reservation (466
and growing). The id-universe scan read each entry with its own
`git cat-file -p <sha>:<file>` — i.e. **466 sequential subprocess spawns**.
Timed in isolation on the loaded container: **>90s** (killed before completing).
This ran on EVERY `--allocate` (even `--no-pr-scan --dry-run`), which is why the
hang persisted with the PR scan disabled. The count grows with every allocation,
so it only gets worse.

**Secondary — unbounded network calls.** `execFileSync` has no default timeout,
so a single stuck `gh` (open-PR GraphQL scan) or `git fetch` under API
contention blocks indefinitely with no upper bound.

## Fix

`scripts/claim-issue.mjs`:

1. **`idsFromAssignRef`** — replace the per-entry `git cat-file` loop with a
   **single `git cat-file --batch`** process that reads every reservation blob
   at once (~constant time). The `--batch` stream is byte-framed, so the buffer
   is walked by the header-declared size (execFileSync returns a Buffer when
   `encoding` is omitted — note `encoding: "buffer"` is invalid and throws
   `ERR_UNKNOWN_ENCODING`). Faithful to the original `/^\d+$/` id filter
   (verified: batch yields the identical 459 numeric ids, correctly excluding
   non-numeric slice/sub-issue entries like `"1373b"`, `"1910-s2"`, `"983d"`).
   A **filename-derivation fallback** (leading digits of `<id>.json` /
   `<base>-<slice>.json`) keeps the id universe complete if the batch read fails
   — fail-safe (over-includes low sub-issue bases at worst, never misses a high
   reservation, so it can never hand out a used id).

2. **Bounded network timeouts** (all env-overridable):
   - `CLAIM_MAIN_FETCH_TIMEOUT_MS` (15s) on the allocate-time `git fetch main`.
   - `CLAIM_PR_SCAN_CALL_TIMEOUT_MS` (12s) per `gh` call in the open-PR scan.
   - `CLAIM_PR_SCAN_TOTAL_TIMEOUT_MS` (25s) overall wall-clock budget for the
     whole open-PR scan; past it the scan degrades to the pre-existing fail-open
     fallback (allocate against `main` ∪ reservations only — the PR-time
     `check:issue-ids:against-main` gate remains the hard backstop).

## Result (measured on the same loaded container)

| invocation | before | after |
| --- | --- | --- |
| `--allocate --dry-run` | >60s (timeout) | **~9s** |
| `--allocate --no-pr-scan --dry-run` | >60s (timeout) | **~7s** |
| forced PR-scan timeout (`CLAIM_PR_SCAN_TOTAL_TIMEOUT_MS=1`) | >60s | **~6s**, degrades gracefully + still returns an id |

## Acceptance criteria

- `--allocate` completes in seconds (not minutes) under load. ✓
- The id it returns is unchanged/correct (faithful to the prior content-read
  semantics; verified against the live ref). ✓
- On gh/network stall the scan degrades to the fail-open fallback within the
  bounded budget instead of hanging. ✓
