---
id: 4130
title: "npm-compat refresh reports SUCCESS and commits nothing — the staleness floor reads the artifact the job just regenerated, so it is always ~0h old and a busy queue defers forever"
status: done
sprint: current
created: 2026-08-03
updated: 2026-08-03
completed: 2026-08-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: tooling, ci
language_feature: none
goal: dogfood
related: [3988, 3915, 3958, 3977, 4127]
origin: "user asked why acorn's improvements were not visible on npm-compat.html, 2026-08-03"
---

# #4130 — the npm-compat staleness floor can never fire

## Symptom

`website/public/benchmarks/results/npm-compat*.json` last changed on
**2026-08-01 11:07** (`3ffd8ed5c`) — and that was a *manual* regeneration commit,
not the workflow's. Main was at `fb4f9d415` (2026-08-03 05:28) with the
dashboard still serving 2-day-old measurements.

`npm-compat-refresh.yml` ran repeatedly across that window and **succeeded**:

```
2026-08-03T04:30:15Z  push  completed  success
2026-08-03T04:03:31Z  push  completed  success
2026-08-03T03:41:00Z  push  completed  success
2026-08-03T03:00:37Z  push  completed  success
```

Four green runs, zero commits. Nothing was red; the only symptom was a page that
quietly stopped moving.

## Root cause

The job regenerates the artifact and *then* asks how old the artifact is:

```yaml
- name: Regenerate the npm-compat artifacts     # writes generatedAt: <now>
  run: pnpm run generate:npm-compat
...
- name: Gate the main push on the merge queue
  run: |
    LAST_REFRESH="$(node -e '…readFileSync("benchmarks/results/npm-compat.json")…generatedAt')"
    node scripts/main-push-queue-gate.mjs --last-refresh "$LAST_REFRESH" --stale-after-hours 12
```

`LAST_REFRESH` is therefore the timestamp of the measurement **this job just
took** — always ~0 hours old — so `ageHours` never reaches the 12h floor and
`decide()` returns `defer` whenever the merge queue is busy. On this repo the
queue is busy essentially always (pushes every ~10 minutes), so the promotion
is deferred on every run, forever.

Confirmed by executing the gate's own decision function:

| ageHours | queueLen | decision |
| -------: | -------: | -------- |
|        0 |        3 | **defer** (what happens today) |
|        0 |        0 | proceed |
|       12 |        3 | proceed |
|       42 |        3 | proceed (the artifact's real age) |

The gate script is fine — its own usage doc says `--last-refresh` should come
from "a value carried IN the artifact", meaning the committed one. Only this
workflow's step ordering is wrong.

## Why it went unnoticed

Every visible signal said healthy. The run was green, the sanity-check passed,
the defer path is deliberately *not* a failure (correctly — a deferred refresh
is normal), and the staleness floor existed precisely so an indefinite defer
could not happen. The floor was the safety net, and the safety net was measuring
the wrong thing.

This is the third time this dashboard has shipped stale. The workflow's own
header records the first two (#3958 rendered `39/null`; #3977 kept showing `lit`
as not-integrated) and says they were "the case for a mechanism rather than for
remembering". The mechanism was built and then defeated by a two-line ordering
detail.

## Fix

Capture the committed artifact's `generatedAt` in a step that runs **before**
the regeneration, and feed the gate from that.

## Acceptance criteria

- [x] The staleness floor is computed from the artifact main is currently
      serving, not from the freshly generated one.
- [x] A structural regression test, since this failure has no observable output
      to assert on: step ORDER (`id: committed` before
      `pnpm run generate:npm-compat`) and the wiring
      (`steps.committed.outputs.last_refresh`, and no post-regeneration re-read).
- [x] The test is demonstrated to FAIL against the unfixed workflow — 2 of 5
      fail on `main`'s version, 5 of 5 pass with the fix.
- [x] The gate's decision table is pinned directly, so a future change to
      `decide()` cannot silently reintroduce a permanent defer.

## Deliberately not done

- **No locally-measured artifact commit.** The obvious "just refresh it" is to
  run `pnpm run generate:npm-compat` here and commit the result — but these
  numbers come from a shared, noisy container while every committed measurement
  so far came from a clean CI runner. Mixing the two would corrupt the trend
  history with incomparable figures for a one-time gain. The correct refresh is
  the next workflow run, which this fix unblocks.
- **The `cancelled` runs are not investigated.** Several runs in the same window
  show `cancelled` despite `cancel-in-progress: false`; that is consistent with
  GitHub keeping at most one *pending* run per group (which the workflow's
  comment already anticipates), but it was not verified here.
