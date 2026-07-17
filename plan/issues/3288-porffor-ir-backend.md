---
id: 3288
title: "Optional Porffor IR backend: prove the target-neutral JS2 linear-memory plan"
status: in-progress
created: 2026-07-16
updated: 2026-07-17
priority: high
feasibility: hard
reasoning_effort: max
task_type: architecture
area: ir, codegen-linear, backend
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: porffor-backend
depends_on: []
horizon: xl
model: gpt-5.6-sol
related: [1585, 1713, 1715, 1851, 1852, 3029, 3030, 3141, 3295, 3296, 3297, 3298, 3299, 3300]
origin: "2026-07-16 user directive: add Porffor IR as an optional backend and share JS2 linear-memory allocation strategy work"
loc-budget-allow:
  - src/ir/lower.ts
---

# #3288 - Optional Porffor IR backend over the JS2 linear-memory plan

## Objective

Lower JS2's typed SSA IR to Porffor's IR as one optional experimental backend,
while sharing JS2's linear-memory layout and allocation decisions with the
existing linear-Wasm backend.

Porffor IR targeting C is only one possible downstream path. The important
architectural result is a backend- and artifact-neutral **linear-memory plan**
that can also feed direct C, LLVM/MLIR, another native IR, or a future
linear-memory Wasm backend without redesign. Porffor is a useful proof consumer,
not the owner or limiting target of that plan.

```text
TypeScript/JavaScript
        |
        v
JS2 typed SSA IR + allocation-site provenance
        |
        v
shared LinearMemoryPlan
        |
        +--------------------+--------------------+----- ...
        |                    |                    |
        v                    v                    v
linear-Wasm backend   Porffor IR backend   future native backend
        |                    |                    |
        v                    v                    v
      Wasm              optional C         C / LLVM / MLIR / ...
```

## Current state (verified 2026-07-16)

- `src/ir/backend/contract.ts` defines the five-part backend contract:
  `TypeConverter`, `BackendLegality`, `BackendEmitter<Sink>`,
  `LayoutResolver`, and `ModuleAssembler`.
- `src/ir/lower.ts` already drives a generic emitter sink through
  `lowerIrFunctionBody<S>`, and the bytecode backend proves that the sink need
  not contain Wasm instructions. Some returned metadata and raw escape hatches
  are still Wasm-shaped and must be removed or adapted for this backend.
- `src/ir/backend/linear-integration.ts` and `src/codegen-linear/` are the live
  second consumer of the JS2 front end. The linear backend currently uses a
  bump/arena allocator and owns concrete layouts in backend code.
- The optional Porffor submodule is checked out at `vendor/Porffor`, pinned to
  commit `60a1d41d60580ff4faa38ffd5f7783d23df68bad`.
- At that commit, Porffor IR nodes are six-slot arrays
  `[kind, type, effects, a, b, c]`. Its types include `f64`, `i32`, `u32`,
  `i64`, `u64`, `jsval`, and `ptr`; its effects distinguish memory, calls, and
  globals; and its node set includes structured control flow, calls,
  `Load`/`Store`, `Alloc`, and `GcBarrier`. `compiler/render.js` consumes a
  module record containing functions, data, globals, an entry name, preferences,
  and used type IDs, then emits C.
- Porffor describes this IR-to-C path as experimental. Its internal node enum
  and module record are not a stable public API, so compatibility must be
  guarded at the pinned commit rather than assumed.

## Architectural decision

### The linear-memory plan is not a Porffor abstraction

`LinearMemoryPlan` is part of JS2's target-neutral middle end. It must be
designed from JavaScript semantics, JS2 IR facts, and allocation analyses - not
from the operations currently available in Porffor IR. Porffor-to-C is one
adapter at the edge of the architecture and may be removed, replaced, or
supplemented without changing the plan.

Adding this backend must not make C the preferred or mandatory destination for
linear-memory IR. Linear Wasm remains a first-class consumer, and future
backends may produce C directly, lower through LLVM/MLIR, emit another native
IR, or target a different linear-memory runtime.

### Share the plan, not raw backend instructions

JS2 should own a backend-neutral `LinearMemoryPlan` derived from existing IR
facts and analyses. At minimum it must describe:

- allocation-site identity and source provenance;
- allocation class: static, stack, arena, or managed heap;
- constant or dynamic size, alignment, and type/layout identity;
- field offsets, element stride, and pointer/reference maps;
- root lifetime and safepoints for managed allocations;
- whether a store requires a write barrier;
- data-segment and global-storage requirements;
- the selected allocator/runtime ABI as symbolic operations, never concrete
  function indices.

The existing linear-Wasm backend and the optional Porffor backend both consume
this plan as the initial two proofs. A future allocator policy - stack
promotion, size-class allocation, region reuse, tracing GC, or another measured
strategy - is selected once in the planner and lowered by any registered
backend.

### Keep representation-specific work below the plan

The shared plan must not contain:

- Wasm `Instr`, local indices, function indices, or block depths;
- Porffor `K.*`/`T.*` numeric enum values or six-slot IR arrays;
- a Porffor NaN-boxed `jsval` encoding;
- assumptions that the final artifact is C or that Porffor's renderer exists;
- backend runtime symbol names or C fragments.

The backends remain responsible for their concrete instructions, local naming,
module assembly, runtime calls, and final artifact format.

### Preserve JS2's memory model first

The first Porffor backend must use JS2's planned layouts and semantics, lowering
them through Porffor's low-level `ptr`, `Load`, `Store`, `MemCopy`, `Alloc`, and
`GcBarrier` nodes. It must not silently reinterpret JS2 objects as Porffor-native
objects or route operations through Porffor builtins that assume Porffor's own
layout.

Adopting Porffor's NaN-boxing, object layout, builtins, or GC wholesale is a
separate follow-up experiment. That option may ultimately reduce more runtime
code, but it changes the value ABI and must be evaluated explicitly rather than
entering through this backend adapter.

### Keep Porffor optional

Normal installation, typechecking, and tests must succeed without initializing
`vendor/Porffor`. Production `src/**` code must not statically import files from
the optional submodule.

JS2 owns a small structural compatibility layer for the Porffor IR it emits.
An optional integration test dynamically loads the pinned Porffor constructors
and renderer, verifies the schema/enum fingerprint, renders C, and fails with a
clear version-mismatch diagnostic when the pin changes incompatibly.

The Porffor adapter's first deliverable is an explicit API/tool such as
`lowerIrModuleToPorffor()` plus an IR/C artifact test. It does not add a public
`compile()` target until the proof establishes a stable output contract.

## Dispatch structure

This issue is the non-dispatchable tracking umbrella. Implementation proceeds
through one PR per dependency-ordered child issue:

| Slice | Issue                                                     | Dispatch gate        |
| ----- | --------------------------------------------------------- | -------------------- |
| P0    | #3295 - freeze the optional Porffor compatibility surface | merged (#3107/#3109) |
| P1    | #3296 - make generic lowering results non-Wasm            | #3295 and #2953      |
| P2    | #3297 - scalar/control-flow Porffor proof                 | #3296                |
| P3    | #3298 - extract shared `LinearMemoryPlan`                 | #3297 and #2956      |
| P4    | #3299 - heap/layout proof through Porffor IR              | #3298                |
| P5    | #3300 - prove allocation-policy leverage                  | #3299                |

Do not mark #3288 complete until all six child issues are merged and the
umbrella acceptance criteria below are revalidated.

## Implementation slices

### P0 - Freeze the compatibility surface

1. Record the supported Porffor node, type, effect, function, and module-record
   shapes against the pinned submodule commit.
2. Add a schema fingerprint test covering enum names/order and renderer input
   fields. A changed Porffor pin must fail locally with an actionable message,
   not produce malformed C.
3. Define the optional-loader boundary. Core builds use only JS2-owned types;
   Porffor modules are dynamically imported only by the adapter tool and
   optional integration tests.

### P1 - Make the generic lowering result genuinely non-Wasm

1. Add `porffor` to `IrBackendKind` and implement a narrow, fail-loud legality
   profile.
2. Promote the existing `TypeConverter` contract into the generic lowering
   path. `lowerIrFunctionBody<S>` currently returns Wasm-shaped `LocalDef[]` and
   `typeIdx`; the Porffor path needs backend slots, named locals, parameters,
   and return types without fabricating Wasm types or indices.
3. Close or explicitly reject every remaining `pushRaw`/`Instr[]`-only family.
   No core Porffor lowering may use `RawC` as a substitute for a real IR node.
4. Add contract-conformance coverage for the fourth backend.

### P2 - Scalar/control-flow proof

1. Implement `PorfforSink` as a structured builder with a statement list and
   expression/value stack. JS2 lowering emits operands before terminal ops;
   the sink must combine those operands into Porffor expression trees while
   preserving left-to-right evaluation and effects.
2. Implement constants, numeric conversion/arithmetic/comparison, locals,
   globals, select, structured `if`/block/loop/branch, direct calls, return, and
   unreachable. Reject all heap/reference operations in this slice.
3. Implement function/module assembly with stable symbolic names. Porffor array
   indices and renderer function positions are assigned only during final
   assembly.
4. Render the resulting module with the pinned Porffor renderer, compile the C
   with the available CI C compiler, and compare results with both JS execution
   and JS2's linear-Wasm backend.

### P3 - Extract the shared `LinearMemoryPlan`

1. Define the plan and allocator-policy interfaces above all linear-memory
   backends. Their vocabulary must remain meaningful without the Porffor
   adapter present.
2. Feed the planner from JS2 IR allocation-site IDs plus the existing escape,
   ownership, encoding, and stack-allocation analyses under `src/ir/analysis/`.
3. Move concrete size/alignment/field-offset decisions out of one-off emission
   paths where necessary. There must be one canonical plan per shape/allocation
   site, consumable by any linear-memory lowering.
4. Adapt the existing linear-Wasm backend to consume the plan. With the default
   arena policy, its emitted Wasm must remain byte-identical for programs whose
   behavior and configuration are unchanged.
5. Keep allocator/runtime operations symbolic through planning so function
   registration order cannot reintroduce the index-shift bug class covered by
   #3029's `ModuleAssembler` invariants.

### P4 - Heap/layout proof through Porffor IR

1. Lower one fixed-shape object and one dense numeric vector/array family using
   the shared plan and Porffor `Alloc`/`Load`/`Store` operations.
2. Preserve JS identity, aliasing, bounds, and mutation semantics. Include a
   test where two aliases observe the same mutation and two equal-looking
   objects remain non-identical.
3. Emit root/barrier operations from the plan. If the selected runtime policy
   is arena-only, prove why no barrier is needed; if managed, render an explicit
   `GcBarrier` and verify collection safety under stress.
4. Differentially execute the same IR through linear-Wasm and Porffor-C.

### P5 - Prove allocation-policy leverage

Implement and compare at least two policies over the same program and layout
plan:

1. the current bump/arena baseline; and
2. one non-trivial alternative justified by the existing analyses, preferably
   stack promotion for non-escaping fixed-size allocations, with managed-heap
   fallback for escaping values.

Report output size, peak memory, allocation count, and runtime on a small fixed
benchmark set. The second policy must be selected without changing either
backend's semantic emitter.

## Acceptance criteria

- [ ] A fourth backend lowers real JS2 IR through the five-part backend
      contract; there is no parallel AST-to-Porffor front end.
- [ ] Core install, build, typecheck, and non-Porffor tests pass when
      `vendor/Porffor` is absent/uninitialized.
- [ ] The pinned Porffor compatibility test validates the node enum, value
      types, effects, function record, and module record before invoking the
      renderer.
- [ ] Scalar/control-flow functions render to C, compile, and produce the same
      results under JavaScript, JS2 linear-Wasm, and Porffor-C.
- [ ] `LinearMemoryPlan` is the single owner of allocation class, layout,
      pointer-map, root, and barrier decisions consumed by the initial two
      backends without exposing Porffor or C concepts.
- [ ] Removing or disabling the optional Porffor adapter requires no changes to
      `LinearMemoryPlan`, its analyses, or the production linear-Wasm backend.
- [ ] Migrating today's linear-Wasm backend to the default plan is byte-identical
      on the established emit-identity corpus and has no conformance regression.
- [ ] The heap proof covers allocation, reads/writes, aliasing, identity, and
      vector bounds through both backends.
- [ ] At least two allocation policies consume the same plan; switching policy
      requires no changes to `LinearEmitter` or `PorfforEmitter` semantic-op
      implementations.
- [ ] Unsupported IR produces localized `porffor backend does not support ...`
      legality diagnostics before emission. No silent fallback to raw C.
- [ ] A measurement note records code size, runtime, peak memory, allocation
      count, supported IR families, and the exact Porffor commit.

## Tests and gates

- Backend contract conformance and legality unit tests.
- Porffor schema-fingerprint and renderer-input tests at the pinned commit.
- IR-node mapping tests that assert operand order and `FX` propagation.
- Three-way scalar differential tests: JS vs linear-Wasm vs Porffor-C.
- Heap alias/identity/bounds tests and managed-allocation stress tests.
- Existing `prove-emit-identity` coverage for the linear-Wasm default policy.
- Full IR/equivalence suites and merge-group conformance validation for any
  slice that changes shared planning or the production linear backend.

## Non-goals

- Reusing Porffor's parser or AST-to-IR codegen.
- Making the Porffor submodule a required install dependency.
- Making Porffor IR or C the canonical destination of JS2 linear-memory IR.
- Restricting future linear-memory consumers to Porffor's type system, node
  inventory, runtime, or artifact formats.
- Claiming Porffor-native objects are ABI-compatible with JS2 objects.
- Porting the entire Porffor builtin library in this issue.
- Replacing the WasmGC or linear-Wasm backends.
- Shipping a stable public `--target porffor` before the experimental API,
  compatibility gate, and differential proof are complete.
- Reaching full test262 parity in the first implementation. Coverage widens by
  backend-legality family after the scalar and heap proofs are sound.

## Risks

- **Unstable upstream IR:** Porffor's internal enums and module record may
  change without a compatibility promise. The commit pin and fingerprint gate
  are mandatory; updating the pin is an intentional adapter migration.
- **Value-representation mismatch:** Porffor's `jsval` is NaN-boxed and its
  `ptr` is an arena offset. JS2's linear representation must not be coerced into
  those types without an explicit ABI decision and differential tests.
- **Expression-tree effects:** Porffor embeds effects in expression nodes,
  while JS2 lowering is stack-oriented. `PorfforSink` must preserve evaluation
  order and never duplicate or reorder effectful operands.
- **Runtime ownership:** sharing allocation decisions is useful only if the
  allocator/root/barrier ABI has one owner. Backend-specific runtime helpers may
  implement that ABI, but they must not independently re-plan lifetimes.
- **False abstraction:** if the alternate policy requires emitter-specific
  special cases, the plan is at the wrong level. P5 is the proof that the shared
  boundary provides real leverage rather than merely renaming current code.

## Dependency notes

- The umbrella has no whole-issue blocker; dependency gates belong to its
  dispatchable children.
- P0 #3295 has no blocker. P1 #3296 waits for #3295 and #2953. This makes
  #2953 a generic-lowering/op-family dependency rather than a P0 dependency.
- #2956 L1 already supplies the production linear-IR precedent. Its remaining
  work gates shared-plan extraction through #3298, not #3295 through #3297.
- #3030's serialized interchange is related but not a blocker. Start in-tree
  through the backend contract so the allocation plan and legality hooks remain
  available; an out-of-tree adapter can consume serialized IR after T3/T5 land.

## Slice execution record

### P1 - backend-neutral generic lowering result (2026-07-16)

Status: complete in this PR. The umbrella remains `in-progress`; P2-P5 were not
started on this branch.

#### Acceptance status

- [x] Registered `porffor` as the fourth backend kind with a narrow legality
      allow-list and localized `porffor backend does not support ...`
      diagnostics.
- [x] Replaced the generic lowerer's Wasm-shaped function metadata with
      `IrLoweredBody<Sink, Slot>`: named parameters and locals, grouped backend
      slots, grouped result slots, and an opaque backend sink.
- [x] Moved Wasm function-type interning and local-slot flattening to the
      WasmGC and linear-Wasm adapter edges. Bytecode now supplies its own
      explicit `TypeConverter`.
- [x] Rejected `raw.wasm`, slot ops, `Instr[]`-only loop/try/await families,
      reference/heap families, and composite `js.*` arithmetic before a
      Porffor emitter can reach `pushRaw`.
- [x] Covered all four registered backend kinds in contract tests and added
      focused Porffor metadata, legality, backend-mismatch, and unsigned-local
      tests.

#### Findings

- Logical `IrType` must travel with every materialized SSA local until backend
  slot conversion. Reconstructing it from the current Wasm-facing internal
  local type loses the `signed: false` domain fact and would expose the same
  `u32`/`u64` value as signed when it is materialized, but unsigned when it is
  a parameter or result.
- The generic result no longer interns a Wasm function type. Existing WasmGC
  and linear-Wasm assembly still flatten the same one-slot values at their
  adapter edges, so the default emission layout is unchanged.
- P1 intentionally adds no Porffor sink, IR arrays, renderer import, C output,
  heap layout, or allocation plan. Those remain dependency-ordered P2-P5 work.

#### Validation

- `pnpm run typecheck` - passed.
- Direct Vitest run of `tests/issue-3288.test.ts`,
  `tests/backend-contract.test.ts`, and `tests/ir-bytecode-proof.test.ts` - 42
  tests passed.
- `pnpm run check:pushraw` - passed; 82 sites, `+0` versus the merge base.
- `scripts/prove-emit-identity.mjs` against a clean current `origin/main`
  control - all 56 `(file, target)` records identical across gc, standalone,
  WASI, and linear.
- PR #3166's first quality run passed lint, formatting, typecheck, the IR
  fallback and `pushRaw` ratchets, and linear tests, then failed only the
  change-scoped LOC ratchet because the backend-neutral metadata work grows
  its generic lowering driver by 70 lines. The issue grants that intentional
  `src/ir/lower.ts` growth without changing the shared LOC baseline;
  `last_ci_retry_head` records the handled failed head.
- Broad `tests/ir-*.test.ts` plus `tests/ir/*.test.ts` run - 419 passed and 18
  failed in existing non-P1 harness paths (string/helper initialization,
  missing host import stubs, and a stale AST-to-IR return-shape assertion); no
  Porffor metadata, backend-contract, or bytecode proof assertion failed.
- Final retry validation after merging `origin/main` at `5bae1e42a38` passed
  typecheck, the 42 focused tests, the `pushRaw` and LOC ratchets, and a fresh
  56-record emit-identity comparison against that exact main commit. The prior
  PR head `0e65d083f90` was fully green before the required main catch-up.
- PR head `0c2b1d696d8` passed every implementation, linear, equivalence, and
  test262 relevance check. Its standalone `cla-check` failed only because the
  gate's GitHub org-membership request received a transient HTTP 503; the
  recorded retry head preserves that infrastructure failure for the same-PR
  retry.
- Attempt 2 confirmed that head `f9bd48a8a8f` again failed only `cla-check`:
  GitHub returned HTTP 503 while the workflow fetched PR #3166. After merging
  `origin/main` at `6e1f780c07c`, typecheck, the 42 focused tests, the
  `pushRaw` and LOC ratchets, and a fresh 56-record emit-identity comparison
  against that exact main commit all passed. No branch-owned repair or later
  Porffor slice was needed.
- Attempt 3 confirmed that head `abbedb937d9` passed quality, linear,
  equivalence, cross-backend parity, and test262 relevance checks. Its only
  failure was again infrastructure-only: `actions/setup-node` received
  GitHub's HTTP 503 response while downloading Node 25 for `cla-check`.
  `origin/main` remained at the already-merged `6e1f780c07c`; no P1 behavior
  changed and P2-P5 remain unstarted.
- Attempt 4 succeeded on head `f314715a523`: every PR-level check passed,
  including CLA, quality, linear, equivalence, cross-backend parity, and
  test262 relevance. The branch still contains only P1, and the umbrella stays
  `in-progress` for dependency-ordered P2-P5 follow-up branches.
- Final same-PR validation merged the source-bearing `origin/main` tip at
  `048f715edb0`, then passed typecheck, the 42 focused tests, the 82-site
  `pushRaw` ratchet, the change-scoped LOC gate, and a fresh 56-record
  emit-identity comparison against a clean archive of that exact commit. A
  publication-time catch-up then merged the docs-only `fce847b1ac8` tip; it
  changed no source or test input. No branch-owned repair or P2 work was
  needed; `last_ci_retry_head` remains the recorded failed head.
- This retry found PR head `401c8eb97a5` fully green and mergeable, with no
  failing GitHub Actions checks. After merging current `origin/main` at
  `1db134ff631`, typecheck, the 42 focused tests, the 82-site `pushRaw` ratchet,
  the change-scoped LOC gate, and all 56 emit-identity records passed again.
  The prior failures remain classified as transient GitHub HTTP 503s; no P1
  source repair or later Porffor slice was required.
- The current retry found head `ad44d816d5d` fully green and already queued,
  then merged the advanced `origin/main` tip at `6fa60b00cae` as required
  before republishing. Typecheck, all 42 focused tests, the 82-site `pushRaw`
  ratchet, the change-scoped LOC gate, and all 56 emit-identity records passed
  against a clean archive of that exact main commit. No P1 source repair or P2
  work was needed; `last_ci_retry_head` remains the preserved infrastructure-
  failure audit head.
