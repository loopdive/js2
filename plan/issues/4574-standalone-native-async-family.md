---
id: 4574
title: "Standalone IR: project the final async family through the native Promise runtime"
status: done
created: 2026-08-20
updated: 2026-08-20
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, async, runtime
language_feature: async-functions, Promise, Promise.all, setTimeout
goal: ir-full-coverage
sprint: current
parent: 3527
depends_on: [4573]
assignee: ttraenkler/codex
horizon: m
lane: ir-retirement-r7-standalone
related: [2895, 2961, 3137, 3469, 3518, 3526, 3527, 3792, 4103, 4104, 4106, 4110, 4124, 4398, 4566, 4573]
origin: "2026-08-20 continuation from the measured 23 IR / 14 legacy / 14 Unsupported standalone checkpoint"
files:
  - scripts/ir-only-baseline.json
  - scripts/ir-kind-neutrality-baseline.json
  - src/codegen/any-helpers.ts
  - src/codegen/async-frame.ts
  - src/codegen/async-ir-planning.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/ir-async-frame.ts
  - src/codegen/ir-async-runtime-adapters.ts
  - src/codegen/ir-native-async-runtime.ts
  - src/codegen/native-dynamic-boundary-tag.ts
  - src/codegen/native-promise-number-boundary.ts
  - src/codegen/prepared-native-async-await.ts
  - src/ir/async-from-ast.ts
  - src/ir/async-plan.ts
  - src/ir/async-runtime-providers.ts
  - src/ir/async-semantic-runtime.ts
  - src/ir/integration.ts
  - src/ir/intrinsic-support.ts
  - src/ir/prepared-component-sealing.ts
  - src/ir/runtime-manifest.ts
  - tests/issue-4103-ir-async-runtime-providers.test.ts
  - tests/issue-4104-ir-async-plan-runtime-consumer.test.ts
  - tests/issue-4110-ir-fetch-all-parallel.test.ts
  - tests/issue-4574-standalone-native-async-family.test.ts
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/3527-ir-r7-ast-free-async-plan.md
  - plan/issues/4574-standalone-native-async-family.md
---

# #4574 — standalone native async-family compile-once ownership

## Problem

After #4573, the authoritative standalone lane contains 37 terminal units,
23 IR bodies, 14 legacy bodies, 14 typed Unsupported outcomes, and zero
Invariants. The native `delay` dependency root is prepared, but the four exact
async owners in `website/playground/examples/js/async.ts` still stop at
`select/async-function`:

- `fetchUser`
- `fetchAllSequential`
- `fetchAllParallel`
- async `main`

The JS-host lane already prepares the same checker-certified `IrAsyncPlan`s.
Standalone already has the native `$Promise`, reaction queue, settlement,
timer boundary, Promise combinator, string, number-format, and output
substrates. The remaining gap is target projection: prepared async runtime
bindings and frame lowering are hard-coded to host imports and an externref
Promise carrier, so standalone selection rejects the plans and emits their
legacy bodies.

## Scope

- Add one all-or-nothing standalone-native runtime projection for the existing
  immutable `IrAsyncPlan`; do not create another async planner or frame engine.
- Reuse the existing native `$Promise`, `$AsyncFrame`, scheduler, settlement,
  and Promise combinator implementations. Register every callable and physical
  type before prepared-component/Program-ABI sealing.
- Admit the exact dependency-complete family only after `delay`, `fetchUser`,
  both aggregators, and `main` all have sealed prepared dependencies.
- Keep the JS-host projection byte-for-byte/behaviorally unchanged and leave
  WASI, async methods, async closures, generators, `for await`, generic
  Promise shapes, and source near misses unsupported.
- Delete each standalone-direct specialization that has no remaining consumer;
  retain shared direct async machinery while Calendar/Builtins or unsupported
  shapes still consume it.

## Semantic and optimization parity

- `fetchUser` awaits the native `delay` Promise and resolves `id * 10` only
  after the timer boundary drains reactions.
- Sequential aggregation starts item N+1 only after item N fulfills, keeps its
  counter as `i32`, total as `f64`, IDs as a typed vector reference, handles an
  empty input, and rejects exactly once without starting later work.
- Parallel aggregation starts every item before suspension, preserves input
  order through the existing native Promise.all combinator, reduces through a
  typed numeric vector without dynamic carrier round trips, and rejects once.
- `main` preserves one fixed vector, two suspension phases, four deterministic
  standalone clock snapshots, two numeric durations, four specialized number
  conversions, two fused five-part native string concatenations, four typed
  output writes, and `Promise<void>` settlement with the native undefined
  sentinel.
- The module imports only the explicit timer capability. It must not import
  host Promise constructors/reactions, `Promise_all`, `__make_callback`,
  `__date_now`, host concat/format/console adapters, or generic closure bridge
  machinery.
- Optimized IR must be on par with or better than the runnable direct artifact
  in raw/gzip/WAT/body/function/local/call metrics and must not regress the
  established #4573 delay runtime benchmark. Byte identity is not required.

## Runtime oracle rule

The current direct standalone async family is not a valid semantic or runtime
oracle: it resolves `main` before timers fire, fans out the nominal sequential
loop, exposes non-native Promise boundary values for the aggregators, and can
produce `NaN`/`null` results. Correctness therefore comes from the unchanged
source semantics, deterministic timer/order traces, native Promise state and
value observations, and the already-covered JS-host IR plan. Direct standalone
is used only as an optimization/artifact reference. No whole-family speedup is
claimed against work the direct path incorrectly skips.

## Acceptance criteria

- All four owners report `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and non-empty prepared component IDs; `delay` remains
  prepared once.
- Standalone ratchets from **23 to 27 IR bodies** and from **14 to 10
  legacy/Unsupported bodies**; `select/async-function` moves **4 to 0** and
  Invariants remain zero. The remaining ten are exactly Calendar six and
  Builtins four.
- Deterministic tests prove pending-before-fire behavior, sequential start
  order, parallel eager fan-out plus input-order reduction, empty inputs,
  first-error rejection, duplicate-callback idempotence, and exact `main`
  phase/output behavior.
- A live direct-body poison is bypassed by the exact family while a near miss
  reaches the poison; an injected post-claim failure cannot reopen legacy.
- WAT proves native Promise/frame carriers, typed spills, direct prepared
  callee calls, native Promise.all, fused concat, native number formatting and
  output, with no host async adapter or indirect-call ladder.
- The #4573 delay benchmark and artifact metrics do not regress; the complete
  candidate is deterministic and no larger/slower than the valid comparison
  envelope after direct/direct noise controls.
- Typecheck, formatting, focused async tests, IR-only shadow, census, fallback,
  Program-ABI, issue-integrity, oracle, LOC/function-budget, stack, harness,
  dead-export, and optimization-retirement gates pass.

## Checkpoint result

The exact standalone async family is now dependency-complete on the native IR
runtime. `fetchUser`, `fetchAllSequential`, `fetchAllParallel`, and async
`main` each report `legacyBodyEmitted: false`, `irBodyEmitted: true`, and a
non-empty prepared component ID. The authoritative terminal census is **27/37
IR bodies, 10 legacy bodies, 10 typed Unsupported outcomes, and zero
Invariants**. `select/async-function` is eliminated. The ten remaining bodies
are exactly Calendar six and Builtins four.

The shared native frame and Promise runtime retain the established optimized
shape: sequential aggregation keeps its `i32` counter and `f64` total; parallel
aggregation uses the native Promise.all combinator with eager starts and
input-order reduction; `main` retains the fixed typed vector, four clock
snapshots, four specialized number conversions, two fused five-part concats,
four typed output writes, and the canonical native undefined settlement value.
Raw `main` fulfillment proves the native boundary carries **undefined tag 2**,
not **null tag 1**; this checks the value before any JS wrapper can normalize
it.
The compiled module imports only `env.__timer_set_timeout`; no host Promise,
clock, formatting, concat, console, callback, or generic closure bridge is
present. Empty Promise.all completion remains observably asynchronous.

The final tuned standalone artifact is better than the legacy-direct reference
on every frozen aggregate metric: **125,889 vs 133,307 raw bytes**, **55,276 vs
57,037 gzip-9 bytes**, **1,081,058 vs 1,197,082 WAT characters**, and **346 vs
353 functions**. Both artifacts import exactly one timer capability. The direct lane is an
artifact/optimization reference only because its async behavior is not a valid
semantic oracle.

## Validation

The #4574 focused suite passes **13/13**. Related async/provider coverage passes
**39/39**, the final host async plan suite (#4124) passes **11/11**, and the
native delay checkpoint suite (#4573) passes **12/12**. IR-only shadow
validation is non-vacuous: the exact family bypasses a live direct-body poison,
near misses still reach it, and post-claim failures cannot reopen legacy.
The final integration matrix passes strict IR-only census, fallback, issue and
issue-ID integrity, oracle, adoption, dead-export, coercion, boxing, rollback,
LOC/function, stack, harness, typecheck, formatting, and lint gates.

A final fresh-process delay guard kept the #4573 hot path decisively ahead of
its direct reference. Across three direct/IR/direct rounds, with compilation,
instantiation, and real timer waiting excluded, median IR overhead was **375.9
ns/op** versus **1,868.9 ns/op** for the pooled direct endpoints: **0.201x**, or
**79.9% less overhead**. Direct endpoint drift was **1.5–2.8%**, all 135 timed
batches produced checksum **5,788,385**, and both lanes retained exactly the
timer capability import.

## Handoff

Standalone now has ten legacy bodies: Calendar six and Builtins
four. Their remaining blockers are DOM capability/storage projection, native
Date construction/snapshots, and the resulting call-graph closure. They are
separate families and must not be widened as part of the async runtime patch.
