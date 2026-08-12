---
id: 3521
title: "IR-only R2: prepare-before-emit free-function ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-12
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r2
model: gpt-5.6-sol
parent: 3518
depends_on: [3520]
required_by: [3522, 3523, 3525, 3526]
related: [2138, 2855, 3143, 3203, 3518, 3519, 3678, 4260, 4382]
origin: "#3518 R2 — invert single-source free functions from compile/patch to prepare/emit"
files:
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/integration.ts
  - src/ir/abi-bindings.ts
  - src/ir/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/string-carrier.ts
  - src/ir/string-support.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/lower.ts
  - src/ir/verify.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/string-contract.ts
  - src/ir/backend/wasmgc-emitter.ts
  - src/ir/backend/linear-emitter.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/program-abi-global-planning.ts
  - src/codegen/program-abi-import-planning.ts
  - src/codegen/program-abi-provider-planning.ts
  - src/codegen/program-abi-type-planning.ts
  - src/codegen/fixups.ts
  - src/codegen/ir-overlay-preparation.ts
  - src/codegen/ir-overlay-safety.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/program-abi-export-planning.ts
  - src/codegen/module-global-registration.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/index.ts
  - src/compiler.ts
  - tests/issue-3521-prepared-ir-program.test.ts
  - tests/issue-3521-prepared-component-dependencies.test.ts
  - tests/issue-3521-prepared-free-function-routing.test.ts
  - tests/issue-3521-scoped-prepared-abi-seal.test.ts
  - tests/issue-3520-program-abi-import-callable-planning.test.ts
  - tests/issue-3520-callable-provider-abi.test.ts
  - tests/issue-3765-numeric-locals.test.ts
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/index.ts
  - src/ir/backend/porffor/assembler.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/index.ts::generateModule
  - src/ir/backend/linear-integration.ts::makeLinearIrResolver
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::makeResolver
  - src/ir/lower.ts::lowerIrFunctionBody
---

# #3521 — IR-only R2: prepare-before-emit free-function ownership

## Objective

Introduce `PreparedIrProgram` and invert the default single-source top-level
free-function pipeline so every in-scope function is classified before any
function body emitter runs:

```text
source + ProgramAbiMap
        |
        v
prepare all free-function components
        |
        +-- Prepared    -> emit IR body exactly once
        `-- Unsupported -> emit direct body exactly once (temporary hybrid)

Invariant at any stage -> fail; never retry through direct codegen
```

R2 is deliberately limited to top-level `FunctionDeclaration` units in the
ordinary single-source pipeline. It establishes the ownership mechanism that
later slices extend. It does not absorb class/member/closure inventory,
module-init execution, multi-source/M0, runtime-family migration, async, or the
linear backend.

## Current evidence

The current “IR-first” path is still a conditional overlay:

- `src/codegen/index.ts:1568-1591` documents that `planIrOverlay` was extracted
  so the same mutation-bearing planner can run before or after direct body
  compilation. Type and class-shape state may depend on body-emitter effects.
- `src/codegen/index.ts:1671-1708` describes `computeIrFirstSkipSet` as a narrow
  positive allowlist. A selected function outside that numeric/boolean subset
  still compiles direct and is later patched.
- `src/codegen/index.ts:3068-3100` plans a skip set, calls
  `compileDeclarations`, and installs `unreachable` placeholders for the
  allowed subset.
- `src/codegen/index.ts:3107-3144` then builds, optimizes, lowers, and patches IR
  after `compileDeclarations`. Host callback, Date, and Promise support is
  finalized only after legacy declaration/body side effects.
- `src/codegen/declarations.ts:2251-2277` decides at body-emission time whether
  to compile direct or write a placeholder, keyed by a string name.
- `src/ir/integration.ts:168-247` mixes selection, IR build, allocation
  registry setup, and concrete Wasm registry mutation. At `:589-714` it runs
  middle-end passes; at `:748-773` it allocates new Wasm slots; and at
  `:918-1004` it lowers and patches already-created functions.
- The measured allowlist ceiling is only **441/1,568 (28.1%)**. Widening that
  allowlist cannot make the remaining 71.9% compile once.

Therefore “selected” and even “IR-emitted” are not ownership proofs. R2 makes
`Prepared` a pre-emission fact and removes the allowlist from free-function
ownership.

## `PreparedIrProgram` contract

Add a program object whose construction completes before the first in-scope
body instruction is emitted. Exact names may follow repository conventions,
but the contract is fixed:

- `abi: ProgramAbiMap` — the R1 identity/slot plan.
- `units` — one terminal R0 outcome for every inventoried in-scope unit.
- `preparedUnits` — verified, post-pass typed IR keyed by `IrUnitId`, with
  source location, final signature, export intent, and backend-legality proof.
- `directUnits` — temporary hybrid `Unsupported` units with their stable code;
  this is a routing plan, not an untyped catch/retry path.
- `supportIntents` — the complete set of imports, globals, types, literals,
  helpers, closure/callback support, runtime entry intents, and exports that a
  Prepared body may reference.
- `components` — local call-graph components and their frozen ownership. If a
  cross-unit ABI/call edge cannot be proven safe, the entire component becomes
  typed `Unsupported` before emission rather than partially emitting and
  discovering the mismatch later.
- `formatVersion` and `decisionSchemaVersion` — explicit compatibility keys for
  a deterministic serialized handoff. No AST node, compiler callback, live
  registry, concrete Wasm index, or backend-owned mutable object may cross this
  boundary.

`Prepared` means AST→IR build, verification, hygiene, inline/mono transforms,
symbolic resolution validation, support-intent collection, target legality,
and final ABI/signature checks succeeded. Backend body emission is a consumer,
not another capability probe.

## Versioned serialized handoff

Define a canonical encoder/decoder for the frozen `PreparedIrProgram`. This is
an architectural boundary and cache/tooling primitive, not permission to make
serialized IR a stable public language before its compatibility policy is
documented.

- Canonical ordering makes equivalent programs byte-identical regardless of
  source/map traversal order.
- Tagged scalar encoding preserves `NaN`, infinities, negative zero, bigint,
  nullish values, strings, and stable symbol/type/unit identities without JSON
  coercion loss.
- Source identity includes normalized paths/IDs, content hashes, and exact
  locations needed by #3678 diagnostics without embedding mutable TypeScript
  nodes.
- Decode reconstructs immutable data and re-runs structural, type, ABI, effect,
  component, support-intent, runtime-manifest, and target-legality verification
  before returning `Prepared`.
- Unknown versions, malformed fields, missing provider/capability decisions,
  and target/backend mismatches fail with typed diagnostics before any module,
  slot, import, cache entry, or output file is published.
- Backend-specific lowering state is excluded. R8 must prove WasmGC and linear
  consume the exact same decoded snapshot rather than reparsing or reselecting.

## Prepare/emit split

Refactor `compileIrPathFunctions` into explicit phases:

1. **Inventory and plan.** Consume R0 outcomes and R1 identities/ABI. Run the
   selector for every top-level free function even if tracking/logging is off.
2. **Build all candidate IR.** Build every selected local-call component into
   an `IrModule`; do not allocate or patch concrete function bodies.
3. **Optimize and verify.** Run current hygiene, inline, monomorphization,
   allocation provenance, and target-legality checks. Any failure before the
   Prepared boundary becomes the typed outcome required by R0.
4. **Materialize support intents.** Inventory every symbolic ref and helper
   request and resolve it through `ProgramAbiMap` before body emission. Lazy
   creation of an unplanned import/type/global/helper after this seal is an
   `Invariant`, not a reason to retry direct codegen.
5. **Freeze ownership.** Every in-scope component is now exactly one of
   Prepared, Unsupported, or Invariant. No later code can mutate that choice.
6. **Emit once.** Direct compilation receives only the Unsupported ID set and
   emits each once. IR emission receives only Prepared units and emits each
   once into its planned slot. No `unreachable` placeholder is a shipping
   ownership mechanism.

The temporary `JS2WASM_IR_FIRST=0` / `disableIrFirst` compatibility policy may
still force a unit to the typed legacy policy until R9, but it may not create a
compile-twice unit: it must classify that unit before body emission and direct
compile it once. R9 deletes the options and this forced-legacy outcome.

## Exact emission accounting

Extend the R0 unit ledger with counters keyed by `IrUnitId`:

- `prepareAttempts`
- `directBodyEmissions`
- `irBodyEmissions`
- `legacyBodyEmitted` and `irBodyEmitted` compatibility booleans derived from
  those counters

For every R2 free function:

| Outcome                 | Direct emits | IR emits | Compile succeeds |
| ----------------------- | -----------: | -------: | ---------------- |
| Prepared                |            0 |        1 | yes              |
| Unsupported (hybrid)    |            1 |        0 | yes              |
| Invariant               |            0 |        0 | no               |
| Post-Prepared invariant |            0 | 0 or 1\* | no               |

`\*` A backend may have begun writing only to an isolated transaction/buffer;
the module must not publish it. It may never direct-compile the unit. Counters
record the attempted emission and fatal outcome without claiming success.

The sum of Prepared + Unsupported + Invariant must equal the inventory
denominator, and no successful unit may have `direct + IR != 1`.

## Bounded landing sequence

### Commit 1 — split preparation from emission, no routing change

- Introduce `PreparedIrProgram` and pure/intermediate build/pass/verify APIs.
- Collect and seal support intents; make emission consume a prepared value.
- Preserve the existing routing while tests prove build/emit separation and
  byte/runtime parity.

### Commit 2 — freeze single-source free-function ownership

- Replace `computeIrFirstSkipSet` for R2 free functions with terminal outcomes.
- Pass ID sets, not names, into direct compilation.
- Direct-compile Unsupported functions once; emit Prepared functions once.
- Turn every failure after Prepared into a typed fatal Invariant with no legacy
  catch/retry.

### Commit 3 — remove free-function patch/placeholder compatibility

- Stop allocating free-function body slots as a side effect of legacy body
  compilation. Use `ProgramAbiMap` slots directly.
- Delete the free-function `unreachable` placeholder/patch branch and derive
  transitional `irFirstSkipped` / `irCompiledFuncs` telemetry from exact
  counters.
- Retain class/module overlay code untouched for #3522/#3523.

## Prepared-program-core structural slice (2026-07-30)

The first R2 landing is intentionally structural. `src/ir/program.ts` and
`src/ir/prepare.ts` define and validate the immutable prepared-program boundary
without wiring it into `src/codegen/index.ts`:

- the denominator is exactly the R1 inventory's top-level free-function
  terminals, with every unit represented once;
- asserted IR/direct/invariant routes, signatures, exports, legality,
  inline-small/monomorphization results, symbolic support, allocation, and
  provenance are retained only as explicitly **unvalidated candidates**;
- caller-supplied component groupings are likewise non-authoritative hints.
  This slice does not infer the call graph, use those groupings to claim atomic
  ownership, or reject a mixed grouping as though it were a proven component;
- a capability-only, one-shot isolated transaction exercises candidate-route
  accounting and publishes only an explicitly unvalidated candidate snapshot;
- every input is defensively copied, functions/accessors and other executable
  or mutable non-data objects are rejected recursively, and any staging,
  freezing, direction, duplication, or partial-publication error atomically
  aborts the transaction without retry.

The later production-routing slice must derive call/ABI components and
Prepared evidence from the actual post-pass IR, symbolic references,
`ProgramAbiMap`, backend legality results, allocation registry, and provenance
registry. Only that reconciliation may promote a candidate to terminal
`Prepared`, `Unsupported`, or `Invariant` ownership and feed a real emitter.

This slice does **not** change production routing and its expected
legacy-body reduction is therefore exactly **0**. It does not claim the issue's
compile-once cutover acceptance criteria; the later routing slices must consume
this boundary.

Future routing work must preserve optimization parity rather than treating the
loss of the legacy discovery pass as acceptable churn. In particular, complete
program preparation must retain inline-small eligibility, monomorphized clone
identity/signatures, and allocation provenance, and
`check:ir-optimization-retirement` remains fail-closed until its committed
parity evidence is retirement-ready.

## Scoped prepared-component ABI prerequisite (2026-07-30)

The next file-disjoint prerequisite adds a scoped seal to
`ProgramAbiSession`; it does not activate production routing. A one-shot
component transaction starts from exact terminal `IrUnitId`s, automatically
closes over source and pass-derived callables plus existing aliases/exports,
and accepts only explicitly discovered external/support binding IDs.

Successful scope sealing proves, before unrelated direct-body planning:

- source/derived callable and support identities are complete;
- callable/global structured type contracts match their planned signatures;
- required slots have an observed structural reservation and an exact
  allocator locator already present in the module;
- later derived units, aliases, exports, unit-owned support, type-contract
  additions, or locator replacement cannot extend or mutate the sealed
  component.

The whole `ProgramAbiSession` intentionally remains in planning state, so
unrelated direct bindings and support can still be registered. Whole-program
seal and final publication rebuild each scoped ABI, compare every materialized
contract while ignoring only whole-program dense-order renumbering, and fail
closed on missing/drifted identities, contracts, reservations, or locators.
Explicit type-layout remaps advance the scoped structured contracts through the
same validated remap rather than hiding an unreported mutation.

Focused evidence in
`tests/issue-3521-scoped-prepared-abi-seal.test.ts` covers a non-empty source
callable plus monomorphized clone, alias, export, and support closure; continued
unrelated planning; missing locator/reservation rejection; prepared-owned late
support/derived rejection; signature drift at publication; exact final
reconciliation; and transaction abort/retry without partial scope publication.

Adversarial review further pins the boundary:

- every registered lifted/monomorphized executable beneath a prepared terminal
  must already own exactly one source-callable reservation, structured
  contract, structural reference, and locator;
- explicitly requested bindings are limited to canonical external/support
  dependencies, cannot import another terminal's source callable/global, and
  cannot overlap a previously sealed component;
- type/class cells retain an immutable canonical layout contract. Direct cell
  remaps and in-place layout mutation fail, while the complete validated
  `applyTypeLayoutRemap` event advances the pinned layout and callable/global
  structured contracts together only when each replacement is canonically
  equal to the prior layout under that exact index remap;
- imported callable/global locators are re-read for exact host module/name,
  callable signature, global storage type, and mutability during
  reconciliation, so mutating the same import object cannot bypass the seal;
- malformed/custom binding IDs, alias cycles, duplicate dependency discovery,
  and removal of a pinned allocator object all reject before publication.

The follow-up ownership hardening uses the complete structural inventory
rather than treating a terminal row as the whole component:

- every inventoried nested function, function expression, arrow, object
  method/accessor, and class-member/support unit whose terminal ownership
  resolves to a prepared root is part of that root's sealed unit denominator;
  any existing callable is closed into the scope, while later callable or
  support planning for those units fails closed;
- every binding in the final alias/export/support closure retains the terminal
  owner resolved from its canonical encoded owner. Class owners resolve
  transitively through `IrClassRecord.lexicalOwnerId`, so a binding beneath a
  different terminal cannot be auto-claimed through an alias/export edge or
  explicitly requested as support;
- scoped type evidence pins the full transitive graph reachable from type and
  class cells plus callable/global reference contracts. An exact index
  permutation must preserve each reachable payload definition, including
  fields, mutability, and supertype relationships, under the same remap.
  `StructTypeDef.superTypeIdx === -1` remains the open-root sentinel rather
  than being traversed or rewritten as a concrete type index;
- semantic-preserving type reorders refresh alias contracts through their
  canonical callable/global owner. Aliases intentionally carrying no sidecar
  of their own therefore remain valid without weakening the exact graph
  comparison.

Focused coverage includes all inventoried nested callable kinds in the R2
component, late nested planning rejection, cross-component nested-unit and
nested-class dependency rejection, disjoint nested-class scopes,
foreign-owned alias/export closure rejection, referenced payload-shape swap
rejection, and non-vacuous callable/global inherited-alias reorder success.

This prerequisite changes neither `compileDeclarations` nor
`compileIrPathFunctions`. Production adoption and legacy-body reduction remain
exactly **0**, and all inline-small, monomorphization, allocation-provenance,
and retirement-parity obligations remain assigned to the later prepare/emit
wiring slice.

## Production free-function routing slice (2026-07-30)

The current R2 wiring replaces the primitive numeric/boolean skip allowlist in
the default single-source pipeline. After declaration slots and TDZ globals
exist, the compiler finalizes support preflight, builds and optimizes all
retained top-level free-function IR, lowers it, and installs the successful
bodies before `compileDeclarations` starts body emission.

Routing is derived only from exact terminal `IrUnitId` evidence:

- `patched` owners preserve their installed IR body and skip direct emission;
- typed `Unsupported` owners are not skipped and direct-compile once;
- `Invariant` owners remain IR-owned, receive no direct retry, and fail the
  compile through the existing outcome audit.

Class/member and module-init owners remain on their post-direct overlay until
#3522/#3523. Their disjoint report is merged with the prepared free-function
report before the shared exact reconciliation and telemetry path, so each
terminal row is audited once.

The routing helpers now live in `ir-prepared-free-functions.ts`; final-context
support preflight moved out of the `index.ts` driver into
`ir-overlay-preparation.ts`. `prepareModuleTdzGlobals` is idempotent and runs
before IR preparation as well as for compatibility callers. Dynamic member-set
support is registered before IR build, eliminating the former dependency on a
direct-body side effect.

Anti-vacuity coverage proves:

- a string-method body rejected by the retired primitive allowlist is
  IR-owned, records `legacyBodyEmitted: false`, and executes correctly;
- a selector-rejected default-parameter owner direct-compiles once;
- a prepared body remains valid when that later direct owner adds a host
  import and shifts the imported-function prefix;
- an injected build invariant fails without either direct or IR success.

Focused evidence is 82/82 across the new routing tests plus #3521 core, #3143,
#3203, and #3795. IR fallback, optimization-retirement, LOC, and function
budgets pass. A first broad prepare-before-emit attempt reduced legacy body
emission from 37 to 16, but full equivalence exposed twelve final-ABI
regressions because those functions still depended on direct-body discovery.
That unsafe breadth was removed.

The fail-closed routing slice selects exact closed scalar/string top-level call
components. An unrelated class member or module-init owner no longer blocks a
closed free-function component; an exact call edge to or from a direct-owned
unit removes the complete affected component before preparation. Pending
ambient-call, callback, Date, Promise, fast-mode, async/generator,
reference-shaped callable contracts, allocated-slot signature mismatches, and
unresolved dependencies remain conservative boundaries. Exact comparison
against the already allocated source-callable slot prevents preparation from
replacing an empty body with a different callable ABI; those components retain
the established post-direct parity withdrawal and direct fallback.
A separate fast-mode guard prevents source `number` positions whose direct ABI
grounds to i32 from being skipped against an early f64 IR signature, while
retaining annotation-proven boolean compile-once owners.

The single-host readiness lane now records **35 legacy body emissions**, **33/37
IR-emitted terminals**, four typed Unsupported units, zero invariants, and a
READY hybrid policy. The two-unit legacy reduction comes from the first sealed
static-method R3 continuation described in #3522; free-function anti-vacuity is
carried by focused sealed-component fixtures. Strict IR-only remains NOT READY
on the four unsupported async-related units and every remaining legacy body.

The required 106-test matrix is 104 passing. Both failures reproduce unchanged
on the exact parent: one stale end-to-end `inline-small` expectation and the
#3214 imported-overload inventory-owner failure. No optimization test regressed
under R2.

Remaining R2 work before closing this issue is the full required gate matrix,
explicit component/counter reconciliation evidence, and removal of the
compatibility placeholder branch once #3522/#3523 no longer consume it.

## Production dependency-complete component seal (2026-08-02)

The next R2 slice now consumes post-pass component dependency evidence in the
production prepared free-function route. For each dependency-complete scalar
component, preparation:

- registers every terminal source callable against its exact preallocated
  `WasmFunction` object and structured signature;
- registers any already-declared public export aliases of those exact objects;
- derives the final local call component from optimized IR and resolves its
  symbolic external/support dependencies through the planning session; and
- seals the component scope before Wasm lowering starts.

Lowering fills `locals` and `body` on the already sealed allocator object. It
does not replace that object, allocate a second source slot, or rediscover the
public export target. Successful terminal evidence carries a
`preparedComponentId`, providing an observable distinction between this
sealed route and the older transitional prepare/patch route. The new scalar
call-component test proves two non-inlined functions share one sealed
component, record `legacyBodyEmitted: false` and `irBodyEmitted: true`, and
execute with the expected result.

This is a bounded production adoption, not R2 completion. Components using
string, dynamic, object, class-layout, or other still-implicit support remain
on the established route because the current IR does not yet express every
such dependency as a symbolic Program ABI intent. Components containing a
pass-derived executable likewise remain unsealed until its callable slot can
be reserved before lowering. No fallback category was widened and no legacy
optimization was retired.

Current validation on `origin/main` plus this slice:

- focused component dependency, scoped ABI, and production routing tests:
  **39/39 passing**;
- TypeScript validation, IR fallback gate, optimization-retirement ledger,
  adoption check, and hybrid IR-only readiness gate: passing;
- the pre-push numeric-local parity gate: **17/17 passing** after replacing a
  stale debug-WAT type-name/index coupling with direct f64/no-boxing body
  evidence;
- readiness denominator: **31/37 IR-emitted**, **6 typed Unsupported**, **0
  invariants**; and
- broad #3520/#3521 ABI matrix: **384/390 passing**. The same six failures
  reproduce on an untouched `origin/main` worktree: four stale host-bridge
  census totals, the nested source-callable reservation assertion, and the
  linear inventory build-count assertion.

The shortest remaining R2 path is to make runtime/layout dependencies
symbolic during IR preparation, reserve derived callable objects before
lowering, then consume the sealed component view in an explicit emission
transaction with exact direct/IR counters. Only after that evidence is green
can the free-function placeholder/patch compatibility branch be deleted.

## Runtime/intrinsic provider preparation continuation (2026-08-02)

Dependency-complete preparation now includes defined runtime and intrinsic
callable providers instead of discovering them for the first time during Wasm
lowering:

- preparation walks every nested instruction in the final post-pass IR and
  resolves each `runtime`/`intrinsic` call, lifted-closure target, and explicit
  class callable target to its exact import or `WasmFunction` object;
- provider-resolution failures are correlated to the exact terminal owner and
  classified before dependency sealing, while the walk continues so the
  successful provider-key denominator is complete;
- an unresolved external-callable failure now carries its structural reference
  key. A component is eligible for early provider planning only when those
  exact provider keys are its complete blocker set;
- the provider registry seals one stable, sorted observation denominator and
  can plan the selected defined providers early. Final planning reuses those
  identities and can still discard an unplanned import observed only by a
  withdrawn candidate; and
- dependency discovery reruns after provider planning, allowing the newly
  complete component to seal before its Wasm body is lowered.

The production anti-vacuity fixture combines `Math.sin` and `%`. Its body now
records `legacyBodyEmitted: false`, `irBodyEmitted: true`, a non-empty
`preparedComponentId`, and the expected runtime value. Registry coverage also
proves that preparing `__fmod` neither retains a candidate-only import nor
allows a new provider key to appear after the denominator is sealed.

### Canonical import-backed provider preparation

Import-backed providers now cross the same preparation boundary without
letting the semantic provider take ownership from the canonical import:

- ordinary compilations keep the existing dense final-import ordering;
- the first prepared import seals the complete sorted pre-DCE import
  population as a stable sparse denominator;
- only exact imports required by otherwise complete components are planned at
  that point. Dead siblings never become required ABI entries;
- imports registered after the seal receive deterministic trailing ordinals,
  so they cannot renumber or reuse a prepared identity; and
- the runtime/intrinsic provider aliases the canonical import binding before
  the component scope seals. Final planning reuses both identities and their
  exact locator instead of double-owning the slot.

The import-planner regression removes a pre-DCE sibling, adds a new import
after the seal, and proves the required binding keeps its original identity
and final index. The provider regression additionally proves a runtime
provider aliases that canonical import while a candidate-only semantic import
is discarded.

Validation after this continuation:

- focused provider/import-planning, dependency, scoped-ABI, and
  production-routing tests: **75/75 passing**;
- numeric-local optimization parity: **17/17 passing**;
- typecheck, scoped Biome/Prettier, LOC/function budgets, fallback ratchet,
  adoption, and hybrid IR-only readiness: passing;
- readiness remains **31/37 IR-emitted**, **6 typed Unsupported**, and **0
  invariants**; and
- the broad #3520/#3521 matrix is **388/394 passing** with the same six
  parent-reproduced failures: four stale host-bridge census totals, the nested
  source-callable reservation assertion, and the linear inventory build-count
  assertion. All four new provider/import tests pass.

The next R2 dependencies are symbolic string/dynamic/object/layout support and
pre-reserved pass-derived callable slots. The explicit emission transaction
and removal of the remaining placeholder/patch branch follow those dependency
families.

## Symbolic string-carrier continuation (2026-08-02)

The first string dependency now crosses the prepared-program boundary without
exposing a backend storage type to JS inference:

- inference and the optimization passes continue to use the backend-neutral
  `IrType.string` kind;
- final post-pass IR receives one canonical `carrierRef` throughout params,
  results, block arguments, nested result types, closure signatures, object
  shapes, ref cells, unions, and vector element metadata. Exact class-shape
  identities remain untouched because their class binding owns the complete
  physical layout;
- the Program ABI maps that ref to slotless `externref` in the host-string
  backend or to the exact remappable `$AnyString` type cell in the native
  backend; and
- dependency discovery accepts the string type only when that exact support
  type plan exists. Transitional IR without the ref remains blocked.

The production `value.charCodeAt(0)` fixture already carried an explicit
intrinsic provider after the preceding slice. Its remaining implicit string
parameter blocker is now removed: the body records `direct=0`, `IR=1`, gains a
`preparedComponentId`, and still returns `65`. The host-string late-import
fixture also seals both string-typed bodies before lowering and continues to
execute correctly after a later direct owner adds an import.

That host fixture exposed a compilation-wide scope invariant that was too
strict for prepared programs: two independent components could not share one
immutable import or support type. Prepared ABI bookkeeping now retains every
scope using a binding. Dependencies with no terminal source owner may be
shared, while terminal-owned callables, globals, classes, and support remain
exclusive to their component. Mutation guards still reject late contract,
locator, or alias changes; prepared type layouts advance only through the
existing exact-remap transaction.

Validation for this continuation:

- focused import/provider planning, scoped ABI sealing, dependency derivation,
  prepared-program, and production routing coverage: **76/76 passing**;
- numeric-local optimization parity: **17/17 passing**;
- the broad #3520/#3521 matrix: **389/395 passing**, with the same six
  parent-reproduced failures already recorded above (four stale host-bridge
  census totals, nested source-callable reservation, and the linear inventory
  build-count assertion);
- typecheck, scoped lint/formatting, LOC/function budgets, fallback ratchet,
  optimization-retirement ledger, and adoption checks: passing; and
- hybrid readiness: **31/37 IR-emitted**, **6 typed Unsupported**, **0
  invariants**, READY. Strict IR-only remains NOT READY because all 37 lane
  units still pass through legacy body emission and the same six unsupported
  units remain.

The remaining string work is instruction-level support: literals, concat,
equality, length, character operations, and string iteration still name
implicit backend globals/helpers in their IR instructions. Dynamic carriers,
object/ref-cell/closure/union/vector layouts, pass-derived callable slots, and
the explicit emission transaction remain subsequent R2/R6 dependencies.

## Symbolic string literal/length continuation (2026-08-02)

String literals and `.length` now carry their exact backend dependencies into
the final post-pass IR without exposing those representations to JS inference:

- host literals reference the exact immutable `string_constants` imported
  global already owned by the Program ABI, while native literals reference the
  existing interned `__strlit_` global and retain the selected UTF-8 or UTF-16
  representation;
- host length reads reference the exact `wasm:js-string.length` callable,
  while native length reads reference field zero of the symbolic `$AnyString`
  support type; and
- dependency discovery records those global, callable, and type bindings
  before the component scope seals. Lowering consumes the same refs through
  the resolver instead of rediscovering numeric indices.

The attachment pass runs only after inference and all middle-end transforms,
so `IrType.string` remains backend-neutral. It is idempotent and rejects an
attempt to replace an already attached provider with a different binding.
Prepared native literal lowering continues to use the existing interning,
hashing, and UTF-8 storage path rather than introducing a second literal
representation.

Native literal preparation also made the existing V8 leaf-struct finalization
visible to sealed type graphs. `markLeafStructsFinal` now reports the exact
types it changed, and `ProgramAbiSession` accepts that event only when every
reported reachable change is precisely `final: false -> true`. Explicit
prepared type/class roots, altered fields, changed reachability, and unreported
mutations still fail closed. This preserves the legacy devirtualization
optimization without weakening the prepared ABI seal.

Production anti-vacuity covers both `gc` and `standalone` for
`return "abc".length`: each function records `direct=0`, `IR=1`, and a
non-empty `preparedComponentId`, validates as Wasm, and returns `3`.
Dependency coverage separately proves that the carrier, literal storage, and
length provider form the exact three-entry ABI dependency set.

Validation for this continuation:

- core Program ABI and #3521 preparation/routing coverage: **102/102
  passing**;
- numeric-local and focused host/native string coverage: **108/108 passing**,
  including all ten `str_to_utf8` cases;
- typecheck, lint, formatting, fallback ratchet, optimization-retirement
  ledger, adoption check, LOC budget, and function budget: passing;
- hybrid readiness remains **31/37 IR-emitted**, **6 typed Unsupported**, **0
  invariants**, and READY; strict IR-only remains NOT READY because all 37 lane
  units still pass through legacy body emission; and
- the required completion command is **104/106 passing** with the same two
  parent-recorded failures: the stale inline-small WAT assertion and the #3214
  imported-overload inventory-owner failure. The separate imported-string
  suite is **17/21 passing**; all four failures reproduce on the exact parent
  commit.

Cross-backend differential coverage is **29/29 passing**. The full equivalence
gate reports **1,605 passing** and **38 failing** against a 36-entry baseline:
six failures are outside that stale baseline, but all six reproduce on the
exact parent commit in the function-variable, branch-hoisting, and function
property `typeof` cases. No shared baseline file is changed by this slice.

Remaining string dependencies are concat, equality, character operations,
iteration, and oversized native literals that must materialize inline rather
than through an interned global. Dynamic/object/ref-cell/closure/union/vector
layouts, pass-derived callable reservation, and the isolated emission
transaction remain after those instruction families. This slice unlocks more
pre-lowering component seals but does not change the retirement-lane headline
or make the legacy path removable yet.

## Symbolic string callable continuation (2026-08-02)

The remaining non-iteration string instructions now carry exact callable
dependencies in final IR instead of rediscovering backend indices while the
body is emitted:

- immutable `string.concat`, owned-append `string.concat`, `string.eq`,
  `string.char_at`, and `string.char_code_at` each receive a backend-neutral
  intrinsic ref after inference and all middle-end passes;
- host preparation binds those refs to the exact `wasm:js-string.concat`,
  `wasm:js-string.equals`, `env.string_charAt`, and guarded host char-code
  providers. A char-at-only component now registers and verifies the exact
  import before provider planning rather than trusting the compatibility
  function map;
- native preparation binds the same intents to stable handles for
  `__str_concat`, `__str_concat_owned`, `__str_equals`, `__str_charAt`, and
  `__str_charCodeAt`; and
- dependency discovery records all five semantic callable identities before
  the prepared component scope seals. Reattachment is idempotent and rejects
  binding drift.

Owned append deliberately remains a distinct semantic intent even though the
host backend aliases it to ordinary concat. This preserves the migrated legacy
string-builder optimization on the native backend: production disassembly now
proves the prepared IR body calls `__str_concat_owned`, and the existing growth
boundary and string-hash runtime matrix remains green. The compatibility
numeric-index branches remain only for unprepared callers; sealed production
components lower through their exact provider refs.

The focused Program ABI, prepared-program, scoped-seal, production-routing,
string-contract, and owned-append matrix is **96/96 passing**. The expanded
numeric-local and host/native string matrix is **238/238 passing**, including
all ten `str_to_utf8` cases. Typecheck, lint, targeted formatting, fallback
ratchet, optimization-retirement ledger, adoption check, LOC budget, and
function budget pass. The fallback shape diagnostic reports **0 attributed
body-shape rejections**.

The required broad completion command remains **104/106 passing**, with the
same inline-small tail-call assertion and imported-overload inventory-owner
failure recorded by the parent slice. Cross-backend differential coverage is
**29/29 passing**. The full equivalence gate again reports **1,605 passing**
and **38 failing** against its 36-entry baseline: the same six function-value,
branch-hoisting, and function-property `typeof` failures remain outside that
stale baseline. The first local equivalence attempt lost its worker IPC channel
before writing a report; an otherwise identical single-fork rerun with a 1.5
GiB test heap completed and produced these counts.

Hybrid readiness remains **31/37 IR-emitted**, **6 typed Unsupported**, **0
invariants**, and READY. Strict IR-only remains NOT READY: **37/37** lane units
still have a legacy body emitted, and the six unsupported units are two async
functions, one call-graph closure, one async-body shape, and two static class
members. This callable slice changes preparation coverage, not that bounded
headline.

At that point, the remaining string preparation blocker was oversized native
literals that cannot use an interned global. Two string-builder
optimizations also remain: the generic owned-append loop is IR-owned, but IR
does not yet preallocate a backing array from the direct path's exact static
trip-count proof, and constant-count literal append loops remain intentionally
selector-deferred to the direct path's one `repeat(N)` plus one concat
transform. Both optimizations must be migrated before their direct handlers can
be retired. Dynamic carriers, object/ref-cell/closure/union/vector layouts,
iterator/generator/exception/async providers, pass-derived callable slots, and
the explicit emission transaction remain subsequent R2 dependencies.

## Component-local emission transaction continuation (2026-08-02)

Preparation is now component-local across mixed source ownership. A direct
class or module owner no longer forces an unrelated, dependency-complete free
function component through legacy emission. Exact local call edges still close
policy boundaries: a free function called by module init or a direct class
member stays on the post-direct route.

The preparation probe also no longer publishes an unsealed early body as final
ownership. Exact compiled-artifact evidence removes every unsealed terminal
from the early report; derived artifacts are refused on that retrying route.
Direct emission then runs, and the established late overlay produces the one
terminal report consumed by the outcome audit. Sealed owners preserve their
installed allocator object and skip direct emission. Deferred callers retain
exact AST-site plans for already sealed callees without re-adding those callees
to the emission population.

Nested executable owners and top-level functions materialized as callable
values stay off the retrying/sealed route. Their derived identities and cached
trampoline/global bindings are still created by the direct pass; attempting
them early either registered one derived unit twice or tried to mutate a sealed
prepared scope. The selector now refuses both the materialized target and an
owner that contains such a value reference, while an explicit invariant rejects
any future unsealed attempt that unexpectedly produces a derived artifact.

This continuation supplies the reusable transaction used by #3522's first
static-method slice. Validation is **89/89 passing** across exact outcome and
skip correlation, class/source/support callable ABI, prepared-component
dependency, scoped-seal, free-function routing, and static-method runtime
coverage. Typecheck, fallback ratchet, optimization-retirement ledger,
adoption check, and hybrid readiness pass. The strict gate reports **33/37 IR
emitted**, **4 Unsupported**, **0 Invariants**, and **35 legacy bodies**, so R2
is not complete and no direct handler is retirement-ready yet.

The four equivalence files that exposed #4014's six new regressions are now
**28/28 passing**: function values stored in variables, a function-valued
module object property, and branch-hoisted nested declarations all retain their
working direct/late integration path. The complete **8/8 equivalence shard**
gate reports zero new regressions; four committed baseline failures now pass,
and the baseline remains unchanged.

The next R2 work is to make the remaining dynamic/object/layout and
pass-derived dependencies sealable, then replace the transitional probe/direct/
late-overlay sequence with one isolated prepare/emit transaction and exact
emission counters. The compatibility placeholder branch cannot be deleted
until the remaining R3/R4 owners consume that transaction.

## Native string-iteration provider continuation (2026-08-02)

Native `forof.string` no longer discovers `__str_charAt_cp` by compatibility
name during lowering. Final string preparation attaches the backend-neutral
`__ir_string_iterator_char_at` callable intent; provider pre-registration
binds that intent to the exact allocator object, and prepared-component
discovery records the resulting Program ABI dependency before sealing.

The semantic distinction from `string.char_at` remains explicit: ordinary
`charAt` returns one UTF-16 code unit, while string iteration returns one full
code point and advances by that element's one- or two-code-unit length. The
lowerer retains its transitional semantic-provider default for standalone IR
fixtures, but production preparation always supplies the exact symbolic ref;
an absent provider still blocks component sealing.

The new anti-vacuity route failed before the change with
`legacyBodyEmitted: true`. It now compiles the supplementary-character fixture
once through IR, reports a prepared component, emits no legacy body, validates
as Wasm, and returns three code points for `"A💩B"`. Exact dependency coverage
also proves both the string-carrier type and iterator callable are present in
the sealed ABI component. The focused R2/string-for-of/contract matrix is
**96/96 passing**; typecheck, lint, formatting, fallback, and the optimization
retirement ledger pass. The ledger now records **15** decisions, **4** with
complete IR ownership, and **0** retirement-ready.

The bounded readiness corpus does not contain this source shape, so its
headline is intentionally unchanged: hybrid is READY at **33/37 IR bodies**,
**4 typed Unsupported**, **0 invariants**, and **35 legacy bodies**. Strict
IR-only remains NOT READY on those exact four unsupported units and 35 legacy
bodies; the production anti-vacuity fixture, rather than an unrelated corpus
delta, proves this slice's compile-once effect.

After this continuation, string preparation had one known residual: oversized
native literals that could not use an interned global. Dynamic/object/layout,
closure/ref-cell/vector, iterator/generator/exception/async, and pass-derived
dependencies remained the larger R2/R6 continuation.

## Oversized native-literal materializer continuation (2026-08-02)

Oversized native literals now have a symbolic, dependency-closed route instead
of falling back to direct body emission. Final preparation attaches one
per-literal `__ir_string_literal_materialize:*` callable intent after inference
and middle-end transforms. The callable-provider registry binds it to the exact
allocator-owned helper, prepared-component discovery records that dependency,
and lowering consumes the ref without consulting a compatibility name or
backend index.

The anti-vacuity test also exposed a pre-existing direct-backend defect: V8
rejects `array.new_fixed` lengths above 10,000, so the former inline fallback
produced a nominally successful but invalid Wasm module. The shared native
literal materializer now keeps every common literal on the existing immutable
interned-global path. An oversized literal is split into fixed-array-safe,
interned chunks, and one cached zero-argument helper assembles those chunks as
a native `ConsString` rope. Both direct and prepared IR bodies call the same
helper; no oversized `array.new_fixed` remains.

Production coverage exercises 10,001 code units in both ordinary and UTF-8
storage lanes, with a surrogate pair deliberately straddling the 10,000-unit
chunk boundary. Both direct and IR modules validate, return the exact JS
code-unit length, and iterate the boundary pair as one code point. A separate
10,004-byte/5,002-code-unit UTF-8 fixture proves byte-only overflow falls back
to one interned i16 global rather than building a rope with unsupported UTF-8
leaves. The prepared functions report `legacyBodyEmitted: false`,
`irBodyEmitted: true`, and a non-empty component ID. WAT assertions require the
cached materializer and 10,000-element chunks while rejecting every
10,001–10,009 fixed allocation. Exact dependency coverage proves the string
carrier and materializer callable are both present in the sealed component.

The focused R2/string/contract matrix is **108/108 passing** across nine test
files. Typecheck, lint, formatting, fallback, issue/adoption, LOC, and function
budget gates pass. The optimization ledger now records **16** decisions,
**5** with complete IR ownership, and **0** retirement-ready; the literal row
deliberately retains its performance follow-up before direct-path deletion.
Hybrid readiness remains READY at **33/37 IR bodies**, **4 typed Unsupported**,
**0 invariants**, and **35 legacy bodies**. Strict IR-only remains NOT READY on
those four units and the retained legacy-body population; this bounded corpus
does not contain the oversized source shape.

This closes the known instruction-level string preparation residual. String
builder presizing and counted-literal append remain separate optimization
migrations rather than component-sealing blockers. Dynamic/object/layout,
closure/ref-cell/vector, iterator/generator/exception/async, and pass-derived
dependencies remain the larger R2/R6 work.

## File ownership and locks

Lock `src/codegen/index.ts`, `src/codegen/declarations.ts`,
`src/ir/integration.ts`, `src/ir/prepare.ts`, and `src/ir/program.ts` to one R2
developer. The split crosses the ownership boundary and cannot be safely
implemented as independent edits to those files.

Changes to `class-bodies.ts`, module-init body construction, multi-source
`generateMultiModule`, `src/codegen-linear/`, runtime/builtin providers, or
async frame code are out of scope. If preparation exposes one of those as a
required follow-up, record a typed Unsupported outcome and update its assigned
R3–R8 issue instead of absorbing it.

## Anti-vacuity tests

`tests/issue-3521-prepared-ir-program.test.ts` must include:

1. A numeric allowlist function and an IR-supported function outside the old
   allowlist both become Prepared and each record exactly `direct=0, IR=1`.
   This proves the result is not merely the old skip set under a new name.
2. A selector-rejected free function becomes typed Unsupported and records
   exactly `direct=1, IR=0`; there is no IR attempt or second direct compile.
3. A local-call component with one unsafe ABI edge is classified before
   emission. No member has an emitted body when the component outcome is still
   undecided.
4. Injected build/verify/backend-legality failures before Prepared yield the
   correct typed outcome. An injected failure after Prepared is a fatal
   Invariant and direct emission stays zero.
5. An unplanned symbolic import/global/type/helper requested after the support
   seal is fatal. A planned host callback, Date snapshot, Promise delay, string
   literal, lifted closure, and monomorphized clone all resolve without lazy
   fallback.
6. `JS2WASM_IR_FIRST=0` / `disableIrFirst` (while still supported) can select
   the temporary direct policy but never cause `direct=1, IR=1`.
7. Inventory, outcome, and emission denominators reconcile; duplicate/missing
   counters and a shipping placeholder fail the test.
8. Encode/decode round-trips a fixture containing all supported scalar and ID
   forms, including `NaN`, infinities, negative zero, bigint, source spans,
   support intents, and component ownership, with semantic deep equality.
9. Reordered construction produces byte-identical serialization. Corruption,
   unknown versions, forged outcome/provider data, and backend mismatch fail
   before an emitter or publication hook can run.

Run these with `tests/issue-3143.test.ts`, `tests/issue-3203.test.ts`,
`tests/issue-3214-imported-hof.test.ts`, the inline/mono pass suites, and the
full equivalence/cross-backend gates.

## Acceptance criteria

- [ ] `PreparedIrProgram` is complete and immutable before any R2
      free-function body emission starts.
- [ ] Its canonical, versioned serialization round-trips without scalar,
      source-identity, ABI, effect, support-intent, component, or decision loss;
      equivalent input orderings produce byte-identical output.
- [ ] Decoding is fail-closed and re-verifies the complete prepared contract.
      Invalid/incompatible snapshots emit typed #3678 diagnostics before any
      artifact, cache entry, registry state, or output file is published.
- [ ] Preparation includes final typed IR, verification/passes, target legality,
      ABI validation, and every support intent; emission performs no new
      capability decision.
- [ ] Component ownership is frozen before body emission. Each free function
      has exactly one terminal outcome and at most one successful body emitter.
- [ ] Prepared free functions never invoke `compileFunctionBody`, never receive
      a legacy placeholder, and record `direct=0, IR=1` regardless of whether
      they belonged to the old numeric allowlist.
- [ ] Unsupported free functions direct-compile exactly once in temporary
      hybrid mode. Invariants fail without direct retry.
- [ ] Any failure after Prepared is fatal and cannot demote, patch back, or ship
      a partial/unreachable body.
- [ ] Transitional fallback/adoption/R0 telemetry is derived from the exact
      ledger and retains label/count parity where policy did not intentionally
      change.
- [ ] Existing runtime behavior, public ABI, equivalence, cross-backend,
      standalone/WASI validity, and full merge-group Test262 are
      net-non-negative.

## Risks and mitigations

- **Preparation side effects:** a failed unit could leave imports, helpers, or
  slots behind. Build in an isolated transaction and publish only a terminal
  Prepared component.
- **Mixed-component ABI drift:** direct callers and Prepared callees may
  disagree on signatures. Freeze ownership by call/ABI component and validate
  every edge against `ProgramAbiMap` before any body emission.
- **Late support discovery:** strings, callbacks, lifted units, or runtime
  helpers may be requested during lowering. Inventory typed support intents
  during preparation and make a post-seal request an Invariant.
- **Lost inlining behavior:** the second legacy phase currently populates an
  inlinable registry. Run optimization over the complete Prepared program and
  retain explicit performance/equivalence evidence without a discovery pass.
- **Coarse fallback hiding progress:** component-atomic Unsupported may direct-
  emit more bodies initially. Report both root cause and affected component;
  never split ownership merely to improve the headline count.

## Out of scope

- Class declarations/members, constructors, class expressions, object methods,
  or nested closure ownership (#3522).
- Module-init preparation, static field/block execution, TDZ/start semantics,
  or removal of the two direct init passes (#3523).
- `generateMultiModule` whole-program ownership (R5), new runtime semantic
  intrinsics (R6), async ownership (R7), or shared linear consumption (R8).
- Removing public/env escape hatches (R9) or deleting direct handlers
  (#3090/R10).

## Required completion evidence

```bash
pnpm exec vitest run tests/issue-3521-prepared-ir-program.test.ts tests/issue-3143.test.ts tests/issue-3203.test.ts tests/issue-3214-imported-hof.test.ts tests/ir/inline-small.test.ts tests/ir/phase3c.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

The PR report must include inventory and outcome denominators, a per-unit
direct/IR emission table, the old-allowlist vs Prepared delta, all post-Prepared
failure injections, and proof that no in-scope placeholder or compile-twice
unit shipped. “IR emitted” without `directBodyEmissions: 0` is not acceptance.

## 2026-07-30 Program ABI session-seal prerequisite

The bounded `3521:program-abi-session-seal` slice separates
`ProgramAbiSession` into an explicit deterministic `sealPlan()` boundary and a
later `bindAndPublish()` boundary. The existing `publish()` API remains a
behavior-preserving wrapper over both phases, so production routing is
unchanged.

After sealing, new ABI drafts, derived units, contracts, locators, and
structural-reference registrations are rejected. Exact function/global
locator replacement, type-layout remapping, provisional index resolution, and
final binding remain available until publication. `sealPlan()` exposes only a
frozen read-only view; the bind-capable `ProgramAbiMap` is rebuilt privately
from frozen structural intentions and the current post-DCE type sidecars.
Final locators, indices, and collisions are validated into a temporary set
before any index is committed or a publication becomes observable.

Focused coverage proves late-plan and missing-locator rejection, post-seal
function replacement, callable/global/type-cell DCE remapping, late-import
index shifts, capability-safe sealed views, atomic failure on a later missing
locator, exact final-index binding, post-publication closure, and one-shot
publication.

This is a prerequisite seam only. Prepared free-function ownership, terminal
component outcomes, support-intent collection, and direct/IR emission
accounting remain for the main R2 implementation.

## 2026-08-02 symbolic vector-layout continuation

Vector types in typed IR now carry only their logical element type and
nullability. The WasmGC carrier struct and backing-array references are
attached during final Program ABI preparation, after the backend and numeric
element representation are known. Prepared-component dependency collection
records both exact support-type roots and fails closed for a missing, invalid,
or drifting layout. Vector helper identities are likewise logical; WasmGC,
linear, and Porffor resolve them at their final lowering boundaries without
embedding physical type indexes in IR provider names.

The post-rebase equivalence shard also proved that logical vectors must use the
same representation boundary for mutable locals and parameters. Slot planning
now resolves string, dynamic, and vector storage through one helper, while
identifier reads and assignments retain their logical IR types. #1196 covers
both a reassigned local vector and a reassigned vector parameter, with the
counted-loop bounds proof correctly withdrawn after reassignment.

Anti-vacuity coverage now proves that the quicksort-plus-main vector component
is prepared and emits with `direct=0, IR=1`. The original #1198 complex fixture
is retained and still exposes its separate bitwise/runtime-support dependency;
a smaller dense-fill fixture proves the vector preparation path independently.
#1001 counted push, #2780 fixed literals, #2766 bounds-sensitive reads, and
#3734 i32 elements cover the migrated vector optimizations. The focused core
matrix passes 58/58, the optimization matrix passes 69/69, and #3501 passes
9 tests with 2 optional native tests skipped. Typecheck, formatting, staged
lint, the changed-root hook, and the optimization-ledger checker pass. The
ledger contains 21 decisions: 10 are IR-owned and the i32-element row is the
first retirement-ready vector decision; four performance-attribution rows
remain open.

This slice does not claim the whole six-function Algorithms fixture. Its
remaining component blockers are source-global storage, TDZ, and module-init
ownership in #3523, plus throw/exception, `extern.call`, box/unbox, undefined,
numeric, string, and console support providers in #3526. Those are independent
of vector layout and remain the next prepared-ownership work.

## 2026-08-09 uncovered provider-transaction violation

#4259's injected pre-seal failure exposed a gap in this issue's existing
"abort without partial publication" contract. Blocking callable imports and
providers are currently published through compilation-wide `planPrepared`
state before the consumer opens its `PreparedProgramAbiScopeTransaction`.
Aborting that component therefore cannot retract the provider/import draft: a
TDZ setter leaves a stale host `__new_ReferenceError` reservation or an
unplanned standalone provider when direct fallback resumes.

#4260 owns the bounded repair and regression matrix. It must stage exact
provider/import keys with the component, atomically publish them on seal, and
discard failed-only plans on abort while retaining one canonical provider for a
healthy component that shares it. Keeping a dead import or weakening the
missing-locator invariant does not satisfy this parent issue's transaction
acceptance.
