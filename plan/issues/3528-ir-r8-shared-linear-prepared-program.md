---
id: 3528
title: "IR-only R8: linear consumes the shared Prepared IR program"
status: blocked
sprint: Backlog
created: 2026-07-21
updated: 2026-07-21
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen-linear, compiler
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r8
model: gpt-5.6-sol
parent: 3518
depends_on: [3525, 3526, 3527]
related: [1713, 1714, 2953, 2954, 2956, 3090, 3497, 3500, 3518]
origin: "#3518 R8 — delete linear's second selector/direct frontend after shared-program parity"
files:
  - src/ir/program.ts
  - src/ir/program-abi.ts
  - src/ir/runtime-manifest.ts
  - src/ir/async-plan.ts
  - src/ir/backend/linear.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/backend/emitter.ts
  - src/ir/backend/legality.ts
  - src/codegen-linear/index.ts
  - src/codegen-linear/context.ts
  - src/codegen-linear/runtime.ts
  - src/compiler.ts
  - scripts/check-linear-ir.ts
  - scripts/linear-ir-baseline.json
  - tests/issue-3528-linear-shared-prepared-program.test.ts
---

# #3528 — IR-only R8: linear consumes the shared Prepared IR program

## Objective

Make linear lowering consume the exact same frozen `PreparedIrProgram`,
`ProgramAbiMap`, runtime-feature manifest, and `IrAsyncPlan` instances as
WasmGC. Backend choice occurs only after front-end preparation:

```text
source -> PreparedIrProgram -> WasmGC emitter
                            -> linear emitter
```

Linear may choose different value/layout/runtime providers below typed IR, but
it may not reread source AST, rerun selection/type propagation, rebuild IR,
infer a second ABI, or fall through to direct AST visitors. A source feature
unsupported by linear is a typed pre-emission backend `Unsupported`; a missing
adapter for a feature advertised as linear-capable is an `Invariant`.

## Current evidence

Linear is currently a direct frontend with an additive single-source overlay:

- `src/codegen-linear/index.ts:101-280` scans the `TypedAST` for classes,
  functions, globals, strings, and runtime needs, preassigns legacy slots, and
  then calls `compileLinearIrFunctions` at `:227`. A rejected overlay function
  immediately falls through to direct `compileFunction`.
- `src/codegen-linear/index.ts:283-438` implements multi-source separately and
  never invokes the IR overlay. It scans every source, handles entry/re-export
  names, and compiles every top-level function directly.
- Direct visitors remain the semantic frontend:
  `compileFunctionMulti` (`src/codegen-linear/index.ts:441-523`),
  `compileFunction` (`:525-625`), `compileStatement` (`:682+`), and
  exported `compileExpression` (`:1615+`), plus class/literal/call helpers in
  the same module.
- `src/ir/backend/linear-integration.ts:1-38` explicitly describes an overlay
  that independently runs `planIrCompilation`, `lowerFunctionAstToIr`, verify,
  legality, and demotes everything else to LINEAR DIRECT.
- `compileLinearIrFunctions` at
  `src/ir/backend/linear-integration.ts:156-412` accepts a
  `ts.SourceFile`, builds its own TypeMap/recursive evidence at `:192-216`,
  walks top-level `FunctionDeclaration` AST at `:218+`, runs its own fixpoint,
  constructs an `IrModule`, and catches build/lower errors into direct-path
  rejection buckets.
- The linear resolver still reads checker/AST representation and mutates
  direct-backend registries for strings, aggregate helpers, types, and runtime
  operations. `LinearIrResult` reports an overlay population, not an exhaustive
  shared-program denominator.
- `linearIrEnabled` at `src/ir/backend/linear-integration.ts:137-139` is
  default-on with `JS2WASM_LINEAR_IR=0` restoring the direct backend. Default-on
  overlay is not IR-only ownership.

The ratchet is also false-safe for retirement:

- `scripts/check-linear-ir.ts:64-89` compiles only playground examples. Its
  `try/catch` at `:68-75` swallows compilation crashes as “direct-path
  concerns.”
- The gate requires only that `compiled` not decrease (`:115-117`) and that no
  rejection bucket increase (`:118-123`). A corpus can pass with direct
  emissions, unhandled sources, multi-source AST lowering, or a permanently
  partial IR overlay.

## Shared consumer contract

The compiler prepares once, independent of target. Both backend consumers
receive immutable references to:

1. The same ordered source-unit census and R0 terminal outcomes.
2. The same `ProgramAbiMap` binding identities, semantic signatures, exports,
   globals, aliases, class shapes, module-init plan, and support-unit graph.
3. The same verified/transformed IR functions and `IrAsyncPlan`s, byte/hash
   comparable before backend adaptation.
4. The same #3526 intrinsic/runtime-feature manifest. Each backend maps features
   to its representation-specific provider and projects its minimal host
   capabilities without changing the semantic feature set.
5. Backend legality/adaptation results recorded before any body is emitted.
   Linear-only layout planning (arena, vector/string/object layouts, concrete
   `ValType`s, runtime function indices) is a deterministic lowering product,
   never input to shared preparation.

The linear consumer must accept both single- and multi-source programs through
one entry. It resolves every call/global/class/export/module-init/async edge by
structural ID and planned ABI handle. Concrete linear indices and layouts are
allocated once below the frozen ABI and cannot feed back into selection.

## Terminal outcome and gate contract

For each source/support unit and target, the R0 ledger records exactly one
backend terminal result before publication:

- `Emittable(linear)` — the shared Prepared unit and every required feature/
  async adapter are legal; emit once.
- typed `Unsupported(linear/<stable-code>)` — the source semantics are prepared
  but intentionally unavailable for linear; IR-only compilation fails with a
  source location and emits no binary/body.
- `Invariant` — missing adapter, ABI mismatch, unexpected lowering failure,
  duplicate/missing slot, or late mutation; fail in every policy.

There is no `rejected -> compileFunction`, catch-to-direct, or “no report”
state. Linear lowering is not allowed to discover a capability gap after a
body or mutable runtime registry has been published.

Replace `check:linear-ir`'s count ratchet with an exhaustive matrix gate that:

- derives its denominator from the same Prepared program ledger;
- includes single/multi-source, cross-backend, class, module-init, runtime
  family, async, standalone, WASI, fast-relevant, and validity corpora;
- requires zero unaccounted units, zero caught compile failures, zero post-
  Prepared demotions, and zero direct body emissions;
- checks that every emitted linear unit references the same shared IR/ABI/plan
  hash as the WasmGC preparation run; and
- fails, rather than updates a permissive baseline, on a newly missing adapter.

## Bounded landing sequence

### L0 — shared-program parity adapter

- Change the linear entry to accept `PreparedIrProgram` while temporarily
  retaining the old overlay as a comparison oracle only.
- Build a deterministic adapter table from IR types/instructions/intrinsics/
  async operations to linear representations and providers. Record exhaustive
  legality before emission.
- Compare shared versus independently rebuilt IR hashes on the current overlay
  population; mismatch is visible and blocks ownership.

### L1 — single-source shared ownership

- Emit every linear-supported function/class/closure/module-init unit from the
  shared program and planned ABI slots. Use #3526 feature providers and #3527
  async plans without source-AST callbacks.
- Turn remaining intentional gaps into typed pre-emission linear Unsupported.
  Remove the single-source `planIrCompilation`/`lowerFunctionAstToIr` rebuild
  and catch-to-direct route after zero-direct proof.

### L2 — whole-program multi-source and startup

- Consume #3525's same multi-source program, aliases, globals, re-exports,
  classes, ordered init, and support registry. Remove the separate direct
  `generateLinearMultiModule` semantic scan.
- Prove single-source and one-file multi-source consume identical unit/ABI/IR
  identities; prove cross-file same names and async delegation by ID.

### L3 — strict gate and AST visitor retirement

- Replace `scripts/check-linear-ir.ts` and its baseline with exhaustive
  zero-unhandled/zero-direct accounting; remove the bare catch and overlay
  compiled-count semantics.
- Poison and then delete `compileFunctionMulti`, `compileFunction`,
  `compileStatement`, `compileExpression`, class/source scanners, the second
  selector/type-propagation driver, and `JS2WASM_LINEAR_IR` only after
  reachability plus corpus proofs pass.
- Keep linear runtime/layout/emitter providers that are reached below IR.

## File ownership and locks

One developer owns `src/ir/backend/linear-integration.ts`, the new/shared linear
backend adapter, `src/codegen-linear/index.ts`, `src/codegen-linear/context.ts`,
`src/compiler.ts`, and `scripts/check-linear-ir.ts` for L0/L1. They encode the
one-consumer/no-fallback invariant and must not be split across parallel
writers.

Coordinate manifest/provider interfaces with #3526, whole-program ABI/startup
with #3525, and async plan lowering with #3527. Runtime/layout files may be
owned by disjoint follow-up slices only after the adapter contract is fixed.

## Anti-vacuity tests

`tests/issue-3528-linear-shared-prepared-program.test.ts` must prove:

1. Instrument preparation and compile the same fixture for WasmGC then linear:
   preparation runs once, both consumers receive the same object/IR/ABI/
   manifest/async-plan hashes, and backend adaptation cannot mutate them.
2. Poison `planIrCompilation`, `lowerFunctionAstToIr`, TypeMap building, source
   AST walks, `compileFunction*`, `compileStatement`, and `compileExpression`
   after preparation. Supported single- and multi-source linear fixtures still
   compile and run.
3. Every Prepared+linear-emittable unit records direct=0/IR=1. An intentional
   linear Unsupported has a stable code/span, emits no body/binary, and cannot
   be changed into success by enabling the old direct path.
4. A missing instruction/type/intrinsic/async/runtime adapter is Invariant
   before emission; a thrown compile, missing report, or caught lowering error
   fails the new gate.
5. Same-name cross-file functions/classes/globals, default/namespace/re-exports,
   closures, class members, ordered module init, and startup resolve through
   shared IDs rather than flat `funcMap` spelling.
6. A real two-suspend async function and async generator reuse the exact R7
   state/liveness/handler plan; no linear-specific async frontend exists.
7. Linear layout/provider differences do not alter semantic IR or feature
   manifest. Reordering internal maps leaves concrete output deterministic.
8. A reachability test detects any import from `typescript` or AST/source
   visitor reachable below the linear backend entry after L3, while explicitly
   allowing retained runtime/layout/emitter modules.

Run the new test with `tests/linear-ir.test.ts`, `tests/issue-2956.test.ts`,
`tests/issue-3497-linear-jsdoc-landing-signatures.test.ts`,
`tests/issue-3500-linear-ir-recursive-call-graph-type-evidence.test.ts`,
`tests/cross-backend-diff.test.ts`, and the `tests/linear-*.test.ts` suite,
plus multi-source, class, module-init, async, standalone/WASI, and Wasm validity
matrices from the R5–R7 issues.

## Acceptance criteria

- [ ] WasmGC and linear receive the same immutable `PreparedIrProgram`,
      `ProgramAbiMap`, runtime-feature manifest, and `IrAsyncPlan`s; their only
      difference begins in backend adaptation/lowering.
- [ ] Linear performs no AST/checker scan, selection, type propagation, IR
      rebuild, semantic ABI inference, or runtime-intent discovery.
- [ ] Single- and multi-source linear compilation use one shared consumer entry
      and resolve all source/support units by structural identities.
- [ ] Every supported linear unit is emitted once from IR; intentional target
      gaps fail typed/source-located before emission; missing adapters and late
      failures are fatal Invariants.
- [ ] `check:linear-ir` requires exhaustive zero-unhandled, zero-caught-error,
      zero-post-Prepared-demotion, and zero-direct-emission evidence across the
      named matrix.
- [ ] The second selector/front-end driver, `JS2WASM_LINEAR_IR` escape,
      single/multi direct function/statement/expression/class visitors, and
      catch-to-direct routes are unreachable and deleted after proof.
- [ ] Linear runtime, allocator, layout, C-ABI, string/collection, and other
      backend providers remain single-sourced below IR where still reachable.
- [ ] Cross-backend/equivalence/linear/full IR-only/typecheck/format/validity,
      standalone/WASI, and merge-group Test262 gates are net-non-negative.

## Deletion boundary

R8 deletes linear AST visitors, its second selector/type-propagation/from-AST
driver, direct fallback routing, and permissive count gate only after shared-
program and zero-direct reachability proofs pass. It retains backend emitter,
memory/layout/allocator, runtime, C-ABI, and provider code. WasmGC's remaining
general direct handlers persist until R9 makes IR-only sole policy and
#3090/R10 proves them unreachable.

## Out of scope

- Making WasmGC and linear use the same concrete representation, allocator, or
  runtime implementation.
- Rebuilding IR per target to simplify legality or layout inference.
- Treating a caught compile failure or stable nonzero rejection baseline as
  retirement evidence.
- Deleting retained linear runtime/provider code merely because its old entry
  was an AST visitor.

## Risks and mitigations

- **Semantic hash drift:** target options can leak into preparation. Serialize
  and compare the shared program before adaptation under every target.
- **Legality discovered too late:** current lowering catches failures. Build an
  exhaustive adapter/feature legality result and freeze it before any body.
- **Multi-source regression:** linear currently has a separate direct path.
  Require the R5 one-file/multi/collision/module-init matrix before deletion.
- **Runtime deletion confusion:** AST visitors and providers coexist in
  `codegen-linear`. Keep a function-level reachability classification and
  delete only the frontend side.
- **Gate denominator shrink:** removing a report can make counts appear green.
  Derive expected units from the Prepared census and fail on missing reports,
  compile catches, or unaccounted source/support units.
