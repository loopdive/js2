---
id: 6461
title: "main's standalone host-free pass count is ~165 below its high-water mark and is parking every PR that reaches the merge queue"
status: done
completed: 2026-09-13
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

## Why this is not #5893's

#5893 ([#6423](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6423-absent-number-property-stringifies-as-nan))
touches only the js-host ToString arms; standalone / WASI / native-strings
binaries are byte-identical to the parent (nine SHA-256 hashes across three
fixtures in all three non-js-host configurations). #5897, unrelated, reported
the identical `pass=35567`. The drop is main-side.

## Resolution

**There is no producer disagreement. The mark is honest and the regression is
real.** The working hypothesis when this issue was filed — that the scheduled
`baseline-summary-sync` ratcheted the mark from a different producer or a
different metric than the gate asserts — does not survive the evidence.

### Both numbers come from the same producer

`.github/workflows/baseline-summary-sync.yml` ratchets from
`test262-standalone-report.json` in `loopdive/js2wasm-baselines`. That file is
not computed by the sync: `write-run-cache-bot` (and `promote-baseline`) copy it
verbatim from `shard-artifacts/test262-standalone-report-merged.json`, which is
`scripts/build-test262-report.mjs --input <merged standalone JSONL> --target
standalone` over the **merge group's own shard matrix output** — the same
artifact `merge shard reports` builds and the gate asserts on. Both sides read
`full_summary.host_free_pass`. Same producer, same metric.

### The mark was measured, not inferred

merge_group run **34734641960** at `6aac84c0b6` (03:05Z) ran the full matrix —
`COMPLETE: 52 shard(s), 48735 verdicts` host, `COMPLETE: 50 shard(s), 48735
verdicts` standalone — and its own floor step printed:

```
[standalone-highwater] current pass=35742, mark=35686 (floor=35636, tolerance=50, delta=+56).
```

35742 is that run's measurement. `baseline-summary-sync` banked it 3h38m later
at 06:43Z. The ratchet did exactly what it is supposed to do.

### What actually regressed

Diffing the merged standalone JSONL of run **34734641960** (`6aac84c0b6`, good)
against run **34742396970** (`a7265340b1`, first breach) — 48735 rows each:

| status | 6aac84c0b6 | a7265340b1 | Δ |
| --- | --- | --- | --- |
| pass | 35742 | 35567 | **−175** |
| compile_error | 3176 | 3350 | **+174** |
| fail | 9694 | 9696 | +2 |

181 tests went pass → other, 6 recovered. **174 of the 181 are
`test/language/statements/for-await-of/*`**, all with the same compile error:

```
internal: async function `fn` activates a state machine (result: Promise/externref)
```

That string is `reportDeclaredAsyncResultDisagreement` in
`src/codegen/async-activation.ts:268`, introduced by `1ba798b5cc`
("fix(#6412): bake the Promise carrier into an activated async declaration's
result", PR #5871) — `git log -S "activates a state machine"` returns that
commit and no other. The assertion fires when `asyncEngineWouldActivate` at
declaration-registration time and the body-time activation decision disagree.
It is standalone-specific: the js-host lane over the same window moved **+19**.

So the real standalone host-free pass count on main is **~35,567–35,585**, and
the 35742 mark is the pre-regression truth. Re-seeding the mark down would bank
a real 174-test loss; `check-standalone-highwater.mjs` is a raise-only ratchet
precisely so that cannot happen by accident. The fix belongs on #6412's side.

### Second finding: three PRs landed with a FAILING required check

`merge shard reports` is `failure` on three commits that are on `main`:

| commit | PR | `merge shard reports` |
| --- | --- | --- |
| `607c3c799f` | #5875 | failure |
| `c12c178e55` | #5882 | failure |
| `82ca09dd09` | #5871 (the regressing one) | failure |

(`gh api repos/loopdive/js2/commits/<sha>/check-runs?check_name=merge+shard+reports`
returns a single check run, conclusion `failure`, for each.) The shard jobs in
that window all died with `Test262 shard did not reach afterAll; refusing
partial JSONL evidence` — the `test262` submodule gitlink had been replaced by a
symlink, repaired later by `7871adcc79` (#5892). `merge-report` correctly failed
(`SHARDS_RAN: false`, `SHARD_SKIP_OK: false`), and the queue landed the groups
anyway. That is how an unmeasured −174 reached `main`, and it is filed
separately — see New issues below.

## What changed here

One workflow change, no compiler change.

`merge shard reports` now defers the #2097 floor's failure to the end of the
job (`continue-on-error` on the floor step, a re-raising step before the
uploads). The floor is exactly as strict and still blocks the merge queue; the
difference is that the steps *below* it now run on a breach — in particular the
**#1897 standalone regression guard, which is the only thing in CI that prints
WHICH standalone tests moved**, plus the per-edition `--compare` ratchet and the
#3953 staleness annotation.

Before this, a breach exited the job at the floor and every parked PR author saw
one line (`current pass=35577, mark=35742`) with no way to separate a real
regression from a drifting mark. Reconstructing the 174-test `for-await-of`
bucket above took an out-of-band download of two 24 MB JSONL artifacts and a
local diff — reproducing offline exactly what the #1897 guard would have printed
in the run.

## Impact

Queue-blocking while it lasted: #5890, #5893, #5894, #5896, #5897, #5902 and
main's own post-merge run all parked on the same breach.
