---
id: 3521
title: "IR-only R2: prepare-before-emit free-function ownership"
status: in-progress
created: 2026-07-21
updated: 2026-09-02
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
assignee: ttraenkler/fable-ir-takeover
horizon: xl
complexity: XL
es_edition: n/a
lane: ir-retirement-r2
model: claude-fable-5.1 (plans); implementation lanes per slice claim
related: [2138, 2855, 3143, 3203, 3518, 3519, 3678, 4260, 4382]
loc-budget-allow:
  - src/ir/propagate.ts
  - src/ir/select.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/index.ts
  - src/codegen/ir-overlay-outcomes.ts
  - src/codegen/legacy-body-audit.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/outcomes.ts
  - src/codegen/context/types.ts
  - src/codegen/program-abi-session.ts
  - src/ir/backend/porffor/assembler.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
  - src/ir/builder.ts
  - src/ir/prepared-component-dependencies.ts
  - src/codegen/ir-prepared-free-functions.ts
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
  - src/codegen/ir-overlay-outcomes.ts
  - src/codegen/legacy-body-audit.ts
  - src/index.ts
  - src/compiler.ts
  - src/ir/outcomes.ts
  - tests/issue-3520-outcome-correlation-identity.test.ts
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

## 2026-08-29 R2-v2 static collector repair record

The 2026-08-28 independent-audit HOLD and its 119-line collector repair plan
were **authored but never committed** — that section does not exist on `main`
or on any remote branch. What survived into this session is the enumeration of
the four FALSE PASSES the audit proved against the collector plus one census
defect. This record replaces the lost plan.

### Correction to the starting premise: the collector itself was never committed

The repair was dispatched as "repair the existing R2-v2 collector". There is no
such collector in this repository. Verified before any code was written:

- `scripts/` contains no R2-v2 collector, contract, or manifest file;
- the strings `r2-linked-parser`, `parserSwitch`, `FAILED-DIAGNOSTIC-NOT-ACCEPTANCE`
  and `JS2WASM_TEST_DISABLE_LINKED_STRING_PARSER_ABI` occur **only** in this
  issue file and `plan/agent-context/ir-migration-handover-2026-08-27.md`;
- the merged R2-v2 branch `codex/3521-r2-v2-validation-plan` (PR #5086) is the
  **plan** checkpoint and adds no collector source;
- the v1 adapter root `.tmp/ab-drafts/r2-linked-parser` is under a gitignored
  path and was never committed either.

So the collector, like the repair plan, existed only in an uncommitted working
tree on the codex host. **There is no pre-repair code path to run a mutation
against**, and no evidence in this session is an observation of the original
collector.

The work delivered is therefore the R2-v2 static contract **implemented
fail-closed from the start** on all five defect classes, plus a committed
`baseline-naive.mjs` that RECONSTRUCTS the five pre-repair check shapes the
audit described. The reconstruction reuses every unrelated check from
`contract.mjs` and replaces only the five audited strategies, so each
mutation's PASS/FAIL split isolates exactly one defect and cannot be explained
by any other divergence. That makes every mutation demonstrably non-vacuous —
but it is evidence about the reconstruction, not about the lost original.

### Delivered adapter

`scripts/r2-linked-parser-ab-collection-v2/` — `contract.mjs` (fail-closed
oracle), `fixtures.mjs` (canonical 24-child report + mutation operators),
`baseline-naive.mjs` (reconstructed pre-repair baseline), `selftest.mjs`,
`relock.mjs`, `manifest.json`, and a byte-for-byte `bundle/` mirror. Wired as
`npm run -s check:r2-v2-collector`.

**No collection was run.** The contract validates report objects only; it never
spawns a child, never invokes the compiler, and never touches a runtime. Per
"Relock, run, and interpretation gates", only an approved relock may run the
24-child collection.

### Five defects repaired, with per-mutation former-false-pass evidence

Each row is two-sided and runnable via
`node scripts/r2-linked-parser-ab-collection-v2/selftest.mjs`:

| # | audited false pass | mutation | reconstructed pre-repair | repaired | fail-closed code |
| --- | --- | --- | --- | --- | --- |
| D1 | arbitrary extra unitless `compileDeclarations` call not detected | append an unowned unitless `compileDeclarations` row to one candidate/standalone/prepared child | **PASS** (false pass reproduced) | FAILED-DIAGNOSTIC-NOT-ACCEPTANCE | `declaration/unsanctioned-unitless-row` |
| D2 | wrong-file prepared module-init outcome not detected | rewrite that child's module-init outcome `file` to `other.mjs` | **PASS** (false pass reproduced) | FAILED-DIAGNOSTIC-NOT-ACCEPTANCE | `outcome/join-mismatch` |
| D3 | duplicate outcome key not detected | append a second outcome under the same key carrying `direct-legacy` | **PASS** (false pass reproduced) | FAILED-DIAGNOSTIC-NOT-ACCEPTANCE | `outcome/duplicate-key` |
| D4 | parser's second WAT parameter `i32`→`f32` with hashes recomputed | flip `params[1]`, recompute the carrier SHA-256 **and** the report manifest entry | **PASS** (false pass reproduced) | FAILED-DIAGNOSTIC-NOT-ACCEPTANCE | `wat/abi-mismatch` |
| D5 | attempted/spawned/completed collapse when spawn throws | mark one child `spawnOutcome:"threw"` while the census still reports all three states at full count | **PASS** (false pass reproduced) | FAILED-DIAGNOSTIC-NOT-ACCEPTANCE | `census/state-collapse` |

The repairs, in the same order: the physical-row census is **closed** (every row
joins an inventory unit or is the one sanctioned unitless exception); outcomes
join their inventory unit on **every field**, not by key presence; the outcome
index **detects duplicates** instead of `map.set` overwriting; the expected WAT
ABI is carried **structurally** (`EXPECTED_WAT_ABI`), so self-consistent hash
recomputation cannot hide a parameter-type change; and attempted / spawned /
completed are **derived separately per child** and cross-checked against the
reported counters, so a throwing spawn cannot collapse them.

Non-vacuity is anchored by the unmutated canonical report passing **both**
validators. Denominators: 24 scheduled children (16 landed-A/B + 8 live), 38
static assertions — 3 canonical-fixture, 10 defect (5 mutations × 2 sides), 16
structural, 5 accumulated-failure, 4 digest/reorder — all green, plus the relock
check.

### Also enforced (not in scope of the five defects)

Expected 16+8 key census with missing/duplicate/extra/unknown-phase/wrong-side
rejection; base and candidate pin equality with a single frozen live revision;
`parserSwitch` field and the switch environment variable as schema errors;
missing/duplicate/mutated graph-global exception; the reviewed base
standalone/prepared parser-parity withdrawal and its paired caller cascade;
`direct=1, IR=1` candidate accounting; malformed and empty transport; and
reorder-stable phase-local plus aggregate digests.

`relock.mjs` recomputes every source digest, requires the `bundle/` mirror to be
byte-for-byte, and derives a root hash over the sorted per-file digests together
with the pins, expected census, and expected ABI. Every manifest field is compared on its
own — deliberately not through a `JSON.stringify` replacer array, which filters
object properties at every level and would let a hand-edit inside a nested field
read as equal. Three tamper paths were proven to fail closed: a one-line edit to
a mirrored file reports `bundle/contract.mjs is DIFFERS`; editing the contract's
expected ABI reports `expectedWatAbi` / `sources` / `rootHash` drift; and a
hand-edit to `manifest.json`'s `pins.base` alone reports `pins` drift. Adapter root hash at this
checkpoint: `d9e2327de0f2a57e3cc612b218f7fa77d940133a8da8a041f14c1312a240958d`.

### Open items the independent auditor must close before any relock

1. **`EXPECTED_WAT_ABI` values are pinned placeholders.** The repair is that the
   ABI is carried exactly rather than by hash; the specific parameter and result
   types must be confirmed against the landed L3 production ABI and re-pinned
   under the approved relock.
2. **The sole exception is enforced per child.** "Each side must retain exactly
   one copy" is implemented as exactly one sanctioned unitless row per child
   record, since each child is a separate compilation of the graph. Confirm this
   reading.
3. **The fixture is synthetic.** `fixtures.mjs` hand-builds a canonical report;
   the inventory shape (one owned module-init unit in `empty.mjs`) follows this
   issue's description of the bounded multi-source exception and needs
   confirming against a real frozen inventory.

This tracker stays `in-progress`. Nothing here satisfies R2 compile-once, and no
runtime replay was performed.

## 2026-08-30 — fast typed-scalar pre-body admission

Status: implemented as a bounded production checkpoint; the broader R2 tracker
remains `in-progress`.

Model: `gpt-5.6-terra` implementation worker, reviewed and completed by the
owning Codex session.

The blanket fast-mode rejection in
`selectR2PreparedOwnerComponents` is narrowed to one fail-closed contract.
Only an exact top-level function claim with required identifier parameters,
explicit `number`/`boolean` parameter annotations, and an explicit
`number`/`boolean`/`void` return may prepare before direct emission. The syntax
projection must match the final IR override position by position (`number` →
`f64`, `boolean` → `i32`, `void` → no result), and that override must still
match the already allocated Program ABI slot exactly.

Generics, async/generator declarations, defaults, rest/optional parameters,
destructuring, inferred/JSDoc-only positions, strings, vectors, dynamic values,
and every reference carrier remain on the established direct/post-direct
route. All existing body-shape, nested-executable, poison-pill, activation,
function-value, component-closure, and slot-parity guards remain in force.

Focused coverage poisons the direct emitter for a fast numeric leaf and for a
mixed numeric/boolean component. Both now report one IR body, zero legacy
bodies, `irFirstSkipped`, and a prepared component identity while preserving
the `8_000_000_000` result above the i32 range. A route-off poison control proves
the direct path is still live, and a fast default-parameter negative remains
direct and fails under the same poison.

The changed-root CI gate also exposed three assertions already stale on
current `main`. Their coverage is retained rather than suppressed: function
value identity now pins the exact GC/standalone binary deltas (`0` / `119`
bytes), the independent `directOnly` scalar owner proves compile-once beside a
blocked function-value component, and the module-init boundary poisons the
scalar callee's direct body while proving that the module initializer itself
remains direct.

## 2026-08-30 — exact function-body UnitId routing checkpoint

This bounded checkpoint makes exact `IrUnitId` skip and preserve receipts the
authority at the ordinary prepare-before-direct declaration seam, including the
inherited compatibility route and already-installed prepared free bodies. The
legacy name sets remain deterministic compatibility/telemetry projections and
must agree with the exact receipts or fail closed. It changes neither selector
population nor the legacy-body count.

## 2026-08-30 — production R2 body-emission accounting checkpoint

This follow-up remains bounded to same-source, top-level free-function terminal
outcomes. It does not alter selector population, Wasm ABI/layout, direct body
emission, class/member accounting, module-init accounting, or the legacy body
count.

The outcome ledger now records `prepareAttempts`, `directBodyEmissions`, and
`irBodyEmissions` for the bounded production population. Direct counts come
only from exact `compileFunctionBody` AST-entry receipts keyed by `IrUnitId`;
IR counts come only from exact terminal `patched` evidence. Compatibility
booleans are derived from these counts and policy validation rejects partial,
impossible, duplicate, or boolean-inconsistent accounting.

The direct receipt census deliberately ignores known nonterminal/support,
runtime-namespace, and synthetic function bodies. Unknown, mismatched, or
foreign identities remain fatal evidence. Reconciliation validates/indexes the
direct receipt census and raw terminal patch receipts once per source, then
uses constant-time per-terminal lookups. A skip receipt supplies only the
expected route: skipped emitted owners require direct `0`; non-skipped emitted
late-overlay owners require direct `1`.

Required terminal shapes are therefore explicit:

- prepare-before-direct success: `(1, 0, 1)`;
- typed direct fallback: `(1, 1, 0)`;
- ordinary prepared invariant/unpatched: `(1, 0, 0)` and fatal; and
- intentional post-direct linked-overlay success: `(1, 1, 1)`.

Receipt corruption cannot be normalized: missing, duplicate, foreign, or
impossible direct/IR evidence becomes a typed invariant (or an existing trusted
boundary invariant), retaining the observed count for diagnosis.

### 2026-08-30 — independent review corrections

The R2 denominator now mirrors the physical top-level declaration contract:
for a duplicate named Script declaration it contains only the last body-bearing
declaration that the direct emitter can compile. Shadowed declarations retain
their existing public outcome rows but do not receive R2 counters. A receipt
for one of those excluded UnitIds is still foreign to the exact denominator and
fails the physically accountable owner closed.

Accounting diagnostics now compare the final invariant with the exact
report-visible failure. Only an unchanged report-visible invariant suppresses a
second diagnostic. If body accounting replaces either outcome-only or
report-visible failed evidence, the synthesized `body-emission-evidence`
invariant emits one public accounting diagnostic.

The direct dispatcher indexes each receipt into its source bucket at record
time, with one graph-global fail-closed sentinel for evidence that cannot be
attributed safely. Source audits no longer scan the graph entry ledger. The
physical R2 terminal populations are likewise cached once per authoritative
planning context, so the added graph accounting is linear with constant-time
per-terminal reconciliation.

## Test Results

- Focused exact-routing plus fast-scalar/route-off/direct-negative subset: 6 passed.
- TypeScript 7 validation, changed-file lint/format, IR fallback/layering, and
  LOC/function budget ratchets: passed.
- 2026-08-30 production body-accounting controls:
  - `tests/issue-3520-outcome-correlation-identity.test.ts`: 9 passed
    (normal triples plus missing, duplicate, foreign, and impossible receipts).
  - Four focused `issue-3521-prepared-free-function-routing` controls passed:
    support-body scoping, direct fallback `(1,1,0)`, prepared success
    `(1,0,1)`, and prepared invariant `(1,0,0)`.
  - `tests/issue-3521-linked-string-parser-abi.test.ts`: 4 passed, including
    the intentional post-direct linked-overlay `(1,1,1)` route.
  - TypeScript 7, changed-file Biome lint and Prettier check, IR
    layering/dialect/kind-neutrality/fallback/IR-only readiness, adoption,
    optimization-retirement, oracle, and LOC/function budget gates: passed.
- 2026-08-30 independent-review correction:
  - Six focused regressions first failed against `0e5fbac` (replacement
    diagnostic, duplicate denominator/foreign receipt, unattributed corruption,
    source-population indexing, source-local direct indexing, and the production
    duplicate Script compile), then passed after the correction.
  - Scoped #3520/#3521 reconciliation, routing, and linked-parser validation:
    23 passed, 36 skipped across 3 files. The linked-parser controls remain 4/4.
  - TypeScript 7, changed-file Biome lint and Prettier check, `git diff --check`,
    IR layering/dialect/kind-neutrality/fallback/IR-only readiness, adoption,
    optimization-retirement, oracle, and LOC/function budget gates: passed.

## 2026-09-01 — fast JS-host pass-through string-signature checkpoint

Status: bounded production checkpoint only; this tracker remains in-progress.

The separate r2FastJsHostPassThroughStringSignature admission adds only the
normalized JS-host lane: !ctx.nativeStrings && !ctx.standalone && !ctx.wasi &&
!ctx.strictNoHostImports. It requires one top-level named function with
required identifier parameters, explicit string annotations at every parameter
and result position, no generic/async/generator/default/rest/optional/
destructured form, and a constructed all-IrType.string override that still
equals the exact allocated Program ABI slot. The existing fast scalar admission
is unchanged. Native strings, standalone, WASI, strict no-host imports, and
defaulted string parameters retain their direct or existing post-direct route.

Focused evidence: tests/issue-3521-prepared-free-function-routing.test.ts
passed 46/46 with VITEST_FORK_MAX_OLD_SPACE_SIZE=4096. The poisoned fast
JS-host echo(value: string): string route returned its original string with
irFirstSkipped, a UnitId and prepared-component identity, and exact post-#5313
accounting (prepareAttempts, directBodyEmissions, irBodyEmissions) = (1, 0, 1).
Four isolated excluded-lane controls reached the poisoned direct emitter. The
unpoisoned native-string control records directBodyEmissions=1 without
pre-body skip ownership (its established late-overlay patch remains (1,1,1)),
and the defaulted-string boundary remains direct. Existing standalone and
native-string routing coverage ran in the same focused suite.

This does not broaden general string admission or complete the overall R2
prepare-before-emit migration.

## 2026-09-02 R2-T1/G1 implementation plan — admission withdrawal telemetry, `tests/ir` under CI, and the two red suites

Written by the Fable planning lane against `origin/main` `47e337f3b6` from the
verified R2 census (scratchpad `r2-census.json`; the verifier's corrections and
ranking applied — this slice is its #1 and #3, merged because both are S and
the telemetry's pins live beside the `tests/ir` suites); revised after the
critic pass. `origin/main` is now `33ea8606aa` (draft: `6d96d01f5d`; critique:
`1c8ee381a9`; revision 2: `26b13e2134`); `git diff --name-only 47e337f3b6 origin/main` is 58 paths and a
per-file `git diff --quiet 47e337f3b6 origin/main -- <f>` over the 26 files
cited here reports none changed, so every `47e3` line holds on today's main
(113 anchors, `.tmp/r2-plans/r2-t1g1/anchors.txt`, re-checked by the critic
with `git show 47e337f3b6:<file> | sed -n`). Landed in between (first-parent `git log 47e337f3b6..origin/main`: PR #5472 F2-S7, #5477 revert of #5474, #5476, #5479, #5478, #5473 F2-S6, #5481): 39 files under `src scripts tests .github docs`
(`declarations.ts` + its deleted prelift file, #5479's 17 builtin/proto codegen files, the F2 seam in `src/ir/` plus `stdlib-selfhost.ts`/`native-batched-concat.ts`,
`ir-kind-neutrality-baseline.json`, eleven #3523/#3526/#4104/#5194 tests) — none of this slice's. In flight (heads fetched,
`git diff --name-only $(git merge-base origin/main FETCH_HEAD) FETCH_HEAD`;
none overlaps the edits below; open PRs at 13:15 UTC): #5482 F2-S8 (`hold`) — F2
seam files only; #5480 gap-6a v2 (`hold`) — `declarations.ts`, the prelift
file, one #3523 test (the After-table's R2-S1 row waits on it); codex #5390 — `src/codegen/index.ts` and `context/types.ts`
in other regions (`generateModule` tail, `generateMultiModule`,
`resolveWasmType`/`ensureStructForType`, `CodegenContext` tail; re-merge if it
lands first); #5063 (`hold`)/#5393/#5397/#5400 — none of the slice's files. Live-lane
files: `src/ir/outcomes.ts` (#3520, codex) is NOT edited — the R2 vocabulary, validator and
row projection live in a new R2-owned `src/ir/r2-withdrawal.ts` (A); #3525's
`multi-prepared-callable-orchestration.ts` is NOT edited (C8); both lanes get
a heads-up before the PR opens. Every number's driver/output is indexed in
`.tmp/r2-plans/r2-t1g1/COMMANDS.txt`.

**Sequencing.** Branch from `origin/main`, no predecessor, enqueue
independently. Claim #3521 at dispatch (`node scripts/claim-issue.mjs --check 3521`,
2026-09-02 re-run: `NO ACTIVE CLAIM, id TAKEN (released, ttraenkler/codex,
2026-08-30T22:46:51Z), read origin/issue-assignments`). Yield is **zero
conformance by design**: every compiler byte stays identical; the slice adds
observability (one reason per compile-twice row) and admission (CI sees `tests/ir`).

### What moves and what does not (census, 486 cells)

Denominators: 48 shape rows × 6 lanes (46 `SHAPES` keys, two yielding two
function rows), 49 `compileFiles` rows × 2 lanes, 50 `compile()` rows × 2 lanes.

| # | site (`47e337f3b6` = `26b13e2134`) | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `src/codegen/ir-prepared-free-functions.ts:1297-1344` admission loop of `selectR2PreparedOwnerComponents` (`:1262-1467`, 206 lines by `check-func-budget`'s rule `:185-187`); the `if (…) { continue; }` chain `:1319-1341`; `freeFunctionCandidates.add` `:1343`; result `:1448-1466` | ten predicates OR'd in order: fast proofs `:1320-1324` (`r2FastPreparedScalarFunctionSignature :742`, `r2FastJsHostPassThroughStringSignature :802`), `isAsync :1312`, generator lane (`generatorsPreparable :695`), nested executable syntax, poison-pill read `:622`, direct-caller activation target `:565`, function-value reference `:583`, param/return `r2StableSignatureType :364`, `r2SignatureMatchesAllocatedSlot :705` at `:1339` | **RECORD** — same predicates, same order; the first failing one is the reason; the bare `continue` gains a recorder call; the result gains `withdrawals` |
| 2 | `:1378-1428` fixed point over `[...candidates] :1380` (functions ∪ class members); `crossesOwnership :1382-1423` (edges: `:1383` callee-of-unowned-caller, `:1384` callee outside, `:1393` construction, `:1409` storage, `:1422` reverse callers); unattributed `candidates.delete` `:1425` | the five edges, `outsideCallerCertifiedUnitIds :1366`, `preparedStorageTerminalUnitIds` | **RECORD** — first true edge is the reason, then the same `delete` |
| 3 | `:1432-1445` #3522-F4 class atom (`admitted.fields.map(field => field.calleeUnitId)` `:1437`), `if (candidates.delete(unitId)) changed = true;` `:1443` | `nestedClassFieldCallAdmission.classes` | **RECORD** `fixed-point:class-atom` |
| 4 | `:272-343` `deferUnsealedPreparedComponents` (called `:1840` from `prepareIrBodies :1715`, which holds `identityPlan`, not the `IrOverlayPlan`) | `routing.deferredUnitIds` | **RECORD** `deferred:unsealed-component` (reached by 0 census rows; kept — the only other single-source route to a `(1,1,1)` row) |
| 5 | `src/codegen/index.ts:4624` `timerRouting.owners(...)` (`ir-timer-shim-planning.ts:236-239`: `undefined` when another late feature is pending and no timer owner is eligible) → `:4626-4645` the selector call | `preliminarySelection.funcs` | **RECORD** `not-attempted:late-feature-preparation` for every selector-claimed name the R2 selector never saw — measured (`probe-helpers-route.out`): `helpers.ts::el`/`::bcrd`, the 2 overlay rows of the 50-row `compile()` corpus (`hostVoidCallbacks: 1` in `addBenchCard` → `hasOtherLateFeaturePreparation`, `owners()` → `undefined`, selector `calls=0`); Report A's R2-E1 diagnosis of them is refuted |
| 6 | `index.ts:5628-5629` `irFirst` (`disableIrFirst`, `JS2WASM_IR_FIRST=0`) → `:5648` IR-first plan or `:5776-5778` `irPlan ?? planIrOverlay(…)` | env + option | **RECORD** source default `not-attempted:ir-first-disabled` (the L3 linked-parser route; `tests/issue-3521-linked-string-parser-abi.test.ts:37/:148`) |
| 7 | `src/codegen/multi-prepared-callable-orchestration.ts:148-161` `initializeMultiPreparedProgram` (#3525's file), called from `generateMultiModule :10194` at `index.ts:10211`; the multi overlay chain `compileMultiPreparedProgramOverlays :10156` (called `:10698`) → `compileMultiIrOverlaySource :3887` → `:3972` `consumeIrOverlayReport :3415` → `recordObservedIrOutcomes :3489` (its only call site) | the driver | **RECORD** source default `not-attempted:multi-source-driver` in `index.ts` `compileMultiPreparedProgramOverlays`, on BOTH gate outcomes — measured (`corpus-files-census-instr.mjs`): the selector runs 0 times on all 26 file×lane cells; host `{overlay 28, direct 21}` / standalone `{prepared 6, overlay 13, direct 30}` of 49 → 41 rows get this reason, the 6 prepared rows are R5/#3525's route kinds. `src/compiler.ts:1110` is the multi/single projection of `irFirstSkipped`, not a gate |
| 8 | `src/codegen/ir-overlay-outcomes.ts:927-934` the `patched` arm (`preparedComponentId` spread `:933`); `ReconcileIrOverlayOutcomesInput :42-57`; `index.ts:2501` `recordObservedIrOutcomes` → `:2516` | `evidence`, `bodyAccounting :280` | **ATTACH** the reason iff `directBodyEmissions === 1` |
| 9 | `src/ir/outcomes.ts:250-279` `IrObservedOutcomeBase` (triple `:272-274`, `preparedComponentId :278`); `hasMalformedBodyEmissionAccounting :345`; `evaluateIrOutcomePolicy :365-392` | the triple | **UNTOUCHED** (#3520's file); the R2 vocabulary, row projection and validator go in the new R2-owned `src/ir/r2-withdrawal.ts` (A) |
| 10 | `scripts/check-ir-only.ts:294-320` row-consistency loop (`evaluateIrOnlyReport :258`, exported and fixture-driven by `tests/issue-3519-ir-only-gate.test.ts:6-13`) | `kind`, booleans | one more row rule (silent today: 0 `(1,1,1)` rows in the gate corpus, measured) |
| 11 | `scripts/select-changed-issue-tests.mjs:39-44` `PINNED`, `:46` `ISSUE_TEST`, `:91`; `.github/workflows/ci.yml:690-712` (the `issue-tests` comment; `:713` the job; `:711-712` records ~45 s for the single pinned file), `:725/:741`; `docs/ci-policy.md:63` | git diff names | **ADMIT** `tests/ir/*.test.ts` (advisory regex) + pin six green R2 suites (fatal) |
| 12 | `tests/ir/fnctor-producer.test.ts:360` vs `src/codegen/program-abi-fnctor-producer.ts:225` (`fnctorColdTailStructName?.has(input.structName)`; host twin `:81` still keys `fnctorColdTailTypeIdx`) | ctx maps `context/types.ts:4284/:4291` | **FIX** the test, one line |
| 13 | `tests/issue-3214-imported-hof.test.ts:27-46` (`:44`); `src/ir/from-ast.ts:13217-13242` (`checkerProvesBinarySourceCapabilityGap :12547`, `checkerOperandFamily :12505`); `src/ir/select.ts:9377-9381` `isEquality` | callable-family operands | **FILE** as its own selector issue; not fixed here |

Measured facts the design rests on (each re-run by this lane):

- **Every `(1,1,1)` shape-census row has exactly one cause, and the
  instrumentation is tally-neutral.** The verifier's `git archive` export
  (`wt-instr/`) had sites 1, 2 and 4 rewritten into labelled predicates
  (`instrument.py`, `instrument2.py`; `npx tsc` 0 errors); `npx tsx
  shape-census-instr.ts shapes` reproduces the census tallies (host 23/16/8,
  fast 13/19/15, fast-hostStr 16/18/13, native/standalone/wasi 23/17/7). The
  57 rows: `fast-signature-unproven` 28 (fast 15 + fast-hostStr 13 — the
  first predicate masks every later one); `param-signature-unstable` 9
  (`vec-string-param` host; `object-param`, `destructured-param` ×
  host/native/standalone/wasi); `return-signature-unstable` 4
  (`object-return`); `async-declaration` 4; `storage-terminal-unprepared` 8
  (`scalar-reads-let/-const` × 4 lanes — #4508's edge, R2-S1's population);
  `outside-caller-uncertified` 4 (`callable-param`: admitted by
  `r2StableSignatureType`, refused by `r2CarrierFixedByDeclaration :856`,
  withdrawn by its module-init caller — R2-E1). No other reason was reached.
- **`tests/ir/` on `47e337f3b6`** (21 files, extracted from the substring run
  in `vitest-tests-ir.out`): 19 green, 2 red — `fnctor-producer` 20/21 and
  **`counted-string-append-provenance` 13/29**, a third red the census did
  not see. Test time sums to 58.8 s, 3.9 s of it in the six R2-named files.
  **Wall time is what a PR pays, and collect dominates it**: the six alone
  (`pnpm exec vitest run tests/ir/{fnctor-abi,fnctor-admission,fnctor-argument-projection,fnctor-producer,inline-small,phase3c}.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`,
  `.tmp/r2-plans/critic-vitest-six.out`) take **44.77 s** (collect 36.4 s,
  tests 7.6 s); the 19 green files, same flags (`vitest-nineteen.out`,
  2026-09-02, tree whose `src/` and `tests/ir/` equal `26b13e2134`; 19/19
  files, 280/280 tests) take **140.82 s** (collect 64.8 s, tests 74.4 s).
- **`fnctor-producer`**: 21/21 at `dc60138909`, red at `cb733cde37`, whose
  only producer hunk changed `:225` from `fnctorColdTailTypeIdx?.has(input.functionName)`
  to `fnctorColdTailStructName?.has(input.structName)`; the fixture `:360` sets
  only the old map. Struct-name map = the WasmGC split's signal (`fnctor-cold-tail.ts:361`),
  type-idx map = the linear reservation's (`linear-type-reservations.ts:243`): test stale.
- **`counted-string-append-provenance`** (`attr-counted.log`): 29/29 at
  `87a6165656` (`0f42c1fde4^`), 16 failed at `0f42c1fde4` (2026-08-27, Codex,
  #3518), all `mismatched counted trip-count proof` (`src/ir/counted-string-append-provenance.ts:365`). Not R2's.
- **`issue-3214`** (`probe-3214.out`, `bisect-3214.log`): first-parent bisect
  over 1,437 commits `037ff37d9a` (GOOD) → `47e337f3b6` (BAD): **first bad
  `ff403c6b2c` = merge of PR #5219 (#5165 tail-position loops / finally-less
  `try`)**, parent `82a09a9b33` GOOD. On main `identical` compiles once and
  correctly (`runMain` → 43; only `:44` is red): its row is `(1,1,0)
  unsupported/build/operand-coercion-unsupported`, a POST-claim typed demote
  from `from-ast.ts:13226-13242` (both operands `callable`); before #5165 the
  body was rejected PRE-claim. A selector pre-claim gap (`select.ts:9377-9381`
  guards only module-extern operands) — not R2, not #3522's `from-ast`
  typing; #5165 and #3529 are `status: done`, so no live lane owns it.

### Design — one closed vocabulary, one field, one default; alternatives rejected

**Mirror #2856's recorder (`select.ts:219-248`), unconditional and typed.**
Not copied: the `JS2WASM_IR_SHAPE_DIAG=1` gate (EVERY `(1,1,1)` row must
carry its reason in the ordinary ledger, so censuses need no switch and site
10's rule can be live) and the free-text `detail` (a `string` cannot be
pinned closed; R2-F1/E1/S1 ratchet NAMED buckets). Copied: first-wins in the
chain's own order and zero change to the boolean outcome (V-A by construction).

**The reason lives on the row, beside the triple** (`r2Withdrawal?`, attached by
spread beside `preparedComponentId :278`, typed in `r2-withdrawal.ts`), present iff the row is a `function` row with
`directBodyEmissions === 1 && irBodyEmissions === 1`. Rejected: (a) a second
`IrPreparationFailure` row or flipping the row to `unsupported` — changes
`kind`, policy verdicts and `check:ir-only` counts, and the row DID emit an
IR body; (b) a name-keyed public list like `irFirstSkipped` — names are
#5326's compatibility projection, identity is `IrUnitId`; (c) a map on
`IrOverlayPlan` — VIABLE for the admission/fixed-point stage (under IR-first
the late overlay reuses the IR-first plan, `index.ts:5776-5778` `irPlan ??
planIrOverlay(…)` / `:5786` `preparedSelection ?? …`; the plan is in hand at
`recordObservedIrOutcomes :2504`; it already carries the mutable
`preparationFailuresByUnitId`, `ir-timer-shim-planning.ts:195`/`index.ts:4492`)
but rejected because the other three stages have no plan in hand:
`deferUnsealed` runs inside `prepareIrBodies :1715` (`identityPlan` only;
`:1840`), the `ir-first-disabled` default is set at `:5629` where `irPlan` is
still `null`, and the multi default precedes any per-source plan. One ctx
sink (`Map<IrUnitId, IrR2Withdrawal>` + one source-level default), read once
in `recordObservedIrOutcomes`, serves all four; unit ids are source-qualified
(#3520), so one map spans the multi lane's sources.

**"Not attempted" is a stage, not the absence of a reason.** 41/41 corpus
rows and 2/50 `compile()` corpus rows have no per-unit withdrawal because the
selector never saw the unit; a default set at the multi overlay entry (site
7), the `irFirst` decision (site 6) or the timer routing (site 5) keeps
"exactly one reason" true without inventing evidence, and lets R5 measure its
lane through the same field. No existing ctx state can derive the multi
default: `ctx.callableSourceFiles` is set by BOTH drivers (`index.ts:5030`
`[ast.sourceFile]`, `:10209`), and `length > 1` mislabels a one-file `compileFiles`.

**Fail closed where visible, byte-neutral where not.** A `(1,1,1)` function
row without a reason, a reason on any other row, or one beside
`preparedComponentId` is malformed evidence: `r2WithdrawalDefect` (new R2-owned
`src/ir/r2-withdrawal.ts`) names it and `check-ir-only.ts`'s row rule fails it under BOTH
policies (`evaluateIrOnlyReport` is policy-independent). `evaluateIrOutcomePolicy` is NOT
edited: it has no `src`/`scripts` consumer (`git grep`), so nothing production-visible is lost. No compile diagnostic.

**CI: regex for all of `tests/ir`, fatal pins for the six.** Pinning all 19
green files costs 140.8 s wall per PR against 44.8 s for the six (≈96 s
more) and makes a red in `utf8-storage-roundtrip` or `issue-1373b` fatal for
unrelated PRs; the six are the R2 record's own evidence files, so a red there
is an R2 finding. Every `tests/ir/` file becomes visible to the advisory step
the moment a PR touches it — the gap that let `cb733cde37` and `0f42c1fde4`
redden two files unseen. Rejected: a required check (`docs/ci-policy.md` §7
keeps `issue-tests` non-required until the suite is clean; two reds remain).

### Contract

**A. NEW `src/ir/r2-withdrawal.ts`** (R2-owned; `src/ir/outcomes.ts` — #3520's file — is NOT edited)

1. Export `type IrR2WithdrawalStage = "not-attempted" | "admission" | "fixed-point" | "deferred"`;
   the closed `type IrR2WithdrawalReason =`
   `"multi-source-driver" | "ir-first-disabled" | "late-feature-preparation" | "fast-signature-unproven" | "async-declaration" | "generator-lane" | "nested-executable-syntax" | "poison-pill-read" | "direct-caller-activation-target" | "function-value-reference" | "param-signature-unstable" | "return-signature-unstable" | "allocated-slot-mismatch" | "callee-of-unowned-caller" | "callee-outside-component" | "construction-callee-outside" | "storage-terminal-unprepared" | "outside-caller-uncertified" | "class-atom" | "unsealed-component"`
   (3 + 10 + 5 + 1 + 1 = 20); `interface IrR2Withdrawal { stage; reason;
   detail?: string }` (`detail` only for `unsealed-component`); frozen
   `IR_R2_WITHDRAWAL_REASONS` (20), read by item 3's validator (a `src` consumer).
2. Export `type IrObservedOutcomeWithR2Withdrawal = IrObservedOutcome & { readonly r2Withdrawal?: IrR2Withdrawal }`
   and the only reader `r2WithdrawalOf(outcome: IrObservedOutcome): IrR2Withdrawal | undefined`; C9 attaches the
   property by spread, so `IrObservedOutcomeBase :279` stays byte-identical and the field is `(1,1,1)`-only metadata no emitter reads.
3. `r2WithdrawalDefect(outcome)` in the same new file (shape of `nonExecutableOutcomeDefect`, `outcomes.ts:314`):
   defect when (i) a `function` row with `directBodyEmissions === 1 &&
   irBodyEmissions === 1` lacks it; (ii) present on any other shape (other
   triple, no triple, non-function); (iii) present beside
   `preparedComponentId`; (iv) `reason` not in `IR_R2_WITHDRAWAL_REASONS`, or
   `detail` on a reason other than `unsealed-component`. Called from D's row rule and
   the (a) pins only; `evaluateIrOutcomePolicy :365-392` and `:345` untouched.

**B. `src/codegen/ir-prepared-free-functions.ts`** (no new export)

4. `selectR2PreparedOwnerComponents :1262` returns
   `readonly withdrawals: ReadonlyMap<IrUnitId, IrR2Withdrawal>`. In
   `:1297-1344` replace the ten-way `||` by an ordered predicate table read
   by a local `firstFailing()` in EXACTLY site 1's order (fast proofs → … →
   allocated slot); record `admission:<reason>`, then `continue`. Baseline
   names (`:1308-1310`) record nothing. In the fixed point `:1382-1426`
   compute `firstCrossingEdge()` over site 2's five edges in order and record
   `fixed-point:<edge>` before `candidates.delete :1425`; the class-atom loop
   `:1443` records `fixed-point:class-atom`. First-wins per unit across
   iterations; class-member candidates are recorded but never attached (C9).
5. `deferUnsealedPreparedComponents :272` takes an optional recorder and
   records `deferred:unsealed-component` (+`detail`); `prepareIrBodies :1715`
   threads the ctx sink into the `:1840` call.

**C. Sink and plumbing.** `src/codegen/context/types.ts:1543` neighbourhood:
`irR2WithdrawalsByUnitId?: Map<IrUnitId, IrR2Withdrawal>`,
`irR2NotAttemptedReason?: "multi-source-driver" | "ir-first-disabled"`.
`src/codegen/index.ts` (R2-locked per `## File ownership and locks`, `:951-962`):

6. `planIrFirstBodyRouting :4573`: after `:4646` merge the selector's
   `withdrawals` into the ctx map; for every name in
   `preliminarySelection.funcs` absent from `freeNames` (`:4624`) record
   `not-attempted:late-feature-preparation` via `requireIrOverlayFunctionUnitId`.
   Nothing else there yields `(1,1,1)`: the preflight rejection `:4678`
   (`rejectPreparedLexicalComponentBeforeMutation :4478-4500`) and a timer
   owner withdrawn by `finalizePreparedIrSelection` reach `unsupported` (ovl
   `:912-918`); a non-timer withdrawal is the `:4698` invariant.
7. `:5628-5629`: when `!irFirst` set `ctx.irR2NotAttemptedReason = "ir-first-disabled"`.
8. `compileMultiPreparedProgramOverlays :10156`: first statement, BEFORE the
   `:10165` early return, `ctx.irR2NotAttemptedReason = "multi-source-driver"`
   — the multi overlay entry (called unconditionally at `:10698`), in
   R2-locked `index.ts`, outside `generateMultiModule`'s own body (`:958-962`
   puts that body out of scope) and outside #3525's file (claimed by
   ttraenkler/codex; in its `files:` at L44). Rejected: the `:10211` gate
   call (inside `generateMultiModule`), R5's function `:148-161`.
9. `recordObservedIrOutcomes :2501` passes both into
   `reconcileIrOverlayOutcomes :2516` (`ReconcileIrOverlayOutcomesInput
   :42-57` gains two optionals); the `patched` arm `:927-934` attaches
   `r2Withdrawal` iff `bodyAccounting?.directBodyEmissions === 1`: per-unit
   map, else the source default, else nothing (then A3 names the row). This
   guard keeps A3(ii) consistent: class-member and module-init rows carry no
   triple (`:862-864`), so B4's class-member recordings are inert until #3522
   migrates member accounting. `functionBodyAccountingFailure :303` untouched.

**D. `scripts/check-ir-only.ts:294-320`**: the A3 rule as a row failure
(`compile-twice function X carries no R2 withdrawal reason` and its inverse),
reachable from tests through the exported `evaluateIrOnlyReport :258` on a
hand-built `lane([entry([…])])` (helper shapes: `tests/issue-3519-ir-only-gate.test.ts:44-60`;
`IrOnlyEntryObservation.outcomes :37-40` carries full rows, triple included).
`scripts/ir-only-baseline.json` NOT edited (main's writer; 0 such rows, measured).

**E. CI and the one-line fix**

10. `scripts/select-changed-issue-tests.mjs`: `ISSUE_TEST :46` →
    `/^tests\/(issue-[^/]*|ir\/[^/]*)\.test\.ts$/`; `PINNED :39-44` gains,
    each with a one-line why, `tests/ir/{fnctor-abi,fnctor-admission,fnctor-argument-projection,fnctor-producer,inline-small,phase3c}.test.ts`
    (green on `47e337f3b6` after item 11; 44.8 s wall together). Header
    comment `:4/:11-12`, the `ci.yml:690-712` comment and `docs/ci-policy.md:63`
    say "`tests/issue-*.test.ts` and `tests/ir/*.test.ts`"; steps `:725-760` unchanged.
11. `tests/ir/fnctor-producer.test.ts:360` →
    `["a cold tail", (ctx: CodegenContext) => (ctx.fnctorColdTailStructName = new Map([["__fnctor_Parser", "__fnctor_Parser__cold"]]))],`
    with a comment citing `cb733cde37` / `:225`. Do NOT touch `:81`.
12. `tests/issue-3214-imported-hof.test.ts`: unchanged, NOT pinned. File the
    selector issue at implementation time
    (`NEW=$(node scripts/claim-issue.mjs --allocate --by ttraenkler/<agent>)`,
    never hand-picked): "selector: reject callable-family equality operands
    pre-claim (#5165 regression; red `issue-3214-imported-hof`)",
    `goal: ir-full-coverage`, `related: [3214, 3529, 5165, 3521]`, body = the
    diagnosis above, insertion point `select.ts:9377`, expected shape
    `capabilityNo("operand-coercion-unsupported", "expr-callable-equality", expr)`
    when either operand is callable-typed (that lane measures its
    `check:ir-fallbacks` bucket). It needs a **lead-assigned owner**:
    #5165/#3529 are closed, and `src/ir/select.ts` is listed by #3520
    (`files:` L50, codex) and #3522 (L39, opus-3522-f4). Add the id to this
    record's `related:` and mark it as the blocker on the 3214 line of
    `## Required completion evidence` (`:1056-1075`).

**F. Tests** — new `tests/issue-3521-r2-withdrawal-telemetry.test.ts`,
helpers from `tests/issue-3521-prepared-free-function-routing.test.ts:20-64`
(`outcome(result, name)`, `compileWithPoisonedDirectFunctionBodies`):

- (a) contract — `IR_R2_WITHDRAWAL_REASONS` has 20 members and each appears
  as a literal exactly once across `ir-prepared-free-functions.ts` and
  `index.ts` (no reason minted outside the recorder); `r2WithdrawalDefect` on
  hand-built rows (`issue-3520-outcome-correlation-identity.test.ts:336`
  style): one fixture per A3 case (i)–(iv), each → defect (reason on
  `(1,0,1)`, `(1,1,0)`, no triple and class-member rows separately),
  well-formed → `undefined`; `evaluateIrOnlyReport` fails each under BOTH
  policies (D's row rule; cf. `issue-3519-ir-only-gate.test.ts:243-264`); and
  `evaluateIrOnlyReport` on a `(1,1,1)`-without-reason fixture entry reports
  D's failure string (none on the well-formed twin).
- (b) behaviour, one shape per measured reason, asserting the full triple
  and `preparedComponentId === undefined`: `async` → `admission:async-declaration`;
  `object-param` → `param-signature-unstable`; `object-return` →
  `return-signature-unstable`; `string-length` under `{fast:true}` →
  `fast-signature-unproven`; `scalar-reads-const` →
  `fixed-point:storage-terminal-unprepared`; `callable-param` →
  `fixed-point:outside-caller-uncertified`; a top-level function beside an
  `addEventListener` void arrow (the `helpers.ts` shape) →
  `not-attempted:late-feature-preparation`; `compileMulti` two-file host
  graph → every `(1,1,1)` row `multi-source-driver`; `JS2WASM_IR_FIRST=0`
  single-source (the linked-parser suite's `:37` pattern) →
  `ir-first-disabled`; plus whatever P3 finds claimable.
- (c) neutrality — `(1,0,1)` (`scalar-add`) and `(1,1,0)` (`default-param`)
  rows carry no field; six-lane binary sha of `scalar-add`/`async` equal with
  `trackIrOutcomes` on and off.
- (d) source pins (read source text; import nothing new from `src/codegen/`)
  — the predicate table names the ten predicates in order, the fixed point
  the five edges in order, `deferUnsealedPreparedComponents` `unsealed-component`,
  `compileMultiPreparedProgramOverlays` `multi-source-driver`.
- (e) CI — `execFileSync("node", ["scripts/select-changed-issue-tests.mjs", "--pinned"])`
  lists the six; the script's source contains `ir\/[^/]*` (the changed mode
  needs a git base and is not test-driven).
- (f) `fnctor-producer` 21/21 is its own evidence.

Existing pins that move: none — every `(1,1,1)` row assertion under `tests/`
is `toMatchObject` (routing `:581/620/668`, linked-parser `:77-90`,
3520-correlation `:336-417`; no full-row `toEqual` exists — grep, measured).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — BEFORE byte matrix on the lane's own base**:
  `TREE=<base> OUT=<file> npx tsx .tmp/r2-plans/r2-t1g1/bytes-matrix.mts`
  — 302 cells (46 shapes × 6 lanes = 276, 13 corpus files × 2 `compileFiles`
  lanes = 26; sha256 prefix, success, error text, per-function triples).
  Record for `47e337f3b6`: `bytes-matrix-before.json`, 302/302 `success`.
  Expected on the candidate: 302/302 identical shas AND triples.
- **P2 — the real recorder equals the scratch instrumentation**: re-run
  `shape-census-instr.ts shapes|corpus` with `why` read from `o.r2Withdrawal`.
  Expected: the 57-row attribution above exactly; `compileFiles` 41/41
  `multi-source-driver`; `compile()` corpus `el`/`bcrd` = `late-feature-preparation`.
- **P3 — a claimable shape per unmeasured reason** (the 11 not in (b)):
  `generator-lane` (standalone `function*` the selector claims — the #2951
  route's own test shape; the census's `generator` is body-shape-rejected
  pre-claim), `poison-pill-read` (routing suite `:1149`),
  `allocated-slot-mismatch` (routing suite `:753` implicit-any case is
  `(1,1,1)` today — read its reason), and the rest. Reachability: only FUNCTION
  rows carry the triple (`ir-overlay-outcomes.ts:862-864`), so
  `fixed-point:class-atom` is reachable only through a field-callee function
  (`:1437`) withdrawn with its atom, and no class-member `(1,1,1)` row can
  exist until #3522 migrates member accounting — do not hunt for one.
  Expected: at least `generator-lane`, `allocated-slot-mismatch` and one
  callee edge get a (b) pin; each reason with no reachable shape is listed as
  "recorder present, unreached" with a (d) pin only — never dropped from the
  vocabulary to make the count fit.
- **P4 — gates see no `(1,1,1)` row**: `check:ir-only` both policies on the
  candidate. Expected `41/38/0/0/0/38/3` both lanes, READY, the new rule
  firing 0 times (live, not vacuous: V-C(1) and (6)).
- **P5 — cold-tail semantics**: confirm `fnctorColdTailStructName` is written
  only by `fnctor-cold-tail.ts:361` and `fnctorColdTailTypeIdx` only by
  `linear-type-reservations.ts:243`. Expected yes → item 11 is the whole fix;
  otherwise `:225` is the defect and this becomes a src change (report first).
- **P6 — `tests/ir/` baseline on the lane's base, one file per `vitest run`**
  (never the substring `tests/ir`). Expected 19 green, `fnctor-producer` 20/21,
  `counted-string-append-provenance` 13/29; a third red is reported, not absorbed.

### Verification matrix

- **V-A** byte/behaviour neutrality — P1's 302 cells identical (sha AND
  triples); `check:ir-fallbacks` and `check:ir-only --json` identical to a
  base run (the field must be ABSENT in the gate corpus);
  `tests/cross-backend-diff.test.ts` and `node scripts/equivalence-gate.mjs`
  (the record's Required completion commands, heavy — once on the candidate).
- **V-B** pins — the new suite in full; `fnctor-producer` 21/21; the six
  pinned files via `node scripts/select-changed-issue-tests.mjs --pinned | xargs pnpm exec vitest run --pool=forks --poolOptions.forks.singleFork=true`;
  routing suite 46/46; `linked-string-parser-abi` 4/4 (its `(1,1,1)` rows now
  carry `ir-first-disabled`); `3520-outcome-correlation-identity` 13/13; both `issue-3519-*` suites green.
- **V-C** non-vacuity reverts, each alone (counts unmeasured — record them):
  (1) B4 recorder returns an empty map → every (b) admission/fixed-point pin
  and the (a) `(1,1,1)`-without-reason blocker fail; (2) C7/C8 defaults → the
  two `not-attempted` pins and the linked-parser rows; (3) A3 validator → the
  (a) defect pins only; (4) item 11 → `fnctor-producer` 20/21; (5) item 10 →
  the (e) pins; (6) D's row rule → the (a) `evaluateIrOnlyReport` fixture pin.
- **V-D** gates — the five ratchets bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)` (`check-loc-budget`,
  `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
  `check:dead-exports`); `typecheck`, `lint`, `format:check`;
  `check:ir-dialect`, `check:ir-layering`, `check:ir-kind-neutrality` (the
  new literals are reasons, not kinds — no verdict moves), `check:ir-fallbacks`,
  `check:ir-only` both lanes; `equivalence-gate`; `check:test-vacuity-shapes`
  on the new suite. `check:dead-exports` (`audit-legacy-reachability.mjs
  --check`) graphs all of `src/` with every non-`src/codegen/` node as a root
  and no `tests/` (`:20-21`, `:39`, `:268`, `:424-430`): `src/ir/r2-withdrawal.ts`
  exports are roots and safe, but a NEW `src/codegen/` export consumed only by
  the pins would be flagged and bankable only via a forbidden baseline
  `--update` — hence B's "no new export" and (d)'s source-text pins.
- **LOC** — estimate **+150 net src** (unmeasured):
  `ir-prepared-free-functions.ts` +55 (`selectR2PreparedOwnerComponents` 206
  → ~261 lines, under `check-func-budget`'s `THRESHOLD = 300` at `:83`; the
  file is 2,027 lines, over the 1,500 god-file threshold — it, `outcomes.ts`,
  `ir-overlay-outcomes.ts`, `index.ts`, `context/types.ts` already carry #3521
  `loc-budget-allow` entries, `:27-45`), new `src/ir/r2-withdrawal.ts` +45 (`outcomes.ts` +0), `ir-overlay-outcomes.ts`
  +15, `index.ts` +20, `types.ts` +6, `check-ir-only.ts` +10, `select-changed-issue-tests.mjs` +12; tests ~+300.
  `TOTAL_HEADROOM = 75000` (`check-loc-budget.mjs:71`) needs no `total`
  grant. Add ONE dated `2026-09-02 R2-T1/G1` rationale under this file's
  `loc-budget-allow:` (wording: the #3526 file's dated blocks); **never edit
  `scripts/*-baseline.json`**; simulate CI's base with `LOC_GATE_BASE`.

### Out of scope

R2-F1 (28 `fast-signature-unproven` rows), R2-E1 (4 `outside-caller-uncertified`
rows), R2-S1 (8 `storage-terminal-unprepared` rows; #3523's module-init, PR
#5480 in flight), the late-feature routing that owns `el`/`bcrd` (R3), the
multi-source lane itself (R5/#3525 — this slice only LABELS its rows; its
file and `generateMultiModule`'s body are untouched), the #3214 selector fix
(item 12), the `counted-string-append-provenance` red (#3518, `0f42c1fde4`,
Codex — reported to that owner in the PR body; not pinned, not fixed),
promoting `issue-tests` to required, pinning the other 13 green `tests/ir`
files, any change to `select.ts`/`from-ast.ts`, and this record's stale
frontmatter (`pr: 5000`, `branch`, `assignee`, the absent test in `files:`).

### After this slice (ranked)

| rank | slice | why, now measurable |
| --- | --- | --- |
| **1** | R2-F1 fast mixed string/scalar admission (`:742`/`:802`/`:705`) | 28 `fast-signature-unproven` rows, 7 of them fast-hostStr shapes blocked by ONE non-string position; ratchet the bucket to 0 |
| **2** | the filed #5165-regression selector issue (item 12), once the lead names an owner | unblocks the record's Required completion evidence (`issue-3214`); then pin it |
| **3** | R2-E1 callable/extern outside-caller certification (`:856`, `:890`, `:1422`) | population is the 4 `callable-param` rows only — `el`/`bcrd` are NOT it (measured); Report A's accounting-tightening half must exempt `ir-first-disabled` rows, which the field now distinguishes |
| **4** | R2-S1 storage edge (after PR #5480 settles #3523 gap-6a) | 8 `storage-terminal-unprepared` rows |
| **5** | R2-v2 24-child run (quiet box, load < cores−2) | unchanged; the L3 rows it accepts are now `ir-first-disabled`; then pin the remaining 13 green `tests/ir` files after a second stable base run |
## 2026-09-02 R2-F1 implementation plan — fast-lane mixed string/scalar signature admission

Written by the Fable planning lane against `origin/main` `47e337f3b6` (merge of PR #5475), revised
after an independent critique. `origin/main` is now `33ea8606aa` (2026-09-02 13:15 UTC; merged today:
#5467 #5471 #5472 #5473 #5475 #5476 #5477 #5478 #5479 #5481); `git diff --stat 47e337f3b6
origin/main --` over the eight files anchored below (the two codegen files, `outcomes.ts`,
`ir-overlay-outcomes.ts`, `type-mapper.ts`, `check-ir-only.ts`, `ir-only-baseline.json`, the routing
test) is empty, so every line below holds on both shas; the census export tree
`.tmp/r2-census/wt-main` matches them for `ir-prepared-free-functions.ts` (`diff -q`).
`src/codegen/declarations.ts` moved twice (#5474, #5477) — no anchor here lives in it, deliberately. #5473 (F2-S6, merged 12:35 UTC, after both P0 runs) changed string lowering (`src/ir/integration.ts`, `src/ir/runtime-manifest.ts`, `src/codegen/native-batched-concat.ts`, `src/codegen/stdlib-selfhost.ts`), so the string-shape shas/bytes quoted below are `47e337f3b6` figures — P1 (re-run BEFORE/AFTER on the branch tip) is mandatory, not optional.
In flight on `loopdive/js2` (GitHub API, read 2026-09-02 13:15 UTC): **#5482** (F2-S8, `hold`, 20
files), **#5480** (gap-6a v2, `hold`, 4 files), #5063 (`hold`), and the codex fork PRs
#5400/#5397/#5393/**#5390**. Only **#5390** (typescript binder, 80 files,
base `7fffec534b` of 2026-09-01) edits a file anchored here — `src/codegen/index.ts`: +1 import at
`:374`, +7 in `generateModule`, +38 around `inheritedArrayElementType`, +16 inside
`resolveWasmType`'s array branch, +26 in `ensureStructForType`, +13 in
`inferLetConstInitializerWasmType` (`git diff -U0 7fffec534b <5390 head>`). None of its hunks
touches the `:4626` call, the `:5724` projection or the `:2920`/`:3049`/`:3116` flags by content,
but if it lands those five lines shift +1, `resolveWasmType` and its string arm ≈ +51, its `T[]` arm
≈ +67 — **re-anchor `index.ts` by content.** No open PR touches `ir-prepared-free-functions.ts`, the
routing test, `scripts/ir-only-baseline.json` or `scripts/check-ir-only.ts`. Claim: `node
scripts/claim-issue.mjs --check 3521` → `NO ACTIVE CLAIM … read origin/issue-assignments` (planner
11:42, critic 12:17 — `.tmp/r2-plans/r2-f1/claim-check-3521.out`, `r2-f1-critic/claim-check.out`).

**Sequencing.** Predecessor-stack on **R2-T1** (admission reject-reason telemetry) and, if
dispatched in the same window, **R2-G1** (tests/ir under CI): branch from R2-T1's REAL branch while
it is queued (never a `gh-readonly-queue/*` ref), `git merge origin/main` before enqueue, enqueue
only after it lands. If R2-G1 has not landed, report the evidence suite's two reds
(`issue-3214-imported-hof` 19/20, `ir/fnctor-producer` 20/21) as pre-existing. Two reasons for
stacking on R2-T1, in order:

- *The denominator.* R2-T1 turns every fast-lane `(1,1,1)` row this slice does NOT flip into a named
  withdrawal; the "what stays" list below must be re-checked against that telemetry before the
  checkpoint is signed.
- *The text overlap is not a one-line merge.* Attributing a reason requires R2-T1 to split the
  single `if (A || B || …) { continue; }` at `:1319-1341` into per-guard `continue`s. F1's edit is
  therefore **content-anchored**: "the third disjunct of the fast-arm predicate OR — wherever R2-T1
  places that guard". If R2-T1 lands the split first, the disjunct joins R2-T1's fast-arm guard (one
  reason for all three predicates, whatever name R2-T1 chose), and the two moved pins plus (c) also
  read that reason field where exposed. If R2-T1 is not dispatched, branch from `origin/main`,
  attribute the residual rows with the instrumented probe (P2), and edit `:1322-1323` as written.

### What moves and what does not (census, 288 + 252 cells)

The seam is the fast-mode arm of the admission chain in `selectR2PreparedOwnerComponents`
(`src/codegen/ir-prepared-free-functions.ts:1262`, closes `:1467`, 206 lines): `:1320-1324` is
`(input.ctx.fast && !(r2FastPreparedScalarFunctionSignature(...) ||
r2FastJsHostPassThroughStringSignature(...))) || …`, so in fast mode a candidate survives only if
one of the two landed predicates accepts it; anything else takes the bare `continue` at `:1341` and
lands on the post-direct overlay as `(1,1,1)`. Non-fast lanes never reach either predicate: they go
straight to `r2StableSignatureType` (`:364` — `string` `:368`, `vec` of f64/i32 `:386-389`, scalars
`:390-391`; callable `:379`, extern `:385`, opaque externref `:374`) and
`r2SignatureMatchesAllocatedSlot` (`:705`).

| # | site | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `ir-prepared-free-functions.ts:1320-1324`, the fast arm (content anchor: the `input.ctx.fast && !(… \|\| …)` disjunct of the `:1319` chain) | `input.ctx.fast` and the OR of the two landed predicates | **THE decision** — gains a third disjunct, `r2FastMixedFixedCarrierSignature` |
| 2 | `:742` `r2FastPreparedScalarFunctionSignature` (doc `:730-741`, the #3907 note) | `number`→`f64`, `boolean`→`i32`, `void`; then `:705` | **unchanged** — keeps the all-scalar family; pins test `:568`, `:718` |
| 3 | `:802` `r2FastJsHostPassThroughStringSignature` (doc `:795-801`; `exactJsHostLane` `:814`) | all-`string` annotations, constructed all-string override, then `:705` | **unchanged** — keeps all-string in the JS-host externref lane; pin test `:606` |
| 4 | `:705` `r2SignatureMatchesAllocatedSlot` (doc `:699-703`) | `ctx.programAbiSourceCallables.functionForUnit(unitId)` → `ctx.mod.types[func.typeIdx]`; projects the override through `r2StableValType` (`:665`), compares with `sameValType` (`:657`) | **the safety gate, unchanged** — the new predicate ends in it exactly as `:742`/`:802` do |
| 5 | `:665` `r2StableValType` — string arm `:674-677` (`!nativeStrings` → `externref`; else `ref $anyStr` iff `ctx.anyStrTypeIdx >= 0`, else `undefined`), vec arm `:678-682`, scalar tail `:683-684` | lane fields | **unchanged** — fixes the physical carrier per lane; the predicate mirrors, never replaces, it |
| 6 | fast subset `:78-110` of `computePreparedInheritedIrFirstSkipUnitIds` (`:50`; annotation-proven boolean only + callee closure) | `input.fast` | **not touched** — the inherited allowlist route; F1 is a pre-body admission |
| 7 | `:1325-1340` the rest of the chain (`isAsync`, generator lane, nested executable syntax, poison-pill read, direct-caller activation, function-value reads, `r2StableSignatureType` ×2, `:1339` slot parity) | — | **unchanged** — every guard still runs after the new disjunct admits |
| 8 | `:1366-1377` `outsideCallerCertifiedUnitIds` → `:890` `r2CertifiedAgainstOutsideCallers` → `:856` `r2CarrierFixedByDeclaration` | the admission-time override | **unchanged** — a newly admitted owner is already inside the #4514 carrier family; fixed point `:1378-1428` (withdrawal `:1424-1426`) unchanged |
| 9 | `src/codegen/index.ts:4626` the single production call (`:4640` `preparedStorageTerminalUnitIds`); `:5724` `irFirstSkipped = Object.freeze(projectedNames)` | — | unchanged; `irFirstSkipped` grows by the flipped names |
| 10 | `src/ir/outcomes.ts:272-274` counters; `src/codegen/ir-overlay-outcomes.ts:310-343` (#5313 triple validation; invariant arm `:339-343`) | — | unchanged — flipped rows validate through the existing `(1,0,1)` arm |
| 11 | the direct emitter's slot: `src/codegen/index.ts:12047` `resolveWasmType` — string `:12089-12090` (`ref $anyStr` when `nativeStrings`), `T[]` `:12213-12215` (`ref_null $vec`); `src/checker/type-mapper.ts:77-78` (`string` → `externref`), `:53-60` (#3907: `number` is f64 in every mode) | lane fields | **not touched** — the allocated slot the gate compares against |

**Census 1 — the record's 45-shape × 6-lane grid** (`.tmp/r2-census/shape-census.ts`, 48 function
rows per lane = 288 cells; driver copy re-pointed at the `47e337f3b6` export by
`.tmp/r2-plans/r2-f1/run-before-after.sh`, run as `npx tsx .tmp/r2-f1/shape-census-f1.ts shapes
before` from `wt-main`). Tallies (prepared / direct-fallback / post-direct-overlay): host 23/16/8,
**fast 13/19/15**, **fast-hostStr 16/18/13**, native/standalone/wasi 23/17/7.

**Census 2 — the mixed-signature probe** (`.tmp/r2-plans/r2-f1/f1-mixed-probe.ts`: 23 shapes × 9
lanes — the six above plus `fast-standalone`, `fast-wasi`, `fast-strict-hostStr` (= `fast +
nativeStrings:false + strictNoHostImports`, `:22`); 28 function rows per lane = 252 cells; per cell
route triple, `sha256`, bytes and a `buildImports` runtime call on JS-host lanes). BEFORE, the ten
target rows — `len(s: string): number`, `c(s: string): number` (charCodeAt), `t(n: number): string`
(template), `ns(n: number): string`, `eq(a: string, b: string): boolean`, `sum(xs: number[]):
number`, `range(n: number): number[]`, and the all-string `echo`/`greet`/`up` — are `(1,1,1)` in
`fast`, `fast-standalone` and `fast-wasi`; in `fast-hostStr` the seven non-all-string rows are
`(1,1,1)` and the three all-string rows are already `(1,0,1)` (#5379); all ten are `(1,0,1)` in the
four non-fast lanes. The new mixed shapes `longer(s: string, n: number): boolean`, `bs(b: boolean):
string`, `joinLen(xs: number[], s: string): number` and `anyTrue(xs: boolean[]): boolean` follow the
same pattern.

**P0 — the prototype, measured (the plan's load-bearing evidence).**
`.tmp/r2-plans/r2-f1/proto-patch.py` inserts the predicate below (+81/−1 = +80 lines) into the
untracked export only, asserting each anchor occurs once; `run-before-after.sh` re-runs both
censuses AFTER, then reverts and re-diffs against `origin/main` (`run.status`: `restored ipff ==
origin/main`). Run twice — planner 11:45–11:59 UTC, critic 12:19–12:33 UTC into
`.tmp/r2-plans/r2-f1-critic/` — all four stdout files `cmp`-identical (the critic's run overwrote
`r2-f1/*-{before,after}.{json,txt}` with byte-identical content; the `.stdout` copies are the
originals). Counts below re-derived by me from the JSON: `python3
.tmp/r2-plans/r2-f1-rev/analyze.py` (`analyze.out`).

- Census 1: **17 of 288 cells changed, 271 unchanged** — exactly the 10 `fast` + 7 `fast-hostStr`
  target rows, each `post-direct-overlay → prepared`, `success true→true`, `irFirstSkipped` gained
  the name. AFTER tallies: fast **23/19/5**, fast-hostStr **23/18/6**; host/native/standalone/wasi 4
  × 48 cells identical. **No cell became `(1,1,0)` or `(1,0,0)`.**
- Census 2: **75 route flips (all `(1,1,1)→(1,0,1)`), 0 sha-only changes, 177 cells fully identical,
  0 runtime mismatches.** By lane: `fast` 18, `fast-hostStr` 15, `fast-standalone` 18, `fast-wasi`
  18, `fast-strict-hostStr` 6 (the three vec shapes; its string cells fail on the base — finding
  (iii)); host/native/standalone/wasi 4 × 28 unchanged. Every non-target cell kept its BEFORE route,
  sha and runtime in all nine lanes.
- **Bytes.** 45 of the 75 flips are byte-identical (`sha` same) — every string shape: the prepared
  body equals the overlay body and the direct body left no residue. The other 30 are the three vec
  shapes × 2 functions × 5 fast lanes, deltas **0 … −191** (`fast` −191/−191/−9 for
  sum/anyTrue/range, `fast-hostStr` −94/−94/−9, `fast-standalone`/`fast-wasi` −170/−185/−9,
  `fast-strict-hostStr` 0/0/−9 — four cells change sha at equal length). The WAT diff of
  `vec-num-sum` in `fast-hostStr` (1427 → 1333 bytes, `wat-vecsum-fasthost-{base,proto}.wat`,
  `diff | wc -l` = 18, 12 changed lines) is exactly the direct body's dead residue — one func type, the
  import global `string_constants."Cannot access property on null or undefined at 1:90"`, `(tag
  $__exn)`, `(export "__exn_tag")` — plus the index renumbering of two types and two `env` imports;
  no function body differs.
- **Convergence.** AFTER, for every target shape `fast-hostStr` has the host lane's sha and `fast`
  the native lane's. For the **eight string shapes this already holds BEFORE** (`analyze.out`
  `STRING CONVERGENCE`); only the vec shapes converge *because of* F1 (`vec-num-sum` fast
  `5b64302a…`/23726 → `7895cfc0…`/23535 = native; fast-hostStr `dbae3506…`/1427 → `26c48e7a…`/1333 =
  host; likewise `vec-num-return`, `vec-bool-param`). The fast arm was the only route difference for
  these shapes; it was the only *byte* difference for the vec ones.

What stays `(1,1,1)` in `fast` AFTER (5 rows) and why: `object-param`, `object-return`,
`callable-param`, `destructured-param`, `async` — `(1,1,1)` in all six lanes BEFORE, so not fast-arm
residue; the reference / async family (R2-E1 / R7). `fast-hostStr` adds `vec-string-param`
(`first(xs: string[])`, `(1,1,1)` in host too; `resolve/abi-signature-parity` `(1,1,0)` in `fast`,
native, standalone, wasi). Once R2-T1 lands, each must carry its recorded reason (P2); until then
the attribution is the position-kind refusal / `isAsync` by construction. The remaining probe
controls (`str-void`, `num-str-str`, `any`/default/optional/generic/JSDoc-only/async mixed) are
`(1,1,0)` **select/build/resolve-stage** rejections in every lane — they never reach `:1319`; their
unchanged routes are neutrality evidence, not refusals.

Three base findings surfaced by the probes (out of scope, reported; all re-measured by me on
`origin/main` — `.tmp/r2-plans/r2-f1-rev/{base-findings,strict-lane-errors}.out`):

- (i) `async function af(s: string): Promise<number>` fails compile in host, fast, native and
  standalone with `IR async runtime attachment for af has no valid async plan owner` + the
  `body-emission-evidence` invariant, `success:false`; `asm(n: number): Promise<number>` is
  `(1,0,1)` (host/native/standalone) and `(1,1,1)` in fast (`isAsync`, `:1325`) — the string
  parameter is the trigger (R7 / #4104 territory).
- (ii) `rep(n: number, s: string): string { return s + n }` is `build/operand-coercion-unsupported`
  `(1,1,0)` everywhere, and in the native-string JS-host lanes (`fast`, `native`) its **direct**
  module fails `WebAssembly.compile` (`Compiling function #65:"rep" failed: return_call[1] expected
  type …`); fine in host/fast-hostStr — a direct-emitter bug, byte-identical before/after.
- (iii) **`fast + nativeStrings:false` outside the JS-host lane** (strict, `target:"standalone"`,
  `target:"wasi"`) is NOT a lane where string shapes fail wholesale: all-string pass-through shapes
  (`echo`, `up`) are `(1,1,1)` `success:true` in all three (standalone with a #2961 host-import-leak
  WARNING) — the routing test's `:636-638` entries pin exactly that. The **mixed** string shapes
  (`len`, `c`, `t`, `eq`, `greet`, `longer`, `bs`, `joinLen`) are
  `invariant/patch/body-emission-evidence` `success:false`: the direct body requests
  `string_constants.<name>` (refused under strict/wasi) or hits `stdlib-selfhost: __str_trimStart
  needs string.len but the compilation is not in native-strings mode` (standalone), and the #5313
  arm at `ir-overlay-outcomes.ts:339-343` classifies the failed direct body as an R2 invariant (`ns`
  is `select/primitive-method-unsupported` there; `any-mixed`/`jsdoc-only` are
  `invariant/build/unexpected-internal-throw` under strict-hostStr). The classification is R2's
  (#3521/#5313) and needs its own follow-up; the failure itself is the direct emitter's. F1's lane
  rule refuses these lanes, so every such cell is byte-identical before/after.

Conformance yield of this slice is zero by design; it moves ledger rows, and for vec shapes strips
dead residue.

### Design: one predicate for the declaration-fixed carrier family, disjoint from the two it sits beside

**Carriers, per lane.** The predicate chooses nothing; it asks whether the declaration fixes a
carrier and whether that carrier equals the allocated slot — the two string arms `r2StableValType`
already has (host-string `externref` under `nativeStrings:false` in the JS-host lane, the native
`$anyStr` struct wherever `nativeStrings` is on), and the interned `$vec` for
`number[]`/`boolean[]`:

| position | annotation | IR override | `r2StableValType` (`:665`) | direct slot (`resolveWasmType` `:12047`) | measured |
| --- | --- | --- | --- | --- | --- |
| number | `number` | `f64` (#3907) | `f64` | `f64` | flips |
| boolean | `boolean` | `i32` | `i32` | `i32` | flips |
| string, native lanes (`fast`, `fast-standalone`, `fast-wasi`; nativeStrings defaults ON) | `string` | `{kind:"string"}` | `ref $anyStr` (`:676`) | `ref $anyStr` (`index.ts:12089-12090`) | flips, bytes = native lane's (already BEFORE) |
| string, `fast-hostStr` (`nativeStrings:false`) | `string` | `{kind:"string"}` | `externref` (`:675`) | `externref` (`type-mapper.ts:77-78`) | flips, bytes = host lane's (already BEFORE) |
| string, `nativeStrings:false` + standalone/wasi/strict | `string` | — | `externref` with no host | pass-through shapes `(1,1,1)` `success:true`; mixed shapes hit finding (iii) on the base | refused by the lane rule; unchanged |
| number[] / boolean[] | `T[]` | `{kind:"vec", elementType, nullable}` | `ref_null $vec` (`:678-682`) | `ref_null $vec` (`index.ts:12213-12215`) | flips; bytes lose the direct residue |

**Why `r2SignatureMatchesAllocatedSlot` remains the safety gate.** The direct declaration pass has
already allocated the callable slot, and later direct callers/exports can target it while the body
is still empty (`:699-703`). A syntax predicate cannot see a `jsBodyArrayReturnOverride`, a
wrapper-string parameter, an `anyStrTypeIdx < 0` lane or a future carrier change; the gate re-proves
physical type equality AFTER the syntax proof, so a wrong admission fails closed to the direct route
— the failure #3907 made concrete. The new predicate ends in `:705` like `:742`/`:802`; `:1339`
still runs the general parity check too.

**Alternatives rejected:**

- *Widen `r2FastJsHostPassThroughStringSignature`.* Its doc (`:795-801`) and the 2026-09-01
  checkpoint scope it to the JS-host lane ("does not broaden general string admission"); its pins
  (test `:632-654`, `:656-677`) assert the native-lane exclusion. Rewriting it makes this slice's
  V-C revert a revert of #5379.
- *Delete the fast arm and fall through to `r2StableSignatureType`.* That admits
  `callable`/`extern`/opaque-externref (`:374`/`:379`/`:385`) in fast mode, where
  `dynamicRuntimeBuildable` and `supportsStringArrayLiterals` are `!ctx.fast` (`index.ts:3049`,
  `:3116`) and `dynMemberReadBuildable` is `!(ctx.fast && !ctx.standalone && !ctx.wasi)` (`:2920`).
  The five all-lane `(1,1,1)` shapes show that family is not fast-gate residue anyway.
- *A superset predicate covering the all-scalar and all-string shapes.* Overlapping disjuncts make
  each landed predicate's V-C revert vacuous; the new predicate refuses `:742`'s and `:802`'s shapes
  by construction — pairwise disjoint.
- *Admit `string[]`.* `vec-string-param` is `abi-signature-parity` direct in native/standalone/wasi
  and `(1,1,1)` in host — the non-fast lanes do not agree it is slot-stable; nothing for the fast
  arm to mirror. Out of scope.

### Contract

**A. `src/codegen/ir-prepared-free-functions.ts`**

1. New `function r2FastMixedFixedCarrierSignature(ctx, sourceFile, unitId, claim, override):
   boolean` directly after `r2FastJsHostPassThroughStringSignature`, before the `/**` at `:845` (its
   `(#4514) The narrow value vocabulary` text is `:846`). Exact prototype text:
   `.tmp/r2-plans/r2-f1/proto-patch.py` (`NEW_FN`). Declaration checks as `:802` (name equals
   `claim.legacyName`, top-level statement of `sourceFile`, has a body, no type parameters, no `*`,
   no `async`, `parameters.length === override.params.length`, every parameter an identifier with no
   `?`/`...`/initializer). Per position a syntax→carrier kind: `number`→`f64`, `boolean`→`i32`,
   `string`→`string`, `number[]`→`vec f64`, `boolean[]`→`vec i32` (`ts.isArrayTypeNode` + element
   keyword); anything else (JSDoc-only, inferred, `any`, union, `string[]`, object, callable) →
   `false`. Each kind must equal the IR override at that position (`asVal(...).kind`, `.kind ===
   "string"`, `vec` + element kind) — the parity `:742` performs; return `void` ⇒
   `override.returnType === null`, else the same check.
2. String positions admitted only where the lane fixes a carrier: `ctx.nativeStrings ?
   ctx.anyStrTypeIdx >= 0 : !ctx.standalone && !ctx.wasi && !ctx.strictNoHostImports` (first arm
   mirrors `:676`; second is `:814`'s `exactJsHostLane`). A deliberate duplicate of `:665`'s facts
   (the `:730-741` rule: narrow declaration checks, not a widened vocabulary).
3. Disjointness: refuse when every kind is scalar (`:742`'s shape) and when every position is
   `string` AND `!ctx.nativeStrings` (`:802`'s shape); all-string with native strings IS this
   predicate's (`echo`/`greet`/`up` in the three native fast lanes). Unobservable through the OR
   (P3) — kept for the V-C independence of the two landed predicates, not for a pin.
4. Terminal gate: `return r2SignatureMatchesAllocatedSlot(ctx, unitId, override);` with the real
   override (no constructed one — it already carries the kinds compared above).
5. Chain: the fast-arm OR gains `|| r2FastMixedFixedCarrierSignature(input.ctx, input.sourceFile,
   unitId, claim, override)` (`:1322-1323` on this sha; content-anchored per Sequencing). Nothing
   else in `:1319-1341` changes; the `continue` stays bare (R2-T1's).
6. Doc comment: the family, the two disjointness refusals, the string lane rule, and that
   `string[]`/references stay on their existing routes.

**B. `src/codegen/index.ts`** — no change (`:4626` call, `:5724` projection).

**C. `scripts/ir-only-baseline.json`** — no change expected: `check:ir-only` compiles its corpus in
`defaultCompileSeedEntry` (`scripts/check-ir-only.ts:131-132`, no `fast`) and
`standaloneCompileSeedEntry` (`:134-135`) only, so the fast arm never runs there; both lanes stay
41/38/0/0/0/38/3. A moving lane means the mechanism is wrong — stop. Never hand-edit; a real
ratchet-down goes through `pnpm run check:ir-only -- --policy=hybrid --update` (`:478-479`).

**D. `plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md`** — the checkpoint note
(P-probe answers, AFTER grids, counts, the three base findings) and the frontmatter
`loc-budget-allow` entry for `src/codegen/ir-prepared-free-functions.ts` restated with a dated R2-F1
rationale comment (see LOC).

**E. Existing pins to move (each named; all three green on `origin/main` — `node
node_modules/vitest/dist/cli.js run tests/issue-3521-prepared-free-function-routing.test.ts -t
"excluded lane|unpoisoned fast native-string|fast JS-host string pass-through"`, 3 passed / 43
skipped, `.tmp/r2-plans/r2-f1-rev/routing-pins.out`):**

- `tests/issue-3521-prepared-free-function-routing.test.ts:632-654` "keeps fast string pass-through
  signatures direct in every excluded lane": the `["nativeStrings", { nativeStrings: true }]` entry
  (`:635`) asserts the poison fires for `echo` under fast native strings — after F1 it must not.
  Remove that entry; the other three (`:636-638`, all `nativeStrings:false` — standalone, wasi,
  strict) stay and still refuse (finding (iii): `echo` is `(1,1,1)` `success:true` in all three on
  the base; the lane rule keeps it there).
- `:656-677` "accounts an unpoisoned fast native-string pass-through as direct with no prepared
  owner": the exact inverse of the flip; rewrite to expect `irFirstSkipped` ∋ `echo`, `(1,0,1)`,
  `preparedComponentId`, under poison. Its former assertion moves to the new suite's `string[]`
  control.
- No other suite pins a fast-lane route for an annotation-fixed mixed signature: `grep -rl 'fast:
  true' tests --include='*.test.ts'` = 70 files (66 directly under `tests/`); only the routing
  suite, `issue-2856-async-delay-ir` (`:355`; async `delay`, refused by `isAsync`),
  `issue-2949-slice2-dynamic-producers` (`:305-307`; untyped `f(x)`, refused at the position kind)
  and `issue-4589-multi-prepared-scalar-leaf` (`compileMulti`, never reaches `:4626`) mention
  `irFirstSkipped`. The behaviour suites named under V-A carry 0 routing assertions — evidence, not
  pins to move.

**F. Tests.** New `tests/issue-3521-fast-mixed-signature-admission.test.ts` (anatomy from the
`:606-716` block; helpers `compileWithPoisonedDirectFunctionBodies` `:51`, `outcome`,
`instantiate`):

- (a) contract — the ten target shapes plus `str-num-bool`, `bool-str`, `vec-str-num`, in `fast` and
  `fast + nativeStrings:false`, direct body poisoned: `success`, `irFirstSkipped` ∋ name, `(1, 0,
  1)`, `legacyBodyEmitted:false`, `irBodyEmitted:true`, `preparedComponentId`
  `/^prepared-component:/`; runtime oracle through `instantiate` on the externref lane (`len("abc")`
  = 3, `c("a")` = 97, `t(1)` = `"n=1"`, `ns(1)` = `"1"`, `eq("a","a")` = 1, `longer("abc", 2)` = 1,
  `bs(1)` = `"y"`, `main()` = 6 / 3 / 5 through a scalar wrapper for the vec shapes — JS cannot pass
  a `$vec`); on the native lane call only scalar-in/out exports, pin the rest by outcome.
- (b) byte convergence — **vec shapes only** (`vec-num-sum`, `vec-num-return`, `vec-bool-param`):
  the fast-hostStr binary sha equals the host lane's, the fast binary sha equals the native lane's.
  The string shapes converge BEFORE F1 (P0), so a string pin here cannot detect the disjunct revert;
  string convergence is recorded under V-A as "unchanged by design".
- (c) refusals that actually reach the fast arm and stay refused, each `directBodyEmissions:1`,
  poison firing, route equal to the BEFORE grid: `string[]` via `first(xs: string[]): string` in
  `fast + nativeStrings:false` (`(1,1,1)`, the residual row) and in `fast`
  (`resolve/abi-signature-parity` `(1,1,0)`). Plus two route-equality cells that never reach `:1319`
  (`any` position, defaulted mixed parameter — select-stage `(1,1,0)`), labelled neutrality, not
  refusal evidence. Do NOT put a mixed string shape in any `fast + nativeStrings:false` non-host
  lane — it fails on the base (finding (iii)) and the failure would be blamed on F1; the lane rule's
  non-vacuity is addressed under V-C, not by a pin.
- (d) the route-off control (`experimentalIR:false`, poison fires) for one mixed shape, mirroring
  `:595-604`.
- (e) a mixed component: `function len(s: string): number` called by `function flag(b: boolean):
  number { return len("ab") + (b ? 1 : 0); }`, both poisoned, both `(1,0,1)` in one
  `preparedComponentId` (the `:718-751` shape with a string leaf).
- (f) vec residue — `vec-num-sum` in `fast-hostStr`: no `string_constants` import, no `__exn_tag`
  export, and the `main()` oracle; the BEFORE module had both (the P0 WAT diff), so this pins that
  the residue is gone, not merely moved.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P0 — done above**; re-cite
  `.tmp/r2-plans/r2-f1/{run.status,shape-census-{before,after}.stdout,f1-mixed-{before,after}.stdout,wat-diff-commands.sh}`,
  the critic's `r2-f1-critic/` twins, and `r2-f1-rev/analyze.out`.
- **P1 — the BEFORE grids on the lane's own base, uninstrumented.** Run `shape-census-f1.ts` and
  `f1-mixed-probe.ts` from the branch tip (re-point `ROOT`/`OUT`); expected identical to the two
  `-before` files (any difference is a finding about the base — report, do not absorb). Then AFTER
  on the branch: expected the 17 + 75 flips and nothing else; record the vec sha convergence table
  (b).
- **P2 — what stays, attributed.** With R2-T1's telemetry (or a temporary `process.stderr.write` at
  each `continue` of `:1319-1341` and at the `:1424-1426` withdrawal), name the withdrawal site for
  every fast-lane `(1,1,1)` row left AFTER: expected
  `object-param`/`object-return`/`callable-param`/`vec-string-param` at the position kind,
  `destructured-param` at `ts.isIdentifier(parameter.name)`, `async` at `isAsync` (`:1325`). A row
  attributed to `:1339`/`:705` is a carrier mismatch the table above did not predict — stop and
  report.
- **P3 — non-vacuity of the disjointness refusals.** Drop item 3 in a scratch copy: both grids must
  be identical (the OR makes the overlap unobservable); record 0 changed cells. That is why
  disjointness is proven by V-C reverts of the *other* predicates, not by a pin.
- **P4 — `boolean[]`.** Answered by P0 (`vec-bool-param` flips, `main()` = 1, bytes lose the same
  residue). If P1 disagrees on the branch, drop `boolean[]` and say so. In the native-strings strict
  lane (`fast + strictNoHostImports`, not among the nine) `anyTrue` is `select/body-shape-rejected`
  `(1,1,0)` before and after, while `sum`/`range`/`echo` flip there (−149 / −9 / sha-same; critic's
  `strict-native-vec-{before,after}.txt`, BEFORE re-run by me as
  `r2-f1-rev/strict-native-vec-before.txt`) — a select-stage base fact; that lane is neither a
  refusal lane nor a control lane.

### Verification matrix

- **V-A** byte/behaviour neutrality — Census 1: 271/288 cells identical in route, triple, `success`;
  Census 2: every non-flipped cell identical in sha/bytes/runtime (177), the 45 string flips
  byte-identical (the eight string shapes' fast/native and fast-hostStr/host sha equality holds
  BEFORE and AFTER — unchanged by design), the 30 vec flips explained by the residue diff; `diff`
  the vec WAT against the base and attach it — anything beyond a removed type/import/tag/export and
  index renumbering is a stop; `check:ir-fallbacks` unchanged (its corpus is non-fast: `grep -c fast
  scripts/check-ir-fallbacks.ts` = 0); behaviour suites `issue-3907-cross-lane-number-equality`,
  `issue-3912-fast-number-stringify`, `issue-3912-native-string-lanes`, `fast-arrays`,
  `i32-fast-mode`, `native-strings{,-roundtrip,-standalone}` green.
- **V-B** pins — the new suite; the two moved pins; the routing suite green under
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks --poolOptions.forks.singleFork=true` (46 cases
  on this sha); `tests/issue-3520-outcome-correlation-identity.test.ts` 13/13 unchanged.
- **V-C** non-vacuity reverts, each independent against the kept tests (counts unmeasured — record
  them): remove the third disjunct → every (a) pin (expect 13 shapes × 2 lanes), the vec (b) pins,
  (e), (f) and the two moved pins fail; the string-convergence fact under V-A does NOT move (it
  holds BEFORE — that is why it is not a pin). Restore the `:635` entry → that entry fails alone.
  Drop the lane rule (item 2) → **no kept pin fails on this corpus**: its second arm only affects
  cells that fail on the base (finding (iii)) — record what those cells do without it (unmeasured;
  expected a different failure or a flip into a lane with no string carrier); its first arm
  (`anyStrTypeIdx >= 0`) is expected vacuous because a string-typed declaration has registered
  `$anyStr` by allocation time (unmeasured). Say so; do not invent a pin. Drop the terminal `:705`
  call → **no pin fails on this corpus** (expected — every slot matched in P0); record it and say
  the gate's non-vacuity is #3907's history plus the `implicit-any` pin at `:753-780`.
- **V-D** gates — `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node
  scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s
  check:dead-exports` bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)` (and once more
  against the R2-T1 branch tip while stacked); `pnpm run typecheck`, `pnpm run lint`, `pnpm run
  format:check`; `pnpm run check:ir-dialect`, `check:ir-layering`, `check:ir-kind-neutrality`,
  `check:ir-fallbacks -- --verbose`; `pnpm run check:ir-only -- --policy=hybrid` and `--
  --policy=ir-only --json` (both lanes 41/38/0/0/0/38/3, unchanged); `check:test-vacuity-shapes`
  (globs `tests/**/*.ts`, so the new suite is in scope); `check:host-import-policy` (no new import);
  `node scripts/equivalence-gate.mjs` (three `tests/equivalence/` files use `fast: true`); `pnpm run
  check:r2-v2-collector`.
- **LOC** — the prototype is **+80 lines** (+81/−1) on `ir-prepared-free-functions.ts`, which sits
  exactly at its ceiling (`scripts/loc-budget-baseline.json:51` = 2027 = `wc -l`), so the grant is
  required for +1. Estimate **+85 net src LOC** (predicate + doc + one chain line; unmeasured beyond
  the prototype). The #3521 frontmatter already lists the file under `loc-budget-allow`; grants are
  read from the `plan/issues` files the change-set touches (`scripts/lib/change-scope.mjs:188`), so
  restate it with a dated `# 2026-09-02 R2-F1 …` YAML comment in the same list (wording template:
  `plan/issues/1058-compile-the-typescript-compiler-itself.md:16`).
  `selectR2PreparedOwnerComponents` is 206 lines (`:1262-1467`) vs the 300-line threshold
  (`check-func-budget.mjs:83`), +1 here. **Never edit `scripts/*-baseline.json`.**

### Out of scope

`string[]` and every reference carrier in fast mode (`object-param`, `object-return`,
`callable-param`, `destructured-param` — `(1,1,1)` in all six lanes; R2-E1 once R2-T1 sizes it);
`async` (R7; and finding (i)); findings (ii) (direct emitter) and (iii) (the #5313 classification of
a failed direct body — its own R2 follow-up); the inherited boolean allowlist `:78-110` and the
`disableIrFirst`/`JS2WASM_IR_FIRST` hatches (Commit 3 / R9); top-level `let`/`const` readers
(`body-shape-rejected` at select in both fast lanes — the
#4508 storage edge, R2-S1, is not reached); `compileFiles`/`compileMulti`/`compileProject`
(R5/#3525, claimed by codex); class members (#3522); any change to `r2StableValType`,
`r2SignatureMatchesAllocatedSlot`, `resolveWasmType`, `type-mapper.ts`; the `(1,1,1)` accounting arm
(`ir-overlay-outcomes.ts:320-328`); telemetry (R2-T1).

### After this slice (ranked)

| rank | boundary | why |
| --- | --- | --- |
| **next** | R2-E1 extern/reference-carrier certification | the 5 all-lane `(1,1,1)` shapes + Acorn inline 18/42 are the largest single-source residue; needs R2-T1's attribution first |
| next | finding (iii): a failed direct body classified as an R2 invariant | 8 mixed string shapes × 3 `fast + nativeStrings:false` non-host lanes are `success:false` on main today with an R2-named cause; decide whether #5313's `:339-343` arm or the direct emitter owns it |
| next | the direct body's dead residue on `(1,1,1)` rows generally | P0 showed a `(1,1,1)` vec row ships a dead `string_constants` global, an `__exn` tag and an `__exn_tag` export; every remaining overlay row likely does — a byte-size and import-surface question for the ledger, sized by R2-T1 |
| later | fast-lane `string[]` (`vec-string-param`) | requires the non-fast lanes to agree first (host `(1,1,1)`, others `abi-signature-parity`) — a slot-shape question, not a fast-arm one |
| later | retire the fast arm (`:1320-1324` → fall through to `r2StableSignatureType`) | only once fast mode's reference family (`index.ts:2920/:3049/:3116`) is buildable; the three fast predicates then collapse |
