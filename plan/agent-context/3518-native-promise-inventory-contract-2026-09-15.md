# Native Promise inventory: bounded Low A contract

Specification only. The contract below preserves the exact final Low A response;
the connection amendment afterward refines its implementation boundary before
dispatch. No implementation, claim, commit, or publication is authorized by this
document. Parent owns integration; PR5748 integration and Volta's PR5753
composition remain outside Low A.

## Exact reviewed Low A contract

Low A can be dispatched now as **source/recipe accounting, overlap correction, and validation infrastructure**. It cannot honestly certify a complete executable inventory before B/C and the native frame/boundary producers supply their missing evidence.

The important correction is to separate **population accounting**, **reservation binding**, and **execution completion**. None implies the next.

Grounding remains `8c9b65b389194c8c8fc3e857e4b7316b0ae524e1`. The only worktree change is the parent’s untracked takeover specification. No edits, tests, claims, or external operations were performed.

1. Existing interfaces constrain the design

The current [recipe schema](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/runtime/wasmgc/values/native-resource-declaration-types.ts) supplies `declarations` and `reservationSteps`. A declaration’s `role: string[]` is descriptive; it does **not** authenticate a callable, accessor, allocation site, or completeness claim.

The [ledger](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/wasm/physical/module-reservations.ts) already supplies:

- `assertTypeReservation` during `reserving`;
- `physicalIndex` during `filling`/`sealed`;
- `assertCompletedReservation` for defined functions/globals;
- exact object/descriptor/currentness checks and whole-module sealing.

It does **not** expose a complete reservation-token enumeration or establish which source/resource producer should have supplied a reservation. A must not invent either capability.

The [current Promise inventory](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/backend/wasmgc/resources/native-promises.ts:242) conflates population with exclusive classification. Its only production consumer is `fillNativePromiseResources`; repository search found no other production users of `requiredCarriers` or `inventory.carriers`.

2. Freeze three distinct evidence layers

Use these responsibilities:

- **Source census:** complete borrowed prepared evidence, independent of which physical producers are implemented.
- **Symbolic population plan:** every expected carrier, its owning declaration/source association, ordered lookup facts, and construction obligations. This is complete only when the parent has closed the selected producer graph.
- **Bound inventory:** that exact plan reconciled with issued same-ledger resources. Binding permits body construction; execution completion additionally requires canonical dependency fills and emitted-allocation reconciliation.

Do not add these records to the prepared-program codec or to `NativeResourceRecipe`. They are planning/validation sidecars tied to the current program and transaction.

3. Concrete symbolic contract

The following are proposed types. Imported names refer to existing repository types; `PhysicalResourceKey` remains the existing string key type.

```ts
type CarrierKey = PhysicalResourceKey;

type CarrierEvidence =
  | { readonly kind: "source-occurrence"; readonly occurrence: number }
  | { readonly kind: "allocation"; readonly slot: AllocSiteId }
  | { readonly kind: "abi"; readonly bindingId: IrBindingId }
  | {
      readonly kind: "recipe";
      readonly producer: number;
      readonly declaration: number;
    };

interface CarrierRow {
  readonly key: CarrierKey;
  readonly declaration: Extract<
    NativeStringValueDeclaration,
    { readonly space: "type" }
  >;
  readonly evidence: readonly CarrierEvidence[];
}

interface ThenMethodFact {
  readonly carrier: CarrierKey;
  readonly target: IrFuncRef;
  readonly evidence: CarrierEvidence;
}

interface ThenAccessorFact {
  readonly carrier: CarrierKey;
  readonly getterGlobalKey: PhysicalResourceKey;
  readonly evidence: CarrierEvidence;
}

interface ThenFieldFact {
  readonly carrier: CarrierKey;
  readonly fieldIndex: number;
  readonly evidence: CarrierEvidence;
}

interface CallableRootFact {
  readonly carrier: CarrierKey;
  readonly registrations: readonly {
    readonly producer: number;
    readonly requestId: string;
  }[];
}

interface PromiseLookupFacts {
  readonly methods: readonly ThenMethodFact[];
  readonly accessors: readonly ThenAccessorFact[];
  readonly fields: readonly ThenFieldFact[];
  readonly callableRoots: readonly CallableRootFact[];
}
```

`CarrierRow` covers **both struct and array declarations**. The classifier uses structs; arrays remain accounted resources and must not disappear from the census.

Every carrier must also have an explicit lookup disposition:

```ts
type LookupDisposition =
  | { readonly kind: "facts" }
  | { readonly kind: "open-object" }
  | { readonly kind: "non-object-array" }
  | {
      readonly kind: "no-then-arm";
      readonly reason:
        | "compiler-private"
        | "primitive-carrier"
        | "string-carrier"
        | "vector-carrier"
        | "error-carrier"
        | "closure-without-then-member";
      readonly evidence: readonly CarrierEvidence[];
    };
```

These reasons are **outputs of fixed producer adapters**, never caller permissions. An unknown shape or unavailable adapter yields an unresolved obligation; it cannot choose `compiler-private`.

For construction accounting:

```ts
type ConstructionOp =
  | "struct.new"
  | "array.new"
  | "array.new_fixed"
  | "array.new_default";

interface ConstructionRoot {
  readonly space: "function" | "global";
  readonly key: PhysicalResourceKey;
}

interface ConstructionExpectation {
  readonly root: ConstructionRoot;
  readonly allocations: readonly {
    readonly op: ConstructionOp;
    readonly carrier: CarrierKey;
  }[];
}
```

The allocation list records **static instruction occurrences in canonical traversal order**, not runtime execution counts. An explicit empty list means that the producer examined that body/initializer and expects no GC construction there.

A producer must account for every owned function/global root, including empty ones. Types with no construction site remain in the population: closure roots, supertypes, and reserved unused carrier types are not removed because no `struct.new` was observed.

For source evidence, reuse `NativeStringValueDemands` as the existing complete program/projection buffer census, despite its historical name. Extend the new census alongside it with:

- `irRuntimeSupportFunctions(program.runtimeSupport)`, separately counted;
- all ABI entries, including callable/global/type/class contracts;
- the entire allocation snapshot, including aliases, retired entries, metadata presence, and unused rows;
- typed source evidence paths into parameters, results, block arguments, instructions, async values/layouts, closure captures/subtypes, class shapes and parent shapes.

A source evidence path is a locator into a borrowed authenticated object, not an independently trusted copy.

4. Owner-derived expected population

The parent’s checked composition owns the expected producer roster. A supplied list of recipes must never be able to certify itself as complete.

The roster is derived from the selected program, manifest/configuration, and resource requirements, then closed over producer dependencies. It must cover:

- prepared units and separate formatter support;
- vectors and argument vectors;
- strings, values, errors, formatting/output;
- closures and their ordered registration requests;
- Promise resources;
- selected delay/combinator resources;
- native frames;
- object access and invocation;
- required observation/publication helpers.

The closure algorithm terminates only when every demanded producer and dependency has an authenticated contribution. Unknown producer kinds, missing contributions, or unknown allocation-producing operations remain explicit gaps.

Each contribution must be recomputed by its owner from its actual requirements. Do **not** introduce a public `registerProducer`, `certifyComplete`, arbitrary validator callback, or `complete: true` escape hatch.

Existing adapters must use actual APIs:

- Promise: `nativePromiseReservationInventory` and `assertNativePromiseResourcePlanFor`.
- Closures: `nativeClosureReservationInventory`; its complete-population check must succeed.
- Delay/combinator: checked source wrapper plus `nativeDelayCombinatorReservationInventory`.
- String/value aggregate: `nativeStringValueReservationInventory`, then its completion API at the completion phase.
- Argument vectors: their existing declaration/reservation inventory.
- Other producers: use their actual owner checks, or report that the required owner query is unavailable.

`NativeResourceRecipe.role` and a matching descriptor are insufficient substitutes.

Shared resources have **one owning declaration and multiple borrowing associations**. Duplicate ownership is an error; repeated closure request/cache observations legitimately refer to the same wrapper token and must remain recorded.

Source-to-physical mapping is also required. Source object fields/class methods do not by themselves supply the final field index, getter global, closure subtype, or callable implementation. Missing mapping becomes `source-carrier-association` or `dispatch-evidence` unavailable.

In particular, current preparation does not generally transport the legacy `structAccessorClosure` registry. A may not reconstruct its getter globals from property names or signatures.

5. Exact replacement consumed by Promise fill

Keep the public name `NativePromiseInventory`, but make it an issued wrapper with runtime identity authentication. Its data shape becomes:

```ts
interface NativePromiseInventory {
  readonly owners: readonly NativePromiseOwner[];
  readonly selectedOwners: readonly NativePromiseOwner[];
  readonly derivedUnits: NativePromiseResourcePlan["derivedUnits"];

  readonly population: readonly TypeReservation[];

  readonly methods: readonly {
    readonly type: TypeReservation;
    readonly target: FunctionReservation;
  }[];

  readonly accessors: readonly {
    readonly type: TypeReservation;
    readonly getterGlobal: GlobalReservation;
  }[];

  readonly fields: readonly {
    readonly type: TypeReservation;
    readonly fieldIndex: number;
  }[];

  readonly callableRoots: readonly TypeReservation[];

  readonly anyValue: {
    readonly type: TypeReservation;
    readonly tag: 0;
    readonly ref: 3;
    readonly extern: 4;
  };

  readonly openObject: {
    readonly type: TypeReservation;
    readonly get: FunctionReservation;
  };

  readonly accessorGet: FunctionReservation;
}
```

The standalone native inventory requires **defined native functions**, not arbitrary imports with matching signatures.

Use a module-private `WeakMap` to retain the exact plan, program/projection, transaction, producer witnesses, token associations, and content snapshots. A TypeScript brand alone is insufficient. No structural clone may pass.

The existing fill’s values/resolution/configuration fields stay intact. Replace only inventory checking and conversion into the canonical `PromiseThenableInventory`.

For method facts, verify that the invocation producer’s vararg-`then` coverage contains the same ordered carrier/target associations. A type test returning callable without a corresponding dispatcher arm is invalid.

6. Overlap and fallback rules

Population uniqueness and lookup ordering are different invariants.

- `population` contains each actual type token once.
- A type may occur in both `accessors` and `fields`.
- Reject duplicates within each fact list and contradictory globals/field positions.
- Keep owner-derived order within each category; do not sort by name, key, or physical index.
- Method facts win. Retain underlying field evidence in accounting, but omit method-shadowed field arms from the executable field list, matching `collectFieldEntries`.
- Getter globals must have the actual externref layout and authenticated initialization/definition-site ownership.
- A runtime-null getter global **falls through** to the field/open-object checks.
- A present getter returning a noncallable value returns a noncallable verdict; it does **not** fall through to the stored field.
- A throwing getter throws out of lookup for resolution to handle.
- Returned callable values remain captured exactly as the existing builder implements.

Do not change [thenable-bodies.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/runtime/wasmgc/promise/thenable-bodies.ts) to implement the overlap correction. It already supports separate accessor and field arrays.

Callable roots come from the full registration history and actual ancestry. Preserve first-seen order and cached request associations. One-shot/DOM exclusions require evidence over all relevant allocations; a single excluded-looking request cannot exclude a shared root.

7. Freeze these operations and phase rules

Proposed source-side API:

```ts
collectNativePromiseSourceCensus(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  options: PreparedIrBackendOptions,
  configuration: NativePromiseConfiguration,
): NativePromiseSourceCensus;

assertNativePromiseSourceCensusCurrent(
  census: NativePromiseSourceCensus,
): void;
```

The collector invokes existing whole-program/selected-projection authentication and derives the Promise requirements itself. It must not accept caller-supplied replacement owners.

Proposed reconciliation API:

```ts
compareNativePromisePopulation(
  expected: NativePromisePopulationDescription,
  observed: NativePromisePopulationDescription,
): void;
```

This is explicitly **descriptive validation**, not issuance. `NativePromisePopulationDescription` contains the carrier rows, dispositions, lookup facts, construction expectations, and complete producer roster described above.

Proposed checked backend API:

```ts
bindNativePromiseInventory(
  tx: PhysicalModuleReservations,
  plan: NativePromiseInventoryPlan,
): NativePromiseInventory;

assertNativePromiseInventoryCurrent(
  tx: PhysicalModuleReservations,
  inventory: NativePromiseInventory,
  expected: NativePromiseResourcePlan,
): void;

assertNativePromiseInventoryEmission(
  tx: PhysicalModuleReservations,
  inventory: NativePromiseInventory,
): void;
```

`NativePromiseInventoryPlan` is an opaque **parent-issued complete composition witness**, not an alias for the descriptive structure. Its private record retains the exact module storage, complete resource associations, and producer evidence. There is no public raw-description constructor.

The parent issuance operation belongs in the future native async aggregate. It rederives the roster and contributions before issuing this witness. **Low A does not implement an issuer that pretends unavailable B/C contributions exist.**

Phase sequence:

1. **Before allocation:** collect source census and reconcile symbolic descriptions. Missing producer/mapping/construction evidence returns unavailable; malformed or contradictory evidence throws an invariant error.
2. **Reserving:** producers reserve normally. Inventory diagnostics may inspect authenticated type tokens. Do not call `physicalIndex` here. The ledger has no general reserve-phase callable/global authentication API.
3. **After all reservations:** parent freezes once. Complete closure inventory is mandatory; a settlement prefix is insufficient.
4. **Filling:** bind the issued plan. Authenticate every token using `physicalIndex`, actual signatures, layouts, and owner queries. Emit stable function handles into instructions.
5. **Before Promise fill:** recheck source/plan/token currentness. Dependencies may still await filling because the dependency group is recursive.
6. **After all dependency fills:** run canonical producer completion checks, ledger completion checks, and emitted construction reconciliation.
7. **Before final module seal/emission:** repeat currentness and whole-module coverage checks. The parent’s acceptance-token lifecycle remains authoritative.

Do not require all mutually recursive dependency bodies to be complete before any body can be filled. Conversely, successful binding cannot be reported as executable completion.

8. Emitted accounting is an independent final check

Read actual module functions and global initializers, not a caller-filtered list. Match every root to the parent’s complete ownership map; reject unowned or omitted roots.

Use the canonical Wasm child walker with dense-array and active-path cycle checks:

- preserve repeated occurrences in shared sibling arrays;
- do not use DAG deduplication for occurrence counts;
- inspect nested blocks, branches, catches, and `catchAll`;
- compare ordered construction sequences against producer expectations;
- authenticate completed roots with `assertCompletedReservation`.

The current instruction union has `struct.new` and the three array constructors listed above. Future allocation opcodes require explicit handling; unknown cases cannot disappear silently.

Use `indexPhysicalTypes` for actual flat type coordinates. A must not treat an outer `rec` record index as a carrier index. A bounded implementation may report unsupported composite-token mapping; it must not manufacture member tokens.

Declared population and emitted construction population need not have equal sizes. Missing expected constructions, extra constructions, and wrong target types are errors; legitimately unconstructed parent types remain accounted.

9. Bounded Low A write scope

Proposed new files:

- [IR program directory](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/ir/program): `native-promise-inventory.ts` — source census, symbolic types, descriptive reconciliation.
- [Backend resource directory](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/backend/wasmgc/resources): `native-promise-inventory.ts` — issued-plan/inventory identity checks, token binding, construction audit, current-producer observations.
- [Tests directory](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/tests): `issue-3518-native-promise-inventory.test.ts` and `issue-3518-native-promise-inventory-emission.test.ts`.

Existing modifications:

- [native-promises.ts](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/src/backend/wasmgc/resources/native-promises.ts): inventory shape/checking and projection into existing builders.
- [native Promise resource tests](/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree/tests/issue-3518-native-promise-resources.test.ts): preserve existing negative intentions and add corrected-contract controls.

No A edits to ledger, recipe schema, codec, consumer, physical planner, canonical resolution/thenable bodies, or legacy donors. No overlap with the parent’s PR5748 work or Volta’s PR5753 composition.

The parent aggregate’s complete-plan issuer and B/C owner contribution adapters remain separately assigned integration work.

10. Required controls and honest completion boundary

A’s tests must include:

- Real unchanged family preparation, original/decoded and GVN off/on; preserve **7/5/16** and **16/33**, and separately enumerate formatter support.
- Missing/reordered/duplicated/empty owners; omitted selected runtime-state or support buffers; shared buffers; sparse arrays; cyclic buffers.
- Allocation aliases, retired sites, stale IDs, metadata absence versus present-undefined, and unused registry rows.
- Genuine Promise/closure/delay declaration and reservation observations. Preserve **25/26** Promise resources/operations and closure cache/prefix behavior.
- Omitted declaration, borrowed resource duplicated as owned, forged `role`, extra type, copied/foreign pack, changed requirements, missing source association, and changed descriptor.
- Accessor+field overlap; null getter fallback; noncallable getter result stopping fallback; method shadowing; poisoned getter; exact captured result.
- Noncallable funcref-containing records; shared roots; cached signatures; missing invocation coverage.
- Construction sequences in function bodies and global initializers, nested catches, repeated shared subtrees, wrong type, missing/extra allocation, unowned root, and legitimate unconstructed supertype.
- Currentness after mutation of source association, accessor global association, selected options, producer plan, and completed body.
- Explicit full-family unavailable result naming missing producers/evidence, while the existing consumer refusal remains unchanged.

Detached synthetic overlap/construction examples are valid unit tests of the validator or canonical builder. They must be labelled as such and cannot mint an accepted full-family inventory.

**A completion means:** the source census, overlap representation, current-producer observations, descriptive reconciliation, and audit controls work without fabricated evidence. Full executable inventory issuance, actual B/C dispatch/getter provenance, complete frame/boundary construction mappings, the final carrier denominator, and successful Promise/full-family execution remain explicitly pending.

## Connection amendment before implementation dispatch

This amendment is normative for the first implementation increment where it
narrows or refines sections 5, 7, 9, and 10 above. The preserved contract describes
the eventual complete inventory boundary; it must not be read as an instruction
to ship uncallable opaque APIs ahead of their real issuer.

### Verified live parent entry point

Read-only inspection at the same pinned HEAD confirms:

1. `acceptPreparedIrProgram` in `src/ir/program-consumer.ts` authenticates/selects
   the projection, prepares the actual native string/value reservation input and
   formatter input, then calls `planPhysicalSetup`.
2. `planPhysicalSetup` in `src/ir/program-physical-plan.ts` already derives vector
   requirements, validates formatter input, and constructs native string and
   formatter resource plans. It then reaches host-number/frame planning and the
   existing gaps. An unsupported outcome returns before physical emission.
3. The Promise planning helpers are currently re-exported from that file; the
   ordinary `planPhysicalSetup` body does not call them. Adding another export,
   a test-only call, or an unused census property would not connect A to execution.
4. `NativeStringValueReservationInput` and its `plan.declarations` /
   `plan.reservationSteps` are actual source-derived producer inputs already on
   this live path. They are the smallest available real declaration contribution
   for the first connected accounting increment. Full Promise declarations also
   need genuine closure selection and explicit runtime configuration; neither may
   be fabricated merely to force that contribution into the initial hookup.

### Required first increment: live preflight, no acceptance expansion

Parent adds one checked preflight call inside `planPhysicalSetup`, after current
native string/formatter planning has produced its real inputs and before the
final gap decision. The call is restricted to selected standalone WasmGC native
Promise/async demand. It consumes the full selected program, never a reduced
source fixture or only the first async owner.

Proposed parent-owned wrapper in `src/ir/program-native-async-resources.ts`:

```ts
planNativePromiseInventoryPreflight(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  nativeStrings: NativeStringValueReservationInput | undefined,
  configuration: NativePromiseConfiguration | undefined,
): NativePromiseInventoryPreflight;
```

Its first-increment result is a closed union:

```ts
type NativePromiseInventoryPreflight =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "unavailable";
      readonly source: NativePromiseSourceCensus;
      readonly observations: readonly NativeCarrierProducerObservation[];
      readonly obligations: readonly NativePromiseInventoryObligation[];
    };
```

There is deliberately no `ready`, accepted token, emitted body, or complete-plan
witness in this result. `not-required` must be established from authenticated
selected demand, not from missing resource inputs. `unavailable` requires at
least one located obligation. Contradictory, detached, sparse, or tampered inputs
throw the existing prepared-data invariant error; they are not downgraded to an
ordinary missing feature.

For this initial live adapter, `NativeCarrierProducerObservation` has only the
implemented `kind: "native-string-values"` variant. It retains the exact
`NativeStringValueReservationInput`, its revalidated canonical declaration and
operation order, and the derived type-declaration rows. It does not accept an
arbitrary `NativeResourceRecipe`, caller-authored `role` interpretation, callback,
or contribution-registration API. Extend the union only together with a fixed,
tested adapter for another actual owner. Existing genuine Promise/closure/delay
observations can be tested as producer-local evidence meanwhile, but cannot be
relabeled as a complete source-derived composition.

An obligation records a stable code, the affected `IrUnitId`, relevant source
coordinate or producer identity when available, and a concrete detail. Required
codes distinguish at least missing runtime configuration, missing producer
declaration, missing source-to-carrier association, missing lookup/dispatch
evidence, missing construction contract, and missing complete composition. A
missing declaration observation must not become an empty completed declaration
list. A known declaration without its lookup/construction evidence remains an
observation with those unresolved obligations.

The wrapper calls A's collector and the fixed current-producer observer and uses
the resulting evidence to derive these obligations. Parent appends the located
obligations to the real planning `Gaps` path. Preserve all existing gap detection;
place the additional inventory gaps after existing rows so the current first
refusal is retained. Do not return `not-required` on an incomplete native family,
remove its existing async guard, reserve a module, or mint an acceptance token.
This preserves supported synchronous/no-demand behavior and the full family's
refusal-before-emission behavior. The inventory result must affect validation and
the gap decision; computing it and discarding it does not satisfy the hookup.

### Configuration and source-census refinement

The raw source census does not require runtime hook defaults. To make the live
hookup possible without inventing configuration, refine the collector signature
from section 7 for the first implementation to:

```ts
collectNativePromiseSourceCensus(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  options: PreparedIrBackendOptions,
): NativePromiseSourceCensus;
```

It still authenticates the whole program, selected attachment identity, complete
owners/buffers/allocations/ABI/support evidence, and actual selected native demand.
It does not itself derive configuration-bearing Promise resource requirements.
The parent wrapper calls the existing `planNativePromiseResources` separately
when an explicit configuration from the selected runtime is available. Otherwise
it returns a missing-runtime-configuration obligation while retaining the real
source census and existing producer observations. Do not silently choose disabled
hooks/unhandled tracking. This separation also avoids a recursion cycle between
the collector and the existing checked Promise planner.

Current `planPhysicalSetup` has no explicit Promise configuration parameter.
The first hookup must acknowledge that fact rather than recover configuration
from absence. Parent alone owns any later private forwarding from a real resolved
runtime configuration source. No public option, codec change, or new default is
part of A. When that source is supplied, rederive the requirements and verify
configuration currentness exactly as the preserved contract requires.

### Smallest real producer adapter

Low A implements a fixed declaration observer for the existing
`NativeStringValueReservationInput`, in its backend inventory module. Given the
exact authenticated program/projection and input, it recollects current string
demands, verifies borrowed program/projection/owner/buffer/occurrence identities,
rederives `planNativeStringValuePhysical` with the selected existing options, and
compares the actual plan and declarations. It also verifies any present value
requirements through the existing value-plan currentness API. It returns actual
type declarations and their input/recipe coordinates, with no guessed then-arm
disposition or invented construction expectation.

The aggregate's nested string/value/flatten/output declarations belong to that
one observed producer contribution; do not report them again as separately owned
copies. Borrowed shared types retain dependency associations. The already planned
formatter and vectors remain required accounted categories even when their fixed
inventory adapters are not yet implemented. Their absence from this first
observation is reported as pending, not certified away.

This adapter is intentionally useful before B/C: actual current producer shapes,
selected options, shared references, and the complete family source population
reach the normal parent planning path. It discovers and rejects drift in a real
input and establishes the exact unresolved obligations the next producer must
satisfy. It does not claim property access or invocation has become executable.

### Do not implement an issuerless bind layer

Defer the runtime implementations of `bindNativePromiseInventory`, the opaque
`NativePromiseInventoryPlan` issuer, its `WeakMap` capability checks, and the
complete-inventory emission assertion until the parent can issue a genuine
complete composition witness. Do not add dead exported functions that always
reject, a private issuer reachable only from tests, fabricated placeholder packs,
or a generic registration escape hatch. The types and lifecycle in the preserved
contract remain the specification for that later connected increment.

The first A implementation can ship the source census, the symbolic overlapping
fact representation, pure descriptive comparison/construction-audit primitives,
and the live current-producer observer. It must not label partial output
`NativePromisePopulationDescription` with a complete producer roster when only
one producer is observed; use the explicit partial preflight observation instead.

Defer changing production `NativePromiseFillDependencies.inventory` to an opaque
issued wrapper until the genuine issuer and caller arrive in the same integration.
Likewise, defer wiring the new population shape into actual Promise fill if the
only proposed caller is fabricated test evidence. Overlap/fallback validation can
be exercised against the unchanged canonical lookup builder and descriptive
facts now. This narrows the immediate write scope in section 9: the existing
`native-promises.ts` production signature change is a later connected step, not
a prerequisite for delivering A's live preflight. No legacy permissive inventory
route may be added in the meantime, and all existing refusal checks remain.

Construction audit primitives may be tested on genuine completed existing
producer outputs and explicit detached unit examples. Until all expected owner
contracts are supplied, they cannot certify whole-module emitted accounting.
Expected construction lists must ultimately come from producer requirements and
canonical construction contracts, independently of the emitted scan they check;
deriving both sides from the same emitted body is circular evidence.

### Parent-only files and real-path acceptance for this increment

Parent owns the narrowly scoped wrapper/hookup in:

- `src/ir/program-native-async-resources.ts`;
- `src/ir/program-physical-plan.ts`;
- an additive focused actual-consumer planning test under
  `tests/issue-3518-native-promise-inventory-planning.test.ts`.

No consumer acceptance change is needed: the existing consumer already calls
`planPhysicalSetup` with the real native string/value input. Parent does not add
a special test invocation path or another consumer. A and parent must integrate
this hookup as one reviewable increment before claiming A is delivered; a merged
library plus a promised future hookup is not connected delivery. Parent retains
all shared-file ownership and must compose its concurrent integration work first.

The focused real-path test must:

1. Call the actual `acceptPreparedIrProgram` on the unchanged full family using
   the established support capture and selected preparation, not only call the
   new helper. Observe that the source census and real producer adapter ran on
   the exact selected objects. A delegating spy is acceptable instrumentation;
   a replacement implementation is not the positive control.
2. Verify the nonempty source and real declaration observation, complete source
   denominators (7/5/16 and established 16/33), separately counted support, and
   explicit unresolved producer/configuration/dispatch/construction obligations.
   Derive and then pin the actually observed declaration counts; no guessed count
   or empty count receives credit.
3. Prove the hookup is load-bearing: a controlled throw from the invoked census
   or observer must propagate through the actual acceptance call; bypassing that
   call must fail the test. Separately, after a genuine positive observer run,
   missing/substituted/stale declarations and changed borrowed associations must
   be rejected by the real adapter, not by an unrelated fake validator.
4. Retain unsupported acceptance, the existing first gap, and no emission phases
   for the complete family. Verify the extra located inventory obligations flow
   to parent planning, rather than being merely logged or stored unused.
5. Preserve the existing synchronous output/no-demand acceptance controls. Repeat
   the relevant source/decoded and GVN axes with fresh evidence; plans/wrappers
   from the original program cannot authorize the decoded one.

The original selected refusal test remains unchanged. No full suites are required
for this specification; actual focused implementation validation remains pending.

### Why this advances the full family, and what stays pending

The first connected increment makes normal planning consume the full source
census and an actual producer's declarations and reject contradictory evidence.
It fixes the evidence boundary needed to compose the recursive Promise/property/
invocation group, so later B/C/frame contributors have precise obligations and
cannot silently omit a carrier. It does not reduce the family or create a second
acceptance authority. Its progress claim is connected prerequisite validation,
not new executable async behavior.

Pending evidence remains: the final selected producer roster and carrier count;
explicit selected Promise configuration; complete source-to-carrier and accessor
definition-site provenance; B/C dispatch/getter owner contributions; frame and
boundary construction contracts; complete independent emitted accounting;
genuine complete-plan issuance/binding; successful Promise fill; and the original
full-family execution/codec/GVN/boundary/timing/output proof. Preserve every
earlier fixture, failure, historical receipt, and refusal. Public cutover, ABI30,
strict closure, and frontend retirement remain separate outstanding obligations.

### Persistence receipt

The statements about no edits in the exact response above describe that earlier
specification turn. This turn performs only the user-authorized documentation
write of this file. At inspection, parent HEAD was still
`8c9b65b389194c8c8fc3e857e4b7316b0ae524e1`, with only its untracked takeover
specification present before this addition. No implementation was started, no
production file was edited, and no claims, commit, push, or external mutation
were made.
