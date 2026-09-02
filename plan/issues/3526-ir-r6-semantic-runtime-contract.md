---
id: 3526
title: "IR-only R6: typed semantic runtime contract and frozen feature manifest"
status: in-progress
sprint: Backlog
created: 2026-07-21
updated: 2026-08-30
assignee: ttraenkler/codex
branch: codex/3526-f1-s1-number-boundary
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
  - src/ir/async-runtime-providers.ts
  - src/ir/async-plan.ts
  - src/ir/nodes.ts
  - src/ir/intrinsic-support.ts
  - src/ir/extern-support.ts
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
  - src/codegen/ir-async-runtime-adapters.ts
  - src/codegen/math-helpers.ts
  - src/codegen/stdlib-selfhost.ts
  - src/stdlib/math.ts
  - src/compiler/import-manifest.ts
  - src/runtime.ts
  - src/index.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
  - tests/issue-4103-ir-async-runtime-providers.test.ts
  - tests/issue-4104-ir-async-plan-runtime-consumer.test.ts
  - tests/issue-3526-string-boundary-compare.test.ts
  - tests/issue-3526-string-boundary-schema.test.ts
loc-budget-allow:
  - src/ir/integration.ts
  - src/ir/builder.ts
  - src/ir/nodes.ts
  - src/ir/lower.ts
  - src/ir/verify.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  # 2026-08-31 F1-S1: owner-local number-boundary partition + policy projection
  # + attached-provider materialization trigger (integration.ts); the linear
  # adapter's explicit disabled number-boundary policy (linear-integration.ts).
  - src/ir/backend/linear-integration.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/intrinsic-support.ts
  - src/ir/async-runtime-providers.ts
  - src/ir/async-prepare.ts
  - src/codegen/stdlib-selfhost.ts
  - src/ir/math-runtime-providers.ts
  # 2026-09-01 F1-S2 (boolean boundary, +176 net LOC measured against
  # origin/main dcb6eba6): the `js.boolean.box` intrinsic + feature rows
  # (intrinsics.ts); the `boolean.box` capability record (the central
  # catalogue, new in F1-S1 and named here so the grant is not implicit);
  # the `booleanBoundary` policy, its provider and policy-driven selection
  # (runtime-manifest.ts); the caller policy projection, the owner-local
  # boolean partition and the widened materialization trigger
  # (integration.ts); the explicit disabled policies in the linear and
  # self-hosted-stdlib adapters. All four cited files already carry an
  # F1-S1 grant; this line records the F1-S2 rationale against it.
  - src/ir/runtime-host-capabilities.ts
  # 2026-09-01 F1-S3 (generator setReturn boxing, +294 net LOC measured against
  # origin/main 009b8127): the `generatorNumberBox` policy, its two provider
  # rows and their policy-driven selection (runtime-manifest.ts); the
  # freeze-time demand hook and the manifest-to-callable derivation
  # (intrinsic-support.ts); the caller policy projection, the owner-local
  # generator partition and the threaded attach call site (integration.ts);
  # the shared demand enumeration and the required provider parameter
  # (generator-support.ts); the retired `?? __box_number` fallback at the
  # `gen.setReturn` lowering arm (lower.ts); the explicit disabled policies in
  # the linear and self-hosted-stdlib adapters. Every cited file except
  # generator-support.ts already carries an F1-S1/F1-S2 grant; this line
  # records the F1-S3 rationale against them and adds the one new path.
  - src/ir/generator-support.ts
  # 2026-09-01 F1-S4 (boundary residuals, +265 net LOC measured against
  # origin/main 96f7a3c0): the `js.extern.is_undefined` intrinsic + feature
  # rows (intrinsics.ts); the `extern.is_undefined` capability record
  # (runtime-host-capabilities.ts); the `externIsUndefined` policy, its TWO
  # provider rows and their policy-driven selection (runtime-manifest.ts,
  # which crosses the 1500-line god-file threshold with this slice); the
  # migrated strict-undefined arm and the deleted resolver contract entry
  # (from-ast.ts); the caller policy projection, the owner-local probe
  # partition and the widened materialization trigger (integration.ts); the
  # retired `?? irRuntimeFuncRef(<spelling>)` fallbacks on all four `gen.*`
  # lowering arms (lower.ts); the explicit disabled probe policies in the
  # linear and self-hosted-stdlib adapters. Every cited path already carries
  # an F1-S1/F1-S2/F1-S3 grant; this line records the F1-S4 rationale against
  # them and adds no new path.
  #
  # 2026-09-01 F2-S1 (string.compare under manifest policy + the forof.string
  # fallback retirement, +301 net LOC measured against origin/main bee8a149):
  # the `(externref, externref) -> i32` compare signature (intrinsics.ts); the
  # `string.compare` capability record — family 2's first, and the first record
  # whose physical import is a BASE import minted by the legacy import
  # collector rather than a union or late registration
  # (runtime-host-capabilities.ts); the `stringCompare` policy, its TWO
  # provider rows and their policy-driven selection (runtime-manifest.ts); the
  # freeze-time demand hook and the manifest-to-arm derivation
  # (intrinsic-support.ts); the caller policy projection, the call-population
  # demand predicate, the owner-local compare partition and the prepared
  # manifest threaded to the resolve-time provider table in place of its
  # `ctx.nativeStrings` read (integration.ts); the retired
  # `?? irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN)` fallback on the
  # `forof.string` lowering arm (lower.ts); the explicit disabled compare
  # policies in the linear and self-hosted-stdlib adapters. Every cited path
  # already carries an F1-S1..F1-S4 grant; this line records the F2-S1
  # rationale against them and adds no new path.
  #
  # 2026-09-01 F2-S2 (capability-record schema widening, +278 net src LOC
  # measured against origin/main dc29e1f1): the kind-discriminated record
  # union — two closed id halves, per-kind module unions, the global field
  # scheme, the `ref_extern` value type, the `funcRecord`/`globalRecord`
  # factories, the six new `wasm:js-string` / `string_constants*` rows, the
  # per-kind validator arms and the shared `asCallableRuntimeHostCapabilityRecord`
  # guard (runtime-host-capabilities.ts, +239 net — the whole slice); the
  # `host-callable` capability narrowed to the func id half plus its
  # `#indexProviders` runtime twin (runtime-manifest.ts, which is over the
  # 1500-line god-file threshold and carries an F1-S1 grant); the three
  # func-assuming derivations routed through the func resolver
  # (intrinsic-support.ts); `AsyncHostAdapter` retargeted to the func arm and
  # the kind guard placed before the value-type walk
  # (async-runtime-providers.ts); the one adapter-parity guard
  # (async-plan.ts, the single new path, 1285 lines and far under the
  # threshold). This slice moves NO boundary: no provider references a new
  # row, so every frozen manifest, import and emitted body is byte-identical
  # (35/35 measured cells).
  - src/ir/async-plan.ts
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

### A1 implementation plan — frozen async capability catalog (2026-08-26)

The first dependency-safe async checkpoint is a behavior-neutral schema
consolidation. The current async provider graph closes over typed capability
IDs, but `prepareIrRuntimeManifest` later filters the module-global
`ALL_ASYNC_HOST_ADAPTERS` table again to recover the concrete import records.
That second lookup is deterministic today, yet it leaves the frozen manifest
unable to prove the exact adapter ABI consumed by the prepared async runtime.

This documentation checkpoint may land immediately. The A1 implementation is
a separate, independently reviewed PR based on fresh `main` after this plan
lands. It does not unblock production R6 routing: public `ImportIntent`
projection, import allocation, provider transactions, lazy-registration
deletion, and any new async lowering remain blocked on the #3521 migration and
the #4260 transaction boundary. Re-ground live overlap with #4976, #4980,
#4956, and #4898 before editing; do not stack an implementation on an unmerged
compiler branch.

#### Exact closed catalog

Keep `src/ir/async-runtime-providers.ts` as the sole authority for the seven
already-shipped async capability records. Promote the existing adapter objects
themselves into the typed capability catalog; do not copy their fields into a
second table:

1. `async.callback.wrap` is `env.__make_callback`, a function with
   `(i32, externref) -> externref` and exact exception policy
   `module-tag-payload`.
2. `async.promise.capability.create` is `env.Promise_new_pending`, a function
   with `() -> externref`.
3. `async.promise.react` is `env.Promise_then2`, a function with
   `(externref, externref, externref) -> externref`.
4. `async.promise.resolve` is `env.Promise_resolve`, a function with
   `(externref) -> externref`.
5. `async.promise.settle.fulfill` is `env.Promise_settle_resolve`, a function
   with `(externref, externref) -> externref`.
6. `async.promise.settle.reject` is `env.Promise_settle_reject`, a function
   with `(externref, externref) -> externref`.
7. Optional `async.value.undefined` is `env.__get_undefined`, a function with
   `() -> externref`.

The catalog is closed, canonically ordered by capability ID, and deeply frozen
through each parameter/result array. Arbitrary input traversal order is
normalized to that canonical order; non-canonical record contents are rejected.
Capability IDs stay the provider-edge currency so the runtime-feature fixed
point remains target-neutral. The frozen manifest resolves each selected ID
exactly once. Keep
`FrozenRuntimeManifest.hostCapabilities` as the sorted ID compatibility
projection and add `hostCapabilityRecords` as the correspondingly sorted exact
records consumed by prepared runtime projection. Each host
`PreparedIrAsyncHostAdapter` carries the exact selected frozen record alongside
its symbolic target, so codegen materialization receives the manifest authority
instead of reconstructing it. Missing, duplicate, unknown, or non-canonical
definitions are preparation-time invariants; no consumer may silently skip
them or refilter a different global catalog.

Do not invent `permissions`, compile-mode availability, ABI versions, digests,
or policy defaults in A1. The repository's root
`src/capability-registry.ts` has a broader permission/version contract and an
unsafe dependency direction for direct reuse here. A later checkpoint may
extract dependency-neutral primitives after the permission and compile-mode
vocabularies are designed, but A1 must neither create empty permissions as
authority nor introduce a cyclic IR-to-root registry dependency.

#### Production ownership

The implementation owns only these schema and projection seams:

- `src/ir/async-runtime-providers.ts`: define the one closed capability record
  catalog and its fail-closed ID resolver by reusing `AsyncHostAdapter` as the
  record type; do not introduce a parallel record interface. Publish an exact
  structural validator plus an identity-based canonical-record guard over the
  factory-created frozen objects. Validation rejects missing or extra keys and
  any unexpected `exceptionPolicy`, not only wrong field values. The guard may
  authenticate an attachment but must not return a second record or let
  codegen rediscover ABI fields by ID.
- `src/ir/runtime-manifest.ts`: resolve selected provider capability IDs to the
  exact records during `freeze()`, retain `hostCapabilities` as the canonical
  ID projection for provider assertions, publish the exact records as
  `hostCapabilityRecords`, and deep-freeze both views. A test-only builder
  catalog option may supply reversed or malformed records; production always
  uses the single async catalog.
- `src/ir/async-plan.ts`: extend `PreparedIrAsyncHostAdapter` with the exact
  frozen capability record selected by the manifest under required field
  `record`. Keep the existing capability ID and symbolic `IrFuncRef` as
  explicit joins; do not flatten or recopy record fields into the attachment.
- `src/ir/intrinsic-support.ts`: in the existing async adapter-selection block
  only, consume the resolved records published by the frozen manifest instead
  of filtering `ALL_ASYNC_HOST_ADAPTERS`, and attach that exact record to the
  prepared host runtime.
- `src/codegen/ir-async-runtime-adapters.ts`: remove the
  `ALL_ASYNC_HOST_ADAPTERS` catalog reconstruction. Authenticate that each
  attachment carries a canonical catalog record whose ID and import binding
  match the attachment, deduplicate by exact capability ID, sort selected
  records canonically, and derive type/import materialization only from those
  attached records. Existing imports are still byte-exactly validated and
  reused.

Do not edit `src/ir/integration.ts`, `src/ir/from-ast.ts`, lowering, backend
legality/emission, Program ABI planning, public `src/index.ts`, or
`src/compiler/import-manifest.ts`. A1 changes the internal authority consumed
by async import materialization and deliberately adds the internal `record`
field to each host runtime attachment, but changes no provider choice, target
policy, concrete import spelling/order/signature, semantic async plan, Wasm,
declaration, or public compile-result shape. The host path still materializes
exactly the existing six mandatory imports; the standalone-native path still
materializes none.

#### Anti-vacuity and mutation matrix

Keep the test ownership bounded to
`tests/issue-3526-ir-runtime-manifest.test.ts`,
`tests/issue-4103-ir-async-runtime-providers.test.ts`, and
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`.

- Prove forward and reversed feature/provider traversal publish byte-equivalent
  canonical ID and record projections. Every manifest, catalog record, and
  nested parameter/result array must be frozen.
- For the full host async feature set, require the exact six mandatory records,
  unique IDs, and the current adapter order/signatures. Requesting the optional
  undefined feature adds only its seventh exact record. Math-only and
  standalone-native manifests retain zero capability records.
- Prove the prepared host runtime's import bindings are derived from the
  manifest records and remain the exact six current `env` imports. Supply a
  poisoned or reversed catalog through the explicit test-only builder seam;
  after freeze, the published plan must remain immutable and lookup-only.
- Replace the current assertions that the entire serialized manifest omits
  concrete adapter fields. The target-neutral `IrAsyncPlan`, feature closure,
  and provider edges must remain free of module/field spellings, while the new
  `hostCapabilityRecords` projection intentionally contains the exact concrete
  ABI selected before materialization.
- Substitute, drop, duplicate, or cross-wire an attachment's record, capability
  ID, or symbolic target after preparation. The canonical attachment check in
  materialization must reject before type or import allocation. Reordering
  functions or attachments must retain canonical import order and the same
  Program-ABI dependencies.
- Reject a dropped or duplicated record; an unknown or mismatched capability
  ID; wrong module, field, kind, parameter, result, or callback exception
  policy; a provider that names an unregistered capability; an optional record
  appearing in the selected `hostCapabilityRecords` projection without a
  provider edge that requests it; and any late capability request after freeze.
  The complete closed catalog legitimately retains the optional definition
  even when no manifest selects it.
- Retain strict-no-host and missing-linear-adapter failures, scheduler features
  with no concrete capability, native-managed providers with no host
  capability, async owner/currentness failures, exact Program-ABI planning of
  the six imports, and all existing M1 Math controls.

Run `tests/issue-4106-ir-async-fetch-user.test.ts` and
`tests/issue-4167-async-rejection-identity.test.ts` unchanged as affected
regression controls; they do not widen A1 test-file ownership.

The tests must demonstrate that deleting the manifest-to-record join or
restoring either the prepared-runtime or codegen consumer-side global filter
fails. A renamed or reordered concrete adapter may affect only the
catalog-backed ABI projection; it cannot change semantic feature/provider
closure or be rediscovered from an emitted import string.

#### Landing and hold gates

Run focused tests first, then TypeScript 7 and 5, formatting, IR layering,
fallback/dialect/oracle checks, and the function and LOC regrowth ratchets. Run
the LOC ratchet again immediately before the signed commit, followed by every
normal pre-commit and pre-push hook without skips. Each heavy boundary uses a
fresh finite, non-negative one-minute load sample strictly below
`logical cores - 2` (10 cores means `< 8`). Obtain an independent read-only
audit of the exact signed head before push, open the implementation PR ready
for review, and keep production R6 routing blocked until its upstream
transactions and typed permission/mode contract are separately approved.

#### A1 implementation evidence — 2026-08-28

The bounded A1 checkpoint is implemented without opening production R6
routing. `async-runtime-providers.ts` now owns one exact, deeply frozen
seven-record catalog. Manifest freeze validates that complete catalog, resolves
each selected provider capability ID once, and publishes the corresponding
canonical record identities beside the compatibility ID projection. Prepared
host attachments retain those exact records, and codegen authenticates their
identity, capability, and symbolic binding before any type/import allocation.
ABI materialization reads only the attached records; the semantic provider
graph supplies only the expected capability-ID census, including a focused
control proving that a valid two-capability plan is not widened to all six
imports.

The three owned suites pass 26 focused tests covering reversed provider,
feature, catalog, function, and attachment traversal; full and partial provider
closure; the optional seventh record; exact record/target joins; Program-ABI
dependencies; deep freeze; and malformed, missing, duplicated, cloned,
substituted, or cross-wired catalogs and attachments. TypeScript 7 and 5,
Prettier, IR layering, IR/codegen fallback, IR dialect, and oracle ratchets pass.
The unchanged #4106 and #4167 affected controls each retain one
standalone-native `WebAssembly.validate` failure that reproduces identically on
clean `fb4c01e6ad4f00c116897d7686d5c96c31426465`; their other 13 assertions pass.
That preserved baseline is not A1 acceptance evidence, was not weakened, and
A1 makes no standalone-native runtime acceptance claim.

The checkpoint changes no provider choice, public compile result, semantic
async plan, concrete import spelling/signature/order, lowering, or Wasm policy.
The issue remains `blocked`: public import-intent projection, provider
transactions, lazy-registration deletion, and typed permission/mode authority
still require their separately approved upstream checkpoints.

### A2 implementation plan — per-owner provider and backend-requirement attachment (2026-08-28)

A1 freezes exact host capability records, but it does not yet preserve the
complete provider decision consumed by each async function. During
`prepareIrRuntimeManifest`, the implementation resolves each plan's
`runtimeIntents` to exact provider records, derives a temporary host/native
projection, and then discards those records. The global manifest is a union
across functions. Backend code consequently re-filters the global
`ASYNC_RUNTIME_PROVIDERS` catalog from `fn.asyncPlan.runtimeIntents`, and both
the adapter materializer and frame lowerer reread `runtimeIntents` to decide
whether native `undefined` support is required. A multi-function manifest can
therefore describe a strict superset of one owner's needs, while the backend
is again responsible for reconstructing the per-owner semantic choice.

A2 is a behavior-neutral authority transfer. It retains the exact selected
provider records and a closed backend-requirement projection on each prepared
async runtime, then makes both codegen consumers use only that attachment. It
does not change async selection, runtime semantics, target policy, public
`ImportIntent`, provider choice, import spelling/order/signature, Wasm output,
or runtime results. It also does not delete the existing scheduler, native
Promise, number-boundary, or canonical-undefined provider implementations;
turning those mutable registries into a fully staged transaction is a later
#4260/R6 checkpoint.

#### Closed attachment contract

Add the canonical backend requirement vocabulary:

```ts
type RuntimeBackendRequirement =
  | "async.native.drive"
  | "async.native.number-boundary"
  | "async.native.undefined";
```

The order above is canonical. Host providers project no backend requirements.
Every standalone-native async owner projects `async.native.drive` and
`async.native.number-boundary`; only an owner whose exact selected provider set
contains `native.value.undefined` also projects `async.native.undefined`.
Unknown, duplicate, missing, extra, or reordered requirements are invariants.

`FrozenRuntimeManifest` publishes `backendRequirements` as the deeply frozen,
canonical union selected by all manifest providers. `PreparedIrAsyncRuntime`
retains, for one exact owner:

- the exact frozen manifest object used for selection;
- the exact frozen `IrAsyncPlan` object it authenticates;
- the exact provider objects selected for that plan, in their canonical
  manifest order;
- the exact per-owner backend requirements; and
- the existing attached state bodies, type layouts, and host adapters.

Do not clone provider definitions into a new async catalog. Each attached
provider must be the exact object in `manifest.providers`, and each host
adapter record must remain the exact object in
`manifest.hostCapabilityRecords`. A shared IR-side validator must prove, before
any backend allocation, that the plan and manifest objects are current; the
provider feature set is exactly the plan's canonical intent set; every
provider ID, feature, dependency, implementation, target, backend, and host
capability belongs to the frozen manifest record; the per-owner requirements
are exactly the projection of those providers; and the runtime kind, adapter
set, and target policy agree. This validator owns the semantic join. Codegen
may call it but may not inspect `runtimeIntents` or a global provider catalog.
The attachment envelope, state array and state records, and every attached
state-body instruction tree must remain frozen; trusted copy-on-write passes
re-seal only the exact body they rewrote, while final consumers reject mutable
post-authentication evidence.

The global union is evidence and a freeze-time late-request guard, not
permission to widen an owner. In a two-function standalone manifest where only
one function returns `void`, the global manifest contains
`async.native.undefined`, the void owner contains it, and the non-void owner
does not.

#### Exact production ownership

The A2 implementation owns only:

- `src/ir/runtime-manifest.ts`: define and canonicalize the closed backend
  requirements; derive the frozen global union from the selected provider
  objects; and expose one shared exact projection helper.
- `src/ir/async-plan.ts`: extend the prepared runtime attachment and own its
  fail-closed plan/manifest/provider/requirement currentness validator. The
  target-neutral `IrAsyncPlan` schema and `runtimeIntents` remain unchanged.
- `src/ir/intrinsic-support.ts`: retain each owner's selected manifest provider
  objects, attach the exact plan/manifest references, and derive the per-owner
  requirement vector through the shared helper.
- `src/ir/extern-support.ts`: preserve the attachment's frozen-container
  contract when its trusted copy-on-write pass adds extern provider references
  to prepared async state bodies. This is the only post-manifest pass in A2's
  production order that otherwise returns mutable runtime/state containers;
  the final frame consumer remains fail-closed and never repairs evidence.
- `src/codegen/ir-async-runtime-adapters.ts`: delete
  `expectedHostCapabilities`, the `ASYNC_RUNTIME_PROVIDERS` import, and the
  `IrAsyncRuntimeIntent` import. Validate every function and build a complete
  allocation-free request census first; only then materialize attached host
  records or reserve the three attached native requirements. One malformed
  later function must leave imports, types, scheduler state, Promise boundary,
  and canonical-undefined state untouched.
- `src/codegen/ir-async-frame.ts`: remove the semantic-intent read. Derive
  canonical-undefined frame behavior only from the authenticated
  `async.native.undefined` attachment. The existing idempotent drive-runtime
  lookup may remain to resolve its already-reserved Promise type; it cannot
  become a fallback semantic selector.
- `tests/issue-3526-ir-runtime-manifest.test.ts` and
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`: own all A2
  attachment, mutation, allocation-boundary, and two-owner controls.

Do not edit `src/ir/async-runtime-providers.ts`, `src/ir/verify.ts`,
`tests/issue-4103-ir-async-runtime-providers.test.ts`,
`src/codegen/async-frame.ts`, `src/codegen/async-scheduler.ts`,
`src/ir/integration.ts`, `src/codegen/index.ts`, context files, public compiler
APIs, or backend emitters. The in-flight Deno integration branch owns several
of those adjacent files. Recheck open PRs and dirty Claude worktrees before
every mutation; stop rather than expanding this slice into a live owner.

#### Anti-vacuity and mutation matrix

Positive controls must cover full host, partial host, standalone non-void, and
standalone void provider projections. Reverse input function, feature, and
provider traversal and require identical frozen manifestations, per-owner
attachments, concrete imports, Program ABI dependencies, and runtime output.
Repeating structurally identical manifest preparation must publish another
current authenticated attachment rather than fail on stale object identity.
Use a two-function host control to prove each owner receives only its selected
capability records, and a two-function standalone control to prove optional
undefined support does not leak from the broader owner through the global
union. Host keeps the exact current imports; standalone keeps zero host
imports. Add a static source assertion that both codegen consumers contain
neither `runtimeIntents` nor `ASYNC_RUNTIME_PROVIDERS`.

Reject before the first allocation:

1. a dropped, duplicated, reordered, cloned, substituted, or cross-wired
   provider object;
2. provider ID, feature, dependency, implementation, supported-target,
   supported-backend, or host-capability drift;
3. a dropped, duplicated, unknown, reordered, or extra backend requirement;
4. `native.value.undefined` without `async.native.undefined`, or the
   requirement without that exact provider;
5. a host provider with native requirements, a native provider with host
   adapters, a mixed host/native owner, or a host attachment presented to a
   strict-no-host or linear-backend context;
6. a cloned/cross-wired plan or manifest, plan-intent drift, a dropped whole
   runtime attachment, a runtime without a plan, both plan and runtime authority
   dropped from an async owner, and one owner receiving another owner's broader
   provider set;
7. the existing malformed host record/target/ABI cases; and
8. a valid first function followed by a malformed second function, proving the
   materializer validates the full request census before mutating any registry.

Provider and requirement arrays, their nested provider fields, the manifest,
every prepared runtime attachment, and attached state-body instruction trees
must be frozen. Canonical reordering of input traversal may not change digests
or output; reordering an already prepared attachment is corruption and must
fail.

#### Validation and landing boundary

The signed A1 baseline is 26/26 across the runtime-manifest, async-provider,
and async-consumer suites (7 + 9 + 10). Retain those and run unchanged controls:
#2864 terminal undefined (5), #2895 async frame (8), #4574 standalone native
async family (14), #4106 async fetch user (7), and #4167 async rejection
identity (5). The last two each retain one known standalone
`WebAssembly.validate` failure from A1; compare exact current-main signatures
instead of relabelling them as A2 fixes or weakening their assertions.

Refreshed `main` at `48abcb949c9d1b539cb58472256e4545cacd9dc8` under Node
24.4.1 has a broader environment/runtime baseline than A1. In a clean detached
control with exnref disabled by Node's default, these five unchanged files total
18 passing and 24 failing tests: all five #2864 cases stop at Node compile with
`Invalid opcode 0x1f (enable --experimental-wasm-exnref)`; #2895 has three
standalone `WebAssembly.validate(...) === false` controls; #4106 and #4167 each
retain one; and all fourteen #4574 standalone-native cases retain the same
false validation result. The A2 branch must reproduce that exact membership and
failure signature with zero net drift; it may not mark those rows green, delete
them, weaken assertions, or claim them as A2 defects. The extra #4110
vector/async diagnostic likewise remains exactly 18/19 on both current main and
the A2 branch, with only its existing standalone validation row false.
The final A2 refresh to `f727d529abb40cdb63803a802b1502f91e4e9016`
changes only documentation and benchmark data, so this source/test control
membership remains the applicable final-main baseline.

The A2-owned authority tests remain independently green: require the refreshed
runtime-manifest, async-provider, and async-consumer set to pass 34/34, plus the
trusted extern-support controls 9/9. Full repository hooks and CI remain the
landing authority in their configured environment; current-main equivalence is
diagnostic evidence, not permission to bypass a hook or accept a new branch-only
failure.

No LOC or function-budget allowance is authorized. Keep every touched source
file below 1,500 lines and every function below 300 lines by extracting bounded
helpers inside the owned files. Before the signed commit and push, take a fresh
finite, non-negative one-minute load sample strictly below
`logical cores - 2`; run focused and affected tests, TypeScript 7 and 5,
formatting, IR layering/dialect/fallback/oracle/optimization gates, then LOC and
function ratchets immediately before committing. Run complete precommit and
prepush hooks without bypass. Obtain an independent read-only audit of the
signed head, and open the PR ready only when its scoped diff and required gates
are mergeable; otherwise keep it draft with the exact blocker.

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

## 2026-08-29 F1-S1 implementation plan — number-boundary intrinsics (family 1, slice 1)

**Fable lane.** Grounded on `origin/main` merged at `fe3fe11e52`. This is the
first slice of "Later measured family slices" item 1 (scalar/coercion/value
carriers). It follows the A1/A2 shape: a behavior-neutral authority transfer
with an exact ownership list, no provider-choice change, no Wasm delta on any
clean lane. Opus implements against this plan; every cited line number must be
re-located by symbol before editing.

### Measured facts (verified on the grounded tree)

- The family-1 beachhead already exists and is wired end-to-end:
  `NUMERIC_COERCION_INTRINSIC_IDS = ["js.to_uint32"]`
  (`src/ir/intrinsics.ts:51`), feature (`:98`), signature row (`:194`,
  `F64_TO_U32_INTRINSIC_SIGNATURE`), provider `backend.js.to_uint32`
  (`src/ir/runtime-manifest.ts:105`, `:324`), backend composite `"to-uint32"`
  (`src/ir/intrinsic-support.ts:37` — the composite table also carries
  `math.clz32/imul/max/min`). Copy this pattern, do not invent a parallel one.
- The number boundary is the widest un-migrated coercion carrier, and its IR
  authority is currently split across name-symbolic emission and resolver mode
  proxies:
  - **Box arm** — `coerceToExpectedExtern` (`src/ir/from-ast.ts:6929-6947`):
    f64→externref emits `emitCall(irImportFuncRef("env", "__box_number"))`
    gated on `cx.resolver?.hasHostNumberBox?.()`. Standalone has NO
    `__box_number` (its boxing is the `$AnyValue` family) so the predicate is
    false there and the arm falls through to the demote throw.
  - **Unbox arm** — the declared-f64 return coercion
    (`src/ir/from-ast.ts:8936-8948`): both lanes own `__unbox_number`
    `(externref) -> f64`; the PROVIDER choice is inlined in from-ast —
    `hasHostNumberBox()` → `irImportFuncRef("env","__unbox_number")`, else
    `hasNativeNumberUnbox()` → `irRuntimeFuncRef("__unbox_number")` (the
    native function `addUnionImports` registers under
    `semanticProviders: "native-first"`, #4461), else return unconverted.
  - The predicate implementations are one-line mode reads on the
    integration resolver: `hasHostNumberBox(): !ctx.nativeStrings`
    (`src/ir/integration.ts:4722`), `hasNativeNumberUnbox():
    ctx.targetProfile.semanticProviders === "native-first"` (`:4749`). #2955
    moved these OUT of from-ast precisely so the front-end reads no mode
    flags; F1-S1 finishes the move by making the answer a frozen-manifest
    fact instead of a live mode read.
  - These two arms are the ONLY from-ast consumers of the two predicates
    (measured: `from-ast.ts:6939`, `:8936-8938`; every other hit is doc
    text). `hasHostBooleanBox` (boolean boxing) is a separate consumer family
    and stays untouched.
  - Name-symbolic joins elsewhere in IR:
    `src/ir/compiler-timer-shim-preparation.ts:42,244-278` resolves
    `__box_number`/`__unbox_number` by `ctx.funcMap.get(name)`;
    `src/ir/async-prepare.ts:805-808` authenticates a carrier unbox by target
    NAME `"__unbox_number"`. Both are in-scope consumers of the new records
    (join by attached record, keep the name as diagnostic), IF the join is a
    mechanical substitution; otherwise record them as follow-up rows — do not
    widen.
- `prepareIrRuntimeManifest` runs at `src/ir/integration.ts:752`, after
  lowering and before prepared-component sealing (the M1 ordering), so
  provider choice at freeze-time and intrinsic emission at lowering-time is
  the established order. `IrInstrIntrinsic` (`src/ir/nodes.ts:867`) is the
  node to reuse.
- A2 already publishes `RuntimeBackendRequirement` including
  `async.native.number-boundary` for async owners — the number boundary is
  already a named backend concept; F1-S1 gives it a family-owned intrinsic
  identity for the two synchronous coercion arms.

### Contract

Add to the closed vocabularies (canonical order, versioned signatures):

- `js.number.box` — `(f64) -> externref`. Target policy: HOST-ONLY for this
  slice. A native-first/standalone request is a preparation-time typed
  `Unsupported` naming the intrinsic — exactly the population that demotes at
  the box arm today, moved to a typed reason. The `$AnyValue` standalone
  boxing family is explicitly NOT this intrinsic and NOT this slice.
- `js.number.unbox` — `(externref) -> f64`. Target policy: host AND
  native-first. Two providers, chosen at freeze exactly as the from-ast
  inline pick does today:
  - `host.js.number.unbox` → host capability record `env.__unbox_number`
    `(externref) -> f64`;
  - `native.js.number.unbox` → the union-native `__unbox_number` function
    (symbolic runtime funcref; NO host capability).
- `host.js.number.box` → host capability record `env.__box_number`
  `(f64) -> externref`.

The two host records are the FIRST non-async `HostCapability` records. Reuse
A1's record machinery (`AsyncHostAdapter`-style exact frozen records,
`hostCapabilityRecords` projection, canonical-record guards) — generalize the
record type's name if needed, but do NOT create a second record table or a
second resolver. Feature rows mirror 1:1 (the `js.to_uint32` pattern); the
callable-backed provider attachment follows the seven self-host Math
methods, not the five native-opcode ones.

### Production changes (exact ownership)

1. `src/ir/intrinsics.ts` — the two IDs, signatures, features.
2. `src/ir/runtime-manifest.ts` — the three providers, target policies, host
   capability records, freeze/verification rows.
3. `src/ir/from-ast.ts` — the two arms emit `intrinsic` nodes (id, args, f64/
   externref result, source location) with NO provider and NO predicate read.
   Delete `hasHostNumberBox`/`hasNativeNumberUnbox` from the from-ast
   resolver contract ONLY if the final trace confirms no other consumer;
   otherwise leave the contract entries and delete just these two reads.
4. `src/ir/intrinsic-support.ts` — provider attachment for the two IDs
   (callable-backed pattern); the host arm attaches its exact capability
   record, the native arm its runtime funcref.
5. `src/ir/integration.ts` — provider selection at manifest preparation from
   the target profile (the SAME `!ctx.nativeStrings` /
   `semanticProviders === "native-first"` facts, now consulted exactly once,
   at freeze); the resolver predicate implementations are deleted with their
   contract entries or left for non-from-ast callers per the trace.
6. Timer-shim and async-prepare joins per the measured-facts caveat.

Do NOT touch: legacy codegen emission of `__box_number`/`__unbox_number`
(`coerceType`, deno-api, generators-native-consumer, builtin-value-read — the
direct-route substrate stays until R9/R10), `addUnionImports` registration,
`__box_boolean`/`__box_symbol`, `__any_to_f64`/`__to_primitive`/equality
(later F1 rows), the #2108 coercion-sites gate baseline, and the public
`ImportIntent` projection.

### Behavior-neutrality obligations (each is a test)

1. **Host lane byte-parity**: fixtures whose IR bodies box (f64→externref
   argument/return) and unbox (the #4461 `Map.get` return-hit shape) compile
   byte-identically before/after — same `env` imports, same call sites.
2. **Native-first unbox parity**: the standalone `Map.get` shape still
   IR-emits and calls the union-native `__unbox_number`; runtime parity.
3. **Standalone box parity**: every shape that demotes at the box arm today
   still demotes — now as preparation-time typed `Unsupported` naming
   `js.number.box`. The strict fixed-corpus census
   (`pnpm run check:ir-fallbacks`) must be unchanged in every unintended
   bucket; a reason-string migration inside the same bucket is acceptable,
   a bucket count change is not.
4. **Freeze discipline**: a post-freeze request for either intrinsic is an
   invariant; provider substitution/duplication/cross-wiring on the
   attachment rejects before materialization (A2's mutation matrix shape).
5. **Canonicalization**: reversed traversal publishes byte-equivalent
   manifest projections; the two new records appear in
   `hostCapabilityRecords` only when a provider edge requests them —
   async-only and Math-only manifests keep their current record sets.
6. **Non-vacuity**: reverting only the from-ast arm changes (keeping the
   schema) must fail the new tests (the intrinsic path, not the old inline
   path, carries the fixtures).

### Required pre-implementation verifications (record answers in the checkpoint note)

- Full-repo trace of `hasHostNumberBox`/`hasNativeNumberUnbox` consumers
  (expected: the two from-ast arms + integration implementations only).
- The `gen.setReturn` boxing path (`from-ast.ts` ~2010, throws to legacy when
  the box helper is unresolvable): confirm whether it routes through
  `coerceToExpectedExtern` (then it is covered) or emits its own
  `__box_number` join (then it is an explicit follow-up row, not silent
  scope).
- Who guarantees the union-native `__unbox_number` exists when a prepared
  body calls it (materialization trigger for `irRuntimeFuncRef` resolution)
  — the manifest records the choice; materialization must keep its current
  owner.
- Whether `IrInstrIntrinsic` lowering for callable-backed providers already
  handles externref args/results (the Math seven are all-f64).

### Validation

Focused suite (`tests/issue-3526-ir-runtime-manifest.test.ts` ownership +
a new `tests/issue-3526-number-boundary-intrinsics.test.ts`), the M1/A1/A2
suites unchanged, `tests/issue-4106-ir-async-fetch-user.test.ts` and
`tests/issue-4167-async-rejection-identity.test.ts` as controls; typecheck;
`pnpm run check:ir-fallbacks` bare; ratchet chain bare + `LOC_GATE_BASE`
CI-base simulation; hooks without bypass. Acceptance: all six neutrality
obligations green, census unchanged, the two arms free of predicate reads.

## 2026-08-30 Sol correction — F1-S1 provider and preparation authority

The 2026-08-29 F1-S1 plan is not implementation-ready as written. This
correction is grounded on `origin/main`
`4881206ab3001505fcfca875589aff8daf375ff9` and supersedes its inaccurate
facts and incomplete ownership list. No source implementation may begin until
the overlapping Claude IR PR #5218 has merged, this branch has been rebased on
the resulting `origin/main`, and the exact-file collision census has been
repeated.

### Corrected facts and retained control paths

- Standalone does define native `__box_number` and `__unbox_number` through
  the union-native family. The current f64-to-externref Prepared arm is
  host-only by *policy* (`!ctx.nativeStrings`), not because standalone lacks a
  helper. F1-S1 must preserve that policy and may not infer support from helper
  presence.
- `RuntimeManifestPolicy` currently carries only `target` and `backend`.
  `prepareBuiltFnRuntimeManifest(...)` maps ordinary GC and GC native-first to
  the same host target, while the existing choice additionally depends on
  `nativeStrings` and `semanticProviders`. Provider selection therefore
  requires one frozen number-boundary policy projection containing those exact
  facts; target alone is insufficient. In particular, distinguish ordinary
  host-assisted GC, GC native-first, and host-assisted GC with explicit native
  strings. Do not read the live codegen context after freeze.
- Executable `hasHostNumberBox` implementations exist in integration, the
  linear adapter, and the self-hosted stdlib adapter; `hasNativeNumberUnbox`
  exists in integration. Removing the resolver contract requires updating all
  implementations, not only integration. The linear adapter must keep the new
  externref intrinsics rejected/demoted unless it receives an exact supported
  provider policy.
- `gen.setReturn` does not flow through `coerceToExpectedExtern`. It attaches a
  direct runtime `__box_number` reference through `boxProvider`; that path is a
  named control/follow-up and remains unchanged in this slice.
- `src/ir/async-prepare.ts` recognizes its exact numeric-return roundtrip as a
  raw call to `env.__unbox_number`. Once from-ast emits a provider-free
  intrinsic, that optimization would stop firing. Update this consumer
  mechanically to accept the exact intrinsic ID, version, argument, and result
  shape while retaining its existing raw-import form for legacy owners.
  `compiler-timer-shim-preparation.ts` is a different dynamic box/to-number
  family and remains unchanged unless a later exact trace proves a mechanical
  join.
- A physical union import is shared by several raw consumers. Do not replace
  its `irImportFuncRef` identity with a capability-only identity. Retain the
  canonical host-capability record as manifest authority while lowering to
  the same physical import target.

### One host-capability catalogue

Generalize the existing async-only capability authority into one central
runtime host-capability catalogue, for example
`src/ir/runtime-host-capabilities.ts`; do not add a second table.

1. The closed ID and record unions contain the existing async capabilities and
   the two number-boundary host records. Value types gain `f64` alongside
   `externref` and `i32`. Records retain canonical object identity, exact
   namespace/name/signature, and exception-policy semantics.
2. `async-runtime-providers.ts` must expose narrowed compatibility aliases and
   derive its complete async-only projection from the central table.
   `AsyncHostAdapterValueType` remains exactly `externref | i32`, and
   `AsyncHostAdapter` excludes every new f64 record. Do not re-export the
   widened central union under either async name: the existing async adapter
   materializer treats every non-i32 row as externref and would silently
   mislower f64. Existing async manifests must remain byte-for-byte and
   record-for-record unchanged.
3. `FrozenRuntimeManifest.hostCapabilityRecords` carries the generalized
   record union. Canonicalization validates the complete central catalogue,
   while an individual manifest includes only the exact records requested by
   its provider closure. Math-only, async-only, and empty manifests may not
   acquire number records.
4. No intrinsic instruction duplicates a capability record. The manifest is
   the record authority; the attached provider/target retains enough exact
   identity for verification and lowering.

### Synchronous callable provider implementations

The existing callable intrinsic plumbing is ABI-generic enough for externref,
but its provider model is not. `RuntimeProviderPlan` and
`IntrinsicRuntimeProviderImplementation` currently admit backend/self-hosted
implementations only; `providerAttachment(...)` always constructs an
`irIntrinsicFuncRef`, and provider resolution only accepts the prepared Math
index for an intrinsic target. Copying the seven Math rows is therefore not a
valid implementation.

Add two explicit synchronous callable implementation kinds:

- `host-callable`, naming an exact central host-capability ID and deriving the
  canonical physical `irImportFuncRef`; and
- `runtime-callable`, naming the exact runtime symbol and deriving the
  canonical `irRuntimeFuncRef`.

Keep the existing async `host-capability` implementation non-callable and keep
self-hosted Math unchanged. Extend intrinsic nodes/provider equality,
verification, attachment, provider observation, and lowering only as required
to recompute and authenticate these exact target kinds. A wrong capability,
wrong runtime symbol, cloned/mismatched binding, wrong signature, provider
substitution, duplicate attachment, or post-freeze request is an Invariant
before materialization. The semantic instruction identity remains the
versioned `IntrinsicId`; the physical target remains the existing import or
runtime funcref so legacy consumers and byte order do not drift.

### Exact policy and owner-local preparation

Freeze an explicit, already-resolved number-boundary provider policy per
preparation caller with the runtime manifest. Global target/mode facts are
inputs only; they are not the final policy because adapters deliberately expose
different support. The caller projections are exact:

- integration derives the current host/native truth table from its exact
  `nativeStrings` and `semanticProviders` facts;
- linear resolves both number-boundary arms disabled; and
- stdlib selfhost resolves both arms disabled, even when an ambient host
  context has `nativeStrings === false`.

Within the integration projection, preserve the current decisions exactly:

- host box and host unbox are selected only when `nativeStrings === false`;
- native unbox is selected only when
  `semanticProviders === "native-first"`; and
- all other combinations retain their current unsupported/no-conversion
  behavior. Native `__box_number` presence must not widen the box policy.

The current integration prepares one aggregate runtime manifest for all
healthy functions inside `runGlobalPreparation`; a
`provider-target-unavailable` throw consequently fails every owner. Moving a
box rejection to preparation without changing that lifecycle would turn one
owner-local demotion into `unexpected-internal-throw` for unrelated owners.
Before deleting the from-ast predicate, partition the decision by exact
terminal owner (or an equally exact component boundary):

1. determine provider-policy support before any body, slot, alias, outcome, or
   manifest prefix is published;
2. classify unavailable number-boundary policy for only the requesting
   owner/component as the existing exact outcome
   `kind:"unsupported"`, `code:"late-preparation-unsupported"`,
   `stage:"resolve"`, with a canonical detail that names the exact
   `IntrinsicId` and resolved caller policy; do not add a new outcome code;
3. remove that owner's candidate artifacts, then prepare one deterministic
   frozen manifest over the surviving owners; and
4. keep structural manifest corruption and late mutation fatal for the whole
   transaction.

The required non-vacuity is one standalone box owner beside an unrelated clean
IR owner: the box owner records Unsupported/direct exactly once, the clean
owner remains Prepared exactly once, and no failed-owner slot, alias, outcome,
or body prefix survives. Reordered owner input produces the same surviving
manifest and accounting.

### Materialization without ABI drift

Today a raw `__unbox_number` call makes preregistration invoke
`addUnionImports`, which materializes the complete canonical union family.
Replacing the call with an intrinsic would otherwise remove that trigger and
change import membership/order.

- Preserve `addUnionImports` as the physical whole-family materializer.
- After provider attachment and before body indices freeze, make
  preregistration recognize the exact host import and native runtime targets
  attached to `js.number.box`/`js.number.unbox`, then invoke the same
  materializer.
- Let the existing exact import resolver/runtime observer resolve those
  targets; do not add name scanning or a second allocator.
- Add an isolated synthetic intrinsic fixture whose only union-family trigger
  is the new attached provider. A #4461 Map fixture alone is vacuous because
  its other adapter paths already materialize the union family.
- Compare import set, order, signatures, indices, and Wasm bytes with the
  legacy control in every clean lane.

### Revised production ownership

The implementation owner may edit only the following initially approved
surface, with any expansion requiring another Sol plan amendment before edit:

- `src/ir/intrinsics.ts`
- `src/ir/runtime-manifest.ts`
- one new central host-capability catalogue
- `src/ir/async-runtime-providers.ts`
- `src/ir/nodes.ts` and the exact verifier/provider-equality consumer
- `src/ir/intrinsic-support.ts`
- `src/ir/async-prepare.ts`
- `src/ir/from-ast.ts`
- `src/ir/integration.ts`
- `src/ir/backend/linear-integration.ts`
- `src/codegen/stdlib-selfhost.ts`
- focused #3526 manifest/number-boundary tests and existing directly affected
  async/provider tests.

Do not edit `src/codegen/index.ts`, declarations, raw union registration,
compiler timer-shim preparation, timer shims, generator `setReturn`, public
import projection, or direct codegen handlers without first recording an exact
authority trace and amending this lock. No LOC/function/baseline exception is
authorized by the broad historical frontmatter list.

### Acceptance matrix and coordination gate

In addition to the earlier six obligations, acceptance requires:

- all three GC number-boundary policy combinations above, plus standalone,
  WASI, linear, and self-hosted controls;
- exact provider-attachment mutations for host/runtime crosswire, wrong
  capability/symbol/signature, duplicate, late request, and non-canonical
  capability record;
- the owner-local unsupported-plus-clean-owner transaction test;
- isolated whole-union materialization plus exact import/order/byte parity;
- the exact async-prepare intrinsic roundtrip and unchanged raw-import control;
- unchanged `gen.setReturn`, compiler timer shim, boolean/symbol/AnyValue,
  async-only, and Math-only projections; and
- bare fallback census, TypeScript 7 and 5, focused/equivalence/standalone/WASI
  tests, IR dialect/layering/readiness/oracle ratchets, LOC and function
  regrowth ratchets immediately before every commit, and complete precommit
  and prepush hooks under a finite non-negative one-minute load strictly below
  `logical cores - 2`.

This remains a blocked plan-only checkpoint while #5218 is open. Once the
overlap clears, Luna Max may implement only from the rebased, re-audited lock.
The PR stays draft until an independent Sol reviews the exact pushed head SHA
and explicitly approves provider policy, owner-local failure accounting,
canonical materialization, bytes, tests, and the no-overlap census. Only then,
if the PR is mergeable and green, may root mark it ready.

## 2026-08-31 F1-S1 implementation checkpoint — Opus lane

**Branch** `claude/issue-3526-f1s1-number-boundary`, grounded on `origin/main`
`87002f1fe4dd373e8e3c791dcd964f561e02c78e`. Implemented from the 2026-08-30 Sol
correction (which supersedes the 2026-08-29 plan wherever the two disagree).

### Coordination gate

The Sol correction blocked source implementation until Claude IR PR #5218 had
merged. **#5218 merged 2026-08-31T01:32:04Z** (`feat(ir): nested-vec element
carrier + destructuring for-of heads`), so the gate is clear. The branch is
based on post-#5218 `main`; per project convention `main` is merged in, never
rebased. Exact-file collision census against the grounded tree: no open work
overlaps the eleven owned files.

### Required pre-implementation verifications (answers)

1. **Full-repo trace of `hasHostNumberBox` / `hasNativeNumberUnbox`.** The Sol
   correction is right and the 2026-08-29 plan was not.
   - `hasHostNumberBox` had **two** from-ast reads (`coerceToExpectedExtern`
     f64→externref box arm; `coerceReturnValue`'s externref→f64 provider pick)
     and **three** executable implementations —
     `integration.ts` (`!ctx.nativeStrings`),
     `backend/linear-integration.ts` (`false`), and
     `codegen/stdlib-selfhost.ts` (`false`).
   - `hasNativeNumberUnbox` had **one** from-ast read (the same unbox arm) and
     **one** implementation (`integration.ts`,
     `semanticProviders === "native-first"`).
   - Everything else in the tree was doc prose. All reads, both contract
     entries, all four implementations and every dangling prose reference are
     deleted; `hasHostBooleanBox` is untouched.
2. **`gen.setReturn`.** Confirmed it does **not** route through
   `coerceToExpectedExtern`. `generator-support.ts` attaches a direct
   `irRuntimeFuncRef("__box_number")` through `gen.setReturn`'s own
   `boxProvider`, which `lower.ts` reads (`instr.boxProvider ?? irRuntimeFuncRef
   (...)`). It is a named control and is unchanged in this slice — a follow-up
   row, not silent scope.
3. **Who guarantees the union-native `__unbox_number` exists.**
   `preregisterDynamicSupport` (`integration.ts`) is the trigger and remains the
   owner: `usesNamedUnionImport` (an `env.*` union member) and
   `usesRuntimeUnboxNumber` (a runtime `__unbox_number`) each call
   `addUnionImports(ctx)`, the whole-family materializer. Its detector used to
   key on `call` instructions only, so the migration would have removed the
   trigger. It now also recognizes the **exact attached provider target** of
   `js.number.box` / `js.number.unbox`. This is safe because
   `prepareBuiltFnRuntimeManifest` (provider attachment) runs at the top of the
   preparation sequence and `preregisterDynamicAndForInSupport` runs later in
   the same sequence — attachment always precedes the trigger, and both precede
   any Phase-3 body that could bake a funcidx. No name scanning and no second
   allocator were added. Measured result: **import set and order are identical
   in every lane, before and after.**
4. **Callable-backed intrinsic lowering with externref args/results.**
   `emitPreparedIntrinsic` (`lower.ts`) is already ABI-generic for the callable
   arm — it emits the operands and then
   `emitter.emitCall(resolver.resolveFunc(instr.provider.target))`, with no f64
   assumption; typing flows through the ordinary `IrType` → ValType converter.
   No lowering change was needed. What was **not** generic was the provider
   model, exactly as the Sol correction says: `providerAttachment` always built
   an `irIntrinsicFuncRef`, and provider resolution admitted only the prepared
   self-hosted Math index. Hence the two new implementation kinds.

### What landed

- **`src/ir/runtime-host-capabilities.ts` (new)** — the one central
  host-capability catalogue: closed ID union (seven async + `number.box` /
  `number.unbox`), value types widened to `externref | i32 | f64`, canonical
  object identity, exact-ABI validation, catalogue canonicalization and
  fail-closed resolution.
- **`src/ir/async-runtime-providers.ts`** — derives its async-only projection
  from that table (the *same* frozen objects, so identity guards accept either
  view). `AsyncHostAdapterValueType` stays exactly `externref | i32` and
  `asAsyncHostAdapter` is a **checked** narrowing, not a cast, so no f64 row can
  reach the async adapter materializer (which maps every non-`i32` row to
  externref and would mislower it).
- **`src/ir/intrinsics.ts`** — `js.number.box` `(f64) -> externref` and
  `js.number.unbox` `(externref) -> f64`, versioned, with 1:1 feature rows.
- **`src/ir/runtime-manifest.ts`** — `host-callable` / `runtime-callable`
  implementation kinds; the three providers; the explicit `numberBoundary`
  policy on `RuntimeManifestPolicy`, canonicalized at construction and published
  on the frozen manifest; policy-driven selection whose unavailable arm is a
  typed `provider-target-unavailable` naming the intrinsic and the resolved
  policy.
- **`src/ir/intrinsic-support.ts`** — attachment derives the canonical physical
  `irImportFuncRef` from the exact capability record (host arm) or the canonical
  `irRuntimeFuncRef` (native arm); verification admits a physical target only
  when the closed provider catalogue names it for that intrinsic.
- **`src/ir/from-ast.ts`** — both arms emit provider-free intrinsics and read no
  lane fact; both resolver contract entries deleted.
- **`src/ir/integration.ts`** — the caller-resolved policy projection; the
  owner-local unsupported partition; the materialization trigger.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both arms explicitly disabled.
- **`src/ir/async-prepare.ts`** — the exact numeric-return roundtrip is
  recognized in its intrinsic form (provider-free, since async preparation runs
  before manifest freeze) **and** its existing raw-import form.

### Divergences from the plan (recorded, not widened)

1. **Host-lane byte-parity is not literal byte-identity — measured, and it is a
   consequence of the plan's own design.** A semantic `intrinsic` is *pure*
   under the existing `effectsOf` authority, while the opaque `call` it replaces
   was not. `lower.ts`'s effects-aware emission scheduler therefore stops
   anchoring the boxed/unboxed value into a local and emits it lazily at its
   consumer. Measured over 5 fixtures × 5 lanes (25 cells) before/after:
   - **22 cells byte-identical**, including every standalone, WASI,
     native-strings and linear cell;
   - **3 gc-host cells shrink** (283→273, 626→614, 990→976 bytes). The full WAT
     diff on those cells is *only* removed `(local $$irN externref)` declarations
     and the resulting local renumbering: identical instruction sequence,
     identical call targets, identical `env` import set **and order**, identical
     runtime results (the `Map`-memo fixture returns 15181 both ways).
     Preserving the old bytes would require classifying these two intrinsics as
     impure — i.e. a second, per-ID effect table, which R6 forbids and which
     would also be untrue (`__box_number` allocates a fresh object;
     `__unbox_number` reads a primitive).
   - Follow-up worth naming: purity is correct **at the two producing sites**,
     where the operand is a proven-numeric carrier. A future producer that could
     hand `js.number.unbox` an object with a user `valueOf` would need the
     effect question re-opened.
2. **`RuntimeManifestPolicy.numberBoundary` is optional in the type**, defaulted
   to `NUMBER_BOUNDARY_POLICY_DISABLED` and canonicalized at builder
   construction; all three production callers pass it explicitly, so every
   frozen manifest publishes an explicit resolved policy. This keeps the
   fail-closed default without churning unrelated manifest tests.
3. **`src/ir/math-runtime-providers.ts` edited (one expression), outside the Sol
   ownership list.** Authority trace: `materializePreparedMathProviders`
   projected Math method names as `use.id.slice("math.".length)` over **every**
   intrinsic use. With a number-boundary use in the same manifest that yields
   `"js.number.box".slice(5)` → `"mber.box"` handed to the Math emitter. The
   projection now filters on the `math.` prefix. This is a required consequence
   of the approved change, not a scope expansion; recorded here rather than
   silently absorbed.
4. **The `gc-native-strings` unsupported-unbox population changes outcome code,
   not outcome.** Shapes that previously returned the unconverted externref and
   demoted at the verifier as `return-type-legacy-coupling` / `verify` now
   demote in preparation as `late-preparation-unsupported` / `resolve`, per the
   Sol correction's step 2. Both demote to legacy and **the emitted bytes are
   identical** (measured: `MAPGET` and `MIXED` on `gc-native-strings` are
   byte-identical before and after). The strict fixed-corpus census
   (`pnpm run check:ir-fallbacks`) is **unchanged, output-identical**, with all
   unintended, module-level and post-claim buckets still empty.

### The async-prepare join needed the resolved policy, not a shape match

The Sol correction called the `async-prepare` numeric-return roundtrip a
*mechanical* substitution. It is not, and CI proved it: the standalone IR
cutover corpus failed with `compile/async expected derivedUnitCount=12,
observed 11`.

Cause: before this slice, from-ast emitted `env.__unbox_number` on the host lane
and the union-native runtime symbol on native-first, so `async-prepare`'s
raw-import match **also encoded "this is a host owner"** — and the elision is
only validated against the host Promise ABI. A provider-free intrinsic carries
no lane fact (freeze runs after async preparation), so a plain shape match is
not equivalent to what it replaced. Both naive options were measured and both
change behaviour:

| approach | standalone cutover corpus | host (#4106) |
| --- | --- | --- |
| match the intrinsic unconditionally | **FAIL** — derived 18/19, elision fires where it never did | pass |
| match only the raw-import form | pass — derived 19/19 | **FAIL** — resume function regains the unbox call |

Resolved by threading the caller's **already-resolved** `NumberBoundaryPolicy`
— the same frozen fact manifest freeze consumes — from `compileIrPathFunctions`
through `prepareSuspendingAsyncLowering` into `prepareSingleAwaitIrFunction`.
The intrinsic form is admitted iff `unbox === "host"`, which is exactly the
population the import form matched. Both lanes are now neutral: corpus
`derived=19/19`, #4106 green. The parameter defaults to
`NUMBER_BOUNDARY_POLICY_DISABLED`, so an uninformed caller keeps its
continuation rather than silently eliding.

This is the one place where F1-S1's goal (a lane-free front-end node) and an
existing consumer genuinely conflict; the policy hand-off is the narrow fix. A
cleaner long-term home is a post-freeze pass that reads the attached provider.

### `check:ir-kind-neutrality` baseline refresh

The `quality` lane initially failed on `check:ir-kind-neutrality`. **This was
caused by this change-set**, not pre-existing: the gate passes with exit 0 on a
clean `origin/main` worktree (an earlier stash-based check wrongly suggested
otherwise, and the wrong conclusion was reported before the worktree
measurement corrected it).

The cause is line-number drift in the baseline's `evidence` citations — this
slice's edits moved three cited lines. No verdict, kind, placement, ratchet
count or `settledBy` rationale changed:

| kind | cited file | before → after |
| --- | --- | --- |
| `forof.string` | `src/ir/integration.ts` | 6001 → 6054 |
| `string.len` | `src/ir/backend/linear-integration.ts` | 1611 → 1614 |
| `vec.new_fixed` | `src/ir/from-ast.ts` | 4562 → 4542 |

Refreshed per the gate's own instruction (`--update-on-decrease`, then commit
the baseline diff for review). The three citations plus the `generated` date
were patched surgically rather than committing the regenerator's output, which
reflows every array and would have buried a 4-line semantic change in a
356-line formatting diff. This is the gate's documented refresh flow and is
distinct from `scripts/loc-budget-baseline.json`, which remains main's alone.

### Not touched (per the lock)

`src/codegen/index.ts`, declarations, raw union registration (`addUnionImports`
itself), `compiler-timer-shim-preparation.ts` (a different dynamic
box/to-number family — no mechanical join proven), timer shims, generator
`setReturn`, `__box_boolean` / `__box_symbol` / `$AnyValue`, the `#2108`
coercion-sites baseline, the public `ImportIntent` projection, and every direct
codegen `__box_number` / `__unbox_number` handler.

## 2026-09-01 F1-S2 implementation plan — boolean-boundary intrinsic (family 1, slice 2)

**Fable lane.** Grounded on `origin/main` at `e0b46482fd` (post-F1-S1 merge
PR #5364, post-gap-4 merge PR #5367). Opus implements against this plan. This
slice migrates the LAST resolver-mode predicate at the from-ast externref
coercion boundary — `hasHostBooleanBox` — onto the F1-S1 machinery, which now
exists on main and is the template: mirror it, do not re-derive it.

### Measured facts (verified on the grounded tree)

- **One from-ast read.** `src/ir/from-ast.ts:7227-7241`: the boolean-branded
  i32 → externref arm (`got.kind === "i32" && got.boolean === true`) is gated
  on `cx.resolver?.hasHostBooleanBox?.() === true` and emits a direct
  `emitCall(irImportFuncRef("env", "__box_boolean"), [value], externref)`.
  When the predicate is false the arm FALLS THROUGH to the typed
  `operand-coercion-unsupported` build throw below it (designed
  non-claimability → legacy fallback, the #3553 comment).
- **Three resolver implementations**, exactly the pre-F1-S1 number shape:
  `src/ir/integration.ts:5666` (`!ctx.nativeStrings`),
  `src/ir/backend/linear-integration.ts:1537` (`false`),
  `src/codegen/stdlib-selfhost.ts:190` (`false`). Contract entry at
  `from-ast.ts:421`, prose at `:365`. No other executable read exists —
  pre-implementation verification 1 re-proves this.
- **Box arm only.** There is NO `hasNativeBooleanUnbox` and no unbox arm; the
  integration comment states the boolean capability "has no widening
  follow-up". F1-S2 therefore mints ONE intrinsic, not a pair.
- **ABI** `(i32) -> externref` — confirmed by both `ensureLateImport` sites
  (`array-object-proto.ts:1451`, `array-prototype-borrow.ts:502`).
- **Union-import trigger.** `__box_boolean` ∈ `UNION_IMPORT_FUNC_NAMES`
  (`integration.ts:7244`). The F1-S1 attached-target recognizer
  (`integration.ts:7410-7428`) filters on
  `i.id === "js.number.box" || i.id === "js.number.unbox"` before the
  membership check — the migration removes the raw `call` this detector
  otherwise keys on, so the id filter must admit `js.boolean.box`. The
  membership check itself already covers `__box_boolean`; no other edit.
- **F1-S1 machinery to mirror** (all on main): intrinsic rows + feature rows
  (`intrinsics.ts:60/116/234`), the central capability catalogue
  (`runtime-host-capabilities.ts` — closed ID union currently seven async +
  `number.box`/`number.unbox`), provider definitions and policy-driven
  selection (`runtime-manifest.ts:77-102` policy type, `:410-474` providers,
  `:895-898` canonicalization, `:1184` selection), the owner-local
  unsupported partition (`integration.ts:3481-3493`,
  `unsupportedNumberBoundaryIntrinsic`), and the caller policy projections
  (`integration.ts:829`, `linear-integration.ts:666`,
  `stdlib-selfhost.ts:499`).

### Contract

1. **Intrinsic.** `js.boolean.box` `(i32) -> externref`, versioned, 1:1
   feature row, added beside the number rows (a `BOOLEAN_BOUNDARY_*` sibling
   of `NUMBER_BOUNDARY_INTRINSIC_IDS` / `NUMBER_BOUNDARY_RUNTIME_FEATURES` —
   do not widen the number constants).
2. **Capability.** One record `boolean.box` → `env.__box_boolean`
   `(i32) -> externref` in the central catalogue
   (`runtime-host-capabilities.ts`), same exact-ABI validation and canonical
   identity as the number rows. The async projection must remain unable to
   see it only if its value union would mislower it — an `i32`-typed row IS
   admissible under `AsyncHostAdapterValueType`, so the async-only projection
   must filter by the async ID set, not by value type alone (pre-impl
   verification 2 proves the seven-ID filter already does this).
3. **Policy.** `booleanBoundary: { box: "host" | "unsupported" }` on
   `RuntimeManifestPolicy`, optional in the type, defaulted to a frozen
   `BOOLEAN_BOUNDARY_POLICY_DISABLED`, canonicalized at builder construction,
   published resolved on the frozen manifest — the exact `numberBoundary`
   pattern. All three production callers pass it explicitly:
   integration projects `{ box: !ctx.nativeStrings ? "host" : "unsupported" }`
   (the exact former truth table); linear and self-hosted-stdlib pass
   disabled. Host arm resolves through the existing `host-callable` provider
   kind to the SAME physical target `env.__box_boolean`; there is no
   runtime-callable arm (no native boolean boxer exists).
4. **from-ast.** The branded-i32 type gate stays (it is a type fact); the
   resolver predicate read is deleted (it is a lane fact); the arm emits the
   provider-free `cx.builder.emitIntrinsic("js.boolean.box", [value])`.
   Delete the `hasHostBooleanBox` contract entry, all three implementations,
   and the prose references.
5. **Preparation.** An unavailable arm classifies the OWNER as
   `late-preparation-unsupported` / `resolve` owner-locally, before any body,
   slot, alias, outcome or manifest prefix is published — extend or sibling
   the `unsupportedNumberBoundaryIntrinsic` partition; one demoting owner
   must not fail unrelated owners through the aggregate manifest.
6. **Trigger.** Widen the `integration.ts:7410` id filter to admit
   `js.boolean.box` attached callable targets. Attachment-precedes-trigger
   sequencing is the F1-S1 argument verbatim (manifest preparation runs at
   the top of the sequence, `preregisterDynamicAndForInSupport` later in the
   same sequence); no name scanning, no second allocator.

### Behavior-neutrality obligations (each is a test or a measured record)

1. `pnpm run check:ir-fallbacks` census output-identical; unintended,
   module-level and post-claim buckets stay empty.
2. Import set AND order identical in every lane, before and after.
3. Byte parity: every standalone, WASI, native-strings and linear cell
   byte-identical. Host-lane cells may exhibit ONLY the F1-S1 purity class of
   diff (removed `(local $$irN externref)` declarations + renumbering from
   the effects-aware scheduler no longer spilling a pure intrinsic's result;
   identical instruction sequence, call targets, imports and answers) — any
   other WAT delta is a defect. Record the measured cells in the checkpoint.
4. Outcome-code shift, F1-S1 divergence-4 class: shapes that previously fell
   through to the BUILD-time `operand-coercion-unsupported` demote on no-box
   lanes now demote in PREPARATION as `late-preparation-unsupported`. Both
   demote to legacy; emitted bytes must be measured identical on those lanes.
5. Non-vacuity: reverting ONLY the from-ast arm while keeping the schema must
   fail named tests (the owner-local demote code and the intrinsic-emission
   assertion), while schema/policy tests stay green.
6. The boolean-branded gate population is unchanged: nothing that was not
   emitted before may be emitted now (the resolver predicate never gated
   EMISSION population on host lanes — it only picked demote-vs-box; state
   this as an explicit before/after claim-census comparison).

### Required pre-implementation verifications (record answers in the checkpoint)

1. **Full-repo trace of `hasHostBooleanBox`.** Expected: one from-ast read,
   one contract entry, three implementations, prose only elsewhere. Any
   additional executable read invalidates the one-arm premise — stop and
   re-plan rather than absorb it.
2. **Async non-involvement.** Prove `async-prepare.ts` and the async adapter
   materializer have no `__box_boolean` join (the F1-S1 standalone-cutover
   failure came from exactly such a hidden lane-fact join on the number side;
   grep + run the #4103/#4104/#4106 suites and `check:standalone-ir-cutover`
   locally BEFORE pushing). Also prove the async-only capability projection
   filters by the seven async IDs, not by value type.
3. **`box-boolean-fuse.ts` interaction.** The peephole matches emitted
   `call $__box_boolean` leaves. Establish by measurement whether it ever
   fires on IR-path bodies today; if it does, the lowered intrinsic must
   produce the same call shape it matches (the callable provider emits the
   same `emitCall` — verify on a boolean-condition fixture, byte-comparing
   with the fuse pass on and off).
4. **Brand producers.** Enumerate what sets `boolean: true` on i32 IrTypes
   feeding this arm; confirm none consults the resolver predicate to decide
   whether to produce the branded carrier (emission population must be a pure
   type fact after the migration).

### Validation

Typecheck; `check:ir-fallbacks` bare; ratchet chain bare
(`node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs &&
node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet &&
npm run -s check:dead-exports`) plus the `LOC_GATE_BASE=$(git rev-parse
origin/main)` CI-base simulation; `check:ir-dialect`, `check:ir-layering`,
`check:ir-only`, `check:linear-ir`, `check:host-import-policy`,
`check:standalone-ir-cutover` (run locally — F1-S1's one CI failure was this
gate); the focused #3526 suites and the F1-S1 tests (which must stay green
untouched); hooks without bypass. Growth allowances in THIS issue file's
frontmatter with a dated rationale; no `scripts/*-baseline.json` edits (the
`check:ir-kind-neutrality` evidence-line refresh via its own
`--update-on-decrease` flow is the sanctioned exception if line drift trips
it, per the F1-S1 checkpoint).

### Explicitly out of scope

Generator `setReturn`'s `boxProvider` (a number-family row — F1-S3 candidate),
`compiler-timer-shim-preparation.ts` (no mechanical join proven), every direct
codegen `__box_boolean` handler and the `box-boolean-fuse` peephole itself,
`__box_symbol` / `$AnyValue`, `__unbox_boolean` (a union member with no IR
producer today), and the #2108 coercion-sites baseline. One owner for the
same file family as F1-S1 minus the async files; check the claim ledger before
touching `integration.ts` (#3525 codex lane overlaps it — coordinate, never
parallel-write).

## 2026-09-01 F1-S2 pre-implementation verifications — Opus lane

**Branch** `claude/issue-3526-f1s2-boolean-boundary`, grounded on `origin/main`
`dcb6eba626eea623c91156b7b8fc44a2d6b3fc00`. Implemented from the 2026-09-01
F1-S2 plan (boolean-boundary intrinsic), whose template is the landed F1-S1
machinery, not a re-derivation.

The plan requires these four answers BEFORE any source edit. All four were
measured on the grounded tree with the migration NOT yet applied.

### 1. Full-repo trace of `hasHostBooleanBox` — the one-arm premise HOLDS

`grep -rn hasHostBooleanBox` over the whole tree (excluding `node_modules` and
`.git`) returns exactly nine hits, and the executable split is precisely what
the plan predicted:

| kind | site |
| --- | --- |
| from-ast READ (1) | `src/ir/from-ast.ts:7233` — the branded-i32→externref box arm |
| contract entry (1) | `src/ir/from-ast.ts:421` |
| implementation (3) | `src/ir/integration.ts:5666`, `src/ir/backend/linear-integration.ts:1537`, `src/codegen/stdlib-selfhost.ts:190` |
| prose (4) | `src/ir/from-ast.ts:365`, `plan/issues/2955-…:399`, `plan/issues/3526-…:918`, `plan/issues/3526-…:1292` |

**No additional executable read exists**, so the STOP-and-report condition did
not trigger. There is no `hasNativeBooleanUnbox` and no unbox arm: F1-S2 mints
ONE intrinsic, not a pair.

### 2. Async non-involvement — proven twice over

- **No `__box_boolean` join.** `grep -rn "__box_boolean" src/ir/` returns seven
  hits: the one from-ast emission arm, its error message, four prose comments,
  and the `UNION_IMPORT_FUNC_NAMES` membership row in `integration.ts:7244`.
  **`src/ir/async-prepare.ts` contains no `box`/`unbox` reference other than
  its own `js.number.unbox` numeric-tail roundtrip** (`:812-851`), which keys
  on `js.number.unbox` / `env.__unbox_number` by exact ID and binding. A
  boolean row cannot reach it. The F1-S1 standalone-cutover failure came from
  the number side's hidden host-lane fact riding on a raw-import match; the
  boolean side has no such consumer, so no policy hand-off is needed and none
  is added.
- **The async-only capability projection filters by ID, not by value type.**
  `ASYNC_HOST_CAPABILITY_RECORDS` (`async-runtime-providers.ts`) is
  `RUNTIME_HOST_CAPABILITY_RECORDS.filter((entry) =>
  isAsyncHostCapabilityId(entry.capability))`, and
  `ASYNC_HOST_CAPABILITY_ID_SET` is exactly the seven `async.*` IDs. An
  `i32`-typed `boolean.box` row IS admissible under
  `AsyncHostAdapterValueType` (`"externref" | "i32"`) — which is precisely why
  a value-type filter would have been the wrong guard — but the seven-ID filter
  excludes it, and `asAsyncHostAdapter` additionally throws on a non-async
  capability, so the narrowing is checked rather than assumed. No async
  manifest can acquire the boolean record.

### 3. `box-boolean-fuse.ts` interaction — measured, and it is NIL

The pass is env-gated **default OFF** (`fuseEnabled()` returns `false` unless
`JS2WASM_UNBOXED_BOOL_FUSE` is set) and matches the direct-codegen
`logical-ops.ts` if-merge SINK shape, not this coercion boundary. Measured on
the grounded tree with the pass forced ON and its debug counters enabled, over
the IR-path boolean fixture plus a logical-value control:

| fixture | fuse counters | bytes fuse OFF | bytes fuse ON |
| --- | --- | --- | --- |
| `BOOLSTORE` (`a[0] = n > 2`, IR-emitted) | `fused-sink=0 fused-adjacent=0 leaf-box-call=0 sites=0` | 1754 | 1754 (sha identical) |
| `LOGICAL` (`if ((a>1)||(b>2))`) | pass declined — no `__is_truthy` in module | 160 | 160 (sha identical) |
| `BOOLSTORE_LOGICAL` | `sites=0` | 1654 | 1654 (sha identical) |

**The pass never fires on an IR-path body today**, so there is no matched call
shape to preserve. The obligation is therefore discharged as a *maintained
zero*: the same measurement is repeated after the migration and must stay at
`sites=0` with identical shas. (The lowered intrinsic emits through
`emitPreparedIntrinsic` → `emitter.emitCall(resolveFunc(target))`, i.e. the
same `call $__box_boolean` leaf, so even a future firing would match.)

### 4. Brand producers — all pure type facts

Every producer of a `boolean: true` i32 `IrType`, enumerated:

| site | what it is |
| --- | --- |
| `src/ir/boolean-brand.ts:38` (`irBool()`) | the canonical brand factory; its `IR_BOOL` singleton (`from-ast.ts:2992`) feeds 25 comparison / truthiness / `i32.eqz` / bool-const sites |
| `from-ast.ts:3825` | `typeNodeToIr` — the `boolean` **type annotation** |
| `from-ast.ts:7106` | `new Boolean(x)` argument's expected type |
| `from-ast.ts:7644` | standalone `RegExp.test` result type |
| `from-ast.ts:7795` | pristine-ES5 `Object.isFrozen` constant-fold result |
| `backend/linear-integration.ts:1242` | `latticeEvidenceToIr` — a certified `bool` lattice fact |

**None consults `hasHostBooleanBox`, or any other capability predicate, to
decide whether to produce the branded carrier.** (`:7795` reads
`cx.resolver?.isAmbientBinding`, an unrelated *binding-provenance* question:
"is `Object` the pristine ambient global?" — not a lane/capability question.)
Emission population is therefore a pure type fact both before and after the
migration, which is what obligation 6's before/after claim-census comparison
asserts.

### Reachability of the arm — measured, and it is narrow

Worth recording because it bounds every neutrality claim below. With a
temporary stderr trace at the arm, `pnpm run check:ir-fallbacks` (the fixed
`playground/examples` corpus) fires the arm **zero** times, and eight
hand-written candidate shapes (`Map<number, boolean>.set`, `Set<boolean>.add`,
`any[]` push, `JSON.stringify`, template/string concat, an extern class method,
a DOM property write) all demote at IR **selection** before reaching it. The
one shape found that both IR-selects and reaches the arm is the **element
store into an `any[]` parameter**:

```ts
export function put(a: any[], n: number): number { a[0] = n > 2; return n; }
```

That is the `BOOLSTORE` fixture used for every byte cell and for the
non-vacuity test; `MIXED` combines it with the F1-S1 `Map` memo shape so one
module carries both boundaries.

## 2026-09-01 F1-S2 implementation checkpoint — Opus lane

Implemented from the 2026-09-01 F1-S2 plan, mirroring the landed F1-S1
machinery rather than re-deriving it. The four required pre-implementation
verifications are in the section above; none triggered a STOP.

### What landed

- **`src/ir/intrinsics.ts`** — `js.boolean.box` `(i32) -> externref`,
  versioned, with a 1:1 feature row, added as a `BOOLEAN_BOUNDARY_*` SIBLING
  of the number constants (which are unchanged). One ID, not a pair: there is
  no `js.boolean.unbox` because `__unbox_boolean` has no IR producer. The new
  `I32_TYPE` param carries no `signed` field, so it matches the branded
  carrier the arm passes (`signed ?? true` on both sides) while
  `valTypeEquals` erases the brand itself.
- **`src/ir/runtime-host-capabilities.ts`** — one record `boolean.box` →
  `env.__box_boolean` `(i32) -> externref`, inserted in capability-ID sort
  order between the async prefix and the number rows, so the async prefix
  keeps its historical position.
- **`src/ir/runtime-manifest.ts`** — `BooleanBoundaryPolicy`
  (`box: "host" | "unsupported"` — no `"native"` member, because no native
  boolean boxer exists), a frozen `BOOLEAN_BOUNDARY_POLICY_DISABLED`, the
  optional `booleanBoundary` field on `RuntimeManifestPolicy` canonicalized at
  builder construction and published resolved on the frozen manifest, the one
  `host.js.boolean.box` provider (`host-callable` → capability `boolean.box`),
  and its policy branch in `#selectProvider` whose unavailable arm is a typed
  `provider-target-unavailable` naming the intrinsic and the resolved policy.
- **`src/ir/from-ast.ts`** — the arm emits the provider-free
  `js.boolean.box` intrinsic and reads no lane fact; the `hasHostBooleanBox`
  contract entry, all three implementations and the prose reference are
  deleted. The branded-i32 gate STAYS, and is load-bearing.
- **`src/ir/integration.ts`** — `integrationBooleanBoundaryPolicy`
  (`{ box: !ctx.nativeStrings ? "host" : "unsupported" }`, the exact former
  truth table), the owner-local `unsupportedBooleanBoundaryIntrinsic`
  partition run in the same pass as the number one, and the one-line trigger
  widening.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `BOOLEAN_BOUNDARY_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-boolean-boundary-intrinsic.test.ts`** (new, 16 tests).

`src/ir/intrinsic-support.ts` needed **no edit**: its attachment and
admitted-target tables are driven by `RUNTIME_PROVIDERS` ×
`INTRINSIC_DEFINITIONS`, so the new `host-callable` row is picked up by
construction. Neither did `src/ir/backend/legality.ts` — its linear
`intrinsic` arm is an allowlist, so `js.boolean.box` falls to the default
reject. Neither did `src/ir/async-prepare.ts`, per verification 2: unlike the
number side, this family has no async consumer, so no policy hand-off exists
to thread.

### Measured neutrality

**Byte parity — 25/25 cells identical, WAT included.** Five fixtures
(`BOOLSTORE` = the element store; `BOOLSTORE2` = two arms in one owner;
`MIXED` = the boolean store PLUS the F1-S1 `Map` memo in one module; `CLEAN` =
a Math-only control; `MEMO` = F1-S1's own fixture) × five lanes (gc-host,
gc-native-strings, standalone, WASI, linear), compiled before and after on the
same tree. Every cell matches on byte length, binary sha256, and import set
AND order; a file-by-file diff of all 25 emitted WAT texts is empty.

**This slice produced NO purity-class WAT diff at all** — the one divergence
F1-S1 had to record. The reason is specific and worth keeping: F1-S1's boxed
value was anchored into an `(local $$irN externref)` spill that the pure
intrinsic no longer needed, whereas the boolean box's result is consumed
immediately by its element store and was never spilled. The plan permitted
that diff class; none appeared.

| fixture | gc-host | gc-native-strings | standalone | WASI | linear |
| --- | --- | --- | --- | --- | --- |
| `BOOLSTORE` | 1754 ✓ | 23758 ✓ | 50462 ✓ | 50489 ✓ | 4918 ✓ |
| `BOOLSTORE2` | 1643 ✓ | 24001 ✓ | 50688 ✓ | 50715 ✓ | 4958 ✓ |
| `MIXED` | 2188 ✓ | 26289 ✓ | 124929 ✓ | 103377 ✓ | 5140 ✓ |
| `CLEAN` | 117 ✓ | 21976 ✓ | 22591 ✓ | 22618 ✓ | 4883 ✓ |
| `MEMO` | 584 ✓ | 24596 ✓ | 124959 ✓ | 103399 ✓ | 5118 ✓ |

(✓ = bytes, sha256, imports and WAT all identical before/after.)

**Imports and order.** Identical in every cell. The host-lane `BOOLSTORE`
import list is `__box_boolean, __get_undefined, __unbox_number, __box_number`;
`MIXED` is `Map_new, Map_get, Map_set, __unbox_number, __box_number,
__box_boolean, __extern_is_undefined, __get_undefined`.

**Census.** `pnpm run check:ir-fallbacks` is output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

**Outcome-code shift (obligation 4).** Exactly the F1-S1 divergence-4 class,
and nothing else — the only non-byte delta anywhere in the 25 cells:

| lane | before | after |
| --- | --- | --- |
| gc-native-strings, standalone, WASI | `operand-coercion-unsupported` / `build` | `late-preparation-unsupported` / `resolve` |

Both demote to legacy, and the emitted bytes on those lanes are measured
identical. `MIXED` on gc-native-strings shows the two boundaries demoting
side by side, each naming its own policy.

**The trigger widening is NOT decorative — measured.** With the
`js.boolean.box` arm removed from `preregisterDynamicSupport`'s recognizer and
everything else left in place, `BOOLSTORE` and `BOOLSTORE2` on gc-host change
sha (same byte length, different content): the union family materializes later,
moving `__unbox_number` from type 11 to type 15 and `__box_number` from 12 to
16. That is import-order/index drift of exactly the kind obligation 2 forbids,
so the one-line widening is load-bearing and its removal is caught.

**`box-boolean-fuse` (verification 3) — the zero is maintained.** Re-measured
after the migration with the pass forced on and its debug counters enabled:
still `fused-sink=0 fused-adjacent=0 leaf-box-call=0 sites=0` on every fixture,
and every sha identical both before/after the migration and fuse-on/fuse-off.

**Emission population unchanged (obligation 6).** Asserted directly rather
than argued: `lowerFill` lowers the same source under a resolver that answers
the deleted predicate `true` and one that answers it `false`, and the two IR
bodies are shape-identical (same intrinsics, same call targets) — because the
front-end no longer asks. Nothing that was not emitted before is emitted now.

### Non-vacuity — verified by the specified revert-only-the-arm check

Reverting ONLY the from-ast arm to its direct `emitCall(env.__box_boolean)`
form while keeping the entire schema, then re-running the suite:

- **4 tests fail**, and they are exactly the two named classes — the
  intrinsic-emission assertion ("lowers the branded carrier to the
  provider-free intrinsic", plus its lane-freedom twin) and the owner-local
  demote code ("demotes only the requesting owner …" and its
  standalone/WASI sibling);
- **all 9 schema / policy / freeze-discipline tests stay green**, as the plan
  requires.

Worth stating plainly: the host-lane byte-parity test does NOT distinguish the
two implementations (the bytes are identical by construction — that is the
point of the slice), so it is deliberately not relied on for non-vacuity. The
IR-level assertion is.

### Divergences from the plan (recorded, not widened)

1. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` asserts the frozen
   manifest policy by exact object equality, and the policy now publishes
   `booleanBoundary` alongside `numberBoundary`. This is the same mechanical
   consequence F1-S1 had when it introduced `numberBoundary` into that
   assertion. Every #3526 F1-S1 test and both async suites are otherwise
   green and untouched.
2. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned
   exception, handled exactly as the F1-S1 checkpoint prescribes. No verdict,
   kind, placement, ratchet count or `settledBy` rationale changed — only
   citation line numbers moved.

   Pre-merge this branch carried three drifted citations plus the `generated`
   date (`forof.string` `integration.ts` 6058→6112; `string.len`
   `linear-integration.ts` 1614→1617; `vec.new_fixed` `from-ast.ts`
   4542→4534). Main's own refresh has since absorbed two of them, so **the
   shipped diff is ONE line**: `forof.string`'s `src/ir/integration.ts`
   citation, 6051 (main's value) → **6105**.

   That final number is neither side's, which is the trap this note exists to
   flag: main moved the line one way and this branch's +56 LOC in the same
   file moves it the other, so the merge resolution had to RE-DERIVE it from
   the gate rather than pick a side or do arithmetic. Patched surgically in
   both rounds rather than by committing the regenerator's output, which
   reflows every array (measured: a 354-line diff for a 1-line change). The
   semantic delta was established each time by normalising both JSON
   documents and diffing those, so "only this line" is measured, not assumed.

### Reachability, stated as a limit rather than a claim

The migrated arm is narrow: it fires **zero** times on the fixed
`playground/examples` corpus, and eight of nine candidate source shapes demote
at IR *selection* before reaching it. Everything above is therefore measured on
the one shape that does reach it (an element store of a comparison result into
an `any[]`), plus hand-built owners for the manifest-level obligations. The
neutrality result is strong for that population and says nothing about shapes
that cannot reach the arm today — which is also why the census is unchanged.

### Validation run

Green: TypeScript 7 and TypeScript 5 typecheck; `check:ir-fallbacks` (bare,
output-identical); the ratchet chain bare AND under
`LOC_GATE_BASE=$(git rev-parse origin/main)` (`dcb6eba6`) — loc, func,
coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (after the refresh
above), `check:test-vacuity-shapes`; `lint`; `prettier --check` over
`src`/`tests`/`scripts`; and — F1-S1's one CI failure —
`check:standalone-ir-cutover-corpus`, which passes with `derived=19/19`,
`units=47/47`, `terminal=38/38`. The new 16-test suite, the F1-S1
number-boundary suite, both #3526 manifest/math suites and both async suites
(#4103/#4104) are green.

**Pre-existing failures, measured on a clean `origin/main` worktree at
`dcb6eba6` and NOT caused by this change-set** — identical failures on base
and branch: `tests/equivalence/arguments-nested-and-loops.test.ts` (1) and
`tests/equivalence/logical-conditional-identity.test.ts` (3);
`tests/ir-backend-emitter.test.ts` (1), `tests/ir-bytecode-proof.test.ts` (1),
`tests/ir-scaffold.test.ts` (1) and `tests/issue-1058-ir-inline-dag.test.ts`
(1). The last of those was worth checking rather than assuming, since a pure
intrinsic can in principle change an inlining decision; it fails identically
on base.

### Not touched (per the plan's scope discipline)

Generator `setReturn`'s `boxProvider`, `compiler-timer-shim-preparation.ts`,
every direct codegen `__box_boolean` handler and the `box-boolean-fuse`
peephole itself, `__box_symbol` / `$AnyValue`, `__unbox_boolean`, the timer
shims, and the #2108 coercion-sites baseline. `scripts/*-baseline.json` is
untouched apart from the sanctioned `check:ir-kind-neutrality` evidence
refresh above; `scripts/loc-budget-baseline.json` remains main's alone.

## 2026-09-01 F1-S3 implementation plan — generator setReturn boxing under manifest authority (family 1, slice 3)

**Fable lane.** Grounded on `origin/main` at `009b812779` (post-F1-S2 merge
PR #5396) via a four-probe measurement pass. Opus implements against this
plan. Governance note: the dormant whole-issue codex claim on #3526 (branch
`codex/3526-f1-s1-number-boundary`, tip = the merged 2026-08-30 Sol
correction, ancestor of main, no activity since 08-30) was released as stale
on 2026-09-01; this slice runs under the slice claim `3526:f1s3`.

This slice migrates the follow-up row both F1 checkpoints named: the
`gen.setReturn` seam still pins `__box_number` by runtime symbol, chosen by
presence, outside the frozen manifest's authority.

### Measured facts (verified on the grounded tree; every line quoted in probes)

- **One attachment site.** `attachIrGeneratorSupport`
  (`src/ir/generator-support.ts:112-125`, generators only per `:82`) attaches
  `provider = irRuntimeFuncRef("__gen_set_return")` and
  `boxProvider = irGeneratorSetReturnNeedsBoxing(valueType) ?
  irRuntimeFuncRef("__box_number") : undefined`; the boxing predicate
  (`:57-61`) is `val.kind === "f64" || val.kind === "i32"`. Re-attachment is
  guarded (`:119-122`) and `requireSameProvider` (`:64-67`) makes a
  binding-kind switch across re-preparation a hard error.
- **Reads.** `src/ir/lower.ts:2797`
  (`instr.boxProvider ?? irRuntimeFuncRef("__box_number")`, consumed at
  `:2808` f64 and `:2812` i32-after-convert; unresolvable box → `resolveFunc`
  throws → whole-function demote, `:2788-2791`);
  `collectAttachedGeneratorProviders` (`generator-support.ts:161-163`) feeds
  pre-sealing observation at `integration.ts:3600-3602`; the sealing
  agreement check `needsBoxing === (instr.boxProvider !== undefined)`
  (`prepared-component-dependencies.ts:687-697`); dependency evidence at
  `:1478-1479`. `boxProvider` exists ONLY on `IrInstrGenSetReturn`
  (`dialect/js.ts:491`); no `__unbox_number` anywhere in the generator path.
- **Order.** Inside `compileIrPathFunctions`: manifest freeze
  (`integration.ts:3557`, `prepareBuiltFnRuntimeManifest`) → generator
  attach (`:3596`) → Phase-3 lowering (`:4205`). `preparedRuntimeManifest`
  is a local in scope at the attach point — threading is plumbing, not
  reordering. Built fns (and thus setReturn value types) exist BEFORE
  freeze, so freeze-time demand scanning is possible.
- **Manifest coverage holes.** The manifest walk collects only
  `instr.kind === "intrinsic"` uses (`intrinsic-support.ts:265`, `:297`); a
  generator-only module yields NO manifest (`:335` empty-uses early return);
  the retained provider map is keyed by actual uses. The asyncPlans hook
  (`builder.requestFeature`, `:341`) is the precedent for freeze-time
  feature requests from non-intrinsic consumers; the async-prepare policy
  threading (`integration.ts:2343-2350` → `async-prepare.ts:680/:747/:829`)
  is the precedent for handing a resolved policy to a prepare step.
- **The truth table this slice must reproduce EXACTLY.**
  | lane | today's boxProvider resolution |
  | --- | --- |
  | gc-host (`!nativeStrings`) | runtime symbol → `resolveAndObserveCallableProvider` materializes `env.__box_number` |
  | gc-native-strings host | runtime symbol → native `__box_number` helper via funcMap presence |
  | standalone / WASI / linear | seam UNREACHABLE — generators demote at BUILD (`from-ast.ts:1255-1271` `jsHostExterns` gate; `imports.ts:2284`) |
  Note `integrationNumberBoundaryPolicy` says `box: "unsupported"` on
  native-strings host while this seam boxes natively there — the seam's
  truth table is WIDER than `numberBoundary` and must NOT reuse it; F1-S1
  deliberately excluded a native member from `numberBoundary.box`
  (presence-must-not-widen doc at `integration.ts:776-782`,
  `runtime-manifest.ts:464-468`).
- **Test surface.** NO test references `boxProvider` (zero hits) — the
  attachment is pinned only by src-side checks. Behavior is pinned
  indirectly: `tests/issue-2951.test.ts:50` (`VALUE_RETURN_GEN`, IR-claimed
  host, terminal `done:true, value:3`), `:111` (`FOROF_GEN`, with
  `trackIrOutcomes` anti-vacuity), `:85-89` (standalone must NOT IR-claim
  the generator), `tests/issue-2035.test.ts:72-75`,
  `tests/issue-1169f-7a/7b`. No fixture distinguishes the i32 arm of the
  boxing predicate. `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-440`
  pins the frozen policy by whole-object equality — every new policy field
  breaks exactly that one test (F1-S1 and F1-S2 precedent).

### Contract

1. **Policy.** New `RuntimeManifestPolicy` field
   `generatorNumberBox: { box: "host" | "native" | "unsupported" }`,
   optional in the type, defaulted to a frozen
   `GENERATOR_NUMBER_BOX_POLICY_DISABLED` (`box: "unsupported"`),
   canonicalized at builder construction, published resolved on the frozen
   manifest — sibling constants, never a widening of `numberBoundary` (whose
   box arm has no native member by design). Callers: integration projects
   `{ box: !ctx.nativeStrings ? "host" : "native" }` — the exact measured
   truth table; `linear-integration.ts` and `stdlib-selfhost.ts` pass
   disabled (the seam is build-unreachable there; fail closed).
2. **Freeze-time demand.** `prepareBuiltFnRuntimeManifest` scans
   `healthyForLower` for generator fns whose `gen.setReturn` needs boxing
   (the same `irGeneratorSetReturnNeedsBoxing` predicate over the same
   inputs the attach pass reads — export and reuse it, do not duplicate) and,
   when present, requests the generator-box feature via the asyncPlans-style
   hook so a generator-only module still freezes a manifest carrying the
   provider row. Provider selection by `generatorNumberBox`:
   `"host"` → the existing `host-callable` capability `number.box` (physical
   `env.__box_number`, ABI authority `runtime-host-capabilities.ts:123`);
   `"native"` → a `runtime-callable` provider on the runtime symbol
   `__box_number` (both implementation kinds exist since F1-S1);
   `"unsupported"` with demand present → typed
   `provider-target-unavailable` naming the seam and resolved policy,
   classified owner-locally (only the demanding generator owners demote).
3. **Attachment.** `attachIrGeneratorSupport` takes the selected provider
   ref as a parameter (threaded from the frozen manifest at
   `integration.ts:3596`) and attaches THAT instead of the hardcoded
   `irRuntimeFuncRef("__box_number")`. The parameter is required at the
   integration call site; a defaulted fallback may exist only for tests and
   must equal today's runtime ref. `requireSameProvider` stays authoritative
   for re-attachment consistency.
4. **Lowering.** `lower.ts:2797` keeps its shape; whether the `??` fallback
   can be retired to a hard error depends on pre-implementation
   verification V1 — if attachment is proven total for every lowered
   `gen.setReturn`, retire it (fail closed); if any path lowers un-attached
   instrs, keep it and say which path.
5. **Sealing/evidence.** The agreement check
   (`prepared-component-dependencies.ts:687-697`) and evidence recording
   (`:1478-1479`) are provider-shape-agnostic; verify they accept an
   import-bound ref unchanged (V2) rather than assuming.

### Behavior-neutrality obligations (each a test or measured record)

1. Byte parity on the REACHABLE lanes: gc-host and gc-native-strings cells
   over generator fixtures — `VALUE_RETURN_GEN` (f64 arm) plus a NEW
   i32-return generator variant (the arm no fixture distinguishes) —
   byte/sha/WAT/import-set-and-order identical before and after. The F1-S1
   purity-diff class does not apply here (no intrinsic purity change);
   ANY WAT delta is a defect.
2. Standalone/WASI/linear: generators still demote at build; the census
   (`check:ir-fallbacks`) is output-identical; `tests/issue-2951.test.ts:85-89`
   stays green untouched.
3. Import set AND order identical on both host lanes — the binding-kind
   switch (runtime-bound → import-bound on gc-host) changes the observation
   path at `integration.ts:3600`; measure that import membership, order and
   indices do not move (the F1-S2 trigger-widening measurement is the
   precedent for proving this class non-decorative). If order DOES move,
   the sanctioned alternative is recorded in the plan: keep the attached
   ref runtime-bound and thread only the SELECTION (policy authority)
   through the manifest — behavior identical, physical binding unchanged;
   record which route was taken and why in the checkpoint.
4. `tests/issue-4104-...:432-440` whole-shape policy pin gains the new
   field — the one expected test edit outside the #3526 suites (divergence
   class recorded by both prior checkpoints).
5. Non-vacuity: reverting ONLY the attachment threading (hardcoded runtime
   ref restored) with the schema kept must fail named tests (the
   manifest-row assertion and a boxProvider-shape assertion — which also
   closes the measured gap that NO test pins `boxProvider` today), while
   schema/policy tests stay green.

### Required pre-implementation verifications (record answers in the checkpoint)

1. **Attachment totality.** Can `lower.ts:2797`'s `??` fallback ever fire on
   the integration path (an un-attached `gen.setReturn` reaching Phase 3)?
   Trace every producer of the instr; decide the fallback's fate from the
   answer, not from taste.
2. **Sealing/evidence shape-agnosticism.** Prove
   `prepared-component-dependencies.ts:687-697/:1478-1479` and the
   observation path accept an import-bound `boxProvider` with identical
   import membership/order on gc-host; if not, take the recorded
   runtime-bound alternative (obligation 3).
3. **Freeze-scan equivalence.** The freeze-time demand scan and the attach
   pass must classify the same population — prove by construction (shared
   predicate + shared input enumeration), not by sampling.
4. **i32 arm coverage.** Confirm the new i32-return fixture actually takes
   the `:2810-2812` convert-then-box path (WAT-inspect once) so the parity
   cell is not vacuously identical.

### Validation

Typecheck; `check:ir-fallbacks` bare; ratchet chain bare + the
`LOC_GATE_BASE=$(git rev-parse origin/main)` simulation; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (evidence-line
refresh via its own flow if line drift trips it), and
`check:standalone-ir-cutover` locally before pushing; the focused suites:
issue-2951, issue-2035, issue-1169f-7a/7b, issue-2864, issue-680, all five
issue-3526 suites, issue-4104/4103; hooks without bypass. Growth allowances
in this issue file's frontmatter with a dated rationale.

### Explicitly out of scope

The from-ast generator build gate (`jsHostExterns`), `gen.push` /
`gen.epilogue` / `gen.yieldStar` providers and the `__gen_*` import family,
legacy generator codegen and the native state machine,
`compiler-timer-shim-preparation.ts`, `numberBoundary` / `booleanBoundary`
(untouched), and everything owned by #3525 (multi-prepared ownership —
check the claim map before touching `integration.ts`; keep that file's diff
to the freeze scan, the policy projection, and the attach call site).

## 2026-09-01 F1-S3 pre-implementation verifications — Opus lane

**Branch** `claude/issue-3526-f1s3-generator-boxprovider`, grounded on
`origin/main` `009b812779`. Implemented from the 2026-09-01 F1-S3 plan, whose
template is the landed F1-S1/F1-S2 machinery.

All four answers were measured on the grounded tree BEFORE any source edit.
Two of them decide routes the plan deliberately left open, and both decisions
below are the measurement's, not a preference.

### V1 — attachment totality: the `??` fallback is UNREACHABLE, so it is retired

Traced end to end rather than sampled:

| step | finding |
| --- | --- |
| producers | ONE: `builder.ts:1425` (`emitGenSetReturn`), reached only from the `funcKind === "generator"` return arm at `from-ast.ts:1985-2004`. |
| middle end | `inline-small.ts:924` and `monomorphize.ts:891` only rename operands; both spread the instr, so an attached `boxProvider` survives — and both run BEFORE attachment anyway. |
| lowering entry | ONE production site: `integration.ts:4205` → `lowerIrEntryFunction` → `lowerIrFunctionToWasm`. `linear-integration.ts`, `backend/porffor`, `stdlib-selfhost` lower non-generator bodies only, and NO test lowers a `gen.setReturn` (zero hits across `tests/`). |
| ordering | attachment (`integration.ts:3596`) precedes Phase 3 (`:4205`), and every later `healthyForLower` assignment is a `retainHealthyOwners` FILTER — nothing joins the lowered set after attachment. |
| the one splice risk | `canInline` admits a single-block callee with a `return` terminator, which a trivial generator can satisfy — so a `gen.setReturn` could in principle land in a NON-generator owner, which `attachIrGeneratorSupport` skips. That case is already rejected earlier in the same lowering arm by the `func.generatorBufferSlot === undefined` guard, which fires before the boxing reference is read. Slots are not migrated by the inliner, so the guard cannot be satisfied by a spliced owner. |

One divergence between the two type maps is worth recording because it is
NOT a hazard: `valueTypesOf` (attachment) covers block args, while lowering's
`typeOf` covers params and instruction results only. A block-arg-typed stash
would therefore be attached and then throw in `typeOf` — demoting the owner,
never silently mis-lowering. In the other direction the attachment map is a
superset, so anything lowering can type, attachment can too.

**Decision: retire the fallback.** `lower.ts` now throws
`gen.setReturn numeric stash has no prepared boxing provider` instead of
re-deciding the symbol locally. Failing closed demotes one owner; the old
`??` silently re-introduced a second authority for the very symbol this slice
exists to give one.

### V2 — sealing/evidence shape: the import-bound route is NOT available

The plan asked whether an import-bound `boxProvider` survives sealing with
identical import membership and order, and named a runtime-bound alternative
if order moved. The measurement did not get as far as import order.

Attaching `irImportFuncRef("env", "__box_number", "__box_number")` in place of
the runtime ref — one line, everything else unchanged — was compiled on both
reachable lanes:

| fixture | gc-host | gc-native-strings |
| --- | --- | --- |
| `VALUE_RETURN_GEN` | **compile FAILS** — `invariant/unexpected-internal-throw` | **compile FAILS** — same |
| `I32_RETURN_GEN` | **compile FAILS** — same | **compile FAILS** — same |
| `REF_RETURN_GEN` (no boxing) | unaffected, 341 bytes | unaffected, 22223 bytes |

The error is `callable-provider resolution requires a runtime or intrinsic
reference`, thrown by `resolveAndObserveCallableProvider`
(`integration.ts:5927`) — a deliberate precondition of the observation path
that `collectAttachedGeneratorProviders` feeds. It is not import-order drift
to be absorbed; it is a designed refusal, and it fails the owner outright
rather than demoting cleanly.

**Decision: take the sanctioned runtime-bound alternative** (plan obligation
3). The attached reference stays `runtime`-bound and only the SELECTION is
threaded through the manifest: the frozen manifest decides which physical
symbol answers the seam — via the central `number.box` capability record on
the host arm, via the union-native runtime symbol on the native arm — and the
seam binds that symbol the one way its observation path admits. The physical
target is unchanged on both lanes, which is why the slice is byte-neutral.

Sealing itself is shape-agnostic and was not the constraint:
`recordExternalCallable` (`prepared-component-dependencies.ts:1120`) keys on
`irCallableBindingKey` for every binding kind, and the agreement check at
`:687-697` reads only `needsBoxing === (instr.boxProvider !== undefined)`.
Both accept the runtime-bound attachment unchanged, as they did before.

### V3 — freeze-scan equivalence: one population, by construction

The freeze-time demand scan and the attachment pass share a single
enumeration, `forEachIrGeneratorSetReturn` (`generator-support.ts`): the same
`funcKind` gate, the same `valueTypesOf` map, the same deep instruction walk
and the same `irGeneratorSetReturnNeedsBoxing` predicate. `irGeneratorNumberBoxDemand`
is a thin fold over it; the attachment pass calls the same predicate over the
same map. A test battery (f64 / i32 / externref stashes, flat and nested in a
statement buffer, plus a non-generator owner) asserts the two verdicts are
equal case by case rather than relying on the shared code alone.

The scan runs at freeze, the attachment later, so the population can only
SHRINK in between (owners failing other preparation steps). That direction is
harmless: the manifest carries a row nobody consumes. The opposite direction
is a preparation defect and is caught by V1's fail-closed throw.

### V4 — i32 arm coverage: measured, and the plan's fixture had to be replaced

The plan's `type i32 = number` generator does NOT reach the arm. Five variants
of the native-annotation shape were compiled and every one demotes at IR
selection with `type-resolution-unsupported`, so its `f64.convert_i32_s` is
LEGACY output and the parity cell would have been vacuous.

The shapes that do IR-claim and take the `lower.ts` convert-then-box path are
i32-valued expressions on an ordinary `number` parameter. Two are now fixtures,
both verified by WAT inspection to emit `f64.convert_i32_s` → `call $__box_number`
→ `call $__gen_set_return`, and both confirmed IR-claimed
(`legacyBodyEmitted: false`, owner in `irFirstSkipped`):

- `I32_RETURN_GEN` — `return n | 0` (a numeric i32; the headline i32 cell);
- `BOOL_RETURN_GEN` — `return n > 2` (a boolean-branded i32).

**Out-of-scope observation, recorded because the second fixture exposes it:**
a generator returning a boolean yields `{done: true, value: 1}`, not `true` —
the branded i32 is boxed through `__box_number`. Measured identical on the IR
path and the legacy path (`IR_FIRST=1` and `=0` both answer `1`), so it is a
pre-existing whole-compiler conformance gap, not an IR-path defect and not
something this byte-neutral slice may change. Worth its own issue.

## 2026-09-01 F1-S3 implementation checkpoint — Opus lane

### What landed

- **`src/ir/runtime-manifest.ts`** — `GeneratorNumberBoxPolicy`
  (`box: "host" | "native" | "unsupported"`), a frozen
  `GENERATOR_NUMBER_BOX_POLICY_DISABLED`, the optional `generatorNumberBox`
  field canonicalized at builder construction and published resolved on the
  frozen manifest; the `js.generator.number-box` feature row; the two provider
  rows (`host.…` → `host-callable` on capability `number.box`, `native.…` →
  `runtime-callable` on `__box_number`); the policy branch in `#selectProvider`
  whose unavailable arm is a typed `provider-target-unavailable` naming the
  feature and the resolved policy. Sibling constants throughout — the number
  boundary's box arm still has no `"native"` member, and a test pins that.
- **`src/ir/generator-support.ts`** — the shared
  `forEachIrGeneratorSetReturn` enumeration, `irGeneratorNumberBoxDemand`, and
  `attachIrGeneratorSupport(fn, numberBoxProvider)` with the provider as a
  REQUIRED parameter. A numeric stash with no supplied provider is a hard
  error, not a fallback to a spelled symbol.
- **`src/ir/intrinsic-support.ts`** — `prepareIrRuntimeManifest` takes
  `generatorNumberBoxDemand` and requests the feature the asyncPlans way, so a
  generator-only module (which yields NO intrinsic uses) still freezes a
  manifest carrying the row; `preparedGeneratorNumberBoxProvider` derives the
  attachable callable from the frozen manifest's selected provider.
- **`src/ir/integration.ts`** — `integrationGeneratorNumberBoxPolicy`
  (`{ box: !ctx.nativeStrings ? "host" : "native" }`, the exact measured truth
  table), the owner-local unsupported partition in the same pass as the number
  and boolean ones, the freeze-time demand argument, and the threaded attach
  call site. Four touch points, per the #3525 co-ownership constraint.
- **`src/ir/lower.ts`** — the `?? irRuntimeFuncRef("__box_number")` fallback is
  gone (V1); the arm shape is otherwise unchanged.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `GENERATOR_NUMBER_BOX_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-generator-number-box.test.ts`** (new, 22 tests).

`prepared-component-dependencies.ts` needed **no edit** (V2): the agreement
check and the evidence recorder are binding-kind agnostic and the attachment
stays runtime-bound. Neither did `intrinsic-support.ts`'s admitted-target
tables — this family has no intrinsic instruction, so nothing keys on it.

Note the production consequence of the truth table: the `"unsupported"` arm is
**unreachable in integration** (both lanes resolve to a supported arm, and
generators demote at BUILD on standalone/WASI/linear). That is required by
neutrality — a reachable unsupported arm would be a behavior change — so the
owner-local partition is exercised by tests and by the linear/self-hosted
adapters' explicit disabled policies, not by a production lane.

### Measured neutrality

**Byte parity — 35/35 cells identical, WAT included.** Seven fixtures
(`VALUE_RETURN_GEN` = f64 arm; `I32_RETURN_GEN` = `n | 0`, the i32 arm;
`BOOL_RETURN_GEN` = `n > 2`, the branded-i32 arm; `FOROF_GEN`;
`REF_RETURN_GEN` = the no-boxing control; `VOID_GEN` = no `setReturn` at all;
`CLEAN` = a generator-free control) × five lanes, compiled before and after on
the same tree. Every cell matches on byte length, binary sha256, import set
AND order; a file-by-file diff of all 35 emitted WAT texts is empty. The
measurement was repeated after the V1 fallback retirement and is unchanged.

| fixture | gc-host | gc-native-strings | standalone | WASI | linear |
| --- | --- | --- | --- | --- | --- |
| `VALUE_RETURN_GEN` | 376 ✓ | 22240 ✓ | 49963 ✓ | 49990 ✓ | demote ✓ |
| `I32_RETURN_GEN` | 466 ✓ | 22329 ✓ | 50026 ✓ | 50053 ✓ | demote ✓ |
| `BOOL_RETURN_GEN` | 367 ✓ | 22231 ✓ | 49929 ✓ | 49956 ✓ | demote ✓ |
| `FOROF_GEN` | 416 ✓ | 22274 ✓ | 50256 ✓ | 50283 ✓ | demote ✓ |
| `REF_RETURN_GEN` | 344 ✓ | 22225 ✓ | 49952 ✓ | 49979 ✓ | demote ✓ |
| `VOID_GEN` | 390 ✓ | 22253 ✓ | 49915 ✓ | 49942 ✓ | demote ✓ |
| `CLEAN` | 113 ✓ | 21973 ✓ | 22588 ✓ | 22615 ✓ | 4874 ✓ |

(✓ = bytes, sha256, imports and WAT all identical before/after. `demote` = the
linear target rejects generators at build, identically on both sides.)

**This slice produced NO WAT diff at all.** The F1-S1 purity-diff allowance
does not apply here and none was needed: no intrinsic purity changes, and the
physical call target is the same `__box_number` before and after.

**Imports and order.** Identical in every cell. The boxing lanes carry
`__box_number, __gen_create_buffer, __gen_push_f64, __gen_set_return,
__create_generator` in that order on both host lanes (the gc-host list is
prefixed by its `string_constants` globals); `REF_RETURN_GEN` carries the same
list minus `__box_number`, which is the control that the boxing import is
present only when the seam demands it.

**Census.** `pnpm run check:ir-fallbacks` is output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

**Standalone/WASI/linear (obligation 2).** Generators still demote at BUILD;
`tests/issue-2951.test.ts` needed no edit.

### Non-vacuity — verified by the specified revert-only-the-threading check

Reverting ONLY the attachment threading (hardcoded `irRuntimeFuncRef("__box_number")`
restored) while keeping the entire schema, then re-running the suite:

- **2 tests fail**, and they are exactly the two named classes — the
  `boxProvider`-shape assertion (which also closes the measured gap that NO
  test pinned `boxProvider` before this slice) and the fail-closed
  attachment error;
- **all 20 remaining tests stay green**, including every schema, policy,
  freeze-discipline and derivation test, as the plan requires.

The two halves of the authority claim are pinned separately and both are
needed: `preparedGeneratorNumberBoxProvider` following the manifest's selected
provider (proved by pointing the host arm at a different central capability
and watching the derived callable follow it to `env.__get_undefined`, and by
renaming the native arm's runtime symbol), and the attachment consuming THAT
reference. The byte-parity cells deliberately do not carry the non-vacuity
argument — they are identical by construction, which is the point of the slice.

### Divergences from the plan (recorded, not widened)

1. **The plan's V2 route question resolved to the alternative, not the
   primary.** Recorded above with the measurement; the contract's "host arm →
   `host-callable` capability" survives as the manifest AUTHORITY, only the
   physical binding kind at the seam stays `runtime`.
2. **The plan's i32 fixture does not reach the arm** and was replaced by two
   that do (V4).
3. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` asserts the frozen
   manifest policy by exact object equality and now also sees
   `generatorNumberBox`. Identical mechanical consequence to F1-S1's
   `numberBoundary` and F1-S2's `booleanBoundary`.
4. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned
   exception, handled as the F1-S1/F1-S2 checkpoints prescribe. No verdict,
   kind, placement, ratchet count or `settledBy` rationale changed — the
   semantic delta was established by normalising both JSON documents and
   diffing those, and it is exactly TWO citation lines
   (`forof.string` `src/ir/integration.ts` 6105 → 6159; `string.len`
   `src/ir/backend/linear-integration.ts` 1617 → 1622). Patched surgically:
   committing the regenerator's output instead would have been a 269/85-line
   diff for a 2-line change.

### Validation run

Green: TypeScript 5 typecheck (the two pre-existing
`WebAssembly.Tag` errors in `src/linked-provider-runtime.ts` are unrelated and
fail identically on base); `check:ir-fallbacks` (bare, output-identical);
the ratchet chain bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)`
— loc, func, coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (after the surgical
refresh above), and `check:standalone-ir-cutover-corpus`
(`derived=19/19`, `units=47/47`, `terminal=38/38`). The new 22-test suite, all
five other #3526 suites and both async suites (#4103/#4104) are green — 95
tests across 8 files.

**Pre-existing failure, measured on the base tree and NOT caused by this
change-set:** `tests/issue-2951.test.ts` › "standalone generators stay
compile-twice (out of scope — #680 native carrier)" fails identically with the
change-set reverted. Its five siblings, including both value-returning host
generator cases, pass.

### Not touched (per the plan's scope discipline)

The from-ast generator build gate (`jsHostExterns`), `gen.push` /
`gen.epilogue` / `gen.yieldStar` and the `__gen_*` import family, legacy
generator codegen and the native state machine,
`compiler-timer-shim-preparation.ts`, and `numberBoundary` / `booleanBoundary`
(both unchanged, and a test pins that the number box arm did not acquire a
native member). `scripts/*-baseline.json` is untouched apart from the
sanctioned two-line `check:ir-kind-neutrality` citation refresh;
`scripts/loc-budget-baseline.json` remains main's alone.

### Post-merge re-validation (origin/main `2dfb8396`)

`main` advanced under this branch while the slice was in flight, and one of the
landed changes is generator-adjacent (#3591, `src/codegen/generators-native-consumer.ts`),
so every neutrality claim was re-measured against the merged base rather than
carried over: the 35 byte cells are again identical on bytes, sha256, imports
and WAT against `origin/main` `2dfb8396`; the fallback census is byte-identical
to the pre-merge run; `check:ir-kind-neutrality` needs no further citation
change; TypeScript 7 and 5, the full ratchet chain bare and under
`LOC_GATE_BASE=$(git rev-parse origin/main)`, `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy` and `check:standalone-ir-cutover-corpus` are green.
Focused suites: 134/135 pass across 14 files, the single failure being the
pre-existing `tests/issue-2951.test.ts` standalone compile-twice case, which
was re-confirmed to fail identically with this change-set reverted to
`origin/main` `2dfb8396`.

The merge resolved the issue file as a chronological union — main's F1-S3 plan
section (PR #5409, merged while this branch was in flight) followed by this
branch's verifications and checkpoint. No other file conflicted.

### Merge-queue park (2026-09-01) — diagnosed as not-this-PR, with a gate finding

PR #5412 was auto-parked from the merge queue: the `merge_group` re-validation's
`check for test262 regressions` reported one regression —
`test/language/statements/class/subclass/class-definition-null-proto-super.js`,
pass → fail, `Maximum call stack size exceeded` (`range_error`), net −1 — and
flagged it `Regressions with wasm-hash change: 1` on a content-current
baseline. Read at face value that says a generator-boxing slice moved the bytes
of a non-generator class test, which would violate obligation 1 outright.

**It does not move them.** Compiled on clean `origin/main` and on this branch,
same tree, four shapes: the raw test body; body + `assert.js`/`sta.js` sloppy;
the same strict; and — the shape that settles it — the runner's OWN
`assembleOriginalHarness` output under the runner's exact `compileOptions`,
hashed with the runner's own `computeWasmSha`, for both the primary and the
strict-rerun variant. Every cell is byte-, sha- and WAT-identical
(`aa0313d0d7f6` / `c0a8b0c96fcb` on both sides), and the output is
deterministic across processes.

**Why the gate said otherwise, measured rather than guessed.**
`scripts/diff-test262.ts:1747` computes
`wasmUnchanged = typeof baseSha === "string" && typeof curSha === "string" && baseSha === curSha`,
so the #1222 byte-identity noise filter requires a `wasm_sha` on BOTH sides.
The current baseline JSONL carries **`wasm_sha` on 0 of 48,735 entries** (0 of
35,659 `pass` entries). Against that baseline `wasmUnchanged` can never be
true: every pass→fail transition is counted "with wasm-hash change", and the
companion `Wasm-identical noise: 0` line is structurally guaranteed, not
measured. The filter that exists to absorb exactly this class of runner-variance
failure is therefore **inert**. That is a baseline-schema gap, not something
this slice can fix — it deserves its own issue.

With the bytes identical the behavior is identical, so the stack overflow is
runner-side variance on a stack-depth-sensitive test. The run's other signals
agree (`compile_error → compile_timeout` +1; aggregate compile time +1.8%), and
this change-set is not the cause of those either: on the honest-lane module the
branch compiles marginally FASTER (median 792 ms vs 824 ms over 5 runs).

Resolution: one sanctioned re-admission (hold removed) on a confirmed
not-this-PR determination, with no code change — there is nothing in the diff to
fix. Recorded on the PR as the standing-down comment the park rules require.

**Outcome:** the re-validation passed on re-admission and PR #5412 merged
(`2e74deee` is an ancestor of main), which is the confirmation the diagnosis
predicted — the same head, unchanged, went green on the second `merge_group`
run. This note could not ride that PR because a queued branch is locked against
pushes, so it lands separately.

### Two follow-ups this slice surfaced but does not own

Both were measured here and neither has an issue id yet:
`node scripts/claim-issue.mjs --allocate` refuses in this container (exit 6 —
`gh` is unauthenticated, so the open-PR id scan degrades and the reservation
would not be verified against in-flight PRs). Reserving under
`--allow-unscanned` to file them would risk exactly the permanent hole in the
sequence that #3890/#3891 burned, so they are recorded here for whoever can
allocate cleanly:

1. **The test262 baseline carries no `wasm_sha`, which disables the #1222
   byte-identity noise filter.** `scripts/diff-test262.ts:1747` requires the
   field on BOTH sides; the baseline has it on 0 of 48,735 entries. Every
   pass→fail transition is therefore reported "with wasm-hash change" and
   `Wasm-identical noise: 0` is structurally guaranteed. The filter exists to
   absorb runner-variance failures and currently cannot. Fix is on the
   baseline-producing side (record `wasm_sha` per row), not in the gate.
2. **A generator returning a boolean yields `1`, not `true`.** `return n > 2`
   in a generator stashes a boolean-branded i32, which `gen.setReturn` boxes
   through `__box_number`. Measured identical on the IR and legacy paths
   (`IR_FIRST=1` and `=0` both answer `1`), so it is a whole-compiler
   conformance gap, not an IR-path defect. Out of scope for a byte-neutral
   slice; the `BOOL_RETURN_GEN` fixture added here pins the current behavior
   and would need updating alongside the fix.

## 2026-09-01 F1-S4 implementation plan — boundary residuals (family 1, slice 4)

**Fable lane.** Grounded on `origin/main` at `41265d89f5` by a four-probe
census workflow (symbol boundary, remaining predicates, R4 gaps,
overlap/freshness). Opus implements against this plan. Slice claim
`3526:f1s4`, branch `claude/issue-3526-f1s4-boundary-residuals`.

Three sub-migrations, one PR: they share every piece of landed F1 machinery
and reviewer context, and each is independently revertible for non-vacuity.
The census's other candidates are dispositioned: the symbol boundary is
blocked on brand production (filed as #5258, deferred), R4 gap 5 is R3's by
design, R4 gap 3 is a separate R4 slice.

### Sub-slice A — the two remaining `__unbox_number` from-ast arms

**Measured.** `src/ir/from-ast.ts:12273` and `:12303` (ToPrimitive-adjacent
arms) still emit direct `__unbox_number` calls by runtime symbol; the
sibling coercion arm at `:9524` already emits the provider-free
`js.number.unbox` intrinsic (F1-S1). Every piece exists and is exercised:
intrinsic id (`intrinsics.ts:60`), capability row
(`runtime-host-capabilities.ts:124`), `NumberBoundaryPolicy.unbox` with
host/native arms, freeze-time attachment, owner-local unsupported partition,
and the union-import trigger's attached-target recognition (which already
names `js.number.unbox`).

**Contract.** Both arms emit `emitIntrinsic("js.number.unbox", [...])`;
population unchanged (the arms' guards stay). NOT in scope:
`lower.ts:1440`'s defensive `__unbox_number` in `coerceToF64ForBitwise` —
it is a lower-time consumer (post-freeze, cannot carry a provider-free
intrinsic) and its retirement belongs to #1305; record it untouched.

**Byte expectation.** The F1-S1 purity class MAY appear on host lanes (a
pure intrinsic result no longer spilled); measure the cells and record the
WAT diff class exactly as F1-S1 did. Native/standalone/WASI/linear cells
byte-identical.

### Sub-slice B — `__extern_is_undefined` under manifest authority

**Measured.** `src/ir/from-ast.ts:13769-13770` is the last surviving
pre-F1 two-armed shape in from-ast: runtime symbol vs `env` import chosen
in the front-end by the resolver predicate `externIsUndefinedIsNative?()`
(contract `:626`; integration implementation is
`ctx.standalone || ctx.wasi || ctx.nativeStrings`, #4461). No capability
row exists. The preregistration trigger (`integration.ts`,
`preregisterDynamicSupport`) has raw-call detectors for BOTH forms
(`usesExternIsUndefined` on the env call, `usesNativeExternIsUndefined` on
the runtime symbol) — the F1-S1/S2 precedent says the migration removes the
raw calls those detectors key on, so attached-target recognition must be
widened for the new intrinsic id.

**Contract.** `js.extern.is_undefined` `(externref) -> i32` intrinsic with
a 1:1 feature row; capability record `extern.is_undefined` →
`env.__extern_is_undefined` `(externref) -> i32`; policy
`externIsUndefined: { probe: "host" | "native" | "unsupported" }` on
`RuntimeManifestPolicy` (sibling constants; optional; frozen disabled
default; canonicalized; published resolved). Callers: integration projects
`{ probe: (ctx.standalone || ctx.wasi || ctx.nativeStrings) ? "native" :
"host" }` — the exact former truth table; linear and selfhost project their
measured current behavior (verify what linear-integration's resolver
answers today and mirror it — do not guess). Host arm resolves via the
capability record (`host-callable`); native arm via `runtime-callable` on
the runtime symbol. Delete the resolver contract entry and every
implementation of `externIsUndefinedIsNative`; the from-ast site emits the
provider-free intrinsic with no lane read. Owner-local
`late-preparation-unsupported` partition for a demanding owner on a
disabled policy (mirror the F1 partitions). Widen the trigger's
attached-target recognition to the new id and prove import set/order parity
(the F1-S2 measured-trigger precedent — that proof was non-decorative
there).

**Byte expectation.** Byte-identical everywhere; the F1-S1 purity class MAY
appear if the probe result was previously spilled — measure and record; any
other WAT delta is a defect.

### Sub-slice C — retire the four `gen.*` lowering fallbacks

**Measured.** `src/ir/lower.ts:2731/2749/2769/2796` still carry
`instr.provider ?? irRuntimeFuncRef("__gen_push_*" | "__create_generator" |
"__gen_yield_star" | "__gen_set_return")`. F1-S3 deleted only the
`boxProvider` fallback with a totality proof (`lower.ts:2798-2808`); the
same argument covers all four `provider` fields — `attachIrGeneratorSupport`
attaches them unconditionally for every `gen.*` kind before Phase 3.

**Contract.** Replace each `??` fallback with the F1-S3 fail-closed throw
(a missing attachment demotes one owner, never re-decides the symbol
locally), AFTER pre-implementation verification V3 re-proves totality for
all four kinds. No new rows, no behavior change, bytes identical.

### Required pre-implementation verifications (record in the checkpoint)

1. **V-A population.** Which shapes reach `from-ast.ts:12273/:12303`, and
   does the current resolution of the raw runtime symbol on each reachable
   lane match `NumberBoundaryPolicy.unbox`'s truth table exactly? If any
   lane diverges (a population the policy calls unsupported but the raw
   symbol resolves today), STOP on sub-A and record — do not absorb a
   behavior change.
2. **V-B readers.** Enumerate every reader of `externIsUndefinedIsNative`
   and both trigger detectors; after migration, prove import membership,
   order and indices identical on every lane (the binding-kind switch
   hazard from F1-S3's V2 applies — if order moves, keep the native arm
   runtime-bound and record the route).
3. **V-C totality.** Extend F1-S3's attachment-totality evidence to all
   four `gen.*` provider kinds (same producer/lowering-site enumeration).
4. **V-D fixture reach.** For sub-A, name the fixture(s) that actually
   reach each migrated arm (WAT-inspect once) so the parity cells are not
   vacuous; add one if none exists.

### Behavior-neutrality obligations

`check:ir-fallbacks` census output-identical; import set AND order
identical per lane; byte cells per sub-slice expectation above (record the
matrix); the outcome-code divergence-4 class is NOT expected here (no
demote-site moves) — its absence is itself an assertion; non-vacuity by
reverting each sub-slice's arm independently against the kept schema
(named failing tests per sub-slice, including a first-ever pin of the
`gen.*` provider attachments if none survives C's throw conversion);
`tests/issue-4104-...` whole-shape policy pin gains the new field (the
recorded precedented edit).

### Validation

Typecheck; `check:ir-fallbacks` bare; ratchet chain bare + the
`LOC_GATE_BASE=$(git rev-parse origin/main)` simulation; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (evidence-line
refresh via its own flow if tripped), `check:standalone-ir-cutover` locally
before pushing; the five issue-3526 suites, the F1-S3 generator suite, the
#4461 extern-is-undefined tests, #4103/#4104; hooks without bypass. Growth
allowances in this file's frontmatter, dated.

### Explicitly out of scope

`lower.ts:1440` (#1305), `__to_primitive` itself and the `__ir_dyn_*`
family, the string-plan/stringMethodPlan predicate family (family-2
territory), `env.__get_undefined`/`env.__make_callback` non-async reach
plumbing (runner-up, own slice), the symbol boundary (#5258), R4 gaps
(#3523), and everything owned by #3525/#3522. `integration.ts` diff stays
minimal (policy projection, partition sibling, trigger widening); check the
#3525 claim before touching it.

## 2026-09-01 F1-S4 pre-implementation verifications — Opus lane

**Branch** `claude/issue-3526-f1s4-boundary-residuals`, grounded on `origin/main`
`96f7a3c0`, slice claim `3526:f1s4`. Implemented from the 2026-09-01 F1-S4 plan,
whose template is the landed F1-S1/F1-S2/F1-S3 machinery.

All four answers were measured on the grounded tree BEFORE any source edit. One
of them is the plan's STOP condition, and it fired.

### V-A population — **the STOP condition is REAL. Sub-A is not in this PR.**

The plan asked whether the current resolution of the raw `__unbox_number`
symbol at `from-ast.ts:12273/:12303` matches `NumberBoundaryPolicy.unbox`'s
truth table on every reachable lane. It does not.

**Reach, measured with a temporary trace at each arm.** The two arms are
reached only through `emitUnaryToNumber`, and the shapes that get there are
narrower than the plan assumed:

| arm | reached by | measured |
| --- | --- | --- |
| `:12273` (`extern:Object`) | unary `+`/`-` on an OrdinaryToPrimitive object literal whose methods are property-assigned **function expressions** — `lowerOrdinaryToPrimitiveObjectLiteral` gives that form the open `extern:Object` protocol | IR-claimed and REACHED on gc-host, gc-native-strings, standalone and WASI |
| `:12303` (`object`, string sub-arm) | would need a **shorthand-method** literal whose method returns `string` | **UNREACHABLE.** The closed structural route admits only `number`/`boolean` returns (`select.ts:10344` `hasPreparedParityReturn`, mirrored at `from-ast.ts:5592`); a string-returning method is admitted ONLY as a function expression, which takes the `extern:Object` route instead. Measured: the arm fires zero times across the `check:ir-fallbacks` corpus, the equivalence-adjacent suites and five hand-built candidate shapes |

Eight further candidates (an `Object`-annotated parameter, a declared ambient
`Object`, arrow-function OTP literals, a typed `{ valueOf: () => string }`
parameter) all demote at IR **selection** (`type-resolution-unsupported` /
`body-shape-rejected`) before reaching either arm.

**The divergence.** On the reachable arm, per lane:

| lane | `NumberBoundaryPolicy.unbox` | what the RAW symbol resolves to today |
| --- | --- | --- |
| gc-host | `host` | `env.__unbox_number` import — **matches** |
| standalone / WASI | `native` | union-native function, no import — **matches** |
| gc-native-strings (`nativeStrings: true`, `semanticProviders: "host-assisted"`) | **`unsupported`** | **`env.__unbox_number` import — the owner compiles and is IR-claimed** |
| linear | disabled | arm unreachable (the shape fails the linear backend outright) |

The gc-native-strings row is the STOP. `addUnionImports`
(`registry/imports.ts:813`) registers the **host** `env` family on every
non-`native-first` lane, so the raw runtime symbol resolves there; the
preregistration comment says as much ("`__unbox_number` comes from the union
family in every lane"). Measured directly: the fixture emits
`env.__unbox_number` in its import list and reports `emitted`, while the
F1-S1 arm on the same lane reports
`late-preparation-unsupported / resolve — box=unsupported/unbox=unsupported`.

Migrating the arm to `js.number.unbox` would therefore turn a compiling,
IR-claimed owner into a preparation demote — a behaviour change, which the plan
forbids absorbing. **Sub-A is stopped and recorded, not implemented.** Two
tests in the new suite pin the divergence so the next slice inherits a
measurement rather than a memory.

*Route for a future slice, recorded not taken:* the F1-S3 precedent applies
almost exactly. This seam's truth table is
`semanticProviders === "native-first" ? native : host` — a fourth policy, a
sibling of `numberBoundary` the way `generatorNumberBox` is. Minting it was not
authorised by this plan (which explicitly routed sub-A through
`NumberBoundaryPolicy.unbox`), so it belongs to an amended plan, not to a
byte-neutral slice.

### V-B readers — enumerated; the import-order-parity route was available

`grep -rn externIsUndefinedIsNative` over the whole tree returns **three**
executable hits and nothing else: the contract entry (`from-ast.ts:626`), the
one read (`from-ast.ts:13768`), and the one implementation
(`integration.ts:5767`, `ctx.standalone || ctx.wasi || ctx.nativeStrings`).
There is no test, plan or doc reference. Both trigger detectors were traced
end to end:

| detector | set at | acts at | action |
| --- | --- | --- | --- |
| `usesExternIsUndefined` | `integration.ts:7534` (env-import `call`) | `:7654` | `ensureLateImport("__extern_is_undefined", …)` + `flushLateImportShifts` |
| `usesNativeExternIsUndefined` | `:7553` (runtime `call`) | `:7628` | `ensureObjectRuntime` + flush + `observeNativeRuntimeProvider` |

The two fire at **different points** in the registration sequence, so the
migration recognises the attached target into the same two FLAGS and leaves the
action order untouched.

**Route taken: import-order parity, not the runtime-bound fallback.** F1-S3's
V2 hazard (an import-bound ref refused by `resolveAndObserveCallableProvider`)
does not apply: that path is the GENERATOR observation path, and this family
lowers through `emitPreparedIntrinsic`, which F1-S1/F1-S2 already proved
accepts an import-bound `host-callable` target. Both arms therefore keep
exactly today's physical binding — `env.__extern_is_undefined` import on the
host lane, the runtime symbol on the host-free lanes — and import membership,
order and indices are measured identical in every cell (table below).

**Adapters — measured, and they project `unsupported`.** The plan asked for
"their measured current behaviour, do not guess". The measurement is that
`linear-integration.ts` and `stdlib-selfhost.ts` **do not implement the
predicate at all**, and that no owner under either resolver ever reaches the
arm: a trace instrumented to report an adapter-resolver hit fired **zero**
times across every `tests/linear-*.test.ts` file, `tests/stdlib.test.ts`,
`tests/issue-3520-selfhost-cache-identity.test.ts` and
`tests/standalone-ir-cutover-corpus.test.ts`. The resolver-absent default would
have been `host`, so projecting `unsupported` is behaviour-neutral over an
empty population while keeping both adapters fail-closed — which is what
F1-S1/F1-S2/F1-S3 chose for the same two callers, and what the self-hosted
stdlib's "owns no JS-host imports" invariant requires. Recorded as a
deliberate reading of the plan's wording, with the population measurement that
makes the two readings equivalent.

### V-C totality — all four `gen.*` provider fields, proven the F1-S3 way

F1-S3's V1 evidence extends to the other three kinds without weakening:

| step | finding |
| --- | --- |
| producers | FOUR builder methods (`emitGenPush`, `emitGenEpilogue`, `emitGenYieldStar`, `emitGenSetReturn`), each guarded on `funcKind === "generator"` (epilogue and setReturn additionally on `generatorBufferSlot`). Their only callers are seven from-ast sites, all inside generator lowering. |
| attachment | `attachIrGeneratorSupport` attaches `provider` **unconditionally** for all four kinds on every generator owner — no predicate, no policy gate. |
| middle end | unchanged from F1-S3: `inline-small.ts` / `monomorphize.ts` only rename operands, spread the instr, and run before attachment. |
| lowering entry | ONE production site (`integration.ts:4259` → `lowerIrEntryFunction`); `linear-integration`, `backend/porffor` and `stdlib-selfhost` lower non-generator bodies only, and **no test lowers a `gen.push` / `gen.epilogue` / `gen.yieldStar`** (zero hits across `tests/`). |
| splice risk | every one of the four lowering arms reads its provider only AFTER the `func.generatorBufferSlot === undefined` guard, so a `gen.*` spliced into a non-generator owner is rejected before the provider is touched. |

**Decision: retire all four fallbacks**, to the same fail-closed throw F1-S3
used. One consequence is recorded rather than absorbed: the `gen.push` arm's
local `__gen_push_f64` / `_i32` / `_ref` derivation existed only to feed the
fallback, so it is gone — but its `typeOf(instr.value)` READ is kept, because
`typeOf` throws for a value it cannot type and that throw demotes the owner.
Deleting the read with its consumer would have silently admitted a population
lowering previously refused.

### V-D fixture reach — named, and one cell is honestly vacuous

| arm | fixture that reaches it | verified by |
| --- | --- | --- |
| sub-B probe | `ANYUNDEF` (`const v = a[0]; v !== undefined`) and `MEMO` (the F1-S1 `Map` memo, which reaches the F1-S1 unbox arm AND this one) | trace at the arm; `env.__extern_is_undefined` in the host import list, absent on standalone/WASI |
| sub-C `gen.setReturn` / `gen.push` / `gen.epilogue` | `VALUE_RETURN_GEN`, `I32_RETURN_GEN`, `BOOL_RETURN_GEN`, `FOROF_GEN`, `VOID_GEN`, `REF_RETURN_GEN` (F1-S3's set) | F1-S3's WAT inspection, re-run here |
| sub-C `gen.yieldStar` | **`YIELDSTAR_GEN`, added by this slice** — F1-S3's set had no `yield*` fixture, so the fourth kind's parity cell would have been vacuous | new fixture; `__gen_yield_star` in the emitted import list |
| sub-A arms | `OTPNEG` (the function-expression OTP literal) | kept in the matrix as an UNCHANGED control, since sub-A is stopped |

The `:12303` string sub-arm has no fixture and cannot be given one — see V-A.

## 2026-09-01 F1-S4 implementation checkpoint — Opus lane

### What landed

- **`src/ir/intrinsics.ts`** — `js.extern.is_undefined` `(externref) -> i32`,
  versioned, with a 1:1 feature row, added as an `EXTERN_BOUNDARY_*` SIBLING of
  the number and boolean constants (both unchanged). One ID, but — unlike the
  boolean family — **two** provider arms.
- **`src/ir/runtime-host-capabilities.ts`** — one record `extern.is_undefined`
  → `env.__extern_is_undefined` `(externref) -> i32`, inserted in capability-ID
  sort order so the async prefix keeps its historical position. Noted in place:
  this is NOT an `addUnionImports` member — on the host lane the import is its
  own `ensureLateImport` registration, which is why the trigger keys on it
  separately.
- **`src/ir/runtime-manifest.ts`** — `ExternIsUndefinedPolicy`
  (`probe: "host" | "native" | "unsupported"`), a frozen
  `EXTERN_IS_UNDEFINED_POLICY_DISABLED`, the optional `externIsUndefined` field
  canonicalized at builder construction and published resolved on the frozen
  manifest, the two provider rows (`host.…` → `host-callable` on capability
  `extern.is_undefined`; `native.…` → `runtime-callable` on the runtime symbol),
  and the policy branch in `#selectProvider` whose unavailable arm is a typed
  `provider-target-unavailable` naming the intrinsic and the resolved policy.
- **`src/ir/from-ast.ts`** — the strict-undefined arm emits the provider-free
  intrinsic and reads no lane fact; the `externIsUndefinedIsNative` contract
  entry and its one implementation are deleted. The `externrefShaped` gate
  STAYS — it is a type/representation fact, not a lane fact.
- **`src/ir/integration.ts`** — `integrationExternIsUndefinedPolicy`
  (`{ probe: ctx.standalone || ctx.wasi || ctx.nativeStrings ? "native" : "host" }`,
  the exact former truth table), the owner-local
  `unsupportedExternBoundaryIntrinsic` partition in the same pass as the number,
  boolean and generator ones, the freeze-time policy argument, and the widened
  materialization trigger. Five touch points, per the #3525 co-ownership
  constraint (`--check 3525` re-read before editing: still CLAIMED by
  `ttraenkler/codex`).
- **`src/ir/lower.ts`** — all four `?? irRuntimeFuncRef(<spelling>)` fallbacks on
  the `gen.*` arms are gone, replaced by one shared fail-closed
  `requirePreparedGeneratorProvider`.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `EXTERN_IS_UNDEFINED_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-boundary-residuals.test.ts`** (new, 26 tests).

`src/ir/intrinsic-support.ts` needed **no edit** (its attachment and
admitted-target tables are driven by `RUNTIME_PROVIDERS` × `INTRINSIC_DEFINITIONS`,
so the new rows are picked up by construction), nor did
`src/ir/async-prepare.ts` (this family has no async consumer — unlike the number
side, whose hidden host-lane join cost F1-S1 a CI failure), nor
`src/ir/backend/legality.ts` (its linear `intrinsic` arm is an allowlist, so the
new id falls to the default reject).

### One divergence from the plan's contract, forced by measurement

The plan specified the intrinsic as `(externref) -> i32` and said nothing more
about the operand. Measured, the arm's own `externrefShaped` gate admits FOUR IR
type shapes, not one: `val` externref (`a[0]` out of an `any[]`), `extern`
(a declared class instance), `callable` (a function-typed parameter) and
host-mode `string`. `emitIntrinsic` type-checks arguments with `irTypeEquals`,
which admits only the first.

Resolved with `coerce.to_externref`, which is a **type normalisation, not a
conversion**: `lower.ts:2962` elides `extern.convert_any` when the operand is
already externref-shaped, and its `alreadyExternref` test is the same four-way
fact as `externrefShaped`. The added IR instruction therefore lowers to **zero**
Wasm instructions on every shape that reaches this arm — which is why the byte
cells below are unchanged. The alternative (loosening `emitIntrinsic`'s argument
check) would have weakened the closed contract for every intrinsic.

### Measured neutrality

**Byte parity — 67 of 70 cells identical, WAT included.** Fourteen fixtures ×
five lanes, compiled before and after on the same tree, compared on byte length,
binary sha256, import set AND order, and the full emitted WAT text.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `MEMO` | 584 ✓ | 24596 ✓ | 125422 ✓ | 103862 ✓ | 5118 ✓ |
| `ANYUNDEF` | 1489 ✓ | n/a ✓ | 122019 ✓ | 99650 ✓ | 4934 ✓ |
| `STRUNDEF` | 184 ✓ | 22439 ✓ | 22603 ✓ | 22630 ✓ | 4894 ✓ |
| `ANYUNDEF2` | 1614 △ | n/a ✓ | 122247 △ | 99875 △ | 4997 ✓ |
| `OTPNEG` (sub-A control) | 3421 ✓ | 25569 ✓ | 126358 ✓ | 103866 ✓ | n/a ✓ |
| `VALUE_RETURN_GEN` | 2543 ✓ | 24255 ✓ | 129904 ✓ | 104352 ✓ | n/a ✓ |
| `I32_RETURN_GEN` | 2858 ✓ | 24562 ✓ | 130421 ✓ | 104532 ✓ | n/a ✓ |
| `BOOL_RETURN_GEN` | 2819 ✓ | 24519 ✓ | 130420 ✓ | 104531 ✓ | n/a ✓ |
| `FOROF_GEN` | 3150 ✓ | 25079 ✓ | 50251 ✓ | 50278 ✓ | n/a ✓ |
| `YIELDSTAR_GEN` | 1925 ✓ | 24185 ✓ | 51207 ✓ | 51234 ✓ | n/a ✓ |
| `REF_RETURN_GEN` | 2522 ✓ | 24332 ✓ | 129207 ✓ | 104465 ✓ | n/a ✓ |
| `VOID_GEN` | 2594 ✓ | 24308 ✓ | 129972 ✓ | 104420 ✓ | n/a ✓ |
| `BOOLSTORE` (F1-S2 fixture) | 1754 ✓ | 23758 ✓ | 50462 ✓ | 50489 ✓ | n/a ✓ |
| `CLEAN` | 108 ✓ | 21970 ✓ | 22585 ✓ | 22612 ✓ | 4877 ✓ |

(✓ = bytes, sha256, imports and WAT all identical before/after. `n/a` = the
fixture does not compile on that lane, identically on both sides — the
native-strings `ANYUNDEF*` cells and every linear generator cell are
pre-existing refusals, unchanged by this slice. △ = the three cells below.)

**Every sub-C cell is identical, including all four `gen.*` kinds.** The
fallback retirement is provably inert: the attachment already supplied the same
symbol the fallback spelled.

**The three △ cells are the F1-S1 purity class, in a stronger manifestation —
measured, argued and runtime-checked.** `ANYUNDEF2` is the only fixture with
TWO probes in one owner. Its WAT diff is 42 lines on each of the three lanes and
is entirely this: two spill locals (`(local $$ir14 externref)`,
`(local $$ir15 i32)`) and their `local.tee`s disappear, and the second element
read moves from a hoisted position at the top of the body down to its consumer.
Same mechanism F1-S1 recorded — a semantic `intrinsic` is *pure* under the
existing `effectsOf` authority while the opaque `call` it replaces was not, so
the effects-aware scheduler stops anchoring the operand and emits it lazily —
but a stronger manifestation than F1-S1's, which lost only local declarations.
Recorded as a divergence from the plan's "identical instruction sequence"
reading of that class, not absorbed:

- the moved read is a pure bounds-checked GC read that yields `ref.null` on
  out-of-bounds and cannot trap;
- it moves across `call $__extern_is_undefined`, the probe itself, which cannot
  mutate the vector;
- the AFTER form is in fact **closer** to source order than the BEFORE form,
  which hoisted `a[1]` ahead of `a[0]`;
- runtime-checked rather than argued alone: five input cases
  (`[1,2] [1] [] [undefined,5] [7,undefined]`) answer **identically** on base
  and branch, on gc-host and standalone, including the pre-existing gc-host
  out-of-bounds divergence from JS. Nothing about the answers moved.

The plan permitted this class "on host lanes"; it appears on standalone and
WASI too, because the scheduler is lane-independent. That widening of the
permitted set is the divergence being recorded here.

**Imports and order.** Identical in every one of the 70 cells, including the
three △ ones. The host-lane `MEMO` list is `Map_new, Map_get, Map_set,
<string_constants>, __unbox_number, __box_number, __extern_is_undefined`;
standalone and WASI carry no `env` import at all.

**The trigger widening is NOT decorative — measured, and it is the most
load-bearing line in the slice.** With `js.extern.is_undefined` removed from
`preregisterDynamicSupport`'s recognizer and everything else left in place:

| cell | without the widening |
| --- | --- |
| `MEMO` gc-host | 584 → **727** bytes, and TWO extra imports appear (`env.__get_undefined`, `env.__new_ReferenceError`) — exactly the import-membership drift obligation 2 forbids |
| `MEMO` standalone | **compile FAILS** — `invariant/unknown-function-ref @ resolve` |
| `ANYUNDEF` / `ANYUNDEF2` gc-native-strings | a **host `env.__extern_is_undefined` import lands in a native-strings module** — precisely the #4461 failure the native arm exists to prevent |

**Census.** `pnpm run check:ir-fallbacks` is output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

**Outcome codes.** No shift anywhere in the 70 cells — the divergence-4 class
does not appear here, and its absence is an assertion, not an omission: the
integration policy resolves the probe to a supported arm on every lane, so no
owner changes demote site. The `"unsupported"` arm is unreachable in production
(as F1-S3's was) and is exercised by tests and by the two adapters' explicit
disabled policies.

### Non-vacuity — each sub-slice reverted independently against the kept schema

- **sub-B**, reverting ONLY the from-ast arm to its direct two-armed call:
  **4 tests fail** — the intrinsic-emission assertion, its lane-freedom twin,
  the operand-normalisation assertion, and "uses the host-free Wasm function on
  standalone, with no env import" (the reverted arm puts a host import into a
  standalone module). All 9 schema/policy tests stay green.
  One assertion had to be **strengthened** to be non-vacuous and the reason is
  worth keeping: the two arms this slice replaced spelled the *same name*
  (`__extern_is_undefined`) and differed only in `import` vs `runtime` binding,
  so the lane-freedom comparison had to compare binding KINDS, not names. A
  name-only comparison passed against the un-migrated front-end.
- **sub-C**, restoring the four `??` fallbacks: exactly the **4** "refuses to
  lower an unattached `gen.*`" tests fail, while the four attachment pins and
  the entire F1-S3 suite stay green.
- **sub-A**: nothing to revert — the two pinning tests assert the arms are
  still unmigrated and that the raw symbol still resolves on the lane whose
  policy calls it unsupported.

The byte cells deliberately carry none of this argument: they are identical by
construction, which is the point of the slice.

### Divergences from the plan (recorded, not widened)

1. **Sub-A is not implemented** — V-A's STOP condition fired. Full measurement
   above; the sibling-policy route a future slice would need is named there.
2. **The `:12303` arm is unreachable**, so even had sub-A proceeded its parity
   cell would have been vacuous. Measured, not inferred.
3. **The intrinsic's operand needed `coerce.to_externref`** — the plan's
   `(externref) -> i32` contract did not anticipate the arm's four admitted
   operand shapes. Byte-inert by the elision at `lower.ts:2962`.
4. **The purity class appears on standalone and WASI, not only host lanes, and
   reorders two pure reads** rather than only dropping local declarations.
   Argued and runtime-checked above.
5. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` asserts the frozen
   manifest policy by exact object equality and now also sees
   `externIsUndefined`. Identical mechanical consequence to F1-S1's
   `numberBoundary`, F1-S2's `booleanBoundary` and F1-S3's `generatorNumberBox`.
6. **One F1-S3 test fixture needed a provider.** Its "refuses to lower a
   numeric stash whose boxing provider was never attached" case built an
   entirely unattached `gen.setReturn`; sub-C makes the SEAM provider fail
   first, so the fixture now attaches `__gen_set_return` and keeps isolating the
   boxing authority. The seam-provider case it used to reach incidentally is
   pinned explicitly in the new suite, for all four kinds.
7. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned
   exception, handled as the three prior checkpoints prescribe. No verdict,
   kind, placement, ratchet count or `settledBy` rationale changed — the
   semantic delta was established by normalising both JSON documents and
   diffing those, and it is exactly THREE citation lines (`forof.string`
   `src/ir/integration.ts` 6159 → 6216; `string.len`
   `src/ir/backend/linear-integration.ts` 1622 → 1624; `vec.new_fixed`
   `src/ir/from-ast.ts` 4534 → 4526). Patched surgically: committing the
   regenerator's output instead would have been a 269/85-line diff for a
   3-line change.

### Validation run

Green: TypeScript 7 typecheck; `check:ir-fallbacks` (bare, output-identical);
the ratchet chain bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)` —
loc (+265 net src LOC, every path granted by this file's frontmatter), func,
coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh above); `lint`;
`prettier --check` over `src`/`tests`/`scripts`; and
`check:standalone-ir-cutover-corpus` (`derived=19/19`, `units=47/47`,
`terminal=38/38`). Focused suites: 223/224 across 17 files — all six #3526
suites, both async suites (#4103/#4104), #2951, #2035, #1169f-7a/7b, #2864,
#680 and #4461.

**Pre-existing failures, measured on the base tree and NOT caused by this
change-set** — identical with the eight source files reverted to
`origin/main` `96f7a3c0`: `tests/issue-2951.test.ts` › "standalone generators
stay compile-twice (out of scope — #680 native carrier)" (1); the five
`tests/stdlib.test.ts` `String.at` / `Array.at` cases; the two
`WebAssembly.Tag` errors in `src/linked-provider-runtime.ts` under TypeScript 5;
and the collect-time failure of
`tests/issue-2949-slice3-dynamic-lowering.test.ts`.

### Not touched (per the plan's scope discipline)

`lower.ts:1440`'s defensive `coerceToF64ForBitwise` `__unbox_number` (a
lower-time consumer, post-freeze, cannot carry a provider-free intrinsic —
#1305 owns its retirement), `__to_primitive` itself and the `__ir_dyn_*`
family, the string-plan / `stringMethodPlan` predicate family,
`env.__get_undefined` / `env.__make_callback` reach plumbing, the symbol
boundary (#5258), R4 gaps (#3523), `compiler-timer-shim-preparation.ts`, and
`numberBoundary` / `booleanBoundary` / `generatorNumberBox` (all three
unchanged). `scripts/*-baseline.json` is untouched apart from the sanctioned
three-line `check:ir-kind-neutrality` citation refresh;
`scripts/loc-budget-baseline.json` remains main's alone.

### One follow-up this slice surfaced but does not own

**The `emitUnaryToNumber` string sub-arm (`from-ast.ts:12303`) is dead code.**
Its `primitiveType.kind === "string"` guard cannot be satisfied: the closed
structural OrdinaryToPrimitive route admits only `number`/`boolean` method
returns, and a string-returning method is admitted only as a function
expression, which takes the `extern:Object` route instead. Measured zero hits
across the fallback corpus and every candidate shape. It is either a dead arm
to delete or a gap in the closed route to close — a decision above a
byte-neutral slice. (`claim-issue.mjs --allocate` still refuses in this
container — `gh` is unauthenticated, so the open-PR id scan degrades and the
reservation would not be verified against in-flight PRs; recorded here rather
than reserved under `--allow-unscanned`, per the #3890/#3891 precedent.)

## 2026-09-01 F2-S1 implementation plan — string.compare under manifest policy (family 2, slice 1)

Grounded on `origin/main` `d39779cbfd`. Slice claim: `#3526:f2s1`
(`ttraenkler/fable-ir-takeover`). Three census probes (boundary surface /
catalogue+policy / test surface) ran against that commit; every line number
below is from them. This slice opens **family 2 (string/text boundary)** the
way F1-S4 closed family 1: one byte-identical policy migration (sub-A) plus
one dead-fallback retirement (sub-B), in one PR.

### Where family 2 stands (census summary)

- **Zero string entries in the R6 vocabulary today**: no string `IntrinsicId`
  (`src/ir/intrinsics.ts:95-101`), no string capability record
  (`src/ir/runtime-host-capabilities.ts:27-39`), no string policy on
  `RuntimeManifestPolicy` (`src/ir/runtime-manifest.ts:165-195`).
- The string ops themselves already flow through IR lane-free in from-ast
  (the #2955 grep gate holds: zero functional `nativeStrings` reads there).
  The un-governed mode reads live in **integration.ts**: the resolve-time
  provider table `resolveAndObserveCallableProvider` (`:6059-6276`, raw
  `ctx.nativeStrings` at Phase-3 resolve time — family 2's largest
  un-governed dispatch), the emit-time no-provider fallbacks (`:6597-6688`),
  and the preparation window `prepareStrings` (`:6943-7129`).
- Measured per-op (gc-host / standalone+nativeStrings / wasi): concat, `<`
  compare, `===`, `.length`, `.charCodeAt`, template literals are all
  IR-claimed today; host lane imports span THREE namespaces (`env` funcs,
  `wasm:js-string` builtins, `string_constants` globals); native/wasi lanes
  are import-free. `String(n)` coercion is selector `external-call` — outside
  IR entirely, selector work before boundary work.
- **Deferred by design**: `string.concat`/`eq`/`len` host providers live in
  the `wasm:js-string` module and `string.const` in imported GLOBALS — both
  outside the frozen capability-record schema (`module: "env"`,
  `kind: "func"`, runtime-host-capabilities.ts:76-78). Widening those axes is
  its own schema slice (the family-2 analog of F1-S1's value widening) and
  does NOT ride along here. `stringMethodPlan` (~14 concrete spellings,
  from-ast.ts:656-666 / integration.ts:5652-5718) is the family's XL tail and
  needs its own per-method census first.

### Sub-A — `stringCompare` policy + `string.compare` capability

**The arm being governed**: `IR_STRING_COMPARE_FN` (`__ir_str_compare`) —
from-ast emits it lane-free (`src/ir/from-ast.ts:8477`; consumer :13189);
resolution happens at `integration.ts:6189-6195`: host
`ctx.funcMap.get("string_compare")` (env import
`(externref,externref)->i32`, shim `src/runtime.ts:17620`) vs native
`nativeStrHelperHandle("__str_compare")`. Truth table is exactly
`ctx.nativeStrings ? runtime __str_compare : host env.string_compare`.

**Contract**:
1. New capability record
   `record("string.compare", "string_compare", ["externref","externref"], ["i32"])`
   in the central catalogue — fits the existing frozen schema (module `env`,
   kind `func`; value union already has externref/i32,
   runtime-host-capabilities.ts:53).
2. New `stringCompare?: StringComparePolicy` — `{compare: "host" | "native" |
   "unsupported"}`, sibling of `externIsUndefined` (two provider rows:
   host-callable → the capability record; runtime-callable →
   `__str_compare`). Frozen disabled default, canonicalized, published,
   selected fail-closed with typed `provider-target-unavailable` naming the
   policy. Follow the 10-point precedented edit list verbatim
   (runtime-manifest.ts type+default+constructor refreeze :1137-1157,
   feature/provider unions :604-701 + :64/:277-284, `#selectProvider` branch
   :1425-1497, caller projection `integrationStringComparePolicy(ctx)` beside
   :799-875 consulted ONCE before freeze, policy literal in
   `prepareBuiltFnRuntimeManifest` :922-936, owner-local partition scan
   :3578-3663, explicit disabled policy in the linear adapter and
   `src/codegen/stdlib-selfhost.ts`, and the whole-shape pin updates).
3. The resolve arm at `:6189-6195` stops reading `ctx.nativeStrings`: it
   reads the frozen manifest's selected provider for the string-compare
   demand and fails closed when absent. Mechanism choice is probe P1's
   (below): freeze-time demand (`requestFeature`, the F1-S3
   `generatorNumberBoxDemand` precedent, intrinsic-support.ts:343-389) vs a
   full `js.string.compare` intrinsic instruction. The demand shape is
   recommended: no new IrType ground, no from-ast changes, and byte identity
   is structurally easier.
4. **Import parity is the hard byte constraint**: the host arm today binds
   the funcMap's existing base import `string_compare` — the policy-driven
   attachment must land the exact same import index (no `ensureLateImport`,
   no new registration), or bytes shift. String spellings are NOT in
   `UNION_IMPORT_FUNC_NAMES` and must NOT be union-materialized — add
   per-demand attached-target recognition (the `attachedExternIsUndefinedArm`
   shape, integration.ts:7553-7560) routing to the EXISTING string
   materializers, keeping each lane's registration order identical.
5. No change to `plan.invocation`, no change to from-ast (the #2955 gate and
   the S4 lane-freedom lesson: pins compare binding KINDS, not names).

### Sub-B — retire the `forof.string` `??` fallback

`src/ir/lower.ts:3375`:
`instr.provider ?? irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN)` is the
last string-op `??` lane fallback in lower.ts (the `gen.*` quartet was
retired by F1-S4; the :3498-3520 quartet is `extern.*`, family 6).
`attachIrStringSupport` attaches the provider unconditionally on every
adapter that prepares strings (`src/ir/string-support.ts:72-73, 138-147`;
linear adapter at `src/ir/backend/linear-integration.ts:735-737`), so the
fallback is dead code under F1-S3's totality argument. Replace with a
`requirePreparedStringProvider`-style fail-closed throw and pin "refuses to
lower an unattached forof.string" — same anatomy as the F1-S4 sub-C pins in
`tests/issue-3526-boundary-residuals.test.ts`.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — mechanism**: demand-at-freeze (recommended) vs intrinsic
  instruction. For the demand shape, name the exact seam that reads the
  selected provider (the `preparedGeneratorNumberBoxProvider` analog,
  intrinsic-support.ts:262-280) and prove the host arm binds the SAME
  `env.string_compare` funcMap index as today (contract item 4). Note the
  measured constraint that generator-style seams accept only
  runtime/intrinsic bindings — verify whether the string-compare seam can
  take an `irImportFuncRef` host binding or must follow the same
  runtime-symbol route; either way the physical import must not move.
- **P2 — adapters**: exact edits for the linear adapter and
  stdlib-selfhost disabled policies (edit-list item 9), with the F1-S2/S3/S4
  loc-budget rationale pattern (issue :83-120).
- **P3 — outcome-pin shift**: which committed pins actually move. Candidates
  measured: `tests/issue-3520-callable-provider-abi.test.ts:16,768-777`
  (IR_STRING_COMPARE_FN binding-key/ABI identity — update to compare KINDS),
  the `tests/issue-4104-...:432-442` whole-shape policy pin and its
  `issue-3526-ir-runtime-manifest.test.ts` analogs (new field), and whether
  any `tests/issue-3529-*` divergence-4 pins
  (`operand-coercion-unsupported`@build) cover populations this arm demotes —
  if none demote (compare is total under both arms), record that the
  divergence-4 class is EMPTY for this slice.
- **P4 — census**: `pnpm run check:ir-fallbacks` output must be diffed, not
  eyeballed (`ir-fallback-baseline.json` has `unintended: {}` and
  `deferred: {"string-builder-candidate": 2}` — neither should move; note
  `check-ir-fallbacks.ts:145-149` has no `resolve` stage key, so any
  demote-site shift would change census OUTPUT). The linear twin
  `scripts/linear-ir-baseline.json` is byte-exact-pinned
  (`tests/issue-4550-linear-ir-census.test.ts:627-629`) — must not change.

### Verification matrix (the 6-point F1 template, issue :1595-1616, verbatim)

- **V-A byte cells**: the F1 fixture protocol — fixtures × 5 lanes (gc-host,
  gc-native-strings, standalone, WASI, linear), before/after on the same
  tree: byte length, sha256, import set AND order per cell; full WAT diff
  empty. Expectation for this slice: **all cells byte-identical** (no purity
  class — the semantic ref shape does not change). Any WAT delta is a defect.
- **V-B import parity**: exact `result.imports.map(name)` array in order on
  the host lane (the F1-S2 :467-492 pattern), plus a runtime oracle equality
  check on string comparisons (`<`, `>`, `localeCompare`-free shapes) across
  lanes.
- **V-C non-vacuity by revert**: restore only the `:6189-6195` mode read
  (sub-A) / only the `:3375` fallback (sub-B); exactly the named new pins
  fail, all schema/policy pins stay green (the S3 2/20, S4 4/9 pattern).
- **V-D fail-closed reachability**: refusal per disabled policy with typed
  `provider-target-unavailable` naming `stringCompare`; owner-local demote
  (`late-preparation-unsupported`@resolve) proven per-owner with a clean
  co-owner staying emitted; unattached `forof.string` refusal pin (sub-B).
- **V-E suites**: new `tests/issue-3526-string-boundary-compare.test.ts` with
  the committed per-slice anatomy (a)-(i) from the F1 files; affected string
  regression controls run unchanged (`issue-3518-string-repeat-ir`,
  `issue-3502-string-contract`, `issue-2955-depolymorph-gate` — the grep gate
  must stay green); all five ratchet gates chained before commit.

### Out of scope

The `wasm:js-string` and `string_constants` capability-schema widenings
(their own slice, before concat/eq/len/const can move); `stringMethodPlan`
(XL, needs per-method census); `String()` coercion (selector work, not
boundary work); `stringForOfPlan`/`charReadPlan` strategy queries (stay
build-time per #2955 — only their provider NAMES could ever be
manifest-projected); the resolve-table rows beyond compare (`__concat_N`,
repeat, charAt families — later slices ride on this slice's machinery).

## 2026-09-01 F2-S1 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s1-string-compare`, grounded on `origin/main`
`bee8a149`, slice claim `3526:f2s1`. Implemented from the 2026-09-01 F2-S1 plan.
All four probe answers were measured on the grounded tree BEFORE any source edit.

### Probe answers

**P1 — mechanism: DEMAND-AT-FREEZE, as recommended. The intrinsic instruction
was not needed and would have been the wrong shape.** The seam has no
`intrinsic` to attach to: from-ast emits a plain `call` through the
`IR_STRING_COMPARE_FN` (`__ir_str_compare`) sentinel func-ref
(`from-ast.ts:8491`), so the F1-S3 `generatorNumberBoxDemand` route is the exact
structural match. The demand is requested by `irStringCompareDemand`, a scan of
the `call` population; the SAME predicate answers the freeze request and the
owner-local partition, so the two can never disagree.

The seam that reads the selected provider is **not** an attachment pass, and
that is the one place this slice diverges from the F1-S3 template. The
`preparedGeneratorNumberBoxProvider` analog is
`preparedStringCompareProvider(prepared)` (`intrinsic-support.ts`), but it
returns the ARM CLASSIFICATION plus the physical spelling
(`{arm:"host",field:"string_compare"}` / `{arm:"native",symbol:"__str_compare"}`)
rather than an `IrFuncRef` — because the two arms are materialized by different
existing routines and no single callable reference could carry the decision
without moving a registration. Its consumer is the resolve-time provider table
itself (`integration.ts`, the `IR_STRING_COMPARE_FN` arm), which now receives
the whole `PreparedIrRuntimeManifest` where it previously received only
`preparedRuntimeManifest?.providers` — the feature row `js.string.compare` is
not in that intrinsic-keyed map, and the host arm's field name comes from the
frozen capability records.

**The plan's note about generator-style seams accepting only runtime/intrinsic
bindings does not bind here, and the import cannot move — for a stronger reason
than the plan anticipated.** No binding is constructed at all: the arm resolves
a funcidx directly. And `env.string_compare` is neither an `addUnionImports`
member nor an `ensureLateImport` registration — it is a **BASE import minted by
the legacy import collector's pre-pass** (`import-collector.ts:1637-1640`, gated
on `!ctx.nativeStrings`), long before any IR preparation runs. The migrated host
arm evaluates `ctx.funcMap.get(record.field)`, which is character-for-character
the same lookup as the old `ctx.funcMap.get("string_compare")`. There is no
registration in this slice to reorder, which is why contract item 4 is satisfied
structurally rather than by measurement alone. The plan's suggested
`attachedExternIsUndefinedArm`-style preregistration widening was consequently
**not needed and not added**: that recognition exists because F1's migrations
removed the raw `call` the detectors keyed on, whereas this slice leaves the
front-end call shape untouched (`prepareStrings`'s own compare detector at
`integration.ts:7034-7040` still sees exactly what it saw before). Recorded as a
divergence below.

**P2 — adapters.** Both take the explicit disabled policy, one line each:
`linear-integration.ts` `prepareLinearIntrinsicFunctions` and
`stdlib-selfhost.ts`'s per-definition freeze. Note honestly what that does and
does not mean: **on the linear lane the disabled policy is inert**, because that
adapter never passes `stringCompareDemand` and resolves the compare through its
own resolver (`linear-integration.ts:1502` → `__str_cmp`). The row is stated so
the frozen policy is total and no adapter inherits a host decision by omission —
the same status `numberBoundary`/`booleanBoundary` already have there. Budget
rationale added to this file's frontmatter in the F1-S2/S3/S4 pattern; no new
path was needed.

**P3 — outcome-pin shift: ONE pin moved, and it is the precedented one.**
- `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-443` — the
  whole-shape frozen-policy equality now also sees `stringCompare`. Identical
  mechanical consequence to F1-S1's `numberBoundary`, F1-S2's `booleanBoundary`,
  F1-S3's `generatorNumberBox` and F1-S4's `externIsUndefined`.
- `tests/issue-3520-callable-provider-abi.test.ts` "binds one string-compare
  intrinsic to the mode-selected import or definition" — **did NOT move.**
  Measured, not assumed: it passed unchanged. It asserts the resolved Program-ABI
  slot, and the slot is identical because the physical target is.
- `tests/issue-3526-ir-runtime-manifest.test.ts` — **did not move**; it carries
  no whole-shape policy assertion.
- **The divergence-4 class is EMPTY for this slice.** No owner changes demote
  site anywhere in the byte matrix: the integration policy resolves the compare
  to a supported arm on every lane (`nativeStrings ? native : host` is total),
  so the `"unsupported"` arm is unreachable in production, exactly as F1-S3's and
  F1-S4's were. Its absence is an assertion here, not an omission — the
  `irOutcomes` records are byte-compared in all 30 cells below.

**P4 — census: `pnpm run check:ir-fallbacks` output is DIFFED and IDENTICAL.**
Run on both trees (`git checkout -- src` for the base, patch re-applied after),
`diff` clean. Neither baseline bucket moved: `unintended: {}` stays empty,
`deferred: {"string-builder-candidate": 2}` unchanged, module-level and
post-claim both `(none)`. `scripts/linear-ir-baseline.json` is untouched
(`git status` clean on `scripts/` apart from the sanctioned two-line citation
refresh recorded below), so the `tests/issue-4550-linear-ir-census.test.ts`
byte-exact pin holds — that suite was run and passes.

### What landed

- **`src/ir/intrinsics.ts`** — `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE`, the
  `(externref, externref) -> i32` ABI shared by both arms. No new `IntrinsicId`:
  this family has no intrinsic instruction.
- **`src/ir/runtime-host-capabilities.ts`** — one record `string.compare` →
  `env.string_compare`, inserted in capability-ID sort order. Noted in place: the
  first record whose physical import is a base import, not a union member or a
  late registration.
- **`src/ir/runtime-manifest.ts`** — `StringComparePolicy`
  (`compare: "host" | "native" | "unsupported"`), a frozen
  `STRING_COMPARE_POLICY_DISABLED`, the optional `stringCompare` field
  canonicalized at builder construction and published resolved on the frozen
  manifest, the `js.string.compare` feature row, the two provider rows
  (`host.…` → `host-callable` on capability `string.compare`; `native.…` →
  `runtime-callable` on `__str_compare`), and the `#selectProvider` branch whose
  unavailable arm is a typed `provider-target-unavailable` naming the feature and
  the resolved policy.
- **`src/ir/intrinsic-support.ts`** — the `stringCompareDemand` input (and its
  place in the "freeze nothing at all" guard) plus `preparedStringCompareProvider`.
- **`src/ir/integration.ts`** — `integrationStringComparePolicy`
  (`{ compare: ctx.nativeStrings ? "native" : "host" }`, the exact former truth
  table), `irStringCompareDemand`, the owner-local `unsupported` partition in the
  same pass as the four F1 ones, the freeze-time policy + demand arguments, the
  prepared manifest threaded in place of its providers map, and the rewritten
  resolve arm.
- **`src/ir/lower.ts`** — the `forof.string` `??` fallback is gone, replaced by
  `requirePreparedStringProvider`, the string family's twin of F1-S4's
  `requirePreparedGeneratorProvider`.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_COMPARE_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-string-boundary-compare.test.ts`** (new, 21 tests).

`src/ir/from-ast.ts` needed **no edit** — the #2955 gate already holds there and
the seam was already lane-free in the front-end; this slice governs the
resolve-time table, not the emission. `src/ir/string-support.ts`,
`src/ir/backend/legality.ts` and the preregistration trigger needed no edit
either (see the divergence below).

### Sub-B totality — re-proved, and the linear half is NOT the plan's argument

The plan justified sub-B by "`attachIrStringSupport` attaches the provider
unconditionally on every adapter that prepares strings, including the linear
adapter at `linear-integration.ts:735-737`". **The first half holds; the second
does not, and the retirement is safe for a different reason.** Measured:

- **WasmGC path — total as stated.** `prepareStrings` (`integration.ts:7111-7126`)
  runs `attachIrStringSupport` over EVERY healthy owner, and
  `irStringCallableProviderRef` returns a non-`undefined` ref for `forof.string`
  unconditionally (`string-support.ts:72-73, 132-148`).
- **Linear path — the plan's citation is conditional.** `linear-integration.ts`
  calls `attachIrStringSupport` only `if (usesRepeat)` (`:733-740`), so a linear
  owner with a `forof.string` and no `string.repeat` would get NO attachment.
  That is harmless only because **`forof.string` is absent from the linear
  instruction allowlist** (`src/ir/backend/legality.ts:230-320`), so such an owner
  demotes at the function-lowering boundary and never reaches `lower.ts`. The
  `FOROFSTR::linear` byte cell is in the matrix precisely to hold that line: it
  is unchanged.
- **`stdlib-selfhost.ts`** lowers its own IR with its own resolver and no string
  attachment pass, but its self-hosted bodies carry no `forof.string`; its cells
  are covered by the whole-module byte parity below.

### Measured neutrality

**Byte parity — 30 of 30 cells identical, WAT included.** Six fixtures × five
lanes (gc-host, gc-native-strings, standalone, WASI, linear), compiled before and
after **on the same tree** (the source patch was captured, reverted with
`git checkout -- src`, re-measured, and re-applied), compared on byte length,
binary sha256, import set AND order, full emitted WAT text, the error list, and
the `irOutcomes` records.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `STRCMP` (`a < b`) | 157 ✓ | 22652 ✓ | 22816 ✓ | 22843 ✓ | 4876 ✓ |
| `STRCMP4` (all four operators) | 270 ✓ | 22540 ✓ | 22704 ✓ | 22731 ✓ | 4988 ✓ |
| `STRMIX` (compare beside concat/eq/len) | 316 ✓ | 22936 ✓ | 23100 ✓ | 23127 ✓ | 4956 ✓ |
| `FOROFSTR` (sub-B) | 1351 ✓ | 22669 ✓ | 49119 ✓ | 49146 ✓ | 4960 ✓ |
| `BOTH` (both sub-slices, one module) | 1504 ✓ | 22902 ✓ | 49352 ✓ | 49379 ✓ | 4989 ✓ |
| `CLEAN` (control, no strings) | 113 ✓ | 21973 ✓ | 22588 ✓ | 22615 ✓ | 4874 ✓ |

(✓ = bytes, sha256, imports, WAT, errors and IR outcomes all identical
before/after.) **No purity class appears and none was expected**: this slice adds
no semantic `intrinsic` instruction, so the effects-aware scheduler sees exactly
the same call it saw before. Any WAT delta would have been a defect; there is
none.

**Imports and order.** Identical in all 30 cells. The `STRCMP` gc-host list is
exactly `["env.string_compare"]` — pinned as an ordered array in the new suite,
which is the assertion that would catch a late registration before a byte diff
did. The three native-strings lanes carry no compare import at all
(`gc-native-strings` carries only the `__str_*` memory-bridge trio; standalone,
WASI and linear carry none).

**The migrated arm is REACHED — measured, not assumed.** With a temporary probe
on the arm, the 30-cell run resolves it **15** times: 3 host
(`{arm:"host",field:"string_compare"}`, the three gc-host compare fixtures) and
12 native (`{arm:"native",symbol:"__str_compare"}`, four fixtures × three
native-strings lanes). `BOTH::gc-host` does not reach it because that owner
demotes at IR selection for an unrelated reason, identically on both trees.

**Runtime oracle.** All four relational operators are checked against JavaScript
on seven input pairs (`a/b`, `b/a`, `a/a`, `""/a`, `""/""`, `ab/abc`, `Z/a`)
through an instantiated host-lane module. Nothing about the answers moved.

**Census.** `pnpm run check:ir-fallbacks` output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

### Non-vacuity — each sub-slice reverted independently against the kept schema

- **sub-A**, reverting ONLY the resolve arm to its `ctx.nativeStrings` read:
  **3 tests fail** — "consults the prepared string-compare provider", "reads NO
  lane discriminator", and "fails closed rather than falling back to a locally
  decided symbol". All 10 schema/policy pins and every end-to-end, import-order,
  runtime-oracle and byte assertion stay green.
  **Those three pins are deliberately SOURCE-shape assertions, and that is a
  finding worth stating plainly rather than hiding behind a green suite.** A
  behavioural pin cannot separate the migrated arm from the one it replaced: the
  policy projection reproduces the old truth table exactly, so both forms emit
  identical bytes on every lane — which is the whole point of the slice and the
  reason all 30 cells are unchanged. What actually moved is WHICH authority
  answers, and on this seam that is only observable in source. The pins use the
  established `tests/issue-2955-depolymorph-gate.test.ts` grep-gate idiom, scoped
  to the one arm. F1-S4's sub-B had a behavioural revert signal available (the
  reverted arm put a host import into a standalone module); this seam has none,
  and manufacturing one would have meant changing behaviour.
- **sub-B**, restoring the `??` fallback: exactly **1** test fails — "refuses to
  lower an unattached `forof.string`" — while the attachment pin, the
  already-attached-provider pin and the end-to-end iteration pin stay green.

### Divergences from the plan (recorded, not widened)

1. **No preregistration/attached-target recognition was added.** The plan
   specified per-demand recognition modeled on `attachedExternIsUndefinedArm`.
   It is not needed and adding it would have been dead code: that mechanism
   exists because F1's from-ast migrations DELETED the raw `call` the detectors
   keyed on, whereas this slice does not touch the front-end at all.
   `prepareStrings`'s compare detector still matches the identical instruction.
   Byte-confirmed by the 30 identical cells, including their import order.
2. **The manifest is threaded to the resolve site, rather than a callable being
   attached at a preparation seam.** The compare is a plain `call`, not a
   `string.*` IR instruction, so it has no provider slot to attach to. The
   threading changes the parameter of `resolveAndObserveCallableProvider`,
   `makeResolver` and `preregisterCallableProviders` from
   `preparedRuntimeManifest?.providers` to `preparedRuntimeManifest`; the
   providers map is re-derived on the first line, so every other arm is untouched.
3. **`preparedStringCompareProvider` returns an arm classification, not an
   `IrFuncRef`** — unlike `preparedGeneratorNumberBoxProvider`. The two arms have
   different existing materializers; see P1.
4. **The plan's sub-B totality citation for the linear adapter is conditional.**
   Corrected above with the real argument (the legality allowlist). The
   retirement is still safe; the reason recorded in the plan was not.
5. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` — the precedented
   whole-shape policy pin.
6. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned exception,
   handled as the four prior checkpoints prescribe. No verdict, kind, placement,
   ratchet count or `settledBy` rationale changed — established by normalising
   both JSON documents and diffing those, which isolates exactly **TWO** citation
   lines (`forof.string` `src/ir/integration.ts` 6243 → 6327; `string.len`
   `src/ir/backend/linear-integration.ts` 1624 → 1626). Patched surgically:
   committing the regenerator's output instead would have been a 524-line diff
   (it reformats every `evidence` array) for a 2-line change.

### Validation run

Green: TypeScript 7 typecheck; `check:ir-fallbacks` (bare, output-identical);
the ratchet chain bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)` —
loc (+301 net src LOC, every path granted by this file's frontmatter), func,
coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh above), `lint`, and
`check:standalone-ir-cutover-corpus` (`records=5/5`, `sources=5`, `units=47`).
Focused suites: **233 passing across 17 files** — all seven #3526 suites
(including the new one), both async suites (#4103/#4104), #3520, #2955,
#3518, #3502, #4550 linear-ir census, #1183 and #3167 (the string relational
suite this seam serves).

### Not touched (per the plan's scope discipline)

The `wasm:js-string` and `string_constants` capability-schema widenings (their
own slice — `string.concat`/`eq`/`len`/`const` stay un-governed and their
resolve-table rows keep reading `ctx.nativeStrings`); `stringMethodPlan`;
`String()` coercion; `stringForOfPlan` / `charReadPlan` strategy queries; the
`__concat_N`, repeat and charAt resolve-table families; `src/ir/from-ast.ts`;
the `extern.*` lowering quartet (family 6); and `numberBoundary` /
`booleanBoundary` / `externIsUndefined` / `generatorNumberBox`, all four
unchanged. `scripts/*-baseline.json` is untouched apart from the sanctioned
two-line `check:ir-kind-neutrality` citation refresh.

## 2026-09-01 F2-S2 implementation plan — capability-record schema widening (family 2, slice 2)

Grounded on `origin/main` `dc29e1f15d` (first parent = PR #5433, the merged
F2-S1). Slice claim: `#3526:f2s2` (`ttraenkler/fable-ir-takeover`). Three
probe lanes (schema+consumers / boundary sites / test-evidence) ran against
that commit; every line number below is theirs.

**This slice moves NO boundary.** It widens the central capability-record
schema so that family 2's remaining host crossings — which live in the
`wasm:js-string` module and in `string_constants` / `string_constants16`
GLOBAL imports — become *expressible* as exact-ABI catalogue rows. No policy
field, no provider row, no resolve/attach/from-ast edit. Byte identity holds
by construction: no provider references the new rows, so `freeze()`
(`runtime-manifest.ts:1430-1446`) never selects them and every frozen
manifest, import and body stays exactly as today. This is what makes the
issue's anti-vacuity item 10 ("typed projections include intentional
non-`env` string import namespaces", :856-857) satisfiable at all — today
the record type cannot spell a non-`env` namespace.

### The frozen schema, measured (`src/ir/runtime-host-capabilities.ts`)

- Record type `:72-83`: `module: "env"` (`:77`), `kind: "func"` (`:79`),
  `params`/`results` over the value union `"externref" | "i32" | "f64"`
  (`:54`, set `:56-60`); factory `record()` `:85-101` hardcodes both literals;
  12 ids `:27-40` (F2-S1's `string.compare` at `:39`, row `:140`);
  `assertRuntimeHostCapabilityRecord` `:189-223` checks the exact key list
  (`:204-206`), `module` (`:207-209`), `field` (`:210-212`), `kind`
  (`:213-215`), value types (`:216-217`), exception policy (`:218-222`);
  `canonicalizeRuntimeHostCapabilityCatalog` `:236-253` demands completeness
  (ids ↔ rows). No `Record<Id,…>` table or `never`-check here — completeness
  is dynamic (`:248-251`).
- Consumers that ASSUME func-kind (each must gain a kind guard or narrow
  type): `intrinsic-support.ts` `ADMITTED_CALLABLE_TARGETS` `:84-90`,
  `providerAttachment` `:229-230`, `preparedGeneratorNumberBoxProvider`
  `:274-278`, `preparedStringCompareProvider` `:309-313`, async adapters
  `:521-529`; `async-runtime-providers.ts` `asAsyncHostAdapter` `:90-100`
  iterates `[...params, ...results]` unguarded (`:94-98`) and the
  `AsyncHostAdapter` alias `:83`; `runtime-manifest.ts` `host-callable`
  implementation `:366-376` admits any id; provider index checks
  `:1484-1509` never verify func-kind; `ir-async-runtime-adapters.ts`
  `expectedSignature` `:27-33` / `assertImportSignature` `:35-` (typed on the
  narrow async union — unaffected if `AsyncHostAdapter` is retargeted to the
  func arm).
- Two measured facts that shape the design:
  1. **`wasm:js-string.concat` returns `(ref extern)`**, not `externref`
     (`imports.ts:628`; binary dump `(result (ref extern))`; `substring`
     `:649-653` likewise). The value union must grow `"ref_extern"` (already a
     `ValType` member, `src/ir/types.ts` after `:265`).
  2. **`string_constants` globals use the literal itself as the import
     field** (`imports.ts:177` `importName = useSurrogateNs ? hexCodeUnits(value) : value`;
     measured `string_constants."f"`, `"ab"`, `""`; lone surrogates go to
     `string_constants16` keyed by `hexCodeUnits`, `STRING_CONSTANTS16_NS`
     `src/string-surrogate.ts:20`). A closed catalogue cannot enumerate
     per-literal fields, so a global record carries a **field scheme**, not a
     field name.

### Contract

1. **Kind-discriminated record union.**
   ```ts
   type RuntimeHostCapabilityFuncModule = "env" | "wasm:js-string";
   type RuntimeHostCapabilityGlobalModule = "string_constants" | "string_constants16";
   interface RuntimeHostCapabilityFuncRecord<Id, V>   { capability: Id; module: FuncModule;   field: string; kind: "func";   params: readonly V[]; results: readonly V[]; exceptionPolicy?: … }
   interface RuntimeHostCapabilityGlobalRecord<Id, V> { capability: Id; module: GlobalModule; field: { scheme: "literal" | "literal-utf16-hex" }; kind: "global"; valueType: V; mutable: boolean }
   type RuntimeHostCapabilityRecord<Id, V> = Func | Global;
   ```
   Module unions are **closed** (`as const` tuple → union, the `:27-42`
   idiom) and live on the kind arm, so `env.<global>` and
   `wasm:js-string.<global>` are unrepresentable. Value union `:54` grows
   `"ref_extern"` (+ set `:56-60`). Factories: `funcRecord(capability, module,
   field, params, results, exceptionPolicy?)` (the 12 existing rows pass
   `"env"`; `record()` may remain as an `env`-defaulting alias so existing
   call sites and tests are untouched) and
   `globalRecord(capability, module, fieldScheme, valueType, mutable)`.
2. **New ids + rows (sorted; catalogue stays complete):**
   - `funcRecord("string.char_code_at", "wasm:js-string", "charCodeAt", ["externref","i32"], ["i32"])` (`imports.ts:640-645`)
   - `funcRecord("string.concat", "wasm:js-string", "concat", ["externref","externref"], ["ref_extern"])` (`:628`)
   - `funcRecord("string.eq", "wasm:js-string", "equals", ["externref","externref"], ["i32"])`
   - `funcRecord("string.len", "wasm:js-string", "length", ["externref"], ["i32"])`
   - `globalRecord("string.const", "string_constants", { scheme: "literal" }, "externref", false)` (matches `addStringConstantGlobal`, `imports.ts:179-183`: `{kind:"global", type:externref, mutable:false}`)
   - `globalRecord("string.const.utf16", "string_constants16", { scheme: "literal-utf16-hex" }, "externref", false)`
   Each row's ABI is pinned against the registration site it names
   (`addStringImports` `imports.ts:627-664`; `addStringConstantGlobal`
   `:179-183`/`:224-228`) — a catalogue-level equality, no emission.
3. **Validator grows kind arms**: key list per kind (`func`: today's six ±
   `exceptionPolicy`; `global`: `capability, field, kind, module, mutable,
   valueType`); module membership checked against the arm's union (a
   runtime twin of the type — "unknown host capability module/kind" is a
   pinnable message, distinct from the equality rejections); `global` arm
   compares `field.scheme`, `valueType` (via `assertValueTypes`), `mutable`;
   `exceptionPolicy` is func-only.
4. **Fail-closed kind guards** at every func-assuming consumer (list above):
   `kind !== "func"` ⇒ throw naming the capability ("not a callable host
   capability"). Prefer the type-level narrowing for `host-callable`
   (`capability: Extract<…, func ids>`) so a global id in a provider row is a
   compile error; keep the runtime check in `#indexProviders` (`:1484-1509`)
   as the twin. `asAsyncHostAdapter` gets the guard BEFORE `:94`;
   `AsyncHostAdapter` (`:83`) retargets to the func arm.
5. **Nothing else moves**: no `IrIntrinsicProvider` global arm
   (`nodes.ts:856-860` — a global capability attaches as an `IrGlobalRef` on
   `IrInstrStringConst.storage`, a later slice's concern), no policy field
   (the `tests/issue-4104…:432-445` whole-shape pin does not move), no
   provider row, `integration.ts:6284` / `:7142` keep reading
   `ctx.nativeStrings` (pin that they do — the F1-S4 grep-gate idiom, so a
   reviewer cannot mistake this slice for the move).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — un-requested ids**: grep `scripts/` and `src/` for any gate
  asserting "every capability id is requested by some provider" (none found
  in `runtime-manifest.ts`; `scripts/` unverified). If one exists, name it
  and decide: exempt the family-2 rows explicitly or sequence the first
  provider row (F2-S3) into this PR — do NOT silently weaken the gate.
- **P2 — `ref_extern` reach**: confirm the widened value type cannot leak
  into `lowerAdapterType` (`ir-async-runtime-adapters.ts:19-21`, typed on
  the narrow async union) and that `assertValueTypes` accepts it only where
  a row declares it.
- **P3 — key-order canonicalization**: the `semanticView` helper
  (`tests/issue-3526-ir-runtime-manifest.test.ts:88-97`) serializes
  `hostCapabilityRecords` verbatim — verify the reversed-catalogue
  canonicalization pin (`:440-452` idiom) stays byte-equal with the new
  rows present, i.e. sorting is by id and the new rows land in a stable
  position.
- **P4 — F2-S3 handoff**: record the exact split of the eq arm out of
  `integration.ts:6277-6296` and the `stringEq` policy shape (`{eq: "host" |
  "native" | "unsupported"}`, projected `nativeStrings ? native : host`) as
  the next slice's starting point — no code for it in this PR.

### Verification matrix

- **V-A byte cells**: the F2-S1 six fixtures (`STRCMP`, `STRCMP4`,
  `STRMIX`, `FOROFSTR`, `BOTH`, `CLEAN`) **plus a literal-heavy `CONST`
  fixture** (so the `string_constants`/`string_constants16` global path is in
  the matrix) × five lanes (gc-host, gc-native-strings, standalone, WASI,
  linear), before/after on the same tree: byte length, sha256, import set
  AND order, full WAT, error list, `irOutcomes` — **100 % identical**; any
  delta is a defect.
- **V-B schema pins** (new `tests/issue-3526-string-boundary-schema.test.ts`,
  the F1/F2 per-slice anatomy, header stating the slice moves no boundary):
  each new row resolves via `resolveRuntimeHostCapabilityRecord` to the exact
  literal (whole-shape `toEqual`) and is canonical (`toContain` identity
  `:282-284` idiom); reversed-catalogue canonicalization byte-equal; async
  projection excludes the new ids and `asAsyncHostAdapter` throws on a global
  record; a Math-only / async-only / compare-only manifest's
  `hostCapabilityRecords` is free of the new rows; validator rejections for
  `env`+`global`, `wasm:js-string`+`global`, `string_constants`+`func`, wrong
  `mutable`, wrong `valueType`, wrong scheme, unknown module, unknown kind;
  every func-assuming consumer throws (not misbehaves) on a global id.
- **V-C exhaustiveness lives in `src/`**: `tsconfig` excludes `tests/`, so
  `@ts-expect-error` in a test is unenforced — closedness is enforced by the
  `as const`-tuple unions and factory parameter types under `pnpm run
  typecheck` (the `quality` gate), with the runtime membership check as the
  vitest-pinnable twin.
- **V-D revert non-vacuity**: reverting the widening fails exactly the new
  file's pins and **0 tests elsewhere** — record that count as the measured
  baseline (the probes' Exp 1/2 showed a no-pin revert fails 0 tests, which
  is why the slice's own pins are its only observability).
- **V-E** the five ratchet gates chained bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)`; `runtime-manifest.ts` is
  already over the 1500-line god-file threshold (1670), so any growth needs
  the dated `loc-budget-allow` rationale block (the `:123-140` template; all
  four likely-touched paths already carry grants at `:78-80`, `:94`);
  controls run unchanged: `issue-2955-depolymorph-gate`,
  `issue-3502-string-contract`, `issue-3518-string-repeat-ir`, `issue-3167`,
  `issue-1183`, `issue-4550-linear-ir-census` (baseline byte-pin), both
  async suites, all #3526 suites, `#3520` callable-provider-abi.

### After this slice (ranked, from the boundary probe)

| rank | boundary | why |
| --- | --- | --- |
| **F2-S3** | `string.eq` | one import, one native symbol (`__str_equals`), no mode sub-arm, ABI in the existing union (only the module axis is new); resolve arm = F2-S1's shape verbatim; demand = `string.eq` instr scan; policy `stringEq` |
| F2-S4 | `string.len` | host arm trivial; native struct-field arm needs manifest provider vocabulary |
| F2-S5 | `string.concat` | `owned-append` sub-arm, `__concat_N` late-import sibling, `string-builder-candidate` census bucket |
| later | `charCodeAt` | `host-capability` two-record provider behind a defined helper (`char-code-at-helpers.ts:173-224`) |
| later | `string.const` | global kind, derived field, two namespaces, oversized materializer, legacy pre-pass ordering |

Out of scope here: every resolve-table arm (`integration.ts:6186-6347`),
`stringMethodPlan`, `String()` coercion, `src/ir/from-ast.ts`, the
`host-import-policy.ts:283-286` classifier (retire once records are typed),
and `import-manifest.ts:337`'s `env`-only walk.

---

## 2026-09-01 F2-S2 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s2-schema-widening`, grounded on `origin/main`
`dc29e1f1` (the merged F2-S1, PR #5433), slice claim `3526:f2s2`. Implemented
from the 2026-09-01 F2-S2 plan. **The slice moves no boundary**: not one
resolve arm, provider row, policy field or emitted import changed, and the
35-cell byte matrix below is 100 % identical.

### Probe answers

**P1 — un-requested ids: NO such gate exists, in `scripts/` OR `src/`. Nothing
was weakened, and nothing had to be sequenced forward.** Measured, not assumed:
the full reference set of the capability catalogue is eleven files
(`grep -rn "RUNTIME_HOST_CAPABILITY_IDS\|RUNTIME_HOST_CAPABILITY_RECORDS\|isRuntimeHostCapabilityId\|hostCapabilityRecords" src/ scripts/ tests/`),
and **`scripts/` contributes zero** — no gate reads the catalogue at all. The
one completeness demand in the codebase is
`canonicalizeRuntimeHostCapabilityCatalog` (`runtime-host-capabilities.ts`),
and it is **ids ↔ rows, not ids ↔ providers**: it fails when a catalogue omits
a declared id, never when a declared id goes un-requested. The frozen
manifest's `hostCapabilityRecords` is built the other way round — from the
capabilities that SELECTED providers request (`runtime-manifest.ts`
`#buildManifest`) — so an un-requested row is structurally invisible to
`freeze()`. That is exactly why this slice is byte-neutral by construction and
not by luck, and it is now pinned rather than argued: the new suite asserts
that no provider row names any of the six ids, and that Math-only, async-only
and compare-only manifests carry none of them.

**P2 — `ref_extern` cannot reach `lowerAdapterType`, on two independent
barriers.** `lowerAdapterType` (`src/codegen/ir-async-runtime-adapters.ts:19`)
is typed on `AsyncHostAdapterValueType`, which stays the narrowed
`"externref" | "i32"` — the F1-S1 note about `f64` applies verbatim to
`ref_extern`. The only route into an `AsyncHostAdapter` is
`asAsyncHostAdapter`, whose value-type loop rejects anything outside that pair
by name. Separately, `assertValueTypes` admits a value type only when it BOTH
equals the expected entry positionally and is a member of
`RUNTIME_HOST_CAPABILITY_VALUE_TYPES`, so `ref_extern` is accepted only where
a row declares it — today that is `string.concat`'s result and nothing else,
which the suite pins as an exhaustive scan of the catalogue rather than a
spot-check.

**P3 — key-order canonicalization holds; the sort is by id and the new rows
land in a stable position.** `compareCapabilityRecords` sorts on the capability
string, so the six ids interleave deterministically:
`number.unbox` < `string.char_code_at` < `string.compare` < `string.concat` <
`string.const` < `string.const.utf16` < `string.eq` < `string.len`. Pinned two
ways: `canonicalizeRuntimeHostCapabilityCatalog` of the **reversed** catalogue
is `JSON.stringify`-equal to the forward one AND element-identical by object
reference; and the sorted id list is asserted verbatim at 18 entries. The
`semanticView` helper (`tests/issue-3526-ir-runtime-manifest.test.ts`) is
unaffected for a different and stronger reason than ordering — it serializes
`manifest.hostCapabilityRecords`, which contains only requested capabilities,
and no new row is ever requested. That suite passes unchanged.

**P4 — F2-S3 handoff, recorded exactly.** The eq arm is **not** a standalone
arm today: `integration.ts:6279-6296` is a THREE-symbol branch
(`IR_STRING_CONCAT_FN || IR_STRING_CONCAT_OWNED_FN || IR_STRING_EQUALS_FN`)
whose single `if (ctx.nativeStrings)` picks between
`nativeStrHelperHandle(ctx, "__str_concat" | "__str_concat_owned" | "__str_equals")`
and `exactCallableImportIndex(ctx, "wasm:js-string", "concat" | "equals")`.
F2-S3's first move is therefore a SPLIT, not a rewrite: lift
`symbol === IR_STRING_EQUALS_FN` into its own `else if` above the concat pair,
leaving the two concat symbols on the untouched lane read, then migrate only
the lifted arm. The policy shape is F2-S1's verbatim:
`StringEqPolicy = { eq: "host" | "native" | "unsupported" }`, projected
`ctx.nativeStrings ? "native" : "host"` (the exact former truth table), two
provider rows (`host.js.string.eq` → `host-callable` on capability
`string.eq`, whose record this slice already provides; `native.js.string.eq` →
`runtime-callable` on `__str_equals`), demand from a `string.eq` instruction
scan, and `STRING_EQ_POLICY_DISABLED` passed explicitly by the linear and
self-hosted-stdlib adapters. No code for any of that is in this PR.

### What landed

- **`src/ir/runtime-host-capabilities.ts`** (+239 net, the whole slice) — the
  id union split into `RUNTIME_HOST_CAPABILITY_FUNC_IDS` (16) and
  `RUNTIME_HOST_CAPABILITY_GLOBAL_IDS` (2) with `RUNTIME_HOST_CAPABILITY_IDS`
  as their sorted merge; closed per-kind module unions
  (`env | wasm:js-string` for func, `string_constants | string_constants16`
  for global), a closed kind tuple and a closed field-scheme tuple, each with
  its runtime `Set` twin; `RuntimeHostCapabilityValueType` grown by
  `ref_extern`; `RuntimeHostCapabilityFuncRecord` /
  `RuntimeHostCapabilityGlobalRecord` and their union;
  `funcRecord` / `globalRecord` factories with `record()` retained as the
  `env`-defaulting alias so the twelve existing rows are literally unchanged;
  the six new rows; a per-kind validator (`assertGlobalCapabilityRecord` for
  the global arm) with kind/module/field-scheme membership checks; and the
  shared `asCallableRuntimeHostCapabilityRecord` guard plus
  `resolveRuntimeHostCapabilityFuncRecord`.
- **`src/ir/runtime-manifest.ts`** (+20) — `host-callable`'s `capability`
  narrowed from `RuntimeHostCapabilityId` to `RuntimeHostCapabilityFuncId`
  (the type-level `Extract` the plan asked for, spelled as the id half so it
  actually narrows), and its runtime twin in `#indexProviders`.
- **`src/ir/intrinsic-support.ts`** (+3) — `ADMITTED_CALLABLE_TARGETS`,
  `providerAttachment`, `preparedGeneratorNumberBoxProvider` and
  `preparedStringCompareProvider` all routed through
  `resolveRuntimeHostCapabilityFuncRecord`. The file now contains no
  unguarded `resolveRuntimeHostCapabilityRecord(` call, which the suite
  ratchets.
- **`src/ir/async-runtime-providers.ts`** (+13) — `AsyncHostAdapter`
  retargeted to `RuntimeHostCapabilityFuncRecord<AsyncHostCapabilityId, …>`;
  `asAsyncHostAdapter` takes the kind guard immediately after the id filter
  and before the value-type walk.
- **`src/ir/async-plan.ts`** (+3) — see the divergence below.
- **`tests/issue-3526-string-boundary-schema.test.ts`** (new, 33 tests).

Nothing else was touched: no policy field, no provider row, no
`IrIntrinsicProvider` global arm, no resolve/attach/from-ast edit.

### One divergence from the plan (recorded, not widened)

**A sixth guard site the plan's enumeration missed: `async-plan.ts`'s
adapter-parity loop.** `assertPreparedIrAsyncRuntimeCurrent` filters
`manifest.hostCapabilityRecords` by the requested capability set and then
builds `irImportFuncRef(record.module, record.field, record.field)` from the
result — a func-assuming read on a value typed as the union. It is not in the
plan's list (which named `intrinsic-support.ts`, `async-runtime-providers.ts`
and `runtime-manifest.ts`), and leaving it out would have been a type error,
not a silent gap, so the omission was caught the moment the union landed. Fixed
in the plan's own idiom — `asCallableRuntimeHostCapabilityRecord(records[index]!)`,
identity-preserving so the `adapter.record !== record` comparison two lines
down is unaffected. `src/ir/async-plan.ts` is the one path added to
`loc-budget-allow`; at 1285 lines it is far under the god-file threshold.

Two things the plan allowed that were **not** needed: no `Extract<>` gymnastics
on the record type (declaring the id union in two halves narrows
`host-callable` directly and reads better), and no separate `AsyncHostAdapter`
compatibility shim (retargeting the alias to the func arm was a one-line
change that every downstream consumer already satisfied — `pnpm run typecheck`
is green with **zero** edits outside the five files above).

### V-A — measured neutrality: 35 of 35 cells identical

Seven fixtures (the F2-S1 six plus the plan's literal-heavy `CONST`) × five
lanes, compiled before and after **on the same tree** (the five source files
were snapshotted, reverted from `HEAD`, re-measured, and restored; the restored
files were `diff`-verified byte-equal to the snapshots). Each cell compares
byte length, binary sha256, the ORDERED import list, the **full emitted WAT
text**, the error list, the `irOutcomes` records and the string pool — deep
JSON equality, not a spot-check.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `STRCMP` (`a < b`) | 157 ✓ | 22652 ✓ | 22816 ✓ | 22843 ✓ | 4876 ✓ |
| `STRCMP4` (all four operators) | 270 ✓ | 22540 ✓ | 22704 ✓ | 22731 ✓ | 4988 ✓ |
| `STRMIX` (compare beside concat/eq/len) | 338 ✓ | 22961 ✓ | 23125 ✓ | 23152 ✓ | 4982 ✓ |
| `FOROFSTR` | 1351 ✓ | 22669 ✓ | 49119 ✓ | 49146 ✓ | 4960 ✓ |
| `BOTH` | 1440 ✓ | 22924 ✓ | 49374 ✓ | 49401 ✓ | 4983 ✓ |
| `CLEAN` (control, no strings) | 113 ✓ | 21973 ✓ | 22588 ✓ | 22615 ✓ | 4874 ✓ |
| `CONST` (literals + `charCodeAt`) | 619 ✓ | 22855 ✓ | 23019 ✓ | 23046 ✓ | 6007 ✓ |

(The fixture SOURCES are this lane's reconstructions from the F2-S1
checkpoint's descriptions, not that slice's byte-identical files — three of the
gc-host numbers differ slightly from its table for that reason. It does not
weaken the measurement: parity is before/after on the same tree, and the six
descriptions are reproduced exactly.)

**The `CONST` fixture earns its place — it is the only cell that reaches the
global path at all.** Its gc-host module imports
`string_constants."" / "f" / "ab" / "abc" / "de" / "abcde" / …`,
`string_constants16."d800"` (the lone-surrogate route, #2880), and
`wasm:js-string.{length,charCodeAt}`; `STRMIX::gc-host` supplies
`wasm:js-string.{concat,equals}`. So every one of the six new rows has its
registration site inside the matrix. Note also that `result.imports` covers
only `env` FUNC descriptors — the `wasm:js-string` and `string_constants*`
imports appear **only** in the WAT — which is why the WAT text is compared in
full rather than the import array alone; an import-array-only matrix would
have been blind to exactly this slice's subject matter.

### V-B / V-C — the pins, and where exhaustiveness actually lives

33 tests in `tests/issue-3526-string-boundary-schema.test.ts`, in eight
sections: the kind-discriminated schema (disjoint/total id halves, closed
per-kind module namespaces, the `ref_extern` widening scanned exhaustively);
the six rows whole-shape plus canonical object identity; the ABI **measured**
against the registration site; the no-provider-selects-them argument; the
async projection; the validator's cross-kind rejections; the fail-closed
guards; and the boundary-did-not-move pins.

**The ABI section is a measurement, not a restatement.** Rather than
re-typing `addStringImports`'s literals, it compiles a host-lane module through
`generateModule(analyzeSource(...))` and compares each record against the type
the compiler actually registers — `module.types[import.desc.typeIdx].params /
.results` for the four `wasm:js-string` rows, and the full
`{kind:"global", type:{kind:"externref"}, mutable:false}` descriptor for both
global namespaces — including that `hexCodeUnits("\uD800") === "d800"` is the
field the `literal-utf16-hex` scheme actually produces and that a
surrogate-free literal never lands in `string_constants16`.

**V-C — exhaustiveness is enforced in `src/`, and that was verified by a
negative probe rather than asserted.** `tsconfig` excludes `tests/`, so a
`@ts-expect-error` in the suite would prove nothing. A temporary
`src/zz-f2s2-probe.ts` (deleted; it is not in the diff) asked
`pnpm run typecheck` for five illegal constructions and got five errors:
`.params` on the union (TS2339, naming the global arm),
`{kind:"host-callable", capability:"string.const"}` (TS2820),
`RuntimeHostCapabilityFuncModule = "string_constants"` and
`RuntimeHostCapabilityGlobalModule = "env"` (TS2322 each), and
`RuntimeHostCapabilityValueType = "i64"` (TS2322). The runtime membership
checks in the validator are the vitest-pinnable twins of those five.

### V-D — non-vacuity: 24 of 33, and 0 elsewhere

Reverting **only** the widening (all five source files back to `HEAD`, the new
suite kept) fails **24** of the new file's 33 tests and **0 tests anywhere
else** — the 17 control suites are 233/233 green on the reverted tree, and
266/266 (233 + 33) with the widening restored.

The **9** that still pass on the reverted tree are named rather than hidden,
because they are the honest ones:

- three **boundary-did-not-move** pins (`integration.ts` still reads
  `ctx.nativeStrings` at the concat/eq arm, at the `string.len` provider and in
  `storageForConst`). These are *supposed* to hold on both trees — they assert
  what this slice deliberately did NOT do, and they are the pins that will fire
  in F2-S3/S4 when the arms move. A pin that passes before and after is vacuous
  only if it was meant to detect the change; this one is meant to detect its
  absence.
- `hexCodeUnits`/emission derivation, "the twelve pre-existing rows are `env`
  func rows", the seven-row async projection, the reversed-catalogue
  canonicalization, "no provider names the six ids", and "Math/async/compare
  manifests are free of them" — all true of the 12-row catalogue too, by
  construction. They are the regression fence for the NEXT slice, which is the
  one that will add the first provider row.

### V-E — validation run

Green: `pnpm run typecheck` (TS7, the `quality` gate) — and the two
pre-existing `WebAssembly.Tag` TS5-lib errors in `src/linked-provider-runtime.ts`
are on `origin/main` too, untouched by this slice. The five ratchet gates, run
**bare** and again under `LOC_GATE_BASE` pinned to `origin/main`
(`dc29e1f1`): loc (+278 net src LOC; every grown path granted by this file's
frontmatter — `runtime-host-capabilities.ts` 264→503, `runtime-manifest.ts`
1670→1690 over the god-file threshold, `intrinsic-support.ts` 544→547), func,
coercion-sites, oracle-ratchet, dead-exports. Also green: `lint`,
`format:check`, `check:ir-dialect`, `check:ir-layering`, `check:ir-only`
(verdict READY), `check:linear-ir`, `check:host-import-policy`,
`check:test-vacuity-shapes`, `check:ir-kind-neutrality` (no evidence-line
drift this time — no cited line moved), and `check:ir-fallbacks` (bare;
unintended, module-level and post-claim buckets all still empty,
`string-builder-candidate` still 2).

Focused suites: **266 passing across 18 files** — all eight #3526 suites
including the new one, both async suites (#4103/#4104), #3520
callable-provider-abi, #2955, #3502, #3518 string-repeat-ir, #3167, #1183 and
#4550 linear-ir census. `scripts/*-baseline.json` is untouched.

### Not touched (per the plan's scope discipline)

Every resolve-table arm (`integration.ts:6186-6347`) including the eq/concat
one this slice's rows describe; `stringMethodPlan`; `String()` coercion;
`src/ir/from-ast.ts`; the `host-import-policy.ts` classifier;
`import-manifest.ts`'s `env`-only walk; the `IrIntrinsicProvider` global arm
(`nodes.ts:856-860`); and every existing policy — `numberBoundary`,
`booleanBoundary`, `externIsUndefined`, `generatorNumberBox`, `stringCompare`
— all unchanged. The whole-shape frozen-policy pin at
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-445` did **not**
move, which is the mechanical signature of a slice that adds no policy field.

## 2026-09-02 F2-S3 implementation plan — string.eq under manifest policy (family 2, slice 3)

Grounded on `origin/main` `351f2bfc6b` (= merged F2-S2, PR #5440). Slice
claim: `#3526:f2s3` (`ttraenkler/fable-ir-takeover`). Three probe lanes
(resolve arm + registration / BEFORE-half byte matrix / test surface) ran
against that commit; every line number below is theirs. The F2-S2 checkpoint's
P4 handoff (`:3786-3802`) is the starting point and is confirmed by
measurement.

### What moves and what does not

- **The arm is a THREE-symbol branch today**: `integration.ts:6280-6296`
  serves `IR_STRING_CONCAT_FN || IR_STRING_CONCAT_OWNED_FN ||
  IR_STRING_EQUALS_FN` with one raw `ctx.nativeStrings` read (`:6284`) and one
  symbol→spelling ternary per lane (`:6286-6291` native helpers, `:6294`
  host field). **First move is a SPLIT, not a rewrite**: lift
  `symbol === IR_STRING_EQUALS_FN` into its own `else if` directly after the
  F2-S1 compare arm (`:6256-6279`), above the concat pair; the two concat
  symbols keep their lane read and raw lookup (`else if` order across
  disjoint symbols is byte-inert). Then migrate only the lifted arm.
- **Host arm = `exactCallableImportIndex(ctx, arm.module, arm.field)`, NOT
  `ctx.funcMap.get`.** `wasm:js-string.equals` is registered by
  `addStringImports` (`registry/imports.ts:609-700`) as the third of a fixed
  five-import block (`concat, length, equals, substring, charCodeAt`,
  `:628-663`), by a base-phase caller (legacy collector pre-pass
  `import-collector.ts:1668/2142/2157/2175`, or the IR pre-pass
  `prepareStrings` `:7099-7101` — `instrUsesStrings` already includes
  `string.eq` at `:7232`), never alone and always ahead of Phase 3. It IS in
  `funcMap` but under the bare field `"equals"`, subject to #1072 user-function
  shadowing — which is exactly why the arm has never used `funcMap`.
  `exactCallableImportIndex` (`:6362-6370`) derives the index from
  import-section position, mints nothing, and is shift-immune. So
  `preparedStringEqProvider` returns `{arm:"host", module: record.module,
  field: record.field}` (a deliberate deviation from F2-S1's `{arm, field}`
  shape and from its source pin `toContain("ctx.funcMap.get(arm.field)")`).
  No attached-target recognition is needed (F1-S4's
  `attachedExternIsUndefinedArm` exists because from-ast deleted the raw call;
  here from-ast is untouched and the `string.eq` instr still triggers
  `addStringImports`).
- **Native arm** = `runtime-callable` on `__str_equals`
  (`native-strings-basics.ts:433-449`, minted via `ensureNativeStringHelpers`
  `native-strings.ts:94-140`, resolved by `nativeStrHelperHandle`
  `func-space.ts:126-133` as a #3909 stable handle). Physical ABI
  `(ref $str, ref $str) -> i32`; semantic signature
  `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE` (`intrinsics.ts:287-291`) — the
  same relationship F2-S1's `__str_compare` row has. Reuse it; no new
  signature.
- **Untouched**: from-ast (`:13178-13183`, `:11410` — lane-free, #2955 gate
  scoped to from-ast stays green), `string-support.ts` attach (`:57-77`,
  `:132-148` — unconditional, binding kind stays `intrinsic`), `lower.ts:2275`,
  `wasmgc-emitter.ts:91-96` (`i32.eqz` on negate), `nodes.ts`, `builder.ts`,
  `runtime-host-capabilities.ts` (row exists `:303`, func id `:67`),
  `registry/imports.ts`, `import-collector.ts`, `legality.ts:274` (`string.eq`
  allowed on linear), `linear-integration.ts:1620-1622` (resolves `__str_eq`
  ignoring the provider — the disabled policy there is inert, as for compare).
- **The emitter no-provider fallback `integration.ts:6718-6727`** (the second
  `ctx.nativeStrings` read in `emitStringEquals`, backed by
  `computeStringBackend` `:5163-5188`): measured **0 reaches** across all 55
  BEFORE cells; attach is unconditional on every healthy owner (`:7195-7210`)
  but conditional on `ctx.programAbiTypes` (`:7137-7138`), and
  `prepared-component-dependencies.ts:636-642` fails any component whose
  `string.eq` lacks a provider before lowering. Probe P1 decides
  retire-vs-pin by measurement (temporary throw over the full matrix), NOT by
  argument from F2-S1's sub-B (whose linear half was itself corrected).

### Contract (F2-S1's 10-point edit list, with the eq-specific deltas)

1. `StringEqPolicy { eq: "host" | "native" | "unsupported" }` +
   `STRING_EQ_POLICY_DISABLED` beside `runtime-manifest.ts:184-196`; optional
   field on `RuntimeManifestPolicy` beside `:221-225`, required on
   `FrozenRuntimeManifestPolicy` beside `:229-235`; constructor default +
   refreeze beside `:1257`/`:1264`.
2. Feature `js.string.eq` (`:326-327`, union `:66-70`); provider ids
   `host.js.string.eq` / `native.js.string.eq` (`:330-336`); rows beside
   `:741-756` — host `{kind:"host-callable", capability:"string.eq"}` with
   `hostCapabilities:["string.eq"]` (type-checks: `string.eq` is a func id),
   native `{kind:"runtime-callable", symbol:"__str_equals"}`; both with
   `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE`; `stringEqProviderId` beside
   `:760-763`; feature-set predicate beside `:765-769`; splice into
   `RUNTIME_PROVIDERS` `:1021-1029`; `#selectProvider` branch beside
   `:1621-1636` throwing `provider-target-unavailable` naming `stringEq`.
3. `integrationStringEqPolicy(ctx) = { eq: ctx.nativeStrings ? "native" :
   "host" }` beside `integration.ts:889-891` — the exact former truth table
   of `:6284`; policy literal beside `:976`; owner-local partition twin of
   `:3696-3710`; demand `irStringEqDemand` beside `:902-919` — a plain
   `instr.kind === "string.eq"` scan over blocks + `asyncPlan.states`
   (simpler than compare's call scan); `stringEqDemand:` beside `:983`;
   `intrinsic-support.ts` input field beside `:390-398`, the "freeze nothing"
   guard `:431` (`&& !input.stringEqDemand`), `requestFeature` beside `:440`,
   feature const beside `:286`; `preparedStringEqProvider` beside `:301-320`
   using `resolveRuntimeHostCapabilityFuncRecord` and returning
   `{arm:"host", module, field}` / `{arm:"native", symbol}`.
4. The resolve arm: split as above, then the lifted eq arm reads
   `preparedStringEqProvider(prepared)`, throws `selection-preparation-mismatch`
   when absent, native → `ensureNativeStringHelpers(ctx); nativeStrHelperHandle(ctx, arm.symbol)`,
   host → `exactCallableImportIndex(ctx, arm.module, arm.field)`. The arm body
   runs once per module per symbol (registry-cached by
   `irCallableBindingKey`); the per-instr count equals the attach count.
5. Adapters: `stringEq: STRING_EQ_POLICY_DISABLED` in
   `backend/linear-integration.ts:680` and `codegen/stdlib-selfhost.ts:507`
   (+ import lists `:140` / `:75`).
6. No edit to `plan.invocation`, no from-ast edit, no new import
   registration anywhere (contract: import set AND order on every lane
   unchanged by construction; the matrix confirms rather than establishes).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — emitter fallback `:6718-6727`**: temporary throw + the full 55-cell
  matrix + the affected suites; 0 reaches ⇒ retire it fail-closed (F2-S1
  sub-B shape, with the "refuses to lower an unattached string.eq" pin);
  any reach ⇒ keep and pin it explicitly as not-moved, naming the lane.
- **P2 — the import-pruning pass**: at arm time `exactCallableImportIndex`
  returns 2 (`EQ`/`NEQ`/`TPLEQ`) or 3 (`EQMIX`/`STRMIX`) while the emitted
  module has `equals` at #0/#1/#3 — unused string imports are dropped before
  emission and the registry's locator (`program-abi-provider-planning.ts:299-300`)
  keeps the final index right. The probe could not name the pruning pass;
  name it, and state why the migrated arm (same lookup, same locator) is
  unaffected.
- **P3 — pins that move**, all measured: (a)
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-443` gains
  `stringEq: { eq: "unsupported" }` (the only whole-shape pin;
  `issue-3526-ir-runtime-manifest.test.ts` has no policy analog;
  `compare.test.ts:252-262` asserts fields individually — extend to six); (b)
  `tests/issue-3526-string-boundary-schema.test.ts:356-363` "no provider
  names any of the six capabilities" FIRES once `host.js.string.eq` names
  `string.eq` — narrow `NEW_IDS` (`:75-84`) for that pin to the five still
  un-provided ids (F2-S2 called this "the regression fence for the NEXT
  slice"); (c) `schema.test.ts:627-638` "keeps the concat/eq resolve arm on
  ctx.nativeStrings and the raw import lookup" — keyed on the three-symbol
  marker and `exactCallableImportIndex(ctx, "wasm:js-string", field)`: after
  the split the concat arm has no `field` variable, so re-spell to
  `"concat"` and retitle concat-only; the eq half INVERTS into the new suite;
  (d) `scripts/ir-kind-neutrality-baseline.json:287` cites
  `integration.ts:6327` (`forof.string`) — inserting the eq arm above shifts
  it: the sanctioned one-line citation refresh (normalize-and-diff both JSON
  documents; never commit the regenerator's 500-line output).
- **P4 — pre-existing red controls on the grounding sha, NOT this slice's**:
  `tests/issue-320.test.ts` "no dead imports (no-op)" (WAT now carries
  `string_constants."add"` module-init globals) and three `issue-3529-*`
  pins (#4512 `!ref` ToBoolean; array-literal widening `<module-init>` row).
  Confirm they are red on base BEFORE your first edit and leave them; file
  or cite an issue for them, do not fix here.

### Verification matrix

- **V-A byte cells — 55/55 identical to the BEFORE record.** The BEFORE
  half is preserved: `scratchpad/f2s3-matrix-before.{mts,json,md}` + 55 full
  WAT texts under `wat/` + the 6-site instrumentation patch
  (`.instrument.py/.diff`). Fixtures (sources verbatim in the JSON): `EQ`,
  `NEQ`, `EQMIX`, `FOROFEQ`, `TPLEQ`, `CLEAN`, `STRCMP`, `STRCMP4`, `STRMIX`,
  `FOROFSTR`, `BOTH` × gc-host / gc-native-strings / standalone / wasi /
  linear: bytes, sha256, WAT sha256, ordered import list WITH func/global
  indices (parsed from the binary import section — `result.imports` covers
  only `env` func descriptors and is blind to this seam), errors,
  `irOutcomes`. Includes reproducing `FOROFEQ::gc-host`'s pre-existing
  build-stage demote (`operand-coercion-unsupported`, 1513 B, `270e2a6a…`)
  byte-identically — it is the host `stringForOfPlan() === "iter-host"`
  binding the loop variable as externref, not the eq seam.
- **V-B reach**: re-apply the instrumentation on the AFTER tree — host 5 /
  native 18 / linear 4 eq resolutions, fallback 0, `resolve-entry`
  fresh+cached per cell as before; runtime oracle for `===`/`!==` on
  ≥7 input pairs across lanes via instantiation.
- **V-C import-order pin** on the host lane via the module import section
  or WAT (`tests/strings.test.ts:69` route) — an `result.imports`-only pin
  is blind to `wasm:js-string`.
- **V-D fail-closed**: `provider-target-unavailable` naming `stringEq` at
  the manifest unit level; the production projection is total (`nativeStrings
  ? native : host`), the linear lane admits `string.eq` and ignores the
  provider, so the `unsupported` arm is unreachable on every lane —
  **divergence-4 class EMPTY** (all `string.eq` producers are guarded before
  emission at `from-ast.ts:13162-13173` / `:11388-11402`; #3529 pins stay at
  `build`). Record integration-level reachability as a limit (F1-S2 style)
  unless a policy-injection seam exists (none does).
- **V-E revert non-vacuity**: revert only the arm → exactly the new
  source-shape pins fail (`stringEqArmSource` marker
  `symbol === IR_STRING_EQUALS_FN) {`, host assertion
  `exactCallableImportIndex(ctx, arm.module, arm.field)`); revert only the
  fallback retirement (if P1 retires it) → exactly its pin fails.
- **V-F**: five ratchet gates chained bare AND under `LOC_GATE_BASE`;
  `runtime-manifest.ts` (1690 lines, over threshold) needs the dated
  `loc-budget-allow` rationale; `check:ir-fallbacks` diffed (no bucket
  moves); controls: `issue-2955-depolymorph-gate`,
  `issue-3520-callable-preregistration` (`equals` NOT imported on native
  lanes), `strings`, `host-string-prefix-suffix-fast-path`,
  `issue-3521-prepared-component-dependencies:1017-1029` (attach binding
  kind), all #3526 suites, both async suites.

New suite: `tests/issue-3526-string-boundary-eq.test.ts`, anatomy from the
compare suite (contract `:166-216`, policy `:218-296`, end-to-end
`:298-337`, demote `:339-358` — but see V-D, the linear trick does not carry
because `string.eq` is linear-admitted — source-shape arm pins `:361-409`).

### Out of scope

`string.concat` / `_OWNED` (stay on the lane read — F2-S5, with `__concat_N`
and the `string-builder-candidate` bucket), `string.len` (F2-S4; native
struct-field arm needs provider vocabulary), `charCodeAt` (two-record
`host-capability` provider behind a defined helper), `string.const` (global
kind), `stringForOfPlan` (`:5970-5972` — the FOROFEQ host demote is its
business, not this slice's), `TPLEQ`'s `env.__concat_3` late import, the
`:6718-6727` twin reads in the other string emitters.
