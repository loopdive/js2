---
id: 3521
title: "IR-only R2: prepare-before-emit free-function ownership"
status: in-progress
created: 2026-07-21
updated: 2026-08-27
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [3520, 4260]
required_by: [3522, 3523, 3525, 3526, 3792, 4601]
assignee: ttraenkler/codex-ir-lead
pr: 5000
branch: codex/3521-linked-owner-closure-current
horizon: xl
complexity: XL
es_edition: n/a
lane: ir-retirement-r2
model: gpt-5.6-luna
related: [2138, 2855, 3143, 3203, 3518, 3519, 3678, 4260, 4382]
loc-budget-allow:
  - src/ir/propagate.ts
  - src/ir/select.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/codegen/context/types.ts
  - src/codegen/program-abi-session.ts
  - src/ir/backend/porffor/assembler.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
  - src/ir/builder.ts
  - src/ir/prepared-component-dependencies.ts
oracle-ratchet-allow:
  - src/codegen/ir-fnctor-admission.ts
  - src/codegen/program-abi-fnctor-producer.ts
  - src/codegen/ir-fnctor-parameter-planning.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::makeResolver
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/select.ts::isPhase1Expr
  - src/codegen/index.ts::generateModule
  - src/ir/backend/linear-integration.ts::makeLinearIrResolver
  - src/ir/verify.ts::verifyInstrStructure
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/codegen/context/create-context.ts::createCodegenContext
origin: "#3518 R2 — invert single-source free functions from compile/patch to prepare/emit"
files:
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/integration.ts
  - src/ir/abi-bindings.ts
  - src/ir/callable-bindings.ts
  - src/ir/fnctor-abi.ts
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
  - src/codegen/program-abi-fnctor-planning.ts
  - src/codegen/ir-fnctor-admission.ts
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
  - tests/issue-3521-linked-final-context-caller-abi.test.ts
  - tests/issue-3521-linked-string-parser-abi.test.ts
  - tests/issue-3521-scoped-prepared-abi-seal.test.ts
  - tests/issue-3520-program-abi-import-callable-planning.test.ts
  - tests/issue-3520-callable-provider-abi.test.ts
  - tests/issue-3765-numeric-locals.test.ts
  - tests/ir/fnctor-abi.test.ts
  - tests/ir/fnctor-admission.test.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
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

## 2026-08-22 lane handover (fable-lead)

Claimed to ttraenkler/fable-lead on the assignment ref (the prior lane is
dead). Not started this session. **Recommended first slice for the next
dispatch: the linked-lane late-preparation gap** measured by PR #4732 and
recorded in #2949's "linked-lane preparation gap" section — the #2949
runtime-dynamic acorn driver compiled as a multi-source project
(`compileProject`) emits **1/43** versus 31/43 inline, with **21 units
selector-accepted but absent from the prepared selection** at
`late-preparation-unsupported` and no recorded preparation failure. The gap
is in final-context preparation (`reconcileIrOverlayOutcomes` bookkeeping),
i.e. this issue's territory jointly with #3520's identity records, and
fixing it makes every claim #2949 has banked visible on the linked lane.
Session-wide context: `plan/agent-context/fable-lead.md`.

## 2026-08-22 next slice plan — linked final-context caller ABI

This slice was re-grounded on authoritative `main`
`31ce53569ec8dd9aab90a34eb16b1d53deb4bc74` with a fresh Acorn 8.16.0
linked-versus-inline measurement and a two-file reduced reproduction. The
handover's historical production ledger reported linked `1/43` versus inline
`31/43`. A fresh pre-optimizer run, used because the current Binaryen O4 lane
returns an unrelated optimizer error before publishing its ledger, reports
linked **1/42 free functions with 21 late drops** versus inline **31/42 with
zero late drops**. The linked run took 33.588 seconds and inline 31.176 seconds.

The honest ceiling for this slice is linked **1 -> 22/42**, not 31/42. Nine
inline wins are already rejected at selection: `isIdentifierStart`,
`isIdentifierChar`, `nextLineBreak`, `codePointToString`, `functionFlags`,
`isRegExpIdentifierStart`, `isRegExpIdentifierPart`, `parse`, and
`parseExpressionAt`. They belong to a later selector/project-type-parity
slice and must not be absorbed here.

### Exact cause and bounded production change

`reconcileIrOverlayOutcomes` reports the consequence but is not the cause.
`planIrOverlay` already invokes the exact per-declaration
`legacyCallerAbiIsProjected` proof. Selection retains those targets, but
`makeMultiIrSafeSelection` later blocks them unconditionally when
`collectLocalCallEdgesByIdentity` reports an unowned/direct caller or a
non-function/non-module-init terminal owner. Acorn's prototype-assigned
function expressions enter through that second caller-direction gate, so 21
certified functions disappear as generic `late-preparation-unsupported`
outcomes without a concrete preparation failure.

Keep production ownership to `src/codegen/index.ts` and add one focused test.
Do not change `select.ts`, `select-identity.ts`, `ir-first-gate.ts`,
`ir-prepared-free-functions.ts`, integration, or the reconciler.

1. When `planIrOverlay` applies `legacyCallerAbiIsProjected`, freeze the exact
   certified target `IrUnitId`s on the overlay plan.
2. In `makeMultiIrSafeSelection`, exempt only those certified target IDs from
   the two duplicated outside/direct-caller blocks. Preserve every other
   cross-file mode, callable-boundary, collision, import-alias, name-registry,
   nested/generic/import-use, forward-callee, and closed-component gate.
3. Record a concrete typed preparation failure for every uncertified target
   removed by the caller gate, with detail that the multi-source direct-caller
   ABI was not certified. The reconciler must not invent a generic reason for
   a known removal.
4. Keep final integration's allocated-slot type-index parity as the last
   fail-closed backstop. A mismatch retains the legacy body and reports the
   existing `abi-signature-parity` outcome.

The certificate is per source-qualified UnitId, never a name or fixture
allowlist. A callable parameter, string-array parameter, implicit return,
collision, unresolved import alias, or unprojected outside caller remains
legacy.

### Mutation-proof acceptance

Add `tests/issue-3521-linked-final-context-caller-abi.test.ts` around a measured
sub-two-second two-file standalone fixture: a dependency declares a JSDoc
`(number) -> number` scalar, and a prototype-assigned function expression calls
it; the entry imports the dependency export. On current main the linked scalar
is selected then dropped as `late-preparation-unsupported`, with legacy true,
IR false, and no compiled function. The same dependency inline emits IR.

- Require linked `compileMulti` and disk `compileProject` to emit the exact
  source-qualified scalar UnitId, run with the inline result, instantiate as
  valid Wasm, and publish no late caller-ABI row.
- Require callable-parameter `apply`, `string[]`, and implicit-return controls
  to remain fail-closed with precise preparation failures. Preserve the
  existing #2138 cross-file numeric/callable and collision controls.
- Add a test-only switch around only the certificate consult. With it disabled,
  the exact positive must restore the current late row and legacy body. A
  mutant that deletes or negates the certificate branch must fail the matrix.

Before and after editing, capture the reduced fixture and full linked Acorn
histograms in fresh processes. Acceptance is linked **1 -> 22/42**, all 21
named late drops removed, no new withdrawal/post-claim errors, every other
linked bucket identical, and inline still 31/42 with the same withdrawal set.
The 21 names are `isNewLine`, `isPrivateNameConflicted`, `checkKeyName`,
`isLocalVariableAccess`, `isPrivateFieldAccess`, `hasProp`,
`isRegularExpressionModifier`, `isSyntaxCharacter`, `isControlLetter`,
`isValidUnicode`, `isCharacterClassEscape`,
`isUnicodePropertyNameCharacter`, `isUnicodePropertyValueCharacter`,
`isClassSetReservedDoublePunctuatorCharacter`, `isClassSetSyntaxCharacter`,
`isClassSetReservedPunctuator`, `isDecimalDigit`, `isHexDigit`, `hexToInt`,
`isOctalDigit`, and `stringToNumber`. If fewer move, stop and report the exact
residual IDs; do not widen the selector.

Run the focused test, #2138 adjacency, typecheck, fallback, oracle, LOC, and
function gates before the full Acorn measurement. Release validation uses all
eight equivalence shards in fresh processes, never an unsharded suite. O4
dashboard timing remains a separate known Binaryen optimizer blocker unless a
working native optimizer lane is available.

Open PRs #4728 and #4723 also touched `src/codegen/index.ts`; re-ground current
main immediately before implementation and merge. PR #4747 is file-disjoint.
The issue checkpoint remains in the single documentation PR; the implementation
worker owns only `index.ts` and the new focused test.

## 2026-08-22 stop checkpoint — caller-gate exemption was inert on Acorn

The proposed `makeMultiIrSafeSelection` exemption above was implemented only far
enough to run its mandatory stop/go measurement on pinned `main`
`3f8b6e6e6bef2e8336e68291bc9330c20afb49b0`, then fully unwound. The worktree is
clean and no implementation commit or PR exists.

The reduced class-member/direct-caller fixture did prove that the exact
source-qualified `legacyCallerAbiIsProjected` certificate can move that narrow
gate: the certified target emitted through IR, and disabling only the consult
restored the precise `multi-source direct-caller ABI was not certified` late
row. That result was not representative of Acorn. The full pre-optimizer linked
Acorn run completed successfully in 127.1 seconds and remained exactly **1/42**
free functions with the same **21** `late-preparation-unsupported` rows. None of
the named target IDs moved, so the required 1 -> 22/42 stop gate failed.

The grounded cause is one layer later. Acorn's prototype-assigned helper calls
are attributed to the source `module-init`. `makeMultiIrSafeSelection` seeds that
module-init owner as blocked, then `closeRetainedIrOwnersByIdentity` propagates
the blocked caller through the caller-to-callee closure. The two explicit
unowned/non-function caller blocks are therefore not the load-bearing rejection
for the real project.

The next slice must be re-planned at that owner-closure boundary, not by widening
the rejected `makeMultiIrSafeSelection` patch:

1. Pass the exact source-qualified certified-target set into the retained-owner
   fixed point (or an equivalent typed edge policy).
2. Preserve the blocked module-init owner and every uncertified callee edge, but
   do not propagate that blocked caller into a target whose direct/allocated ABI
   certificate is exact.
3. Publish a concrete typed late-preparation failure for every uncertified edge;
   do not infer success from absence of a generic row.
4. Prove the rule first with a reduced **module-init/prototype-assignment**
   fixture, not the class-member fixture, and keep the same kill switch.
5. Re-run the full linked Acorn stop gate. Acceptance remains exactly 1 -> 22/42
   with all 21 late rows removed and the nine selector-stage rejects unchanged.

This necessarily expands the production ownership beyond `src/codegen/index.ts`.
Re-ground the exact fixed-point implementation and its dependency/atomicity
contract before dispatch; do not resume the rejected patch or relax selection.

### Re-grounded fixed-point slice

The load-bearing production seam is
`src/codegen/ir-overlay-finalize.ts::closeRetainedIrOwnersByIdentity`. Its
blocked-caller arm currently deletes every retained callee. In the linked Acorn
shape, `makeMultiIrSafeSelection` first places the exact source module-init unit
in `blocked`, then this arm propagates module-init ownership into all 21 helpers.
The reverse arm (retained caller depending on a blocked callee) is a different
correctness rule and must remain unchanged.

The smallest implementation owns `src/codegen/index.ts` and
`src/codegen/ir-overlay-finalize.ts` plus the focused test:

1. Wrap the existing per-declaration `legacyCallerAbiIsProjected` callback at
   selection time. When and only when the existing proof returns true, resolve
   the declaration through `identityContext.unitIdByDeclaration`, require the
   exact same-source bodyful function terminal, and add that source-qualified
   UnitId to an idempotent frozen certificate set on `IrOverlayPlan`.
2. Extend only the M0 `closeIrBlockedComponentByIdentity` call with that exact
   set. Default every other caller to today's behavior; timer, prepared-free,
   overlay-safety, and later support-finalization closures must not inherit the
   exemption.
3. In the blocked-caller-to-retained-callee arm, suppress propagation only when
   the exact callee UnitId is in the validated certificate set. Do not exempt an
   initially blocked certified unit, do not unblock the caller, and do not alter
   retained-caller-to-blocked-callee propagation. A certified target with any
   other blocked dependency still withdraws through the unchanged reverse arm.
4. Return or callback exact propagation evidence to M0 so every uncertified
   target removed by this edge gets a concrete typed
   `late-preparation-unsupported` failure. The reconciler must not fabricate a
   generic reason. The callback/result is diagnostic only; closure and failure
   publication must be computed before Prepared skipping, as one transaction.
5. Keep allocated-slot function-type parity in final integration as the last
   fail-closed backstop. A late mismatch preserves the direct body and reports
   the existing ABI-parity failure; it never retries after an IR-only skip.

Validate every supplied certificate ID before closure: exact source, exact
function terminal/declaration round trip, and presence in the plan's function
claims. A foreign, cloned, non-function, or stale ID is an invariant. The set is
not a name allowlist and does not make an unselected/initially blocked function
retained.

Replace the earlier class-member reproducer with the actual owner shape: a
two-file standalone dependency containing an annotated numeric scalar plus a
top-level prototype/property assignment whose function expression calls that
scalar, and an entry importing the dependency export. Assert the call is owned
by the source module-init, the scalar has the exact certificate, and the linked
compile emits it while the identical inline source remains unchanged. A
test-only switch around only the fixed-point exemption must restore the exact
late row and direct body. Callable, array, implicit-return, collision, foreign
source, uncertified module-init, and reverse-blocked-dependency controls remain
direct with precise failures. Mutants that apply the exemption to every closure
caller, use names, skip validation, or exempt the reverse arm must fail.

The mandatory stop/go remains the fresh pre-optimizer Acorn ledger: linked must
move **1 -> 22/42**, all 21 named late rows must disappear, no other linked
bucket may move, and inline must remain 31/42 with the same nine selector-stage
rejects. Any residual stops the slice; do not widen selection. Current active
branches #3523 and #4615 overlap `index.ts`, so dispatch only from a main that
contains those predecessors (or rebase immediately before editing).

## 2026-08-22 second stop checkpoint — two prerequisites remain

The bounded fixed-point policy above was implemented on `cf9394a65`, exercised
against linked Acorn, and then fully unwound. The stop gate missed: linked moved
from 1/42 to **20/42**, not 22/42. Nineteen of the 21 late helpers emitted,
`checkKeyName` remained `late-preparation-unsupported`, and `stringToNumber`
reached final integration but withdrew at `abi-signature-parity` (IR type 134,
legacy type 141). The worktree is clean; no partial implementation, commit, or
PR remains.

Both residuals were independently re-grounded on authoritative `main`
`e15b07b` and form an ordered two-stage prerequisite:

1. **Native-string ABI parity for `stringToNumber`.** Linked local analysis
   makes the direct first parameter `(ref null $AnyString)`, while IR leaves it
   dynamic/externref. Reuse the existing exact
   `isExactDynamicStringReplaceNumberParser` proof in `src/ir/integration.ts`:
   only when the exact legacy slot is the native-string carrier, the second
   slot is the existing boolean `i32`, and the fixed parser shape matches,
   adopt `{ kind: "string" }` for override parameter zero. In
   `src/ir/from-ast.ts`, reuse the existing string-replace helper for that exact
   `str.replace(/_/g, "")` receiver and add a narrowly paired direct-call
   boundary for parameter zero of the exact parser's `parseInt`/`parseFloat`
   calls, coercing the proven string to externref. Do not add a generic
   string-to-externref rule or change selection. A two-file reduced
   `Parser`/`readNumber` fixture must flip ABI withdrawal to IR emission and
   return 12345.5/15; disabling only first-parameter adoption restores the
   exact parity failure. Pattern, radix, replacement, non-native-string, and
   unrelated direct-call controls remain fail-closed.
2. **Mixed unresolved/native-string caller certification plus owner closure.**
   `checkKeyName` has the exact direct/inline signature
   `(externref, ref null $AnyString) -> i32`, but the current certificate omits
   the mixed unresolved+string surface. Extend only the non-fast stable
   certificate when allocated evidence proves unresolved=externref,
   string=`AnyString`, and the existing boolean result. Then apply the prior
   source-qualified certificate set only to M0's blocked-caller-to-retained-
   callee fixed point, preserving initial deletion, blocked module init,
   reverse dependency propagation, and all other callers. The reduced fixture
   must pin the exact source-module-init UnitId to `checkKeyName` edge; separate
   mutations of mixed-string certification and closure exemption must each
   restore the precise late row.

After both stages, rerun the original fresh linked/inline stop gate. Linked must
be exactly **22/42**, with zero late-preparation and zero ABI-parity rows;
`checkKeyName` and `stringToNumber` both emit. The unchanged linked buckets are
regexp-constructor 2, return-type 3, param-type 1, logical-value 1,
body-shape 11, and call-graph-closure 2; inline remains 31/42. Any miss again
stops and unwinds. Stage one overlaps active #3522/#4608 `integration.ts`;
stage two overlaps #3522/#3523/#4615 `index.ts`. Do not dispatch either until
those predecessors land and the branch is rebased.

## 2026-08-22 stage-one plan — linked native-string parser ABI parity

This prerequisite is READY for implementation from authoritative `main`
`15a8a813379bc1821eb46bec66be23ba313eb45a`, subject to rebasing after #4608
because both touch `src/ir/integration.ts`. It is deliberately an ABI-parity
overlay checkpoint, **not** a prepare-before-direct or compile-once claim.
Success means `stringToNumber` changes from legacy-only after an IR parity
withdrawal to legacy-plus-IR patching. The raw UnitId override remains dynamic,
so the R2 stable-signature gate may still decline early ownership until the
later fixed-point slice.

### Measured reproducer and root cause

The exact preserved two-file fixture is JavaScript-shaped source compiled with
`allowJs: true`:

```js
// entry.mjs
import "./empty.mjs";
function Parser(input) {
  this.input = input;
}
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) return parseInt(str, 8);
  return parseFloat(str.replace(/_/g, ""));
}
function readNumber(parser) {
  var octal = false;
  return stringToNumber(parser.input.slice(0, parser.input.length), octal);
}
export function run() {
  return readNumber(new Parser("12_3"));
}

// empty.mjs
export const unused = 0;
```

Use `compileMulti` with entry `entry.mjs`, `skipSemanticDiagnostics: true`,
`target: "standalone"`, `deferTopLevelInit: true`, `trackIrOutcomes: true`,
`optimize: 0`, `preserveDebugNames: true`, and a function-only WAT view for
`stringToNumber`. On the measured base the compile succeeds, but no function is
IR-emitted. `stringToNumber` reaches patch-time parity and reports
`function typeIdx parity mismatch: IR=123, legacy=43`; its direct header is
`(ref null $AnyString, i32) -> f64`. The filtered outcome ledger was empty in
that diagnostic probe, so the first focused test must prove the attempt through
the parity diagnostic/compile audit rather than inventing a literal base
outcome row.

Linked local string analysis makes the direct first parameter native
`$AnyString`. The shared IR override remains `dynamic`, while the existing
exact parser repair changes only parameter 1 to boolean `i32`. Final IR patching
therefore compares `(externref, i32) -> f64` against
`(ref null $AnyString, i32) -> f64` and keeps the legacy body.

### Bounded production contract

Own only `src/ir/integration.ts`, `src/ir/from-ast.ts`, and
`tests/issue-3521-linked-string-parser-abi.test.ts`.

1. Cache one effective row per exact selected top-level declaration and UnitId:
   `{ signature, exactNativeStringNumberParser }`. Never mutate the raw
   name-keyed or UnitId-keyed override object or either shared map; preparation,
   inherited-skip safety, and other backend consumers must continue to observe
   the original dynamic signature.
2. Resolve the legacy function slot through the exact source-qualified UnitId
   and `ProgramAbiSourceCallableRegistry.handleForUnit`, then require the live
   allocator object through `definedFuncAt`. Do not certify the native string
   carrier through `ctx.funcMap.get(name)`: a same-spelled function in another
   source can overwrite that display-name map. The compatibility path may use
   its historical lookup only when no production identity context exists.
3. Preserve the existing parameter-1 repair independently. Adopt parameter 0
   as semantic `{ kind: "string" }` only when all of these are true: the exact
   `isExactDynamicStringReplaceNumberParser` AST predicate; raw parameter 0 is
   dynamic; the exact legacy slot is `ref`/`ref_null` of `ctx.anyStrTypeIdx`;
   parameter 1 is the already-proven boolean `i32`; standalone native strings;
   non-fast mode; and the dedicated test switch is off. The switch suppresses
   only parameter-0 adoption, never the older boolean repair.
4. Thread an owner-local proof bit through `AstToIrOptions` / `LowerCtx`. It is
   false for every nested or lifted body and confers no generic string-method,
   parse-provider, or string-to-externref capability.
5. Reconcile direct-call plans locally. For a source call whose exact UnitId is
   the adopted parser, clone/replace only that call target's signature with the
   effective row. Preserve an existing exact source target ahead of any runtime
   spelling. A local/same-spelled `parseInt` or `parseFloat` declaration must
   never be replaced by a runtime target; missing or ambiguous target identity
   fails closed. Leave `loweringPlans.signaturesByUnitId` and shared plan maps
   untouched.
6. Make the `parseInt` and `parseFloat` runtime targets available only inside
   the proof-bearing parser owner. Remove the former global
   `selected.funcs.has("stringToNumber")` name exposure. Runtime availability
   and lowering must resolve through the existing
   `ctx.ambientBuiltinFuncMap`, whose contract explicitly prevents a
   same-spelled user function in another source from stealing the ambient
   alias. Do not consult `funcMap` for these two runtime refs, and do not let an
   unrelated owner gain either target.
7. Reuse one exact dynamic string-replace sequence. A proven native-string
   receiver may enter it only for `str.replace(/_/g, "")`: canonical-box the
   receiver and empty replacement, then call the existing
   `IR_DYN_STRING_REPLACE_FN`. The prior dynamic-receiver path must remain byte-
   and behavior-identical.
8. At direct-call argument 0 only, the proof-bearing parser may cross a
   concrete string to the existing externref `parseInt` / `parseFloat` boundary
   with `emitCoerceToExternref`. A dynamic value is accepted there only when
   `dynamicCarrierIsExternref()` is true. Do not use the DOM-only native-string
   marker and do not introduce a general string-to-externref rule. Fast mode
   remains excluded because its `$AnyValue` dynamic carrier is not that host
   boundary.

### Anti-vacuity and mutation matrix

The focused suite must first reproduce the exact base parity failure on the
fixture above. A class-member replacement is invalid: multi-source final
selection currently clears class members and would make both dirty integration
paths unreachable. Keep `readNumber` as the measured top-level caller so the
test exercises source-caller signature reconciliation.

With the change enabled, require valid Wasm and runtime `run() === 123`; add an
otherwise identical true-branch entry proving octal `"17" -> 15` without
changing the exact parser/caller topology. Require `stringToNumber` to be
IR-emitted, retain its honest legacy-body flag, and publish no ABI-parity or
post-claim failure. If a Prepared component ID appears, it is correlation
evidence only; do not describe this stage as direct=0 or compile-once.

Disabling only parameter-0 adoption must restore the exact parity diagnostic,
legacy body, and absence from the IR-compiled set while leaving the parameter-1
boolean repair active. Mutation controls must cover radix 10/missing radix,
`/x/g`, non-empty replacement, a same-name wrong-shape parser, a source/local
`parseInt` collision, an unrelated parse caller, a same-spelled function in a
second source, host strings, fast native mode, and a source caller whose call
plan would still carry the raw dynamic target without local reconciliation.
None may gain the proof or a runtime parse target.

Keep `tests/issue-3794-ir-dynamic-replace.test.ts` and
`tests/issue-4585-npm-compat-refresh-resilience.test.ts` as adjacent controls.
Run the focused stop gate before typecheck or broader gates. Then run
typecheck, Prettier/diff, LOC/function, oracle, fallback, and the relevant
multi-source adjacency. Release still requires eight separate equivalence
shards. The full Acorn 22/42 measurement belongs only after stage two restores
the owner-closure change; stage one alone must not claim that denominator.

The folded production overlay is +180 net lines in `integration.ts` and +84 in
`from-ast.ts`; both are already listed in this issue's
`loc-budget-allow`. Its new focused test currently contains 13 cases. Keep
helpers bounded and the existing functions within the declared function
allowance. This issue file and the new test path must be in the implementation
PR so the change-scoped budget gate reads the grant. Never edit shared budget
baselines.

### 2026-08-22 signed current-stack implementation checkpoint

The R2 worktree at `/private/tmp/js2-3521-r2-replay-4608-5d55` is clean at
signed commit `62a87e822a598f1c260366c17ba768059dbbf597`, with signed #4608
parent `6d553d0ba2382d4caabbf4932c8bb7f37b9787a5`, tree
`cf3dd3e571ef445f29003f98057fdb24d586c666`, source/test stable patch ID
`8efd040fb983d40d58e253cbae85063f220ca111`, and full binary-diff SHA-256
`d0e08a72069418a5e0408c209cb86ca924a88ff0b862f3adb05252ed5505b65d`.
Its SSH signature verifies with Thomas's ED25519 key
`SHA256:DR95AGYro71Tam9UvWGtJZtdhbvNVI+qlGMp/naIyHc`; author and committer are
Thomas Tränkler, with the Codex co-author trailer. The commit owns exactly:

- this issue file, changed by 25 additions and 1 deletion to activate only its
  existing change-scoped allowances and record the bounded replay;
- `src/ir/from-ast.ts`, changed by 131 additions and 47 deletions;
- `src/ir/integration.ts`, changed by 241 additions and 61 deletions; and
- `tests/issue-3521-linked-string-parser-abi.test.ts`, added at 510 lines.

The historical signed source checkpoints remain
`b1f1ebd198f633c1addc5bc8f6152138c3f22ae2` (tree
`6f3a5b2fb30e215cc23462fab5bcc484ee9e1a9a`) plus type-predicate child
`4755b1347292c344efac794b3b103ff6f1fa6046` (combined tree
`33758421a30c7f01b94e88cb612bc27257d42706`). The current commit folds both
into one atomic replay, preserves their production blobs after composition,
and adds only the issue metadata plus the reviewed host-string byte-identity
assertion. Static review is **APPROVE** for the exact signed current-stack tree.
Prettier, Biome, cached diff, IR layering (83/83), IR dialect, LOC, and function
budgets pass. The LOC gate reports the existing grants as +84 for `from-ast.ts`
and +177 for the composed `integration.ts` relative to the current change base;
no shared baseline changed. Runtime and release acceptance remain deferred to
the low-load gates below.

The child changes only the TypeScript predicate that narrows numeric-separator
`replace` receivers. Its return-type annotation is erased, so it is neutral to
runtime and Wasm byte semantics. The current atomic commit incorporates that
child; any future replay must keep the type narrowing folded with R2 rather
than resurrecting the standalone `b1f1ebd1` checkpoint.

Static review tightened the original one-bit contract into two owner-local
facts:

- `exactStringNumberParserRuntimeOwner` proves the exact parser AST and the
  non-fast externref runtime boundary. It alone may construct the parser's
  `parseInt` / `parseFloat` direct-call plans from
  `ctx.ambientBuiltinFuncMap`, and it admits only the authenticated dynamic to
  externref argument-zero boundary.
- `exactNativeStringNumberParser` depends on that first proof and additionally
  requires standalone native strings, the exact `$AnyString` legacy slot, the
  already-repaired boolean parameter, and the dedicated switch. It alone may
  adopt semantic string for parameter zero, box the exact native
  `replace(/_/g, "")` receiver, or coerce a proven concrete string into the
  parse boundary.

Effective signature adoption is copy-only: it clones the parameter array and
copies `preparedDirectCalls` before any owner-local replacement. It does not
mutate the shared name, UnitId signature, or call-plan maps. Production
allocator and signature lookup stays UnitId-qualified; compatibility name
fallback does not authorize this proof. Exact source parse bindings beat
runtime spelling. Ambiguous or mixed identities, cross-source collisions, and
wrong-AST/UnitId declarations withdraw. Ambient providers come only from
`ambientBuiltinFuncMap`, never `funcMap`. Both proof facts reset for nested and
lifted bodies, forced-fast integration remains excluded, and host strings keep
the existing dynamic route.

The 13-case focused matrix covers disabled exact ABI-parity withdrawal,
parameter-one boolean retention, enabled decimal and octal routes, caller-plan
reconciliation, same-source and cross-source identity, ambiguity and wrong
AST/UnitId, radix/pattern/replacement mutations, an unrelated parse caller,
host strings, and forced-fast integration. The host enabled/disabled case
now asserts exact enabled/disabled binary equality before the two results are
independently validated, instantiated, and required to return `123`.

C36 `5573344c`, C37 `b1e974aa`, #4608 `6d553d0b`, and R2 `62a87e82` are now a
literal signed chain on exact main `5d55b338`. C37's exact declaration-owned
direct allocator is the semantic prerequisite for R2's UnitId signature
adoption. #4608 and R2 both touch `src/ir/integration.ts`; the signed composed
tree preserves #4608's post-inline and post-monomorphization
`programAbiModuleDeclarations` hooks exactly while R2 owns the parser-signature
and direct-call reconciliation blocks. The remaining order is **#3522 after
R2**.

The later signed #3522 checkpoint `c549dded` has a real composition conflict in
the direct-call-plan block of `src/ir/integration.ts`. #3522 replaces the
inline collector with `makeIrDirectCallPlanReconciler` and adds
`constructorFieldCalls` exclusions plus exact `requireConstructorInitializer`
handling; R2 adds owner-local ambient/source parser target selection and exact
adopted-UnitId signature replacement at that block. Resolve the conflict by
preserving #3522's constructor-owned field-call exclusions and exact
initializer requirement, then extending or using its reconciler for R2's
owner-local targets and adopted-signature replacement. Taking only the R2 side
would regress field-initializer ownership; taking only #3522 would lose parser
identity and adopted ABI. `src/ir/from-ast.ts` and the focused tests otherwise
compose cleanly.

When a low-load window opens, run the focused R2 stop gate first:

```sh
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 pnpm exec vitest run \
  tests/issue-3521-linked-string-parser-abi.test.ts \
  tests/issue-3794-ir-dynamic-replace.test.ts \
  tests/issue-4585-npm-compat-refresh-resilience.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

After composing #3522, run the ownership adjacency in one bounded fork:

```sh
VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 pnpm exec vitest run \
  tests/issue-3521-linked-string-parser-abi.test.ts \
  tests/issue-3522-nested-class-field-call-ownership.test.ts \
  tests/issue-3522-nested-class-field.test.ts \
  tests/issue-3522-nested-implicit-constructor.test.ts \
  tests/issue-3522-nested-class-accessor.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

Only after those focused gates pass, run:

```sh
pnpm run typecheck
pnpm run check:ir-fallbacks -- --verbose
```

Also complete the existing LOC/function, oracle, and relevant multi-source
adjacency gates without changing shared budget baselines or adding speculative
grants. The exact A/B pair is the immediate composed parent versus the composed
R2 candidate under the same lane, harness, and options. It must prove:

- disabled adoption restores the exact ABI-parity diagnostic, keeps the parser
  and caller out of the IR-compiled set, and returns `123` through legacy;
- enabled adoption patches the parser and caller with honest `legacy=true` and
  `ir=true`, returning decimal `123` and octal `15`;
- host enabled/disabled binaries are byte-identical, and the dynamic receiver
  replacement parent/candidate binaries are byte-identical;
- every near-miss mutation and the forced-fast control retain their original
  routes.

This stage makes no `direct=0`, compile-once, or emission-ownership acceptance
claim. Release still requires all eight equivalence shards as separate
processes:

```sh
SHARD=1/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=2/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=3/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=4/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=5/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=6/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=7/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
SHARD=8/8 EQUIVALENCE_FORK_HEAP_MB=4096 node scripts/equivalence-gate.mjs
```

## 2026-08-23 root implementation sequence — close R2 honestly

1. Qualify the signed linked parser/caller ABI checkpoint in the composed
   stack, including enabled/disabled parser lanes, direct/prepared routes,
   host/standalone targets, decimal/octal runtime values, and exact artifact
   controls. This checkpoint does not by itself prove `direct=0`.
2. Land #4260 before any wider late-preparation claim. Provider, import, and
   in-module implementation requests must publish atomically with their
   prepared component and retract cleanly on abort.
3. Replace the remaining caller/final-context and late-preparation seams with
   one fixed-point `PreparedIrProgram` transaction. Every adopted callee,
   caller, provider, signature, and Program ABI binding must be resolved before
   body emission.
4. Delete only the R2 compatibility paths made unreachable by that
   transaction; typed Unsupported remains policy until #4652/R9.
5. Re-run free-function/provider/component/fallback/multi-source adjacency,
   both policy gates, cross-backend validation, and all eight literal
   equivalence shards before marking R2 done.

The root agent owns the issue plan and acceptance; Luna-max developers execute
file-bounded commits sequentially, with an independent review and signed
landing for every transaction.

## 2026-08-23 collector follow-up — linked parser caller selection repair

The bounded R2 collector captured all 32 children and retained their raw
records. In the candidate standalone/prepared/native-strings/enabled tuple,
`stringToNumber` is emitted but `readNumber` is rejected at selection with
`unsupported/select/param-type-not-resolvable`. This is a production routing
gap, not an acceptance-oracle relaxation and not a new load failure: every
captured one-minute sample was finite, non-negative, and strictly below the
10-core limit of 8.

### Root cause and ownership boundary

The stage-06 parser delta correctly repairs the exact parser ABI in
`src/ir/from-ast.ts` and `src/ir/integration.ts`, but those repairs run only
after the identity selector has produced a claim. `src/ir/propagate.ts` keeps
`new Parser(input)` as `dynamic`; the `readNumber(parser)` body then reads
`parser.input.slice(...)`, which fails `dynamicUsesAreMoveOnly` in
`src/ir/select.ts`. Consequently `planIrCompilationByIdentity` omits the
`readNumber` unit before `compileIrPathFunctions` or
`projectIrIntegrationLoweringPlans` can build an owner-local signature or
direct-call plan. The final `compileMulti` composition did not drop a caller
plan: the caller never entered the active selection/override maps. The
two-source path is relevant because selection and projection are source
qualified, but this fixture's caller and parser are both in `entry.mjs`.

Amend #3521 and keep the existing
`tests/issue-3521-linked-string-parser-abi.test.ts` ownership. Do not create a
new issue or move this into #3522: #3521 owns free-function pre-claim and
parser ABI routing, while #3522's direct-call-plan composition remains a
consumer that must preserve the owner-local adopted-signature replacement.

### Minimal implementation plan

1. **Add a bounded pre-claim proof.** In `src/ir/propagate.ts`, extend the
   source-local expression lattice for the exact function-constructor pattern
   used by this slice: a unique `new Parser(value)` declaration whose body
   assigns a fixed `this.input` field from a string value. Reuse the existing
   fnctor/constructor identity evidence; do not infer arbitrary JavaScript
   objects or aliases. The resulting atom must be an exact object shape with
   `input: string`, and must widen to `dynamic` when the constructor is
   ambiguous, imported/foreign, reassigned, has another field write, or its
   input is not proven string. Add the `NewExpression` arm to `inferExpr` and
   preserve the existing source-qualified call graph/fixpoint. If the current
   fnctor evidence cannot be consumed by propagation without broadening its
   contract, add a small identity-keyed adapter rather than a name-keyed
   fallback.

2. **Feed that proof into selection, not into a post-selection override.** In
   `src/ir/select-identity.ts` (`planIrCompilationByIdentity` and its
   structural assessment path) and the corresponding
   `src/ir/select.ts` selector helpers, allow `readNumber` to resolve its
   parameter as the proven object shape. The normal body-shape and
   `dynamicUsesAreMoveOnly` checks must then see `parser.input` as `string`,
   so the existing `from-ast` property/string lowering is used. Do not add a
   generic exception for a dynamic receiver and do not accept a caller merely
   because its callee is named `stringToNumber`.

3. **Retain the stage-06 parser ABI repair and make the composed plan exact.**
   Keep `AstToIrOptions`/`LowerCtx`,
   `reconcileExactParserExternArgument`, and `lowerMethodCall` in
   `src/ir/from-ast.ts` as the lowering boundary for the parser's first
   argument. In `src/ir/integration.ts` (`compileIrPathFunctions` and the
   effective top-level signature resolver), materialize the adopted parser
   signature only for the exact `stringToNumber` unit in `entry.mjs` and only
   in standalone + native-strings + enabled mode. Its effective ABI is
   `[string, i32-boolean] -> f64`; the caller remains a distinct
   `IrUnitId` with its own exact structural receiver parameter and `f64`
   result.

   In `src/codegen/ir-overlay-identity.ts`,
   `projectIrIntegrationLoweringPlans`, and the `compileMulti` planning path,
   build the caller edge as a copy-on-write, AST-site keyed plan:

   ```text
   readNumber(CallExpression) ->
     irUnitFuncRef({ unitId: exactStringToNumberUnitId,
                     legacyName: "stringToNumber" })
   ```

   `calleeTypes` and the effective signature map must be keyed by the exact
   callee `IrUnitId`; preserve the source ID and the parser/caller unit IDs,
   and require distinct units with the same `entry.mjs` source. Reconcile the
   effective parser signature after the owner-local projection is built, but
   never mutate shared legacy-name maps, borrow a same-spelled function from a
   different source, or replace unrelated AST call sites. Keep the
   #4608 declaration hooks at both existing post-inline and
   post-monomorphization boundaries.

4. **Keep the proof narrow and optimization-neutral.** The repair must not
   disable inline-small, monomorphization, allocation provenance, string
   carrier lowering, or the normal component ownership checks. A failed proof
   remains `Unsupported` and direct-emits once. There is no direct/IR retry and
   no generic widening of dynamic member reads.

### Required tests and mutations

Extend the existing linked-parser test (and its static selftest where
applicable) with the following exact controls:

- A two-source `compileMulti` fixture with `Parser`, `stringToNumber`,
  `readNumber`, and `run` in `entry.mjs`, plus an unrelated `empty.mjs`.
  Standalone/native-strings/enabled must emit both parser and caller with
  `legacyBodyEmitted=true`, `irBodyEmitted=true`; parser and caller must have
  distinct unit IDs, the same exact source ID, the effective parser ABI above,
  and one exact owner-local direct-call edge. Execute decimal and octal inputs
  (including the signed `15`/`123` cases) and validate the resulting Wasm.
- Selector mutations for an unknown/ambiguous/foreign constructor, a
  cross-source or same-spelled parser, an alias/reassignment of `input`, a
  non-string constructor argument, a missing parser call, and a changed
  `slice`/parser topology must all fail closed as `Unsupported`; no mutation
  may make a same-named function from another source eligible.
- Preserve the existing parser param-1 repair and disabled param-0 parity
  failure tests, fast-mode rejection, collision/near-miss/ambiguous binding
  tests, and unrelated parse caller tests. Add a regression asserting that
  host-string and base/disabled tuples retain their existing outcomes.
- The acceptance matrix is intentionally asymmetric: candidate standalone
  prepared enabled is the one positive parser+caller route; base and disabled
  caller routes may remain preselection `param-type-not-resolvable`, and host
  lanes may emit the parser while retaining the unsupported caller. No caller
  warning relaxation changes the mandatory exact `irOutcomes` contract.
- Run static/type/format/layering and optimization-ledger gates before any
  runtime. Then run the repaired candidate A/B and the full 32-child R2
  collector once under finite, non-negative per-child load `< logical cores -
  2`; retain every raw record and fail closed on any route, source, ABI, or
  optimization drift. The unchanged #4035 size ceiling is not a new
  regression.

### Signed-delta and relock policy

The frozen R2 composite, preserved failure envelopes, and their hashes remain
immutable evidence. Implement this as a new signed repair delta appended on
top of the frozen commits; do not amend/rewrite the earlier signed commit or
retroactively change its bundle. After the source repair, regenerate the
source/bundle manifests and issue inventory, obtain an independent static
review, rerun pins-only, and only then schedule the bounded runtime/A-B and
final aggregate gates. The strict load gate remains exactly
`Number.isFinite(sample) && sample >= 0 && sample < (logicalCores - 2)`.

### 2026-08-23 source-trace correction — projection requires lowering

The initial bounded-proof wording above is not sufficient by itself. The current IR
lowerer has no plain function-constructor arm in `lowerNewExpression` and no
`ref_null $__fnctor_*` arm in `lowerPropertyAccess`; a selector-only
object/fnctor admission would therefore create a claim-then-demote path.

The repair must ship as one bounded projection/lowering transaction:

- certify the exact declaration identity of the approved `Parser` fnctor, its
  unique constructor site, fixed `this.input` string field, and source-qualified
  owner; all ambiguity, aliases, foreign constructors, reassignment, extra
  fields, and non-string inputs widen/reject;
- carry a symbolic fnctor-instance projection (reserved fnctor type identity plus
  exact field shape) through propagation, selector, identity planning, and the
  override map; do not encode the module-local type index in the lattice;
- add the matching `from-ast` lowering for the certified plain `new Parser(...)`
  site and `parser.input`/string-slice field access, reusing the existing
  fnctor reservation/constructor semantics and preserving null/ref ownership;
- retain the exact parser ABI and owner-local direct-call plan reconciliation
  already present in the R2 stage; the caller and parser remain distinct
  source-qualified `IrUnitId`s;
- add fail-closed tests for each unsupported projection and for successful
  Wasm/runtime output. A selector bypass without these lowerer and identity
  checks is explicitly rejected.

The withdrawal denominator remains asymmetric: pre-claim caller rejection is valid
for base/disabled/host lanes, while candidate standalone/native-strings/enabled
must emit both parser and caller with exact outcome evidence.

### 2026-08-23 implementation checkpoint — no unsafe selector bypass

The first Luna-max implementation pass was intentionally stopped before source
edits. The existing fnctor constructor ABI carries hidden capture/identity
parameters and reserved internal fields; constructing an `object.new` from the
checker-visible `{ input: string }` shape would produce the wrong nominal type
and field arity. An IR call is likewise not a valid substitute until an exact
constructor-plan seam and resolver support exist. Therefore no selector-only
bypass, generic dynamic admission, or naïve object construction is accepted.

The next implementation checkpoint must identify the existing reservation,
constructor, and field-load plan objects and add a bounded source-qualified
projection/lowering path that reuses them. Until that seam is proven, R2 stays
`needs-runtime-replay`/fail-closed and the frozen composite plus all prior
failure evidence remain unchanged. Static issue-plan checkpoints may land
independently; no runtime replay is authorized by this checkpoint.

### 2026-08-23 Luna architecture result — exact ABI seam required

The existing reservation/layout is in `linear-type-reservations.ts`, while
constructor synthesis and its hidden capture/identity parameter are in
`expressions/new-super.ts` and `fnctor-constructor-identity.ts`. The current
`fnctor-typed-instances.ts` path exposes only the reserved `ref_null` carrier;
it does not provide an IR constructor or field operation. In particular,
`fnctor-ctor-param-types.ts` deliberately does not infer string/reference
fields, so this fixture's `Parser.input` is currently an `externref` field.

The implementation must therefore add an identity-bearing, backend-neutral
`fnctor.new`/`fnctor.get` seam (or an exactly equivalent existing abstraction),
with resolver validation against the declaration identity, escape gate, reserved
type/layout, and synthesized constructor map. It must either prove a native
string field ABI or add a bounded field-to-string conversion before using
native `slice`. A checker-shaped anonymous object, raw `ref_null` override, or
selector-only admission is invalid. Unsupported captures, `arguments`, foreign
returns, aliases, rebinding, cross-source collisions, and parser escape remain
fail-closed. The focused test collection is still deferred; no source edit or
runtime result is claimed by this checkpoint.

### 2026-08-23 Luna max ABI design checkpoint

The second Luna-max pass confirmed that the current IR has no fnctor type,
`fnctor.new`/`fnctor.get` instructions, builder methods, lowering resolver, or
selector propagation kind. Existing `class.*` machinery is not a safe
substitute: fnctor construction is an ABI-specific call whose operand order
includes captures/TDZ values, user parameters, and the trailing constructor
identity parameter.

The implementation delta is therefore explicitly staged as:

1. Add a nominal `IrFnctorShape` and `IrType.kind === "fnctor"` carrying exact
   source/unit identity, constructor target, capture layout, hidden-identity
   requirement, user parameter types, and a symbolic reserved-layout reference.
2. Add builder/verifier `fnctorNew` and `fnctorGet` operations. Enforce hidden
   argument ordering and reject missing/extra capture or identity operands.
3. Extend `IrLowerResolver.resolveFnctor(shape)` to cross-check declaration
   identity, source/unit, `fnctorReservedTypeIdx`, `structFields`,
   `funcConstructorMap`, capture layout, constructor params, and the defined
   function. No name fallback is permitted.
4. Add selector admissions for the exact direct same-source unaliased
   constructor, fixed string field, proven constructor identity, and no
   reassignment/escape; aliases, computed keys, foreign/cross-source joins,
   unsupported captures/returns, and ambiguous propagation demote to dynamic.
5. Add one positive linked-parser test plus negative alias, foreign,
   reassignment, cross-source collision, computed/non-string field, and missing
   reservation mutations.

This is a design checkpoint only: no source edit, commit, runtime, or collector
result is claimed until the staged ABI seam is implemented and independently
reviewed.

### 2026-08-24 bounded source-local fnctor projection checkpoint

The next parser slice is intentionally scoped to one declaration and one
source. It is not a generic object-shape extension and it is not permission to
make the selector tolerate a dynamic receiver. The only positive proof is the
checker-identified `FunctionDeclaration` named `Parser` in `entry.mjs`, with
exactly one `new Parser(stringExpression)` site in the `readNumber` call path,
and a constructor body whose only own write is `this.input = input`. The
constructor declaration, allocation site, field write, and owner source must
all be the same identity records; the spelling `Parser` is only a diagnostic
label. Any second declaration/allocation, alias, reassignment, computed field,
extra field, foreign return, capture/`arguments` use, cross-source match, or
non-string argument must return `Unsupported` before IR lowering.

The exact pre-claim failure is unchanged and is now the first diagnostic to
pin in the static test: `src/ir/propagate.ts::buildCallGraph` records a
constructor call for parameter propagation but `inferExpr(NewExpression)`
still returns `dynamic`; `src/ir/select.ts::dynamicUsesAreMoveOnly` therefore
rejects the `parser.input` receiver, and
`src/ir/select-identity.ts::planIrCompilationByIdentity` never admits
`readNumber`. The parser ABI repair in `from-ast.ts` and `integration.ts` is
downstream of this decision and must not be used as a selector bypass.

The implementation is deliberately a staged transaction with this exact file
map (the files below are the bounded seam, not a grant to refactor the legacy
fnctor emitter):

1. `src/ir/nodes.ts` adds a nominal `IrFnctorShape` and `IrType.kind ===
   "fnctor"`. The shape carries the exact constructor declaration/unit/source
   identity, the reserved symbolic fnctor layout reference, the hidden
   capture/TDZ layout, the user constructor parameter types, and canonical
   fields. It must not carry a module-local type index or a legacy name as an
   identity key. `src/ir/propagate.ts` adds the corresponding identity-bearing
   lattice atom and a single `NewExpression` arm; it may produce this atom only
   after the proof above and otherwise widens to `dynamic`. The existing
   object-literal atom remains unchanged.

2. `src/ir/select.ts` (`isPhase1Expr`, the constructor/property-access shape
   checks, and `dynamicUsesAreMoveOnly`) and
   `src/ir/select-identity.ts` (`planIrCompilationByIdentity` plus structural
   assessment) consume that atom by exact `IrUnitId`/source identity. The
   selector must require one owner-local `parser.input` read and the fixed
   `slice(0, parser.input.length)` topology. It must not accept a dynamic
   receiver, use the callee spelling `stringToNumber` as evidence, or borrow a
   same-spelled constructor from another source. The failed-proof outcome stays
   `param-type-not-resolvable`/`Unsupported` at pre-claim.

3. `src/ir/builder.ts`, `src/ir/lower.ts`, and `src/ir/verify.ts` add the
   backend-neutral `fnctor.new` and `fnctor.get` operations. Their verifier
   checks exact shape identity, field name/type, nullability, and operand
   counts. `src/ir/from-ast.ts::lowerNewExpression` and
   `::lowerPropertyAccess` add only the certified `Parser` arms, dispatching
   through those operations. A selector admission without these lowering arms
   is invalid because it would claim and then demote at the first constructor
   or field read.

4. `src/ir/integration.ts` extends the resolver with one identity-checked
   fnctor lowering implementation. It must validate the shape against
   `ctx.fnctorEscapeGate`, `ctx.fnctorReservedTypeIdx`, `ctx.structFields`, and
   `ctx.funcConstructorMap`, then emit the existing synthesized constructor
   ABI in the exact order `captures/TDZ, user params, constructor identity`.
   `src/codegen/fnctor-ctor-decl.ts`,
   `src/codegen/fnctor-escape-gate.ts`, and
   `src/codegen/expressions/new-super.ts` are read-only ABI authorities for
   this adapter: no parallel constructor, field layout, or type reservation
   may be introduced. The `input` field must be proven to lower as the active
   native-string carrier before the parser ABI is adopted; otherwise the
   projection declines.

5. Only after the constructor/field operation verifies should
   `src/codegen/ir-overlay-identity.ts`,
   `src/ir/integration.ts`'s owner-local projection, and the `compileMulti`
   planning path add the caller edge. The edge is copy-on-write and AST-site
   keyed to the exact `stringToNumber` unit in `entry.mjs`; the parser and
   `readNumber` retain distinct `IrUnitId`s. No legacy-name map or shared callee
   signature map may be mutated. The adopted parser ABI remains
   `[string, i32-boolean] -> f64` only for standalone + native-strings +
   enabled mode.

The static gate for the implementation PR belongs in the existing
`tests/issue-3521-linked-string-parser-abi.test.ts` file and must run without
compiling or instantiating Wasm. It should parse a positive fixture and the
following fail-closed mutations, then inspect the source-qualified proof
records/selection result: unknown or ambiguous `Parser`, foreign and
cross-source constructors, aliases and `input` reassignments, extra/computed
fields, non-string constructor arguments, missing parser calls, changed
`slice`/length topology, unsupported captures/`arguments`, and a same-spelled
`Parser` in another source. The assertions must prove that only the exact
positive AST site yields an `IrFnctorShape`; every mutation remains
`Unsupported`, with no runtime/A-B claim. Runtime decimal/octal probes and the
existing parser ABI matrix remain a later gate after this static seam is
reviewed.

This checkpoint is documentation-only: it intentionally contains no source,
compiler, runtime, A/B, collector, or heavy-test result. The current R2 state
therefore remains fail-closed/`needs-runtime-replay`; the next implementation
PR must land the nominal type, operations, resolver, and static tests as one
reviewable projection/lowering transaction.

## 2026-08-24 source-qualified fnctor admission checkpoint

The first implementation checkpoint is deliberately limited to admission
evidence. `buildIrUnitTypeMap`, identity selection, and the selector accept an
opt-in `IrFnctorAdmission` only when a source-qualified constructor proof
establishes the reserved `Parser { input: string }` shape, direct construction,
fixed unconditional field, and no alias/reassignment/escape/cross-source
collision. Without a resolver, all existing propagation and selector behavior
is unchanged and the site remains dynamic/Unsupported. This checkpoint does
not add an IR fnctor node, constructor lowering, or ABI emission; those must be
landed as the next signed slice with exact reserved-layout and hidden-identity
checks from the architecture section above. The bounded source changes are
covered by `loc-budget-allow` for the two existing god-files and are intended
to be reviewed independently before any R2 replay.

## 2026-08-24 nominal ABI contract checkpoint

`src/ir/fnctor-abi.ts` now defines the backend-neutral nominal shape,
source/unit/layout identity, capture and user-parameter ABI, constructor
identity slot, and a fail-closed `IrFnctorLowerResolver` contract. Pure tests
cover exact acceptance plus duplicate-field, identity-index, and retargeted
constructor rejection. This checkpoint deliberately does not widen `IrType`,
add instructions, or emit Wasm; the next slice must consume this contract from
the IR builder/verifier and standalone resolver rather than duplicating the
legacy `CodegenContext` lookup.

## 2026-08-24 nominal IrType utility checkpoint

The next static slice widens the backend-neutral `IrType` union with a nominal
`fnctor` arm carrying the validated source/unit/layout-qualified
`IrFnctorShape`. Type equality, canonical keys, debug descriptions, context
index scans, and preparation walks now recurse through fields, captures, and
user parameters without assigning a physical carrier. Linear-memory, string,
vector, and physical-reference preparation preserve the opaque arm unchanged;
lowering fails closed with an explicit missing-resolver diagnostic. No
`fnctor.new`/`fnctor.get` instruction, ABI emission, or runtime behavior is
claimed by this checkpoint. The next signed slice must add those instructions,
builder/verifier effects, and an exact standalone resolver before this arm can
reach lowering.

## 2026-08-24 fnctor instruction contract checkpoint

The next static slice defines `fnctor.new` and `fnctor.get` as explicit IR
instructions. `fnctor.new` carries the nominal shape, flattened capture/TDZ
operands, user constructor operands, and an explicit optional hidden identity;
`fnctor.get` carries the exact receiver shape and field name. The builder
checks shape validity, ABI arity, receiver identity, and field existence;
verification checks nominal result/field types and all SSA uses. Effects classify
construction as call-like heap mutation and field reads as heap reads. Every
use walker and transform has an exhaustive operand case, while the lowerer and
all backends fail closed until an exact resolver is supplied. Preparation also
rejects fnctor instructions without prepared resolver/layout evidence.

This checkpoint additionally hardens the nominal utility contract: diagnostic
constructor/ref names are excluded from equality and cache keys, binding keys
are canonicalized independent of object insertion order, recursive anonymous
fnctor graphs are rejected by validation/keying, and fnctor returns require an
exact nominal match. No standalone lowering, ABI emission, compiler/runtime
execution, or R2 replay is claimed here.

## 2026-08-24 fnctor instruction contract hardening checkpoint

The follow-up review closed the remaining instruction-contract gaps before the
physical resolver slice. `fnctor.new` now has an explicit `hiddenIdentity`
mode; the builder, verifier, symbolic resolution validator, and operand checks
require the mode and flattened capture/TDZ/user ABI to agree. Ownership and
escape analyses treat constructor operands as an opaque heap boundary and
`fnctor.get` as a heap read. Prepared-closure support rejects the opaque arm
explicitly, and every backend legality profile rejects fnctor instructions
before raw lowering rather than allowing a late emitter throw.

The monomorphization and linear-memory planners now consume the shared full
semantic fnctor key, including fields, captures, user parameters, hidden
identity, and nominal bindings. The lowering seam is present as an optional
`IrLowerResolver.resolveFnctor(shape)` returning a physical handle; lowering
still fails closed when no source/unit-qualified prepared handle is installed.
The next checkpoint must add the Program-ABI fnctor sidecar and synthesized
constructor support binding before any AST producer or runtime replay is
enabled. No compiler/runtime execution or R2 replay is claimed here.

## 2026-08-24 source/unit fnctor resolver seam checkpoint

The next static slice adds `ProgramAbiFnctorRegistry` as the only permitted
source/unit-qualified observation sidecar. Its observations require exact
`fnctor-constructor` and `fnctor-layout` support binding IDs, authoritative
planning identity membership, a live constructor function handle/object pair,
physical capture/TDZ/user arities, field order, hidden-identity mode, and
immutable one-observation-per-source/unit equality. The IR resolver delegates
to this sidecar and the WasmGC legality check accepts a fnctor instruction only
when that resolver returns a non-null handle; resolver-free callers and all
other backends remain fail-closed. Constructor operands use the legacy ABI
order (all capture values, then all TDZ flags, then user args, then optional
identity), and hidden identity participates in equality and canonical keys.

This is still a dormant resolver seam: no AST producer currently records an
observation or plans the synthesized support callable/layout, so no fnctor
instruction can pass the final resolver gate in this checkpoint. The next
implementation slice must attach the producer to ProgramAbiSession planning,
verify the physical struct/function signatures and support locators, and add
the source-local linked-parser lowering before any compiler/runtime replay.
Static typecheck, focused ABI tests, formatting, IR layering/function/LOC and
pushRaw gates pass; the linear-IR script is environment-blocked by tsx IPC
socket permission in this worktree. No compiler/runtime execution or R2
replay is claimed.

## 2026-08-24 source-qualified admission producer checkpoint

The selector/propagation seam now receives one checker- and planning-identity-
owned resolver. It admits only an exact escape-gate-approved `new F()` whose
constructor declaration is in the same source, has a unique inventory unit,
has a reserved `__fnctor_F` layout, and consists of one unconditional
`this.input = input` assignment from a string parameter. Aliases, conditional
or repeated writes, additional own fields, cross-source collisions, and
unreserved constructors return Unsupported. The same resolver is passed to
the structural TypeMap and identity selector, so no name-only projection can
claim the site. This remains admission/planning evidence only: it does not
plan a support callable, emit `fnctor.new/get`, or change runtime output. The
next checkpoint must bind the admitted shape to ProgramAbiSession support
plans and physical constructor/layout validation before AST lowering or R2
replay.

## 2026-08-24 Program-ABI fnctor observation planning checkpoint

The next bounded producer seam is now explicit but remains dormant until an
admitted AST site supplies a complete physical observation. `ProgramAbiFnctorRegistry.observe`
now fail-closes on the live reserved struct layout and synthesized constructor
function signature, including capture values, TDZ flags, user parameters, the
optional hidden identity externref, and the exact struct-reference result. A
valid observation registers the source/unit-qualified `fnctor-constructor`
support callable and remappable `fnctor-layout` type plan through the existing
Program ABI session/type registry. Structural role ordinals are centralized
(`fnctorConstructor=15`, `fnctorLayout=13`), and allocator-owned function/type
locators are retained for late compaction.

This checkpoint does not synthesize observations, lower `fnctor.new/get`, alter
legacy constructor output, or claim linked-parser runtime coverage. The next
slice must connect the admitted AST producer to this observation only after
the exact capture/TDZ/user ABI and struct fields are available, then add a
source-local lowering proof and focused A/B replay.

## 2026-08-24 admission escape/arity hardening checkpoint

The source-qualified admission proof now scopes local-use analysis to the
owning function (or module body), ignores unrelated sibling functions, and
records invalid uses monotonically instead of allowing a later member read to
erase an earlier call/alias escape. Constructor parameters must be a required,
non-rest, non-default single string parameter, and an admitted `new F(...)` must
carry exactly one non-spread argument. These are static fail-closed controls;
they do not widen the admitted shape or enable lowering/runtime execution.

## 2026-08-24 bounded host fnctor observation producer checkpoint

The dormant Program-ABI sidecar now has one narrow AST producer hook. After
`compileNewFunctionDeclaration` has filled the exact reserved
`__fnctor_F` struct, synthesized `__fnctor_F_new` function, and constructor
body, `program-abi-fnctor-producer.ts` re-runs the source/unit-qualified
admission resolver for that exact `new F()` node and declaration. Only the
fixed one-parameter string constructor with one unconditional `input` field,
no captures or TDZ cells, no layout/cold-tail split, no widened foreign result,
and the host ABI lane can produce a complete `IrFnctorShape` plus physical
`ProgramAbiFnctorObservation`; the registry then performs the existing exact
binding, signature, layout, and remapping checks. Missing planning context,
non-approved sites, and unsupported physical layouts are no-ops and retain
legacy output. Single- and multi-source codegen share the same hook through
`compileNewFunctionDeclaration`.

This checkpoint records planning evidence only: it does not emit
`fnctor.new/get`, alter constructor/call-site instructions, lower an AST site,
or claim standalone/WASI or linked-parser runtime coverage. Captures, TDZ
ref-cell ABI, standalone internal fields, cold tails, layout families, and
foreign-return constructors remain explicit follow-up work requiring a
logical-to-physical layout map. Focused producer/admission/ABI tests, static
TypeScript 7 typecheck, and formatting pass.

## 2026-08-26 remaining implementation plan — linked Parser parameter projection

This repair stays on #3521. It is not a #3522 reconciler change and it does
not create a new issue. The retained full-32 R2 evidence establishes the
failure before integration: on candidate standalone/prepared/native-strings/
enabled, `stringToNumber` is emitted, `readNumber` is rejected at selection as
`param-type-not-resolvable`, and `run` remains
`constructor-resolution-unsupported`. The later
`projectIrIntegrationLoweringPlans`/AST direct-call-plan projection cannot
repair an owner that the identity selector never claimed.

The exact source shape explains that outcome. `run` passes
`new Parser(string)` directly to unannotated `readNumber(parser)`. Under this
`.mjs` fixture's `allowJs`/`checkJs` program, the checker sees the constructor
parameter as `any`. `buildIrUnitTypeMap` therefore sees the allocation as
dynamic, while the legacy caller slot is
`(ref null $__fnctor_Parser)`; #4612 correctly blocks a dynamic-carrier claim.
The existing `IrFnctorAdmission` cannot help: its fixed-input proof first
requires a checker-`StringLike` constructor parameter, `hasNoEscape` then
rejects the call-argument transfer, and the retained admission map is keyed
only by an already-claimed owner containing the allocation. A selector bypass,
a relaxation of that existing admission, a generic object projection, or a
direct-call-map-only edit is unsound.

### Immutable scope and non-goals

The only positive route is the existing `entry.mjs` identity graph:

- one source-local `Parser(input)` with one unconditional
  `this.input = input` write;
- one direct, non-optional, non-generic, non-spread call
  `readNumber(new Parser(<string>))`;
- exact, distinct `Parser`, `readNumber`, `stringToNumber`, and `run`
  terminal `IrUnitId`s in the same source;
- `readNumber` only reads `parser.input` in the selected
  `.slice(0, parser.input.length)` topology; and
- standalone + native strings + non-fast + experimental IR with
  `JS2WASM_IR_FIRST=0`, after legacy direct bodies have produced the physical
  constructor/layout observation.

`run` stays on its current legacy body. This checkpoint needs `fnctor.get` for
the `readNumber` parameter; it does not need to lower `new Parser`, emit
`fnctor.new`, or claim `run`. Default IR-first/pre-body planning remains
Unsupported because no physical observation exists yet. WASI, host, captures,
TDZ cells, aliases, stored/returned instances, optional calls, more than one
allocation/caller, field writes outside the constructor, layout families,
cold tails, presence words, pad slots, foreign constructor results, and
generic fnctor inference remain unsupported. No code may key authority by
`Parser`, `readNumber`, or an `entry.mjs` suffix.

### Checkpoint L1 — dormant source-qualified argument edge

Land a small independently reviewed PR before the routing change.

1. Split the current constructor evidence without widening its consumers. Add
   a pure, source-qualified syntax proof for one constructor declaration with
   one required parameter and one unconditional
   `this.input = <that exact parameter>` statement. Keep the existing
   `IrFnctorAdmission` path unchanged: it still additionally requires the
   checker parameter to be `StringLike` and the allocation to satisfy its
   member-only `hasNoEscape` rule. L1 must not make the unannotated fixture an
   admission or alter propagation/selection.
2. Add a separate allocation-shape proof for the exact unique
   `new Parser(<string>)` AST. Its logical-string authority comes from the exact
   source-qualified allocation argument and the existing expression/call-graph
   lattice, not from the constructor parameter's checker-`any` type. Join it
   to the pure constructor syntax proof, constructor declaration/UnitId,
   allocation AST, source ID/file, and exact physical reservation identity.
   A dynamic, union, foreign, ambiguous, or non-string argument rejects.
3. Add a frozen `IrFnctorArgumentProjection` owned by the structural planning
   layer. It records that allocation-shape proof, containing caller UnitId
   (`run`), direct call AST, callee UnitId (`readNumber`), parameter declaration
   and index, constructor declaration/UnitId, and every forward/reverse AST,
   declaration, UnitId, and source join. It is deliberately not an
   `IrFnctorAdmission` and must never forge the admission's literal
   `noEscape: true`.
4. Keep `hasNoEscape`'s generic call-argument rejection. The separate edge
   resolver permits only the direct same-source argument transfer above and
   proves the instance has no second use, alias, assignment, capture, return,
   property write, or second call edge. Checker declaration identity, not the
   callee spelling, resolves the call.
5. Collect this edge from the complete identity inventory/call graph rather
   than from the already-claimed owner set. Retain it on the identity plan as
   evidence only; do not feed `resolveImplicitParamType`, change selection, or
   alter an override in L1. This real production retention avoids a test-only
   dead export while keeping emitted code and outcomes unchanged.
6. Mutate the checker-`any`/logical-string distinction, every proof key/join,
   and the direct-call restrictions. Include duplicate, missing,
   wrong-parameter, cross-source, same-spelled constructor/callee,
   optional/generic/spread, alias, stored/returned, reassigned, captured,
   second-use, second-allocation, and non-string allocation cases. Canonical
   source ordering must not change the projection.

#### L1 implementation evidence (2026-08-26)

The L1 checkpoint is implemented in signed commits
`10279401a1eaa68b2289cef137be14631f5590e0` and
`88892d1da27e1672f5afd548b946c0473a46b828`. The retained projection is
source-qualified, evidence-only, and dormant outside the exact standalone,
native-string, non-fast, experimental, post-legacy route with
`JS2WASM_IR_FIRST=0`; it does not alter admission, selection, propagation, or
emitted outcomes. Collection covers the complete active-source semantic-use
census, and retention revalidates the live call/new/parameter declarations and
physical reservation identity before deep-freezing the canonical evidence.
The negative matrix includes same-spelled foreign declarations, forwarding,
default/assignment/factory/class-field uses, aliases, captures, reassignment,
storage/return, duplicate allocations, and an unrelated compound-call positive
control.

The focused projection suite passed 52/52 tests and the four affected fnctor
suites passed 71/71. TypeScript 5 and 7 checks, scoped formatting, static IR
ratchets, the LOC and function-growth ratchets, and the complete commit hooks
passed. Independent pre- and post-signature reviews approved the exact signed
repair commit. No compiler/runtime A/B or R2 replay was performed for this
dormant checkpoint; L2 and L3 remain gated on their own implementation,
review, and validation requirements.

### Checkpoint L2 — dormant logical-to-physical fnctor layout contract

Land a second independently reviewed PR with no selector consumer.

1. Replace `ProgramAbiFnctorRegistry`'s current
   `observation.fields.length === shape.fields.length` assumption with a full
   logical-to-physical proof. `IrFnctorField.ordinal` is the physical reserved-
   layout index. Each logical field must have one unique in-range ordinal and
   exact name plus certified physical carrier; `fieldIdx(name)` is derived only
   from that validated ordinal mapping, never the logical-array position. The
   complete physical `StructTypeDef` remains byte-exact against the
   observation.
2. Add a pure standalone Parser observation builder/test fixture, but do not
   enable the existing AST producer yet. Its only valid physical layout is the
   authoritative reservation result: logical mutable `input` at its exact
   ordinal, followed only by the exact compiler-owned `$constructor` and
   `$bag` fields with their canonical types/mutability. Reject any presence,
   padding, split/cold-tail, reordered, duplicated, unknown, or user-visible
   extra field. Reuse `closureBagField()` and the shared `$constructor`
   constant; add one shared `$constructor` field factory rather than restating
   its layout.
3. Keep the semantic and physical constructor ABIs distinct. The shape has one
   semantic `IrType.string` user parameter, while the real synthesized
   constructor's checker-`any` user parameter is physical `externref`. Require
   no captures/TDZ flags, hidden identity as the exact trailing `externref`
   parameter, a non-foreign exact non-null struct-ref result, and the same
   source/unit/support bindings and live allocator objects already enforced by
   the registry. The physical `input` field is exactly
   `ref null $AnyString` while its logical field is non-null `IrType.string`;
   record that exact field refinement explicitly. Do not pretend the physical
   constructor argument is native string and do not add a string-to-externref
   constructor adapter in this slice.
4. Split the resolved handle's carriers and capabilities. Retain the exact
   non-null `ref` constructor result separately from the nullable
   `ref_null $__fnctor_Parser` instance/value carrier used by legacy function
   positions. Each resolved field carries its validated physical index,
   physical carrier, logical type, and optional exact refinement. The
   standalone handle is explicitly `supportsConstruction: false` and
   `supportsFieldGet: true`; a non-null resolver must no longer authorize both
   `fnctor.new` and `fnctor.get` implicitly.
5. Add mutations for every physical field, ordinal, carrier/refinement,
   semantic/physical constructor parameter, result/instance carrier,
   capability, allocator, source/unit, and support binding. Existing host
   observation tests must remain byte-for-byte valid.

### Checkpoint L3 — late-overlay selector and `fnctor.get` activation

Only after L1 and L2 are merged and independently approved may the production
route land.

1. During direct legacy compilation, enable the bounded standalone producer
   after `compileNewFunctionDeclaration` has finalized the reserved struct and
   synthesized constructor. It consumes the shared pure constructor/allocation
   shape proof from L1, not the later argument-edge projection and not full
   `IrFnctorAdmission`, and records the exact L2 physical observation. It does
   not select an owner or alter emitted code. Missing/ambiguous proofs and every
   unsupported physical layout remain no-ops.
2. Only in the explicit non-IR-first late overlay
   (`JS2WASM_IR_FIRST=0`), collect L1 from the complete identity inventory and
   join its argument edge to the current L2 registry resolution. Before
   selection, compare the resolution's nullable instance carrier with the live
   `readNumber` parameter slot through `ProgramAbiSourceCallableRegistry`, not
   `funcMap`. Preselection authority is exactly the UnitId, stable `FuncHandle`
   from `handleForUnit`, exact current `WasmFunction` object from
   `functionForUnit`, `definedFuncAt(handle) === function`, and its current
   `typeIdx`/`FuncTypeDef`. A Program ABI unit binding/locator does not exist at
   this point and must not be invented. If the edge, observation, source
   callable, physical slot, handle, function object, or function type is absent
   or stale, preserve Unsupported. Default IR-first/pre-body planning must
   still decline because it precedes the observation.
3. Build one immutable parameter lowering plan keyed by callee UnitId plus
   parameter index and retain its parameter/allocation/call AST identities.
   Consult this exact plan in `makeIrImplicitParamTypeResolver` before the
   generic projection-candidate gate, because `parser` as the receiver of
   `.input` is not a current generic candidate. The plan may classify only that
   unannotated parameter as the selector's structural `object` category, while
   its override type is nominal `irFnctor(shape)`, never an anonymous
   `IrType.object`, raw `ref_null`, or name-keyed fallback. Carry it
   copy-on-write through `IrOverlayPlan`, identity selection, and
   `IrIntegrationLoweringPlans`; do not mutate shared signature or callee maps.
4. Collect exact permitted field-read AST sites for the owner. In
   `lowerPropertyAccess`, an `IrType.fnctor` receiver is accepted only when the
   projected plan owns that exact access, source, owner, shape, and field, and
   emits semantic `fnctor.get`. Extend the backend handle so
   `src/ir/lower.ts` resolves the certified field index/carrier and emits raw
   `struct.get` followed by `ref.as_non_null` only for the exact
   `ref_null $AnyString -> IrType.string` refinement. Do not introduce a
   backend-neutral generic ref refinement. The legality gate checks
   `supportsFieldGet` separately and must reject `fnctor.new` because this
   handle has `supportsConstruction: false`.
5. Use the current source-qualified APIs—`projectIrIntegrationLoweringPlans`
   and the AST-lowering direct-call-plan collector—to retain the exact
   `readNumber` call edge to `stringToNumber`. The current parameter-1 repair
   is a late `effectiveOverride` keyed through a display name/`funcMap`, while
   `projectIrIntegrationLoweringPlans` has already projected raw UnitId
   signatures. It is not authority for this route and may borrow a colliding
   source slot.

   Before projection and selection, build one full copy-on-write effective-
   signature plan against the exact callee UnitId, source, current live
   callable slots, and AST topology. It applies both semantic parameter 0 as
   string and parameter 1 as i32-boolean, yielding
   `[string, i32-boolean] -> f64`. The same plan must feed the selector
   override, `signaturesByUnitId`, `calleeTypes`, exact direct-call AST plan,
   function lowering, parity, and patching; the exact route must not consult
   the old name/`funcMap` repair. The measured parameter-0 live slot is
   physically `(ref null $AnyString)`, while ordinary semantic-string lowering
   is non-null `ref $AnyString`; those are different function carriers and may
   not be conflated.

   Add an immutable owner/UnitId/parameter-index-qualified semantic-to-physical
   parameter plan. It retains semantic `IrType.string`, copies the exact
   certified physical carrier from the current live source-callable slot
   (`ref` or `ref_null` for the same current `$AnyString` type), and records the
   exact nullable-to-non-null refinement when required. Function-type lowering
   must consult that plan instead of the global string carrier for only this
   parameter; parameter materialization/reads emit `ref.as_non_null` only for
   the exact certified nullable carrier before semantic string operations. The
   plan's preselection handle/function-object/type proof is mandatory for
   direct-call planning.

   Only after `preparedUnitProgramAbiBinding` binds the exact unit may the plan
   require its Program ABI binding, locator, and resolved current index.
   Revalidate those records and the retained handle/function/type immediately
   before lowering, parity, and patching. The existing
   `replaceDefinedFunctionLocator` transfer is the only allowed locator update;
   a missing, foreign, or stale post-binding locator/current-index proof
   withdraws.

   Semantic parameter-0 adoption also changes the parser body's two builtin
   arguments from dynamic to string, while the exact `parseInt`/`parseFloat`
   runtime targets retain `val(externref)` parameter zero. Add two bounded
   native-string-to-externref boundary plans keyed by the exact
   `stringToNumber` owner UnitId, source, call/argument AST, and authenticated
   builtin target for the already-validated parser topology. Build and retain
   them before identity selection. The selector's external-call
   classification may treat only those exact planned sites as internal runtime
   providers; an absent or stale plan must keep `external-call`/Unsupported.
   This exact-site authority replaces the old dynamic-parser predicate only for
   those sites and must not relax parse builtins by name.

   `from-ast` consumes the same plans and calls
   `builder.emitCoerceToExternref` before each runtime call; do not widen
   `irTypeAssignable` or the current name-based dynamic exception. The full
   effective-signature plan, boundary plans, semantic-to-physical parameter
   plan, and direct-call plan travel copy-on-write through both #4608 hooks.
   Mutating either parameter (including parameter 1), current live slot, call,
   owner, site, argument index, target, source, carrier, handle, function
   object, function type, post-binding locator/index, or currentness—or
   substituting a same-spelled source—rejects and restores
   external-call/Unsupported. None of these plans may hard-code a display name,
   borrow a same-spelled unit, mutate raw signature maps, or claim this ABI
   already exists. Preserve distinct owner UnitIds.
6. Keep the prepared-component dependency fnctor blocks unchanged. The exact
   `IR_FIRST=0` late-overlay route calls `completePreparedIrIntegration`
   without `sealPreparedComponents: true`; it does not need to widen early
   prepared sealing. Default IR-first/pre-body planning therefore remains
   Unsupported as scoped above.

   The final candidate selection contains `stringToNumber` and `readNumber`,
   not `run`. In this late-overlay checkpoint each selected owner has exactly
   one direct emission followed by one IR emission/patch (`direct=1`, `IR=1`),
   with exact legacy/IR outcome evidence. This is intentionally not the final
   compile-once checkpoint and must not claim that either body compiled only
   once.

### Acceptance and replay gates

The focused test file must be repaired/ported from reviewed semantics rather
than copied from an untracked draft. Static tests first prove the exact
constructor syntax/allocation/argument-edge projections, selection, early
implicit-parameter plan, nominal override, get-only `fnctor.get`, physical
field index/refinement, semantic-string versus physical-externref constructor
ABI, non-null result versus nullable instance carrier, the parser's semantic-
string versus exact live nullable parameter carrier and entry refinement,
exact function type-index parity, and source/owner/currentness records. Add
fail-closed mutations for
missing/stale observations; either parameter or live slot; call, field-read,
source, owner, shape, effective signature, preselection handle/function/type,
post-binding Program ABI binding/locator/current index, capability, refinement,
builtin-boundary, or direct-call-plan drift; alternate or same-spelled-source
constructors/callers; extra writes/uses; wrong physical constructor/field
carrier; changed `parseInt`/`parseFloat` site, target, or argument carrier; and
every L1/L2 negative. `fnctor.new` stays negative, and the existing early
prepared-component fnctor blockers must remain byte-unchanged.

Then run the normal focused compile/runtime matrix: decimal `12_3 -> 123` and
octal `17 -> 15`; exact candidate standalone/prepared/enabled route movement
under `JS2WASM_IR_FIRST=0`; and exact `direct=1`, `IR=1` parser/caller outcome
accounting with `run` retained as legacy. Default IR-first must retain the
pre-observation Unsupported route. Base, disabled, direct, host,
non-native-string, and forced-fast controls remain unchanged with exact
parser/caller `irOutcomes`; fast-mode checker-`any` uses
`ref null $AnyValue`, so it must not satisfy the physical-externref proof. A
changed binary is observational only, not an acceptance requirement, and this
checkpoint makes no compile-once claim. Run TypeScript 7 and 5, formatting, IR
layering, dialect/fallback/oracle/coercion/optimization checks, the LOC and
function ratchets, all normal commit hooks, and all normal pre-push hooks.

After the compiler PR merges, relock the R2 validation bundle in a separate
checkpoint and obtain an independent read-only static audit. This historical
replay instruction is superseded by the 2026-08-27 R2-v2 plan below: preserve
all three recorded R2-v1 failure envelopes and their raw streams, of which only
attempt 2 is a strict-load abort. Do not schedule the old 16-pair/32-child
collector; R2-v2's 16+8/**24-child** collection is the only scheduled runtime.
Its strict gate remains finite, non-negative one-minute load strictly below
`logical cores - 2` (10 cores means `< 8`). C36/C37 stay scheduled for the
final aggregate rerun, and the unchanged #4035 size ceiling is not reported as
a new regression.

## 2026-08-27 dispatch update — execute the linked-Parser L3 edge

This tracker remains the owner of the linked-Parser pre-claim gap. The next
checkpoint is production wiring on the existing PR #5000 branch, not a new
issue and not a dead-export baseline waiver. The planner module is intentionally
dormant until its exact authority is consumed by the late-overlay route.

Implementation order:

1. Revalidate the current late-overlay route and retain the immutable
   `planIrFnctorParameterPreselection` result only after the legacy constructor,
   `input`, `$constructor`, and `$bag` records exist. Keep default IR-first and
   every non-candidate tuple Unsupported.
2. Carry the plan copy-on-write through `planIrOverlay`, the implicit-parameter
   resolver, identity selection, and `IrIntegrationLoweringPlans`; never mutate
   shared name-keyed signatures, `funcMap`, or cross-source state.
3. Make the exact `fnctor.get input` field read and the semantic-string to
   physical-nullable-carrier refinement consume that plan. Revalidate the
   current handle, function object, type, locator, index, source, owner, and AST
   site immediately before lowering, parity, and patching.
4. Join the same owner-qualified effective signature and the two authenticated
   parser builtin boundary plans to the existing `readNumber` → `stringToNumber`
   direct-call plan. Any stale or missing fact withdraws the caller to typed
   Unsupported; no selector bypass or generic dynamic exception is allowed.
5. Prove the route with the existing focused static/runtime matrix, then run the
   normal type, layering, fallback, optimization, LOC, function, and hook gates.
   Preserve the asymmetric `direct=1, IR=1` late-overlay accounting; this slice
   does not claim compile-once or final R2 completion.

The dead-export check is a stop condition, not a ratchet to widen: the eight
planner helpers must become survivor-reachable through production consumption.
The implementation worker owns only the bounded L3 source/tests listed in the
preceding sections and must leave the adjacent #1719 and #4260 plans untouched.

## 2026-08-27 R2-v2 validation plan — replace the stale switch oracle

The post-merge relock audit stopped before runtime. The approved R2-v1
collector cannot be relocked onto current production without changing its
meaning:

- `JS2WASM_TEST_DISABLE_LINKED_STRING_PARSER_ABI` was never present in a
  committed compiler ancestor. It exists only in the staged stage06/d0ae
  delta used by the historical bundle. PR #5000 landed the independently
  reviewed L3 implementation without that test seam, so an enabled/disabled
  dimension on any committed revision is inert.
- R2-v1 also records one graph-global, unitless `compileModuleInitBody`
  `__module_init` row against `entry.mjs` with
  `structurallyComplete:false`. Current production still has that exact bounded
  multi-source exception: inventory owns the local module-init population in
  `empty.mjs`, while the accumulated graph-global init compiles against the
  last/entry source, which has no module-init unit. #5067 deliberately refuses
  callable cutover when a graph has module-init population; #3525 M2 still owns
  replacing this progressively rebuilt direct path. V2 must retain the exact
  exception rather than pretending later R4/R5 ownership work closed it.

This is a validation-contract migration, not a production regression and not
permission to edit the accepted v1 evidence in place.

### Preserve R2-v1 as immutable historical evidence

Keep all three recorded R2-v1 failure envelopes, their raw streams, and the
approved collector bytes unchanged. Only attempt 2 is a strict-load abort;
the other two retain their original failure classifications. The authoritative
source adapter remains
`.tmp/ab-drafts/r2-linked-parser` with:

- README `b8fd4aabf2fa2178d1cba2e0fd39461de931a8b3be394875aa1a4c6b0bc2f0d3`;
- inner manifest `337b6b28239ed9ac046ec171434cb78ffc71f1846d3af81b5373e077215f4531`;
- driver `bb9108e9d63b2f1f1649719c8ec389d4ec1c72cc16e207e2b1136ed4a06a150d`;
  and
- worker `d26cbfe63a59cf107e2a44a3eba5579ed3dfa4e086749040477280407524245a`.

The historical outer runner
`8e7d9b074a8a1d5c30ec07176c7c021f078df33452cb539167ce59b676c9a6cf`,
inventory
`fac9333a306ff66f75bf35691bb62a79aaca7bacdb21ec92db9a86b9d2ca68fa`, and
root `a3b3cd2ffe123f7685c125c6edb9eaa6c1e8235be9720163e92b842929c2b51b`
hashes remain ledger facts; the deleted outer bundle is not reconstructed and
those hashes are not reasserted from new bytes. The immutable v1 README keeps
its original `FAILED-DIAGNOSTIC-NOT-ACCEPTANCE`/`needs-runtime-replay` label as
historical text. The active v2 inventory records v1 as
`superseded-historical-diagnostic` and schedules only v2; no new replay runs
against the v1 schema.

### Versioned R2-v2 collection

Create a new `r2-linked-parser-ab-collection-v2` adapter and output root. Do
not copy and loosen the v1 oracle. The v2 wrapper runs two named phases in one
exactly-once collection so landed L3 causality and current-main compatibility
remain distinct:

1. **Landed-L3 A/B.** Compare exact pre-merge main
   `de35a52d978e328d46a9929b5438837385ddea5b` with landed PR #5000 merge
   `fcede269da81724397dd00bd854e3830446620f5`. Schedule decimal and octal
   fixtures across host/standalone and direct/prepared routes with the reviewed
   late-overlay option set. Pin host to `target=gc` with native strings disabled
   and standalone to `target=standalone` with native strings enabled. That is
   eight canonical tuples, two sides, and exactly **16 children**. There is no
   parser-switch field.
2. **Current-main compatibility.** Freeze the live-main commit at relock time
   and run the same eight canonical tuples once as side `live`, exactly **8
   children**. This phase validates that later R3/R4/R5 ownership changes did
   not regress the landed linked-Parser behavior; it is not another compiler
   side and may not be folded into the historical A/B digest.

The one wrapper therefore schedules exactly **24 children**. Its expected
matrix, keys, counts, and canonical sort include `phase` and reject any
missing, duplicate, unknown, or extra tuple. Supplying the nonexistent switch
environment variable or a `parserSwitch` field is a schema error, not a third
control lane.

The L3 oracle remains asymmetric and exact. Historical base
standalone/prepared rows must retain the reviewed parser parity withdrawal:
one exact parser post-claim row and its matching compile warning are both
mandatory; the caller post-claim row and matching compile warning are optional
only together as the exact paired cascade; and parser plus caller `irOutcomes`
are both mandatory with their exact source/unit/signature joins.
The landed candidate standalone/prepared rows must contain the reviewed clean
L3 route movement and exact `direct=1, IR=1` parser/caller accounting, with
`run` retained by legacy. Host and direct controls remain exact, and decimal
versus octal must retain the same route projection. Binary drift is
observational only.

The live phase applies those landed route expectations to the current
compiler, then validates every extra terminal against the current identity,
Program-ABI-derived-unit, disposition, physical-unit, and outcome records
exposed by the collection. Every
`base`, `candidate`, and `live` side derives all inventory-owned module-init
terminals from that side's frozen inventory and requires their exact source,
file, observed kind, self-owner, and disposition joins. Prepared routes require
the exact terminal outcome for each such inventory unit. Direct or typed
Unsupported routes require their exact physical evidence; they need not invent
a public outcome, but any outcome that is present must join the same exact
inventory unit and disposition.

Separately, each side must retain exactly one copy of the immutable v1
graph-global exception: the unitless `compileModuleInitBody` physical row
against `entry.mjs`, with the exact accepted v1 record projection and
`structurallyComplete:false`. It is the only permitted structural exception.
A missing or duplicate exception, an attached/wrong unit, source/file/kind
drift, another unowned physical row, or any other structural violation fails
closed. The validator does not manufacture a Program-ABI join or change the
fixture to conceal this production boundary. The focused #3523 module-init and
#3525 unit-keyed body-routing tests are static controls; #3525 M2 remains the
owner of removing the exception in production.

Retain the v1 fail-closed transport design: stdout is one framed JSON document;
progress is stderr-only; each spawned child retains raw stdout/stderr bytes,
SHA-256, base64, decoded UTF-8, parsed record, fallback telemetry, tuple,
ordinal, exit/signal/timeout, and pre/post-child load samples. Semantic failure
after collection publishes every valid child plus all oracle failures. A
safety abort publishes the complete prior census plus the failing transport or
load evidence. Record scheduled, preflight-checked, attempted, spawned,
completed, parsed, valid, and invalid counts separately, and compute phase-local
plus aggregate canonical evidence digests. Every report carries status `PASS`
or `FAILED-DIAGNOSTIC-NOT-ACCEPTANCE` plus the complete expected and observed
canonical key census.

Static selftests must cover phase/key drop, duplicate, reorder, wrong side,
forbidden switch dimension, malformed/empty transport, raw-byte round trip,
fallback telemetry validation, missing/extra diagnostics, missing or wrong
parser/caller outcome, per-side inventory-owned module-init
source/owner/kind/route drift, missing/duplicate/mutated graph-global exception,
and multiple accumulated oracle failures. Canonical input reorder must not
change the digest.

### Relock, run, and interpretation gates

Before the one runtime collection, require an independent read-only audit of
the exact v2 source/bundle equality, manifests, pins, static mutations,
detached worktree trees/diffs, dependency links, expected 16+8 census, and
current module-init derivation. Use fresh output roots only. The wrapper and
every child require a finite, non-negative one-minute load strictly below
`logical cores - 2`; with 10 logical cores the limit remains `< 8`. A failed
gate is retained as diagnostic evidence and is never retried in the same
attempt.

A passing v2 collection accepts only the linked-Parser L3 route on its landed
and current-main revisions. It does not satisfy R2 compile-once: `direct=1,
IR=1` is still transitional, the fixed-point prepare-before-emit transaction
and `directBodyEmissions:0` gates remain open, and this tracker stays
`in-progress`. C36/C37 remain scheduled for the final aggregate rerun. The
unchanged #4035 size ceiling remains a control and is not reported as a new
regression.
