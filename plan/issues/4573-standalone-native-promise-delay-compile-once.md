---
id: 4573
title: "Standalone IR: compile the exact Promise delay through the native Promise runtime"
status: done
created: 2026-08-20
updated: 2026-08-20
priority: critical
feasibility: hard
reasoning_effort: high
task_type: refactor
area: ir, codegen, async, runtime
language_feature: Promise, closures, setTimeout
goal: ir-full-coverage
sprint: current
parent: 3527
depends_on: [4102, 4566]
assignee: ttraenkler/codex
horizon: s
lane: ir-retirement-r7-standalone
related: [1326, 1373b, 2856, 2961, 3178, 3518, 3526, 3527, 3792, 4102, 4124, 4398, 4566]
origin: "2026-08-20 standalone-only continuation from the measured 22 IR / 15 legacy / 15 Unsupported checkpoint"
files:
  - plan/audit/host-import-policy-baseline.json
  - scripts/check-host-import-policy.ts
  - scripts/ir-only-baseline.json
  - src/capability-registry.ts
  - src/codegen/closure-exports.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/ir-native-promise-delay.ts
  - src/codegen/ir-overlay-finalize.ts
  - src/compiler.ts
  - src/ir/integration.ts
  - src/ir/promise-delay-lowering.ts
  - src/runtime.ts
  - src/runtime/platform-capability-adapter.ts
  - src/runtime/standalone-timer-callback-bridge.ts
  - src/runtime/timer-capability-adapter.ts
  - src/timer-capability-contract.ts
  - tests/issue-4398-capability-registry.test.ts
  - tests/issue-4399-adapter-extraction.test.ts
  - tests/issue-4573-standalone-native-promise-delay.test.ts
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/3527-ir-r7-ast-free-async-plan.md
  - plan/issues/4401-ratchet-retire-implicit-js-host-semantics.md
  - plan/issues/4573-standalone-native-promise-delay-compile-once.md
  - plan/issues/4574-standalone-native-async-family.md
---

# #4573 — standalone native Promise-delay compile-once ownership

## Problem

After #4566, the authoritative standalone lane contains 37 terminal units,
22 IR bodies, 15 legacy bodies, 15 typed Unsupported outcomes, and zero
Invariants. Five of the residual bodies form the async playground family. Its
dependency root is the exact helper below:

```ts
export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
```

#4102 already certifies this exact source relationship and compiles it once on
the JS-host lane, but intentionally disables that plan for native-string and
standalone targets. The direct standalone backend already allocates the
in-module `$Promise` carrier and imports only the external timer capability.
IR nevertheless reports `body-shape-rejected/expr-new-type-args` and emits a
duplicate direct body. Because prepared async callers must not call an
unprepared source body, this one residual also blocks `fetchUser` and the three
transitive async terminals from standalone IR ownership.

## Scope

- Reuse #4102's exact checker-backed Promise/timer certification. Do not widen
  generic `new Promise`, nested closures, timers, or call-graph selection.
- Add a standalone projection whose final IR calls one semantic native-delay
  provider with the already-proven `f64 ms, f64 value -> Promise` relationship.
- Implement that provider over the existing native `$Promise`, settlement,
  closure-wrapper, and microtask runtime. Do not create a second Promise or
  scheduler implementation.
- Preserve executor semantics: allocate pending before scheduling; reject the
  same Promise if timer registration throws; resolve exactly once when the
  callback fires; keep concurrent calls isolated.
- Retain exactly one explicit timer platform-capability edge. This slice is
  standalone-provider-linked, not a claim that wall-clock timers are possible
  in a zero-import Wasm module.
- Leave JS-host, WASI, fast, generic Promise, and near-miss behavior unchanged.
- Delete only code whose consumer inventory reaches zero. Host #4102 still
  consumes its executor/timer closure lowering, so that implementation remains.

## Semantic and optimization parity

- Use the existing `$Promise` struct and one-shot native resolve/reject
  functions; emit no `Promise_new`, `Promise_settle_*`, `__make_callback`, or
  `__call_1_f64` host semantic import.
- Preserve the timer capability ABI already used by direct standalone:
  `env.__timer_set_timeout(externref, externref) -> externref`.
- Keep `ms` and `value` as grounded `f64` values until their single boundary
  boxing sites. Do not introduce a number box/unbox round trip in the source
  owner.
- Prefer fewer closures/calls than direct when the exact certification makes
  the executor mechanically redundant. Optimized IR must be on par with or
  better than direct by runtime and raw/gzip/WAT/body/call metrics; byte
  identity is not required.

## Acceptance criteria

- The exact standalone `delay` reports `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and a non-empty `preparedComponentId`.
- Concurrent fast/slow calls settle to their own values, timer-provider throws
  become Promise rejection through the documented foreign-error sentinel, and
  repeated callback invocation cannot settle twice. Exact foreign exception
  identity remains outside the one-import timer capability ABI.
- The import manifest has exactly one timer capability and no Promise/callback
  semantic host machinery.
- A direct-body poison is bypassed for the exact owner while an intentionally
  unsupported near miss reaches its direct poison.
- JS-host #4102 tests and provider/import shapes remain unchanged.
- Standalone readiness ratchets IR bodies 22 -> 23 and legacy/Unsupported
  bodies 15 -> 14, with `body-shape-rejected` 3 -> 2 and zero Invariants.
- IR-only family shadow validation proves the result without silently relying
  on the direct body. Fallback, type, issue, LOC/function-budget, oracle, and
  optimization-retirement gates pass.

## Checkpoint result

The exact standalone `delay` owner now emits once through IR and calls one
`__ir_promise_delay_native(f64, f64) -> externref` provider. Its terminal
outcome is Prepared with `legacyBodyEmitted: false`, `irBodyEmitted: true`, and
a non-empty component ID. The authoritative standalone census moves from
**22 to 23 IR bodies** and from **15 to 14 legacy/typed Unsupported bodies**;
`body-shape-rejected` moves from **3 to 2** and Invariants remain zero. The
JS-host lane remains 37/37 IR-owned with zero legacy bodies.

The replacement preserves the direct path's semantic and optimized contracts:

- the source owner keeps `ms` and `value` as grounded `f64` values and makes one
  direct provider call with no `call_ref`;
- the module imports only
  `env.__timer_set_timeout(externref, externref) -> externref`, authenticated as
  capability `timers@1` with the standalone `embedder` provider;
- `Promise_new`, `__call_1_f64`, `__make_callback`, generic closure-host-bridge
  exports, and the mechanically redundant executor closure are absent;
- compiled standalone instantiation fails closed unless the embedder supplies
  `deps.setTimeout`; arbitrary unregistered `env` imports still trigger the
  standalone host-import-leak diagnostic;
- timer callbacks cross a dedicated collision-safe manifest/marker/binding
  table. Only branded `setInstance` may establish authority, and the runtime
  pins the exact marker, manifest, table, and dispatcher identities. Raw own or
  donor `setExports` records, colliding source exports, and tampered metadata
  fail closed;
- start-time scheduling works before `setInstance`, external timer boundaries
  drain native Promise reactions automatically, and concurrent reverse-order
  timers plus duplicate callback invocation settle exactly once;
- a foreign timer-registration throw rejects the native Promise with a null
  boundary sentinel instead of leaking synchronously as the current direct
  standalone path does. Preserving the foreign exception object's identity
  requires a future typed error channel in the timer capability contract;
- exact direct-body poison is bypassed while certified near misses, provider
  collisions, and injected registration failures prove the negative paths.

The publication refactor keeps the native-first host-debt ratchets strict
instead of raising them for this capability. Timer set/clear binding now lives
in `runtime/timer-capability-adapter.ts`, while the authenticated one-slot
callback authority, export-view mapping, lazy dispatch, and timer-specific
microtask drain live in `runtime/standalone-timer-callback-bridge.ts`. The
generic runtime remains the lifecycle coordinator rather than owning either
implementation. Final source metrics are **17,075 / 17,100** runtime lines,
**7,216 / 7,216** `resolveImport` lines, **15 / 15** import cases, **790 / 819**
generic adapter lines, and **306 / 306** explicit timer-capability lines, with
zero native-first legacy or unknown imports.

The final frozen standalone A/B uses the exact delay source, explicit
deterministic timer callbacks, and `hostBridge: "always"` in both lanes so the
direct control is runnable. Compilation and instantiation are excluded; each
of three fresh-process direct/IR/direct rounds warms 20,000 operations and
measures 15 batches of 20,000 schedule-and-fire operations with checksum
13,160. The per-round IR/legacy-direct medians are **0.261x, 0.268x, and
0.276x**; the combined median is **0.268x**, meaning **73.2% less runtime
overhead than the legacy direct-codegen implementation** for this exact
schedule/callback/Promise-settlement workload. This excludes compilation,
instantiation, and real timer latency; it is not a whole-program speedup.
Direct endpoint controls range from 0.899x to 0.991x, and IR remains 70.9-73.1%
faster even against each round's faster direct endpoint, so the result is well
outside observed noise. A final post-integration guard repeated three fresh
direct/IR/direct processes with 20,000 warmups and 15 batches of 20,000
schedule-and-fire operations per lane. Median IR overhead was **375.9 ns/op**
versus **1,868.9 ns/op** across the pooled direct endpoints: **0.201x**, or
**79.9% less overhead**. Direct endpoint drift was 1.5-2.8%, and all 135 timed
batches produced checksum 5,788,385.

IR is also smaller than direct: **116,578 vs 118,997 raw bytes** (-2.03%),
**52,628 vs 53,244 gzip bytes** (-1.16%), **975,500 vs 1,003,141 WAT
characters** (-2.76%), and **806,327 vs 832,825 function-body WAT characters**
(-3.18%). It uses **303 vs 306 functions**, **1,393 vs 1,415 calls**, and **11
vs 34 `call_ref` sites**. Both lanes import only the exact timer capability.
The separate default host-bridge-off start-time test settles 0 -> 73 through
the authenticated timer boundary with no generic closure bridge.

## Publication validation

The focused #4573, #4398, #4102, and #3520 matrix passes 46/46 tests after the
authority/collision additions. Typecheck, Prettier, Biome, the authoritative
23/14/14/0 standalone census, IR and codegen fallback, issue integrity, issue
ID, oracle, verdict, adoption, dead-export, LOC/function-budget, coercion,
any-box, speculative-rollback, pushRaw, stack-balance, harness-budget, and
optimization-retirement gates pass. The IR-only shadow is non-vacuous: the
exact owner bypasses a live direct-body poison and a near miss proves that
poison remains reachable.

## Handoff to the remaining async family

Once this owner is prepared, the existing source-call closure may admit
`fetchUser` and then `fetchAllSequential`, `fetchAllParallel`, and async
`main`. The follow-up must project the existing prepared `IrAsyncPlan` through
the native frame mode, preserve typed spills, eager/order-correct
`Promise.all`, numeric locals, specialized number formatting and native string
concatenation/logging, and reduce the standalone census from 14 to 10 without
reopening a legacy call edge.
