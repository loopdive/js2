---
id: 5187
title: "RegExp exec result `.index` reads 0 instead of the match offset — ~224 test262 regressions from #5204"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5180, 5204, 5216, 2547]
---

> **Note on the id:** this is issue **#5187**, allocated by
> `claim-issue.mjs --allocate`. Issue ids and PR numbers share one sequence, so
> it collides by name with **PR #5187** (the #4644 fix, unrelated). Link to this
> issue by slug, not by bare `#5187`.

# #5187 — `/re/.exec(s).index` is 0 for every match

## Problem

```js
var m = /b/.exec("abc");
m.index          // wasm: 0     node: 1
```

Measured on plain `origin/main` (`ddab1b0743`, scratch worktree) and on
`origin/issue-5178-method-return-struct-type`. Compiles clean, runs, returns the
wrong number — no diagnostic, no trap.

## Why this matters now

It is the **largest single runtime cluster** in the merge-group regression that
auto-parked PRs #5169/#5178/#5216 (run
[33236737382](https://github.com/loopdive/js2/actions/runs/33236737382),
`hold` + `auto-park-bot:merge-group-failure`):

| cluster | count | cause |
| --- | --- | --- |
| `pass → compile_error … struct field index out of range` | **595** | #5180 — fixed by PR #5223 |
| `pass → fail … __executed.index is expected to equal …` | **224** | **this issue — NOT fixed by #5223** |
| `pass → fail … __split.constructor is expected to equal …` | 65 | separate + older, see below |
| everything else | ~47 | — |

Totals from the run's own artifact (`test262-regressions-detail.txt`, artifact
9710358902), 931 non-timeout regressions, fine-gate net **-876**.

**None of these are caused by the three parked PRs.** Both dominant clusters
reproduce on plain `main`. The queue is parking PRs for defects `main` already
carries; the baseline they are diffed against still records these tests as
`pass`.

## Attribution — bisected, not guessed

The 5-line repro above makes bisection cheap (the #5180 investigation could not
bisect only because its repro was the 157 KB polyfill bundle):

| revision | `.index` |
| --- | --- |
| `fc6fd3b5f3` (#5196) | **1** — correct |
| `4dfedbdc92` (#5203, ES2015 standalone) | **1** — correct, #5203 is clean |
| `523bd0428b` (**#5204**, `claude/pr-5183-fix-osgkt9`) | **0** — broken |
| `ddab1b0743` (current main) | **0** — broken |

So **#5204 introduced two distinct defects**: #5180 (the `__Date` field-metadata
drift, fixed by #5223) and this one. Verified separately that applying #5223's
fix (`structGrowsWithMetadata` guard + helper) to a tree containing #5204 leaves
`.index` at 0 — **#5223 does not fix this**, so closing #5180 must not be read
as closing the park.

## The `.constructor` cluster is NOT this bug

`"a,b".split(",").constructor === Array` is already `false` at `fc6fd3b5f3`, so
those 65 regressions predate this window and have a different cause. Recorded
here so the next investigator does not fold them in; they need their own probe
(the probe used here is coarse — the test262 cases compare against a species
constructor, not `Array`, so confirm before filing).

## Reproduce

```js
// .tmp/probe.mjs — compile with { allowJs: true, skipSemanticDiagnostics: true },
// instantiate, compare against node.
var __executed = /b/.exec("abc");
console.log("index=" + __executed.index);
```

## Acceptance

* `/b/.exec("abc").index === 1` in compiled output.
* The `__executed.index` cluster clears from the merge-group regression diff.
* A regression test asserting the value, not just a clean compile — this bug
  produces a valid module and a wrong answer.
