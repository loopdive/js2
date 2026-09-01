---
id: 3526
title: "IR-only R6: typed semantic runtime contract and frozen feature manifest"
status: blocked
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
