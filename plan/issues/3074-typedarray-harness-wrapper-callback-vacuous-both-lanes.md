---
id: 3074
title: "TypedArray harness-wrapper callback never executes → vacuous fail (both lanes; persists after #2939/#2940)"
status: ready
sprint: Backlog
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, dynamic-dispatch, typed-arrays, test262-harness
goal: host-independence
related: [2939, 2940, 2903, 2879]
created: 2026-07-06
updated: 2026-07-06
origin: "2026-07-06 /harvest-errors run against baselines @ default run 20260706-034320 (gitHash 2aa204b4) + standalone current.jsonl (6.7.2026)."
---

# #3074 — TypedArray harness-wrapper callback stays vacuous in BOTH lanes

## Summary

The single **largest default-lane failure cluster** and a large standalone
cluster are the same signature:

```
other:vacuous: harness-wrapper callback never executed (##) — no assertion ran
```

- **Default (JS-host) lane: 1,535 records** — 927 `built-ins/TypedArray`,
  553 `built-ins/TypedArrayConstructors`, 46 `built-ins/Atomics`, misc.
- **Standalone lane: 448 records** — TypedArray prototype/ctor tests.

These are test262 files wrapped in the harness helper
`testWithTypedArrayConstructors(function(TA){ … })` /
`testWithBigIntTypedArrayConstructors(function(TA){ … })`. The wrapper's
callback (an `any`-typed closure parameter, invoked as `fn(TA)` inside the
harness) is **never executed**, so no assertion in the body runs and the oracle
correctly reports the test as **vacuous → fail** (the #2940 / de-vacuification
machinery working as intended).

## Why this is filed now (both tracking issues are CLOSED)

- **#2940** (`status: done`) measured this exact cluster on the standalone lane
  and concluded the fix was **blocked on #2939** (dynamic dispatch of an
  `any`-typed closure param must tolerate arity mismatch + coerce arg
  type-kinds). It was closed as a measurement/decision doc, not a fix.
- **#2939** (`status: done`) — the closure-dispatch blocker — has since landed.

**Yet the cluster persists at 1,535 (default) + 448 (standalone).** So either
#2939's fix did not cover the harness-wrapper dispatch path, or a narrower case
landed. Neither closed issue reflects an open feature gap, so these ~1,983
records currently have **no open home**. This issue reopens the work.

Note this is **NOT** a standalone-only / host-import problem: the default
(JS-host) lane shows the *larger* count (1,535), so the harness-wrapper closure
simply is not being invoked regardless of target. This is distinct from #2903
(residual `__make_callback` = host-backed *builtin-method* closures), which is a
separate standalone leak-front.

## Sample files (default lane)

```
built-ins/TypedArray/prototype/fill/fill-values-relative-end.js
built-ins/TypedArray/prototype/filter/callbackfn-return-does-not-change-instance.js
built-ins/TypedArray/prototype/includes/return-abrupt-tointeger-fromindex.js
built-ins/TypedArray/prototype/set/typedarray-arg-offset-tointeger.js
built-ins/TypedArray/prototype/copyWithin/negative-start.js
built-ins/TypedArrayConstructors/ctors/typedarray-arg/proto-from-ctor-realm.js
```

## Suggested investigation

1. Reproduce one file (e.g. `fill/fill-values-relative-end.js`) on current main,
   both `gc` and `standalone` targets, with `trackFallbacks`, and confirm the
   `testWith*TypedArrayConstructors(fn)` closure is entered.
2. Re-verify #2939's dynamic-dispatch fix (`calls-closures.ts`) against the
   specific arity/type shape the harness wrapper uses (`fn(TA)` where `TA` is a
   constructor value passed positionally; the callback declares one param). The
   #2940 measurement noted many wrappers pass a **2-arg** `makeCtorArg` callback
   — check the 2-arg path specifically.
3. If the closure is invoked but the body still no-ops, trace where the
   assertion counter stays at 0 (the vacuity detector keys on
   "no assertion ran").

## Acceptance

- The `vacuous: harness-wrapper callback never executed` signature drops
  materially in BOTH lanes (target: <200 default), i.e. the TypedArray harness
  wrapper actually invokes its callback and the body assertions run.
- No net regression in either lane's pass count.
