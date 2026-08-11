---
id: 4352
title: "#4313 is blocked by a reproducible oob trap-ratchet growth on Temporal/PlainDateTime/from/limits.js, plus a 221 > 200 catastrophic-guard trip on a net-POSITIVE diff"
status: ready
sprint: current
created: 2026-08-10
updated: 2026-08-11
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: ci
goal: test-infrastructure
related: [4313, 3189, 3596, 1668, 2547]
trap-growth-allow:
  count: 1
  reason: "Reclassification, not a regression: the named test is status:fail on the baseline with error_category null_deref, and still fails on this change-set as oob. It is the visible edge of the same movement that takes null_deref 1629 to 145 in run 31456242513, on a net-positive diff (+52 pass). See the Resolution section below."
  tests:
    - test/built-ins/Temporal/PlainDateTime/from/limits.js
---

# #4313's park is real, unlike the other three of that day

PR #4313 (`feat(npm-compat): advance real package execution frontiers`) has been
auto-parked twice. Unlike the other parked PRs of 2026-08-09/10, its failure is
**deterministic and reproduces identically across both merge_group runs**, so it
is a genuine gate failure rather than baseline drift.

## Failure 1 — oob trap-ratchet growth (both runs)

```
GATE FAIL: trap category "oob" grew 35 → 36 (+1) — uncatchable-trap ratchet (#3189).
Now trapping: test/built-ins/Temporal/PlainDateTime/from/limits.js (baseline: fail).
```

Identical file, identical delta, in both:

- run `31322523731` (2026-08-09 16:19)
- run `31349616814` (2026-08-10 02:39)

and again, unchanged, in run `31456242513` (2026-08-11 04:00).

Per the gate's own policy text the baseline status selects the remedy, and this
file's baseline status is `fail`, not `pass`:

> `fail` ⇒ named **trap-growth-allow** (#3596)

So this is not a conformance regression — the file was already failing. What
changed is *how* it fails. See the Resolution below: the baseline row shows it
was already trapping too, so this is a move *between* trap categories.

## Failure 2 — catastrophic guard on a net-positive diff

```
Catastrophic guard: 221 wasm-change regressions (threshold 200)
=== Net: +52 pass (32533 → 32585) ===
=== Host stable-path fine-gate net: +41 (262 improvements − 221 regressions) ===
```

The diff is **net positive** (+41 / +52) yet trips a guard that counts raw
regressions and ignores improvements. #4313 is large (133 files, 47 commits), so
high churn in both directions is expected.

### This is NOT a second, independent blocker — corrected 2026-08-11

It was originally written up as one, and that framing was wrong. The guard is
**downstream of the fine gate**, not parallel to it. `test262-sharded.yml`
(`Catastrophic regression guard (#1668)`) branches on `diff-test262`'s exit code
and says so in its own comment:

> `exit 0` → the script's gate PASSED → … (authoritative, #3303)
> `exit 1` → the script's gate FAILED → apply the coarse catastrophic threshold

and on the pass branch, explicitly:

```sh
if [ "$NET" -gt "$CATASTROPHIC_REGRESSION_THRESHOLD" ]; then
  echo "Raw count exceeds ${CATASTROPHIC_REGRESSION_THRESHOLD} but the script's own gate approved it (deliberate re-baseline)."
fi
exit 0
```

So 221 > 200 only fails **because `diff-test262` already exited 1**, and on this
run the sole `GATE FAIL:` line is the oob trap ratchet (the #3457 ratio warning
is already WAIVED on the net-positive diff). Clear the trap ratchet and the
catastrophic guard takes the exit-0 branch and passes at the same 221.

**One blocker, not two.** No policy decision about net-awareness is required to
land #4313, and the PR does not need splitting on this account. Whether the
guard *should* consider net independently is still a fair question, but it is
not this PR's gate.

## Not part of this issue

The first park also cited a standalone high-water breach of −2324. That did
**not** reproduce: the second run measured `+26` (29,520 vs mark 29,494) with no
code change, so that portion was base-related.

## Resolution — 2026-08-11

The reclassification is declared in this file's frontmatter as a machine-checked
`trap-growth-allow` (#3596), which is the mechanism the gate's own policy text
points at for a baseline-`fail` file.

Verified against the authoritative baseline (`loopdive/js2wasm-baselines`
`test262-current.jsonl`, 48,735 entries) before declaring, because #3596 can only
refuse a claim, never admit one — an unverifiable declaration would wedge
baseline promotion (#3644):

```json
{ "file": "test/built-ins/Temporal/PlainDateTime/from/limits.js",
  "status": "fail",
  "error_category": "null_deref",
  "error": "dereferencing a null pointer [in __module_init()]" }
```

All three of `evaluateTrapReclassification`'s conditions hold:

| condition | evidence |
| --- | --- |
| **named** | the nested `tests:` list carries the one file |
| **not previously passing** | baseline `status: fail` — so a reclassification, not a regression |
| **complete** | run `31456242513` grew exactly one category by exactly one file (`oob 35 → 36`), and it is the file named |

Driving `evaluateTrapReclassification` with that baseline row and the run's real
growth numbers returns zero failures and:

```
=== trap-growth-allow (#3596): reclassification VERIFIED for 1 declared test(s) —
    each was non-passing on the baseline, and no undeclared trap growth was observed. ===
```

The baseline row also settles what "grew" means here: the test was **already
trapping**, as `null_deref`. It did not start trapping — it moved between trap
categories, which is the same movement that takes `null_deref` from 1629 to 145
in that run. The #3189 ratchet counts per category and so sees the +1 without
seeing the −1484.

### An earlier refusal was based on a measurement that did not match

On 2026-08-11 03:38 the allowance was declined on the grounds that the trap "no
longer occurs", from a local reproduction showing a clean `Test262Error` on
gc/host. The merge_group run 25 minutes later reported `oob 35 → 36` on the same
file, against a baseline the gate itself certified as content-current (*"0
test262-relevant commits separate the baseline from main HEAD"*, so drift is
excluded). Whatever the local run measured, it was not the merged state the
queue gates on. The declaration is made on the queue's measurement.

### A trap for the next declaration

`parseFrontmatterCountReason` is a **line-based** reader: it ends the block at
the first line that is not `key: value` (or a list item under a key it knows).
A wrapped, multi-line `reason:` therefore terminates the block early and the
nested `tests:` list is silently dropped — leaving a declaration that parses as
valid but *unnamed*, which #3596 refuses. Keep `reason:` on one line and put the
prose here. Caught by running the parser rather than by eye.

## State

`hold` removed once the declaration was pushed. If the PR re-parks, the run will
say which condition failed — that is a fact about the declaration, not a reason
to re-litigate the diagnosis.
