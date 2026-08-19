---
id: 4141
title: "merge_group trap ratchet charges ~1,200 baseline-skip Temporal rows to the candidate as new null_deref traps — the baseline heal step runs without TEST262_INCLUDE_PROPOSALS, so it launders real traps into `skip`"
status: done
sprint: 78
created: 2026-08-03
updated: 2026-08-18
completed: 2026-08-03
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: ci, tooling
language_feature: none
goal: dogfood
related: [3189, 3595, 3596, 2099, 3467, 2547, 4142]
origin: "PRs #4074 and #4088 auto-parked in different lanes with a byte-identical phantom regression, 2026-08-03"
---

# #4141 — heal/shard scope asymmetry manufactures phantom trap growth

## Symptom

Two unrelated PRs in different lanes (#4074 `claude/eslint-compiler-performance-o12y0w`,
#4088 `claude/js2-cross-frame-capture-slot`) were auto-parked by
`auto-park-bot:merge-group-failure` with the **byte-identical** gate delta:

```
skip       1322 → 115   (−1207)
null_deref  156 → 1360  (+1204)
Regressions excluding compile_timeout: 0
```

with the host fine-gate net **positive** and **zero** `pass → trap` transitions.

Two facts make this not-a-codegen-regression on their face:

- a codegen change cannot **un-skip** 1,200 tests — skipping is a
  pre-compile scope decision, nothing a compiler diff can reach;
- the delta is identical across two independent branches, so it is a property
  of the *comparison*, not of either branch.

## Root cause — the healer runs under a different scope than the shards

1. `scripts/heal-poison-rows.ts` (#2099) re-runs contamination-poison rows
   through `runTest262File(...)`. For a non-`negative` test that applies
   `shouldSkip` → `classifyTestScope`, and `built-ins/Temporal/**` classifies
   as a **proposal** — skipped unless `TEST262_INCLUDE_PROPOSALS === "1"`.
2. The shard jobs set that env (`test262-shard` ~L723, `mg-test262-shard`
   ~L896). **The two heal steps did not** (`promote-baseline` ~L2338,
   `write-run-cache-bot` ~L3174). So a Temporal poison row that the shard had
   measured as a real trap was re-run in a process where the same file is out
   of scope, and the healer wrote back `status: "skip"`.
3. Healing runs on the **baseline** path only. `merge-report` (~L991), which
   builds the **candidate** JSONL, does not heal — so the candidate keeps those
   rows as traps.
4. `scripts/diff-test262.ts` excluded only `compile_timeout` / `compile_error` /
   absent from the #3595 "baseline can't testify" set. `skip` was not in it, so
   the whole asymmetry landed as trap growth on whatever PR was in the group.

Measured on the live baseline (`test262-current.jsonl`, 48,368 rows,
fetched 2026-08-03):

| count | rows |
| --- | --- |
| 1,344 | baseline `skip` rows total |
| 1,229 | of those carry `poison_healed: true` |
| 1,229 | of those are `built-ins/Temporal/**` with `error: "Proposal excluded from default scope: proposal feature: Temporal"` |
| 115 | genuine skips — **exactly the `115` the gate reported for the candidate** |

Every single `poison_healed` row in the baseline is one of these; the laundering
is 100 % of the healed population. A representative row:

```json
{"file":"test/built-ins/Temporal/PlainDate/prototype/subtract/basic.js","status":"skip",
 "reached_test":false,"compile_ms":4827,"scope":"proposal","retried":true,"retry_count":1,
 "poison_healed":true,"error":"Proposal excluded from default scope: proposal feature: Temporal"}
```

`compile_ms: 4827` on a row claiming to be skipped is the tell: the *shard*
compiled it for nearly 5 s, then the *healer* overwrote the verdict with a scope
decision.

## Why #4087 / #4086 / #4084 "passed the same gate"

They are not controls. Their `merge_group` runs had every shard job skipped by
`detect test262-relevant changes`, so the shards never executed and no candidate
JSONL was produced to diff. Any PR whose merge_group run actually runs the
shards hits this.

## Fix

**(1) Root cause** — set `TEST262_INCLUDE_PROPOSALS` on both heal steps so the
healer's scope matches the shard's. `promote-baseline` mirrors the shard's own
expression (`github.event_name != 'workflow_dispatch' && '1' || …`) rather than
hardcoding `"1"`, so an `include_proposals: false` dispatch heals under the
scope its shards actually ran under. `write-run-cache-bot` is push +
merge-queue-bot only, so it is always the non-dispatch branch: `"1"`.

**(2) Defense in depth** — add `skip` to the baseline-can't-testify exclusion in
`evaluateTrapCategoryGrowth`. A skipped test was never compiled and never
instantiated, so the baseline made no runtime observation of it at all; a
candidate trap is *unknown*, not *introduced*. This is correct on its own merits
for every skip reason (scope filter, `HANGING_TESTS`, feature filter) and does
not depend on the healer bug. It is **narrow**: a baseline that actually ran
(`pass` or `fail`) and now traps still fails the ratchet, hard.

**(3) Healing the candidate too — deliberately NOT done.** Symmetry could also
be restored by healing `merge-report`'s candidate JSONL, but that is the wrong
lever here and would have been a worse fix:

- it does not remove the defect, it *balances* it — both sides would then
  launder Temporal traps into `skip`, which silently drops ~1,200 real traps
  out of the measured population on both sides. The gate would go quiet by
  becoming blinder.
- with (1) applied, there is nothing left to symmetrise: healed rows record
  their true `fail`/trap verdict, so a healed baseline and an unhealed
  candidate agree on scope.
- it adds a multi-minute serial re-run to the critical path of every
  `merge_group`, which is the most latency-sensitive job in the queue.

Healing the candidate remains defensible for the *original* #2099 reason
(a phantom "Binary emit error" in a candidate row), but that is a separate
question and should not ride along on a ratchet fix.

## Loose end filed separately

The heal steps also omit `TEST262_FULL_RUNTIME_EVAL`, which the **standalone**
shard lane sets to `1` (with the `runtime-eval-provider` artifact downloaded).
A standalone poison row healed without it is re-run on the REFUSAL provider
tier, which `scripts/runtime-eval-provider.mjs` itself labels "NOT
CI-comparable" — the same class of heal/shard asymmetry as this bug. It is not
fixed here because setting the env alone is a no-op (the heal jobs have no
provider cache); it needs the artifact wired into those jobs. Tracked in #4142's
sibling note — see the PR body.

## Acceptance criteria

- [x] Both heal steps run under the shard lane's proposal scope.
- [x] A baseline `skip` row cannot contribute trap-category growth.
- [x] A genuine `pass → trap` or `fail → trap` transition still fails the gate,
      including when it is hidden inside a large skip-unknown bucket.
- [x] `TRAP_RATCHET_TOLERANCE` untouched; no `trap-growth-allow` granted.
- [x] Unit coverage in `tests/issue-4141-trap-growth-baseline-skip.test.ts`,
      including a scaled reconstruction of the +1204 phantom.

## Diagnostics also fixed

The gate printed `(baseline compile_timeout)` for **every** unknown, hardcoded
at the reporting site. That has been wrong since #3595 added `compile_error`,
and it actively misleads triage: it tells the reader the predecessor timed out
when it in fact never ran. It now prints the row's real baseline status plus a
per-status summary, and caps the per-file listing at 50 so a bulk producer-side
asymmetry cannot bury the summary line under a 1,200-line dump.
