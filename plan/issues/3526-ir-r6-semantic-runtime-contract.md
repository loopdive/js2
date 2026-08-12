---
id: 3526
title: "IR-only R6: typed semantic runtime contract and frozen feature manifest"
status: blocked
sprint: Backlog
created: 2026-07-21
updated: 2026-08-12
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, runtime, compiler
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r6
model: gpt-5.6-sol
parent: 3518
depends_on: [3521]
required_by: [3527, 3528, 4382]
related: [1713, 2094, 2514, 2520, 2855, 2954, 2956, 3090, 3143, 3226, 3233, 3518, 3678, 4382]
origin: "#3518 R6 — replace AST-driven lazy runtime registration with typed semantic intents"
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/nodes.ts
  - src/ir/intrinsic-support.ts
  - src/ir/math-runtime-providers.ts
  - src/ir/types.ts
  - src/ir/effects.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/backend/emitter.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/late-imports.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/math-helpers.ts
  - src/codegen/stdlib-selfhost.ts
  - src/stdlib/math.ts
  - src/compiler/import-manifest.ts
  - src/runtime.ts
  - src/index.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
loc-budget-allow:
  - src/ir/integration.ts
  - src/ir/builder.ts
  - src/ir/nodes.ts
  - src/ir/lower.ts
  - src/ir/verify.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::makeResolver
  - src/ir/passes/inline-small.ts::renameInstrOperands
---

# #3526 — IR-only R6: typed semantic runtime contract and frozen feature manifest

## Objective

Establish one typed, immutable contract from prepared semantics to runtime and
host requirements:

```text
Prepared IR -> IntrinsicId -> RuntimeFeature -> HostCapability
```

The complete transitive runtime-feature manifest is computed to a fixed point
and frozen before backend lowering or function-body emission. `ImportIntent`
becomes a public projection of the final `HostCapability` set, not a string
classifier that reverse-engineers semantics from emitted import names.

R6 rewires runtime entry points family-by-family. It deletes AST dispatch and
lazy registration edges only after a typed IR intent reaches the same provider.
Runtime, builtin, scheduler, coercion, collection, regex, and host adapter
implementations remain single-sourced providers; their behavior is not deleted
with the old front-end.

## Baseline evidence and current seam

Before C0, there was no `IntrinsicId`, `RuntimeFeature`, or `HostCapability`
type. Semantics and concrete imports were discovered during emission:

- `src/index.ts:39-92` exposes a broad string-shaped `ImportIntent` union for
  math, console, extern classes, strings, builtins, callbacks, await, boxing,
  Date, Node, timers, and other families.
- `src/compiler/import-manifest.ts:8-248` infers those intents from final import
  name prefixes and a fallback `{ type: "builtin", name }`.
  `buildImportManifest` at `:251-263` walks only final `env` imports, after
  binary/WAT/declaration/helper emission in `src/compiler.ts:1080-1139`, so the
  manifest reports registration side effects rather than governing them and
  omits non-`env` semantic import namespaces.
- `src/codegen/registry/imports.ts:52-116` mutates imports, `funcMap`, and
  indices in `addImport`; host restrictions can refuse registration after a
  caller has started resolving indices.
- `src/codegen/expressions/late-imports.ts:387-406` lets expression emission
  call `ensureLateImport`. It rejects only after `ctx.indexSpaceFrozen`, whose
  contract at `src/codegen/context/types.ts:2162-2172` describes a final
  index-space freeze, not a semantic preparation freeze.
- `src/codegen/index.ts:2883-3021` and its multi-source counterpart collect
  source imports, emit deferred Math/helpers, and perform several registration
  phases before and during bodies. Single/multi paths set
  `indexSpaceFrozen` only at `:3654-3660` / `:5545-5549`, after instruction
  emission has already shaped demand.
- `src/ir/from-ast.ts:120-518` defines a large callback-rich resolver contract.
  `src/ir/integration.ts:1350-1545` implements it by reading and mutating legacy
  codegen registries for strings, externs, host globals, module bindings,
  console variants, methods, and helper names.
- `src/ir/integration.ts:777-917` preregisters and later mutates deferred
  resolver shells. Its resolver at `:1619-1964` can materialize helpers, intern
  types, create vector/dynamic layouts, Promise/exception/string support, and
  other registry state during resolution. `src/ir/lower.ts:101-304` explicitly
  advertises lazy/memoizing resolver operations.
- `src/codegen/stdlib-selfhost.ts:227-504` can build provider IR but still lowers
  and registers providers against the live codegen context, including helper
  materialization, type interning, slot allocation, and `funcMap` mutation.

The first safe semantic slice has a bounded vocabulary:

- `src/ir/select.ts:176-189` defines exactly twelve certified, exact-arity,
  proven-f64 `IR_MATH_METHOD_TABLE` specializations: five direct deterministic
  operations and seven symbolic self-host helpers.
- `src/ir/from-ast.ts` now lowers those calls to versioned semantic intrinsic
  nodes with no provider attached. Final IR preparation selects the provider
  from the frozen runtime manifest.
- `src/codegen/math-helpers.ts:71-87` emits deterministic inline/self-host Math
  providers. They are runtime substrate to retain. `Math.random` at `:89-153`
  adds host/WASI randomness and is deliberately not part of the first pure
  slice.

## Typed contract

### `IntrinsicId`

An exhaustive semantic operation identifier carried by prepared IR. It names
meaning such as deterministic `math.sqrt`, string concatenation, property get,
iterator close, Promise settle, or host-console write. It never contains a
concrete import/function index, backend representation, magic helper spelling,
AST node, or callback.

Each intrinsic has a versioned signature over `IrType`, supported target
policy, and source location at each use. Throw/allocate/suspend behavior reuses
the existing `IrEffects`/`effectsOf` authority rather than creating a second
effect table. Unknown IDs/signature mismatches are verifier failures.

### `RuntimeFeature`

A typed provider requirement selected from one or more intrinsics. Features
form an explicit dependency graph: requesting one feature may add coercion,
allocation, string, exception, iterator, scheduler, or adapter dependencies.
The graph is expanded to a deterministic fixed point before freeze. Cycles are
legal only when declared and produce one canonical provider component.

Backend-specific provider choice happens below this level. WasmGC and linear
may lower the same feature with different representations, but neither may
reinterpret source AST or invent a semantic feature during body lowering.

### `HostCapability`

The minimal external capability required after all in-module/self-host
providers are chosen. It records typed module/name/signature/permission and
mode availability. Host, strict-no-host, standalone, and WASI validate this set
before lowering. A missing capability is typed source `Unsupported` when it is
an intentional target limitation; a missing adapter for an advertised feature
is an `Invariant`.

### Projection and freeze

The immutable manifest owns sorted intrinsic uses, transitive features,
provider choices, host capabilities, imports, types, globals, literals,
helpers, exports, and backend adapter requirements. `ImportIntent` is derived
from `HostCapability` for the public compile result; non-`env` semantic imports
such as string builtins/constants receive an explicit typed projection rather
than disappearing. `classifyImport` may remain temporarily as a debug parity
oracle, but it is never production authority.

The same immutable contract exposes a stable read-only decision projection for
#4382. That public report may add source-facing explanations and #3678
diagnostics, but it cannot maintain a second support table or infer capability
from emitted helper/import names. `unknown` is the required public result when
an internal decision has not yet received a schema projection.

After freeze, resolver/import/type/global/helper registration is lookup-only.
Any lazy mutation, undeclared intrinsic, transitive feature, host import, type,
literal, helper, or slot is an R0 `Invariant`; no catch/retry or direct fallback
is permitted.

## Bounded landing sequence

### C0 — contract, fixed point, and freeze

- Define closed ID vocabularies, signatures, existing-`IrEffects` integration,
  provider dependencies,
  target policies, deterministic ordering, manifest builder, and verifier.
- Collect intrinsic uses from `PreparedIrProgram`, expand provider dependencies
  to a fixed point, choose host/self-host adapters, validate policy, allocate
  through `ProgramAbiMap`, and freeze before lowering.
- Add a legacy parity adapter that compares planned vs observed imports/helpers
  without granting authority to observed strings. Add poison seams for every
  late mutation path.

#### C0 foundation landing (2026-08-02)

The isolated schema seam now defines the exact twelve certified pure-Math
`IntrinsicId`s, their fourteen-entry transitive `RuntimeFeature` vocabulary
(including `math.atan` and `math.reduce-trig` provider dependencies), and the
deliberately empty `HostCapability` vocabulary for this host-free family.
Signatures are versioned f64 contracts; effect evidence is opaque and can only
be created through the existing `effectsOf` authority. The runtime-manifest
builder verifies intrinsic uses and provider signatures/adapters, expands
dependencies to a deterministic fixed point, requires explicit declarations
for cycles, emits canonical dependency components, and rejects both mutation
and unplanned lookup after deep freeze.

Focused anti-vacuity coverage proves all twelve methods against
`IR_MATH_METHOD_TABLE`, canonical output under reversed use/provider traversal,
the shared `pow -> exp + log`, `atan2 -> atan`, and `sin/cos -> reduce-trig`
closure, an injected declared cycle, all eight target/backend policy pairs,
zero host capabilities, provider-name independence, and typed failures for bad
IDs/signatures/effects/providers/adapters and late requests.

This landing intentionally stops before M1 routing. The exact follow-up is to
add the semantic intrinsic use to prepared IR in the sequential owner of
`nodes.ts`/`effects.ts`/`from-ast.ts`, collect it into this builder before ABI
publication, and make backend lowering resolve only the frozen provider plan.
Until that shared integration lands, the existing `Math_*` discovery and
providers remain unchanged and authoritative for production emission.

### M1 — deterministic pure Math

- Convert the exact twelve deterministic, exact-arity, proven-f64 methods in
  `IR_MATH_METHOD_TABLE` to typed intrinsic IDs: direct abs/sqrt/floor/ceil/
  trunc plus self-host sin/cos/exp/log/log2/pow/atan2. Exclude `Math.random`,
  extra/wrong arity, Symbol/dynamic/ToNumber coercion, other Math methods, and
  host state; those retain typed hybrid direct routing until their later slice.
- Make IR preparation request the semantic operation, fixed-point planning
  request any provider/helper, and lowering consume its preplanned ABI entry.
- Delete the Prepared M1 route's magic `Math_*` reference and dependency on
  text-matched AST collection/`pendingMathMethods`/live `funcMap` discovery
  after zero-direct and late-mutation tests pass. Retain selector/from-AST
  recognition, provider bodies, and legacy direct Math dispatch needed by
  non-Prepared unit kinds/coercive shapes until their migration or R9/R10.

#### M1 production landing (2026-08-02)

The exact twelve certified Math calls now enter IR as a closed, versioned
`intrinsic` instruction. AST/type lowering records only the semantic ID,
arguments, result signature, and source location. It no longer selects a Wasm
opcode or names a `Math_*` helper. The builder and verifier reject arity, type,
version, result, or callable-binding drift.

After all current middle-end passes, `prepareIrRuntimeManifest` collects the
final reachable intrinsic uses, expands and freezes their provider graph, and
attaches lookup-only provider choices before callable discovery and prepared
component sealing. Unprepared nodes are explicit dependency failures and
lowering invariants. Provider attachment is recursive and idempotent, including
nested instruction buffers and pass-created functions.

Provider behavior and existing optimizations are preserved:

- WasmGC still emits native `f64.abs`, `f64.sqrt`, `f64.floor`, `f64.ceil`, and
  `f64.trunc` instructions without boxing or calls.
- `sin`, `cos`, `exp`, `log`, `log2`, `pow`, and `atan2` still use the same
  self-hosted `Math_*` provider bodies and the same dependency helpers.
- Provider materialization is driven by the frozen manifest rather than the
  legacy pending-Math AST scan. Self-hosted provider IR uses the same manifest
  preparation recursively, so its own `Math.abs`/`floor`/`trunc` operations do
  not depend on ambient registry mutation.
- Linear IR admits exactly the five native backend operations at its legality
  boundary. The seven callable-backed operations remain fail-closed until the
  linear backend has an explicit self-host provider ABI.

Focused integration coverage proves all twelve source methods become semantic
nodes without magic helper calls, provider-free lowering fails before emission,
the frozen manifest attaches the exact five native and seven callable choices,
all twelve production bodies emit through IR with
`legacyBodyEmitted:false`, no Math host imports appear, native opcodes remain in
WAT, the established self-host helper names remain reachable, and runtime
results match the direct backend. Shadowed, coercive, wrong-arity, and
`Math.random` shapes remain outside M1.

M1 changes semantic authority but does not widen the selector, so the strict
fixed-corpus census is unchanged. The legacy direct Math route remains only for
non-Prepared shapes until their owning family slices and final R9/R10 deletion.

### Later measured family slices

Land each as an independently ratcheted child/slice, in dependency order:

1. **Scalar/coercion/value carriers:** numeric/boolean/bigint/symbol/nullish,
   boxing/unboxing, equality, conversion, dynamic tagged values, errors.
2. **String/text:** allocation, UTF encoding, concatenation, comparison,
   methods, templates, regex-facing text adapters.
3. **Callable/closures/callbacks:** direct/indirect calls, bound functions,
   host callbacks, closure environments, constructor/callable ABI.
4. **Object/property/classes:** get/set/delete/define, prototype/reflection,
   class/member/private/super semantics and dynamic objects.
5. **Collections/iterators:** arrays, typed arrays, Map/Set, iterators,
   destructuring/spread, iterator close, generators' non-async substrate.
6. **Host/DOM/Node/console/timers/linking:** ambient externs, fs/process/event
   adapters, callback imports, strict-no-host policy, WIT/link capabilities.
7. **JSON and RegExp:** parse/stringify, regex compilation/execution and host
   versus native provider selection.
8. **Promise/async scheduler:** Promise capability/reaction/settle/adoption,
   microtask/timer/async-iterator features required by #3527.

Every slice records before/after census, Prepared units, host capabilities,
provider reachability, direct emissions, and late-mutation attempts. Family
completion is structural, not a decrease in one fallback bucket.

## File ownership and locks

C0 and M1 require one owner for new intrinsic/manifest modules, the named IR
core/select/effects files, `src/codegen/declarations/import-collector.ts`,
`src/codegen/registry/imports.ts`, `src/codegen/expressions/late-imports.ts`,
the Math call/collector/provider files, `src/codegen/stdlib-selfhost.ts`, and
`src/compiler/import-manifest.ts`. Splitting the fixed-point/freeze invariant
across parallel writers is unsafe. #3525 overlaps `index.ts`, integration, and
context; land C0's new-module schema first or assign one sequential integration
owner rather than parallel-writing those shared hooks.

Later family slices may run in parallel only when their provider files and
intrinsic IDs are disjoint and C0's manifest schema is frozen. Coordinate the
Promise/iterator slice with #3527 and all backend adapter changes with #3528.

## Anti-vacuity tests

`tests/issue-3526-ir-runtime-manifest.test.ts` must prove:

1. A hand-built Prepared program produces the same sorted intrinsic/feature
   manifest under reordered maps and source traversal; fixed-point dependencies
   appear once and cycles terminate canonically.
2. Host, strict-no-host, standalone, and WASI derive the expected minimal
   `HostCapability` sets before emission. Public `ImportIntent` exactly projects
   that set and is unchanged by concrete helper spelling or function index.
3. An undeclared intrinsic, bad signature, missing provider, missing backend
   adapter, forbidden capability, or provider dependency added after freeze
   fails with the correct typed outcome before any body is published.
4. Poison `addImport`, `ensureLateImport`, type/global/helper/literal insertion,
   and resolver mutation after freeze. Prepared lowering remains green only
   when every lookup was planned.
5. M1 exercises all twelve certified direct/self-host Math entries and proves
   JS equivalence, zero Math host capability/import, canonical transitive
   provider closure, and `legacyBodyEmitted:false`. `pow -> exp+log`,
   `atan2 -> atan`, and `sin/cos -> reduce_trig` dependencies occur once;
   `Math.random` remains visibly outside M1.
6. A test-only provider-name change leaves the semantic manifest stable while
   the concrete ABI projection updates; a string-prefix classifier cannot
   become the source of truth.
7. Dead-edge reachability proves migrated Math AST dispatch is unreachable,
   while the corresponding `math-helpers.ts` provider remains reachable from a
   typed `RuntimeFeature`.
8. A locally or parametrically shadowed `Math` requests no intrinsic/provider.
   Extra/wrong arity and Symbol/dynamic coercion remain typed non-M1 cases; an
   unused provider is absent and reordered uses/maps retain canonical order.
9. Provider TypeScript IR and signatures are prepared before freeze. Poisoning
   `pendingMathMethods`, live `funcMap`, or provider/type/helper insertion during
   lowering cannot affect a Prepared M1 unit.
10. Typed projections include intentional non-`env` string import namespaces;
    they cannot vanish merely because the old manifest filtered to `env`.

Run M1 with `tests/math-inline.test.ts`, `tests/math-minmax.test.ts`,
`tests/issue-2856-builtins-component.test.ts`,
`tests/equivalence/math-builtins.test.ts`,
`tests/equivalence/math-constants.test.ts`,
`tests/equivalence/math-minmax-spread.test.ts`,
`tests/equivalence/math-pow-coercion.test.ts`,
`tests/issue-1732-math-symbol-coercion.test.ts`,
`tests/issue-2933-variadic-math-value.test.ts`,
`tests/issue-3141.test.ts`, `tests/issue-3226.test.ts`,
`tests/issue-3233.test.ts`,
`tests/host-import-allowlist-gate.test.ts`,
`tests/host-import-allowlist-budget.test.ts`, and standalone import-leak checks.

## Acceptance criteria

- [ ] Prepared IR carries typed `IntrinsicId`s whose signatures/effects are
      verified without concrete imports, indices, helper names, or callbacks.
- [ ] One deterministic fixed-point manifest maps all intrinsic uses through
      `RuntimeFeature` providers to minimal `HostCapability`s and freezes before
      backend/body lowering.
- [ ] `ImportIntent` is solely a projection of the frozen capability manifest;
      emitted-import string classification is not production authority.
- [ ] The manifest exposes deterministic decision IDs and source/provenance data
      sufficient for #4382 to generate its capability report without a parallel
      feature table or post-emission inference.
- [ ] Resolver/import/type/global/literal/helper state is lookup-only after
      freeze. Every undeclared or late request is a fatal typed Invariant.
- [ ] The exact twelve-method pure-Math M1 uses typed intents, has no legacy
      collector/name/dispatch authority on the Prepared route or Math host
      import, and retains its shared runtime providers. Coercive and not-yet-
      Prepared direct units remain explicitly outside this deletion boundary.
- [ ] Each later family lands with explicit census, target matrix, transitive
      feature closure, zero-direct evidence, and reachability/deletion proof.
- [ ] Runtime/provider behavior remains single-sourced and callable from both
      WasmGC and linear adapters; no provider is copied into IR lowering.
- [ ] IR-only, equivalence, cross-backend, import-allowlist/leak, standalone/
      WASI validity, typecheck, format, and merge-group Test262 gates are
      net-non-negative.

## Deletion boundary

R6 deletes only Prepared-route AST semantic dispatch/string inference/lazy
registration edges after a family is proven exhaustive and compile-once. Since
R6 depends only on R2, M1 does not delete global legacy `compileMathCall` or
dispatch used by Unsupported coercive forms, classes/closures/module init, or
other not-yet-Prepared owners; those survive until their migration or R9/R10.
R6 explicitly retains runtime provider implementations, coercion/collection/
regex/scheduler substrates, and backend adapters. Final general direct-
frontend deletion remains #3090/R10.

## Out of scope

- Reimplementing runtime behavior inside `src/ir/` or duplicating providers per
  backend.
- Treating concrete helper/import names as stable semantic IDs.
- Folding host capability policy into the selector or backend emitter.
- Claiming all ~47K runtime lines migrate in one unreviewable commit.

## Risks and mitigations

- **Dependency under-approximation:** one missing transitive helper appears only
  during lowering. Verify provider graphs to fixed point and poison all late
  mutation paths.
- **Provider/front-end confusion:** deletion could remove behavior rather than
  dispatch. Maintain a reachability ledger with separate FRONTEND and RUNTIME
  classifications from #3090.
- **Target leakage:** host capability may be requested in standalone/WASI.
  Validate the frozen set per mode before slots exist and run import leak gates.
- **Index/order drift:** replacing lazy discovery can reorder ABI entries.
  Canonically sort typed IDs, allocate once through `ProgramAbiMap`, and compare
  non-semantic output changes explicitly.
- **Math slice widening:** `Math.random`, dynamic coercion, or variadic calls can
  make M1 impure. Define M1 by the exact deterministic table entries and reject
  unlisted shapes until their later family slice.
