---
id: 2977
title: "infra: claim-issue --allocate livelocks under multi-session load (6 concurrent allocators observed)"
status: ready
created: 2026-07-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: infra
area: tooling
language_feature: n/a
goal: dev-infra
related: [2531, 2155]
depends_on: []
---

# #2977 — `claim-issue --allocate` livelocks under multi-session load

## Problem

dev-2856f observed **six concurrent `--allocate` processes livelocking** on the
`issue-assignments` ref: each allocator re-scans hundreds of ref entries (a
per-file `git show` each), computes the next free id, then loses the
first-push-wins race to a sibling — and the loser restarts the full scan. Under
a busy window (many sessions filing issues at once) this degenerates into a
herd where most allocators spin for minutes.

Independently observed in this session (same window): plain `claim-issue`
write-mode calls hung >2 min (two consecutive 90s+ timeouts) and a
non-fast-forward `refs/claim-issue/base` lock error (`cannot lock ref … is at
<new> but expected <old>`) required a manual `git update-ref -d
refs/claim-issue/base` to clear. After the herd cleared, the same calls
completed in seconds.

## Cost

- **Lost id reservations**: #2939/#2940/#2941 were renumbered away during the
  contention window.
- Wasted agent time (each spin burns a dev's foreground loop).
- A disincentive to file issues during busy windows — exactly when findings
  are being produced.

## Possible directions (any one suffices; smallest first)

1. **Backoff + jitter** on push-race loss (cheapest; turns the herd into a
   queue; a few lines in `scripts/claim-issue.mjs`).
2. **Batch reservation** — allocate N ids per push so a busy session pays the
   race once.
3. **Single lightweight lock ref** — take a short-lived advisory lock ref
   before scanning, so only one allocator scans/pushes at a time.
4. **Server-side allocation endpoint** (heaviest; only if 1–3 prove
   insufficient).

Also worth fixing while in there: the stale local `refs/claim-issue/base`
non-fast-forward failure mode (fetch with `--force` into the local base ref, or
delete-before-fetch) — it currently hard-crashes the script with a raw git
error.

## Evidence / references

- Observation: dev-2856f (six-allocator livelock, id renumbering).
- **This issue file itself was renumbered 2951→2977**: the original #2951
  reservation (confirmed pushed 05:35Z) was lost to a parallel session whose
  own #2951 merged first (`2951-ir-first-skip-set-generators-class-members`),
  tripping the dup-id gate on the filing PR — plus two further `--allocate`
  timeouts (>150s, >240s window) before #2977 was obtained.
- This session: two 90s+ `claim-issue` timeouts + the `refs/claim-issue/base`
  lock error, all during the same window; instant completion after the herd
  cleared.
- Sibling infra issue: the `promote-baseline` push-race (dev-2912f).
- Allocator design: #2531 (`--allocate`, first-push-wins); lock protocol: #2155.

## Acceptance

- Two (ideally six) concurrent `--allocate` invocations both complete within a
  bounded time (< ~30 s) with distinct ids, no manual ref cleanup.
- The stale-local-base failure mode recovers automatically.
- No change to the reservation semantics (atomic against origin/main ∪ open
  PRs ∪ existing reservations).
