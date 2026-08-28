---
id: 3526
title: "IR-only R6: typed semantic runtime contract and frozen feature manifest"
status: blocked
sprint: Backlog
created: 2026-07-21
updated: 2026-08-28
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
