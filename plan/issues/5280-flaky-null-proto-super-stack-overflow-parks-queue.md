---
id: 5280
title: "test262 flake: class-definition-null-proto-super.js overflows the stack under merge-group load and parks unrelated PRs"
status: ready
created: 2026-09-02
updated: 2026-09-02
sprint: current
priority: high
horizon: m
feasibility: medium
task_type: infrastructure
area: tooling
goal: ci-infrastructure
requested_by: claude/fable-ir-takeover
related: [5275, 2547, 3426, 3457, 2562, 5479, 5480, 5486]
---

## Problem

`test/language/statements/class/subclass/class-definition-null-proto-super.js`
flips `pass → fail` with `Maximum call stack size exceeded` (`range_error`,
regression bucket signature **`96690aa5e0efb4ff`**, net −1) in the
`merge_group` re-validation, non-deterministically. It has parked **three
unrelated PRs in one day**:

| PR | parked | run | what the PR changed |
| --- | --- | --- | --- |
| #5479 | 2026-09-02 12:15 | 33626922676 | ES2015 standalone TypedArray r2 — builtins/prototype graph |
| #5480 | 2026-09-02 14:51 | 33642323854 | #3523 gap-6a v2 — module-init prelift, default-OFF (byte-neutral) |
| #5486 | 2026-09-02 21:33 | 33683869984 | #3521 R2-T1/G1 — telemetry + CI selection (302/302 byte-identical) |

Three disjoint diffs, one row, one signature. Two of the three PRs carry their
own byte-identity evidence, and #5480's diagnosis measured the row directly:
runner-faithful `runTest262File`, 3 runs each, `origin/main` **pass ×3** and
the PR tree **pass ×3**, identical `wasm_sha` `aa0313d0d7f6`. The compiled
artifact is the same on both sides — nothing in a PR diff selects the outcome.
Each park costs a full ~20-minute matrix cycle plus the re-admission cycle, and
stalls whatever is queued behind it.

Each park was diagnosed by hand and re-admitted once; every re-admission then
passed. That is three hand-diagnoses of the same row.

## Why the existing machinery does not catch it

- The **canary quarantine** (#3426) reports `0 observed transitions excluded`
  for this row: its manifest was built from two same-SHA canary runs
  (29632875780, 29643714720) whose 932 union-eligible paths do not include
  this file. The row is flaky but was not flaky *in those two runs*.
- The **`LIKELY-REAL` banner** (#2562) fires because the baseline is
  content-current (0 test262-relevant commits behind main HEAD). Content
  currency says nothing about whether a row is deterministic, so the banner
  actively argues against the correct call here.
- The **cross-PR signature hint** in the gate's own footer ("Same signature on
  another PR ⇒ identical cluster ⇒ likely baseline drift") is printed but not
  acted on: nothing compares this run's signature against other recent runs'.

## Implementation Plan

Two independent pieces; either alone is worth landing.

1. **Root-cause the overflow.** The failure is a real stack overflow in the
   compiled module (or in the harness driving it), not a compile error — the
   test builds a `class extends` chain whose prototype is `null`. Find whether
   the recursion is in the emitted `[[Construct]]` path, in the runner's
   harness assembly, or in the interpreter's own stack budget under a loaded
   runner (the shards run at pool ≥ 3). If it is our recursion, bound it; if
   it is a stack-budget interaction, raise or pin the budget for that shard.
   The reduced witness is the test file itself — it passes standalone and
   fails only under merge-group load, so reproduce with the shard's real
   concurrency, not a single-file run.
2. **Make the cross-PR signature check load-bearing.** The gate already
   computes the bucket signature and already prints the hint. Persist recent
   `merge_group` signatures (the run artifacts are retained ~1 day, which is
   enough) and, when the same signature appears on a PR whose diff is disjoint
   from the previous one's, downgrade the verdict from `LIKELY-REAL` to a
   flake candidate — or route it into the #3426 canary manifest automatically.
   This is the piece that stops the next three hand-diagnoses.

## Acceptance criteria

1. The row either passes deterministically under shard-level concurrency, or
   is in the canary manifest with the evidence that put it there.
2. A second unrelated PR hitting an identical bucket signature is reported as
   such by the gate itself, without a human comparing two run logs.
3. No PR is parked on this row again without the gate naming the prior
   occurrence.

## Fourth instance, 2026-09-03 01:12 — and the strongest evidence yet

PR #5498 parked on the same signature, 27 minutes after being released.

| PR | what its diff changes | run |
| --- | --- | --- |
| #5479 | #3523 gap-6a | 33626922676 |
| #5480 | #3523 gap-6a v2 | 33642323854 |
| #5486 | #3521 R2 admission telemetry | 33683869984 |
| **#5498** | **one expression in `loops.ts`** | **33701148752** |

Verbatim from the fourth run:

```
⚠️  === Regressions (pass → other): 1 ===
  test/language/statements/class/subclass/class-definition-null-proto-super.js:
      pass → fail (Maximum call stack size exceeded)
=== Regression bucket signature: 96690aa5e0efb4ff (1 non-CT files) ===
=== GATE FAIL: net_per_test -1 < 0 (0 improvements − 1 regressions) ===
```

**Why this instance is the strongest argument for making the check
load-bearing.** #5498's entire source change is
`index: ctx.moduleGlobals.get(name) ?? moduleGlobalIdx` — a module-global index
re-read inside a `for`-head `var` arm. There is no mechanism by which that
produces unbounded recursion in `class C extends null`'s SuperCall, and by the
time it parked, #5506 had already root-caused the overflow to a process-global
class-parent registry leaking across files within a shard worker. So the fourth
instance lands on a diff that is *provably* incapable of causing it, against a
root cause that was *already known*.

**And the gate argued the opposite, correctly-in-general.** Its footer read:

> ❌ LIKELY-REAL REGRESSION (baseline content-current, #2562) … the baseline
> reflects current src, so these regressions are far more likely PR-caused than
> baseline drift. Do not dismiss them.

That heuristic is sound — a content-current baseline genuinely cannot be the
drift source — but it reasons from **one PR's data**. The discriminating
evidence is **cross-PR**, and the gate cannot see the other three runs. It
printed the signature and the hint ("Same signature on another PR ⇒ identical
cluster") on all four, and on all four a human had to be the one to notice.
Four parks, four manual diagnoses, four re-admissions: that is the cost of an
advisory hint, and it is the whole argument for the second work item in this
issue.

Re-admitted once, per the auto-park rules, with a note that a second park on
this signature escalates rather than repeating. #5506 is in the queue; once it
lands, both halves of this issue close.

## How to tell this flake from a REAL failure on the same test

`class-definition-null-proto-super.js` is not exclusively a flake row. On
2026-09-01 it parked PR #5412 and that **was** a genuine, PR-caused regression:
the diff changed generator/IR lowering and the test's **wasm hash moved**, which
is what identified it. Anyone hitting this test needs to separate the two cases,
and neither signal alone is sufficient:

| signal | flake (tonight ×4) | real (#5412) |
| --- | --- | --- |
| bucket signature `96690aa5e0efb4ff` | yes | yes |
| same message, `range_error` | yes | yes |
| wasm hash changed | **sometimes yes** (see below) | yes |
| the PR's diff can reach the failing file | **no** | yes |

**The bucket signature is necessary but not sufficient**, and — the trap —
**`Regressions with wasm-hash change: 1` does not settle it either.** #5498's
park printed exactly that line while being collateral, because the merge group
tests the *merged* state and main's other landed changes move bytes too.

**The decisive question is whether the PR's diff can execute while compiling the
failing file.** For #5498 it provably cannot: the test contains no `for`
statement at all (`grep -cE '^\s*for\s*\(\s*var '` → 0), and that PR's only
source change lives inside `compileForStatement`'s module-global for-head `var`
arm, behind `if (moduleGlobalIdx !== undefined)`. For #5412 the diff changed
lowering reachable from any class body, so it could.

**Recommended order when this parks your PR:**

1. Check whether your diff's changed code paths can be reached while compiling
   `class-definition-null-proto-super.js`. Read the test — it is 20 lines. If
   the answer is no, it is collateral regardless of the wasm-hash line.
2. Only if it *can* reach: reproduce locally on the merged state and byte-compare
   against a clean `origin/main` build, per the #5412 procedure.
3. Cross-check the signature against other open PRs' runs. Four disjoint diffs
   with one signature is strong corroboration — but it is corroboration, not the
   primary test.

This ordering is the useful output of four manual diagnoses. Building it into
the cross-PR signature check (this issue's second work item) is what stops the
fifth person re-deriving it.
