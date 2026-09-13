---
id: 6461
title: "main's standalone host-free pass count is ~165 below its high-water mark and is parking every PR that reaches the merge queue"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: correctness
---

## Problem

The standalone host-free pass-count floor (#2097) is breaching in the
`merge_group` for PRs that cannot have caused it, and auto-park is `hold`-ing
them. Three independent observations, all on 2026-09-13:

| time (UTC) | PR in the group | reported | mark | delta |
| ---------- | --------------- | -------- | ---- | ----- |
| 06:39 | #5893 | `pass=35567` | 35686 (`e8a778638f`, 09-12T21:36Z) | −119 |
| 08:27 | **#5897** | `pass=35567` | 35742 (`6aac84c0b6`, 09-13T06:43Z) | −175 |
| 10:07 | #5893 | `pass=35577` | 35742 | −165 |

The **current** value is what matters: ~35,567–35,577 across three runs, two
different PRs, against two different marks. The mark was *raised* to 35742 at
`6aac84c0b6` while the measured value was already ~35,570 — so the floor is now
unreachable and every PR whose merge group runs the shard matrix gets parked.

## Why this is not #5893's

#5893 ([#6423](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6423-absent-number-property-stringifies-as-nan))
touches only the js-host ToString arms; its helper returns the parent's plain
`call number_toString` unless `coercionMode(ctx) === "js-host"`. Standalone /
WASI / native-strings binaries are byte-identical to the parent — verified by
SHA-256 across three fixtures (for-of numeric concat, the full
`String`/template/`+`/`String.raw` set, generators) in all three non-js-host
configurations: nine hashes, all equal. And #5897, which has nothing to do with
that change, reported the identical `pass=35567`.

## Why it went unnoticed

The mark was set at `e8a778638f` (09-12T21:36Z) and every merge group between
then and 06:39 **skipped the shard matrix** (non-test262-relevant changes), so
the floor was not exercised for ~8.5 hours. Whatever regressed landed somewhere
in that window and was banked into a *higher* mark at 06:43 by a run that also
did not measure it. That combination — a mark that can be raised by a run which
did not exercise the floor — is worth a look on its own.

## What to do

1. **Bisect** the standalone host-free pass count across the commits merged
   between `e8a778638f` (09-12T21:36Z) and `0bba1b92bf` (09-13T06:17Z). Many
   standalone-facing modules landed there: `standalone-link-boundary.ts`,
   `regexp-standalone.ts`, `link-boundary-tostring.ts`,
   `native-globalthis-outline.ts`, among others.
2. Either fix the regression, or re-seed the mark with `--update` on a
   known-good main run **and record why** — but only after (1) says which it is.
   Re-seeding first would bank a real ~165-test loss.
3. Check how `6aac84c0b6` was allowed to raise the mark to 35742 when the
   measured value was already ~35,570: if the promote path can bank a mark from
   a run that skipped the shard matrix, that is a second defect and it is what
   turned a regression into a queue-wide block.

## Impact

Queue-blocking. #5893 has been parked twice and #5897 once; every PR whose
merge group runs the shard matrix will keep parking until the mark and the
measurement agree again.
