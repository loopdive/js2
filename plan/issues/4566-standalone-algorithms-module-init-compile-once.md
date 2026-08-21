---
id: 4566
title: "Standalone IR: prepare Algorithms module init, fibMemo, and main before direct emission"
status: done
created: 2026-08-20
updated: 2026-08-20
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen, modules
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3523
depends_on: [4508, 4514]
assignee: ttraenkler/codex
horizon: s
lane: ir-retirement-r4-standalone
related: [1789, 3518, 3521, 3523, 3792, 4461, 4462]
origin: "2026-08-20 standalone-only continuation from the measured 22 IR / 18 legacy / 15 Unsupported census"
files:
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  - src/codegen/ir-inline.ts
  - src/codegen/program-abi-type-planning.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/passes/batch-string-concat.ts
  - src/ir/physical-ref-support.ts
  - src/ir/prepared-component-dependencies.ts
  - scripts/ir-only-baseline.json
  - plan/issues/3523-ir-r4-module-init-compile-once.md
  - tests/issue-4566-standalone-algorithms-module-init.test.ts
  - tests/issue-4566-physical-ref-support.test.ts
  - tests/issue-3523-ir-algorithms-retirement.test.ts
  - tests/issue-4514.test.ts
  - tests/ir/passes.test.ts
  - plan/issues/4566-standalone-algorithms-module-init-compile-once.md
---
# #4566 — standalone Algorithms module-init compile-once retirement

## Problem

At `origin/main` `e256ab139e0492d0dfb18c4afb36c152080430f8`, the
authoritative standalone readiness lane reports 37 terminal units, 22 IR
bodies, 18 legacy bodies, 15 typed Unsupported units, and zero Invariants.
Every Unsupported unit necessarily retains one legacy body. The remaining
three legacy bodies are all in `website/playground/examples/js/algorithms.ts`:

- `<module-init>` for `const fibCache = new Map<number, number>()`;
- `fibMemo`, which reads and writes that prepared storage; and
- `main`, whose exact local call graph reaches `fibMemo`.

All three already emit an IR overlay after their direct bodies. The only
reason they cannot compile once is that `preparedExactLexicalModuleInit`
admits the exact ordered initializer only on the JS-host/Wasm-start lane.
With no prepared storage terminal, the #4508 storage edge withdraws `fibMemo`,
then the callee edge withdraws `main` before component sealing.

This is not a selector-coverage gap and must not be solved by weakening either
storage dependency closure or prepared-component sealing. Standalone already
has IR-owned native Map, string, numeric-formatting, and console providers; the
missing step is to admit the same exact source-qualified initializer under the
standalone Wasm-start and deferred-export invocation policies.

## Scope

- Extend the existing exact lexical module-init eligibility proof to the
  `target: "standalone"`, native-string, Wasm-start and deferred-export lanes.
- Preserve every existing shape guard: one initialized top-level lexical per
  evaluation entry, exact identity/TDZ/order parity, no live seeds, no fast,
  WASI, strict-no-host override, multi-source, static, imported,
  Promise-delay, or source-function-reaching widening.
- Join `<module-init>`, `fibMemo`, and `main` to the existing dependency-complete
  prepared transaction. Do not special-case source names or bypass the #4508
  storage/callee fixed point.
- Reuse the existing preallocated module-init Program ABI callable and native
  providers. Do not add a standalone scheduler, startup wrapper, host import,
  second initializer, or post-seal fallback.
- Delete obsolete direct implementation only if consumer inventory proves it
  is unreachable globally. The shared direct module-init emitter remains live
  for the 15 Unsupported standalone terminals and wider hybrid shapes, so this
  slice is expected to delete no shared emitter.

## Semantic and optimization parity

- Wasm instantiation initializes the native Map exactly once before an export
  can observe `fibCache`.
- Deferred-export initialization keeps the TDZ guards that reject an export
  call before `__module_init`; only Wasm-start owners may elide those checks.
- Two calls to `main` retain one memo table and produce the exact established
  20-line Algorithms trace per call through the host-free stdout sink.
- The binary has zero imports and no host Map, string, number, console, or
  dynamic-object adapter.
- Preserve native Map get/set, direct recursive `fibMemo`, native numeric
  accumulators and loop counters, proven vector accesses, the `i32.shr_s`
  midpoint, specialized number-to-string, fixed-arity native concat for
  eligible expression trees, pairwise concat for loop-carried strings, typed
  stdout calls, and direct local-call targets.
- Compare optimized standalone IR against the unchanged direct control by
  observable values/output, imports, per-family WAT shape, raw Wasm bytes, and
  aggregate function/body size. IR must be on par or better; byte identity is
  not required.

## Acceptance criteria

- The exact three terminals report `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and the same non-empty `preparedComponentId`.
- All seven Algorithms terminals remain emitted through IR with zero
  post-claim errors or Invariants.
- Standalone readiness ratchets legacy bodies from 18 to 15 while retaining
  22 IR bodies, 15 typed Unsupported units, and zero Invariants. Normal
  fallback and unsupported buckets do not grow.
- A standalone direct-function and direct-module-init poison is bypassed by
  the migrated family; an intentionally unsupported initializer proves the
  poison is live.
- Runtime-by-value/output, exactly-once initialization, persistent memoization,
  zero-import, WAT optimization, IR-only family shadow, and direct-vs-IR
  size/performance parity tests pass.
- Host, WASI, and near-miss shapes retain their established routing. Deferred
  standalone initialization compiles once without acquiring the Wasm-start
  TDZ-elision proof. The host checkpoint remains byte- and behavior-stable.
- Typecheck, formatting, fallback, hybrid readiness, allocation provenance,
  issue integrity, optimization-retirement, source/function budget, and
  relevant regression gates pass.

## Checkpoint result

The final standalone checkpoint prepares the full seven-terminal Algorithms
component as one dependency-complete transaction. `<module-init>`, `fibMemo`,
and `main` now report `legacyBodyEmitted: false`; the authoritative readiness
census moves from **18 to 15 legacy bodies** while remaining at **22 IR bodies,
15 typed Unsupported units, and zero Invariants**. The JS-host lane remains
37/37 IR-owned with zero legacy bodies.

The replacement keeps the direct path's optimized shape instead of merely
matching its result:

- single-site native Map adapters are composed before their source callers,
  so `fibMemo` has the same two raw lookup calls, one hash call, zero
  `__map_get` / `__map_set` wrapper calls, and zero boxing calls as direct;
  a multi-site near miss retains the same shared-helper shape as direct;
- the module initializer contains the same zero-call native Map allocation
  shape as direct;
- number-format carrier thunks are removed under the normal inliner and remain
  present under the explicit off control;
- eligible native concat trees use fixed arity helpers up to eight operands;
  a nine-operand near miss stays pairwise and requests no unsupported helper;
- recursion, vector stores, the signed midpoint shift, typed stdout, direct
  local calls, TDZ behavior, persistent Map state, and the exact two-run output
  are all pinned by executable and WAT tests.

`JS2WASM_IR_INLINE=report` remains strictly non-mutating and therefore reports
the ordinary one-level topology rather than shadow-simulating the apply-only
Map precomposition. The emitted apply path charges the full composed body and
is guarded by the single-site/address-taken checks plus direct-shape and size
comparisons.

Final A/B evidence used exact `origin/main` `e256ab139e0`, Node 24.4.1, the
unchanged standalone Algorithms source, zero imports, and deterministic 20-line
output. Each runtime scenario used seven fresh processes with 15 A/B/A samples;
compilation, module creation, instantiation, and stdout drain were excluded.

| Standalone scenario | IR / direct | Result |
| --- | ---: | --- |
| bounded 1,024-call workload | 0.909x | IR 9.1% faster |
| fresh first call | 0.971x | IR 2.9% faster |
| fresh second call | 1.017x | on par; 1.7% is within the 5.2% control envelope |

The IR artifact is also smaller than direct: 115,406 vs 116,882 raw bytes
(-1.26%), 52,258 vs 52,489 gzip bytes (-0.44%), and 951,205 vs 958,680 WAT
characters (-0.78%). Across the relevant bodies it uses 35,221 vs 41,121 WAT
characters (-14.35%), 106 vs 114 locals (-7.02%), and 63 vs 96 calls (-34.38%),
with zero indirect calls.

## Publication validation

The checkpoint is based on latest `origin/main` `6049c004de7b539b19d11f63166dc9a408d63f5e`.
The final focused matrix passes 72/72 tests across the standalone Algorithms
component, inliner controls, IR passes, physical-reference support, and native
batched concat. Typecheck, scoped formatting/lint, strict IR-only readiness,
IR fallbacks, optimization retirement, issue integrity, oracle ratchets,
allocation provenance, LOC/function/harness budgets, codegen fallbacks,
coercion sites, adoption, dead exports, stack balance, any-box sites,
speculative rollback, and pushRaw all pass. Three `tsx` package wrappers cannot
open their IPC pipe in the isolated sandbox; their direct `node --import tsx`
forms pass, so this is an environment limitation rather than a source failure.

## Handoff

After this lands, the remaining 15 standalone legacy bodies are exactly the 15
typed Unsupported terminals: four host-surface units, three body-shape units,
three call-graph-closure units, one Date-constructor unit, and four async
functions. By example family that is six Calendar terminals, four Builtins
terminals, and five Async terminals; there are no avoidable overlay-only legacy
bodies left.

The next production slice is the complete standalone async component. Project
the exact Promise-delay closure through a native Promise/timer runtime contract
first, then let the existing prepared fixed point admit `fetchUser`,
`fetchAllSequential`, `fetchAllParallel`, and `main`. Do not weaken
source-callee closure to let prepared async call a legacy `delay` body. If a
host-free timer cannot preserve the source contract, keep the family typed
Unsupported until the runtime capability exists rather than claiming an
unprepared legacy callee.
