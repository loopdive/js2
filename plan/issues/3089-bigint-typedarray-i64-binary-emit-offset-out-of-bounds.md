---
id: 3089
title: "codegen: BigInt TypedArray tests fail to compile — 'Binary emit error: RangeError: offset is out of bounds' (i64 codegen, ~22/30 sampled, pre-existing)"
status: wont-fix
sprint: 75
model: opus
priority: medium
horizon: m
feasibility: hard
task_type: bugfix
area: codegen
language_feature: bigint, typed-arrays, i64
goal: host-independence
related: [3074, 3087, 1349, 1644, 1808, 1862]
created: 2026-07-07
completed: 2026-07-08
origin: "2026-07-07 surfaced (not caused) during #3074 keystone validation (dev-keystone): the BigInt-TA harness sample is dominated by a compile-time binary-emit RangeError, independent of dispatch."
---

# #3089 — BigInt TypedArray compile error: `Binary emit error: RangeError: offset is out of bounds`

## Problem

A large fraction of `built-ins/TypedArray*/**/BigInt/**` and
`ctors-bigint/**` tests fail at COMPILE time with:

```
L..:1 Binary emit error: RangeError: offset is out of bounds
```

Measured under #3074's keystone validation: **~22 of 30** sampled
`testWithBigIntTypedArrayConstructors` files are `compile_error` with this exact
signature — **independent of the closure-dispatch fix** (they were already
`compile_error` on `main`; #3074 does not change them). Sample:
`TypedArrayConstructors/from/BigInt/inherited.js`,
`ctors-bigint/object-arg/iterating-throws.js`,
`TypedArray/prototype/slice/BigInt/return-abrupt-from-start.js`.

## Why filed now

It is the **third downstream gap** (alongside #3087 dynamic-`new TA` and #3088
runner-shim faithfulness) standing between the #3074 keystone and real BigInt
TypedArray conformance. Tracked so the BigInt-TA cluster's blockers are
enumerated. Pre-existing i64/BigInt codegen defect — NOT a #3074 regression.

## Scope / approach

The `Binary emit error: RangeError: offset is out of bounds` is a binary-encoder
overflow (a LEB/section offset computed out of range) triggered on the i64/BigInt
paths these tests exercise. Needs a verify-first trace of one minimal repro to
localize the encoder site (likely an i64 constant / memory-offset / type-section
index miscomputation on the BigInt TypedArray element path). Related BigInt i64
work: #1349 / #1644 (i64-brand ValType).

## Acceptance

- The sampled BigInt-TA `compile_error` files compile (then pass or honest-fail
  on downstream semantics), on both lanes as applicable.
- No net regression.

## Verify-First Finding — WONT-FIX / superseded (2026-07-08, dev-ta)

**The per-file `Binary emit error: RangeError: offset is out of bounds`
signature does NOT reproduce on current `main`.** Re-verified against current
main before any implementation (specs were stale repeatedly this session):

**All three of this issue's own named sample files, compiled+run in isolation
(`runTest262File`, gc lane):**

| file | result on current main |
| --- | --- |
| `TypedArrayConstructors/from/BigInt/inherited.js` | `fail` (assert #1) — compiles fine |
| `ctors-bigint/object-arg/iterating-throws.js` | **`pass`** |
| `TypedArray/prototype/slice/BigInt/return-abrupt-from-start.js` | `fail` — honest #3087 (`No dependency provided for extern class "TA"`) |

**23 BigInt-TA files sampled in isolated subprocesses** (one compile per
process, matching the production forked-worker recycle model): **0 produced the
`Binary emit error` / `offset is out of bounds` signature.** Distribution:
dominated by honest #3087 (`new TA(...)` dynamic construction), plus a handful
of genuine `pass` and honest runtime `fail`s (assert / "undefined is not a
constructor" — itself a #3087-adjacent dynamic-construction gap).

**Root cause of the harvested `compile_error`: the #1808 / #1862
poisoned-worker cascade, not a per-file i64 codegen defect.** The harvest ran
the batched `scripts/compiler-fork-worker.mjs`, which drives a **long-lived
incremental compiler** across a batch. As that worker's own header comment
documents (lines 20–29), an emit/allocation-class failure on one file can leave
the incremental compiler / V8 heap degraded, cascading *identical*
`Binary emit error: offset is out of bounds` results for every subsequent file
until the next recycle — "all of which compile cleanly on a fresh run." I
reproduced exactly this: **765 BigInt-TA files run back-to-back in a single
process cascade into `compile_error`, yet each file run alone compiles cleanly.**
The mitigation already exists (`isPoisonCompileError` → `forceRecreate` +
`RECREATE_INTERVAL` recycle in the fork worker; `POISON_ERROR_RE` in
`scripts/test262-poison-error.mjs`).

**Disposition:** no independent actionable i64/BigInt codegen work here.

- The real per-file blocker for the BigInt-TA cluster is **#3087** (dynamic
  `new TA(...)` on an `any`-typed ctor value) — the *same* dominant blocker as
  the non-BigInt cluster. Converting these files to real passes is #3087's job.
- Any residual batch-only `compile_error` cascade is **#1808 / #1862**
  (poison-worker recycle hardening), not a codegen fix. If a future harvest
  shows a *reproducible per-file* binary-emit CE on a specific BigInt-TA file,
  reopen with that minimal repro (`runTest262File <file>` in a fresh process
  showing the error) — none exists on current main.

Closing as **wont-fix (superseded by #3087 + #1808/#1862)**. This does not
touch the Fable-reserved i64-brand substrate (#1349/#1644) — no such change is
warranted.
