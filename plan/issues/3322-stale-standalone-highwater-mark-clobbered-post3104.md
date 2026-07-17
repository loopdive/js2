---
id: 3322
title: "#2097 standalone high-water mark clobbered to a stale, too-high value by a race with #3104's landing — wedged the entire merge queue"
status: done
sprint: current
created: 2026-07-16
completed: 2026-07-16
priority: critical
feasibility: trivial
task_type: ci-infra
area: test-infrastructure
goal: test-infrastructure
related: [2097, 3104, 3285, 3286, 3303]
origin: "found by fable-3161-conflict while investigating #3227's own regression numbers; independently verified and fixed by the tech lead"
---

# #3322 — stale #2097 high-water mark wedged the queue after #3104 landed

## What happened

After PR #3104 (the `assert_throws` harness tightening, #3285/#3286) merged
to `main`, its own carried-forward, tech-lead-reviewed `#2097` floor value
(`23515`, set in `dea01e5dd0a525`) should have become the committed mark.
Instead, a separate scheduled `chore(test262): refresh sharded baseline`
commit (`ea92e392406875`, `[skip ci]`) landed shortly after and **overwrote
it with `25438`** — computed from a report generated at `2026-07-16T16:10:21Z`
(commit `3186699e68`), which **predates #3104's actual merge** (`16:48:31Z`).
That pre-tightening snapshot naturally shows a higher pass count, because the
old lenient `assert_throws` shim let more tests pass than the correctly
tightened one.

Because the `#2097` floor **only ever ratchets upward** (by design — it's a
regression-prevention floor, not a snapshot), this wrongly-inflated `25438`
mark became permanent: every subsequent PR's `merge_group` re-validation
measured the TRUE, honest post-#3104 standalone host-free pass count
(**24825**, confirmed from `pr-3160`'s own merge_group log) against a mark
that no honest measurement could ever reach again. Every PR touching
test262-relevant code was destined to auto-park indefinitely — #3155, #3159,
and #3160 already had before this was caught.

## Fix

Directly overwrote the committed mark
(`benchmarks/results/test262-standalone-highwater.json`) with the verified
current value:

```json
{
  "pass": 24825,
  "host_free_pass": 24825,
  "sha": "ea91a1b0f4bd477c9d1c64ebcc0a8bcc43f24e39",
  ...
}
```

`host_free_pass`/`pass` (24825) is the exact figure the gate check consumes,
taken directly from `pr-3160`'s real `merge_group` log line:
`[standalone-highwater] current pass=24825, mark=25438 ...`. `official_pass`
(24370) is an interim proportional estimate (previous
`official_pass`/`pass` ratio applied to 24825) — informational only, not
consumed by the breach check; the next successful scheduled/promote-baseline
refresh will supersede it with a precisely measured value.

**Why this had to go directly to `main`, not through a PR**: any PR fixing
this file would itself be gated by the exact same broken floor check in its
own `merge_group` re-validation — a PR can't fix a check that blocks PRs.
Same chicken-and-egg class as #3104's original in-PR floor-edit necessity,
just one level further out (queue-wide infra state, not a single PR).

## Root cause (for follow-up, not fixed here)

The scheduled/independent baseline-refresh job that produced `ea92e392` ran
using a snapshot from **before** #3104's merge completed, and — because nothing
enforces recency ordering between "PR merges, carrying a reviewed floor
value" and "unrelated scheduled refresh, using whatever data it happened to
have" — the older-but-numerically-higher measurement won the ratchet-up race.
This is a structural gap: **the ratchet-up-only #2097 mechanism has no
protection against being raised by a measurement that is stale relative to
main's actual current state.** Worth a follow-up: either gate the scheduled
refresh job's mark-raising on `sha` recency (don't raise the mark from a
report whose `sha` isn't a descendant of the currently-committed mark's
`sha`), or serialize it explicitly after any promote-baseline run triggered
by a merge. Not fixed in this issue — flagging for whoever owns #2097/#2879
next.

**Second confirmed instance, broader scope (2026-07-16, later same day):**
the same class of scheduled `chore(test262): refresh sharded baseline` bot
commit (`879cb67ac231b9`) silently reverted an unrelated `CLAUDE.md` doc-line
edit (a tech-lead-authored note, landed in `89d3bf82`) that happened to sit
in the gap between the bot's snapshot and its commit — with **no ratchet
semantics involved at all**, ruling out "it's specific to the #2097
mechanism" as the root cause. This generalizes the bug: the scheduled job
appears to check out a snapshot at job start and commit+push at job end
without re-fetching main's latest state immediately before the commit,
silently overwriting ANY intervening edit to any file the sync script
touches (`benchmarks/results/test262-standalone-highwater.json`,
`CLAUDE.md`, presumably `README.md` and whatever else
`sync-conformance-numbers.mjs` / the promote-baseline job writes). Re-added
the CLAUDE.md line by hand after finding this (commit `048f715e`). Worth
prioritizing the general fix (fetch+rebase immediately before commit, or a
compare-and-swap on the base sha) over the narrower #2097-specific one
above, since it's now confirmed to hit more than one file.

## Acceptance criteria

- Committed mark reflects the true, current, verified standalone host-free
  pass count. ✅
- #3155, #3159, #3160 (and any other PR parked purely on this stale-mark
  signature) can be re-enqueued once confirmed against the corrected mark.
- Root-cause note above is preserved for a future hardening pass — not
  required to close this issue, since the immediate wedge is resolved.
