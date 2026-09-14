# Frozen E2 native string-output implementation contract

Date: 2026-09-09. Astra High. Specification only; not dispatch, claim acquisition,
implementation, test execution, publication or retirement approval.

Authority: Maxwell's `3518-e2-string-output-resource-diagnosis-2026-09-09.md`,
SHA256 `cd562dc0f0aecf4c402457673cb840ae5a67fda320ce62facba088053adc4909`;
published E1 `03d0615e34da8629971659d8c5937b8483f57643`, including repaired
mixed-UTF8 flatten. Compose that prerequisite, not older inline donor bodies.
This document persists the complete previously delivered frozen E2 contract.

## 1. Exclusive implementation scope

After parent reads this contract, grants the aggregate handoff and verifies claims,
Maxwell owns exactly four production paths and two new tests:

1. NEW `src/ir/program/native-string-output-requirements.ts`
2. NEW `src/backend/wasmgc/resources/native-string-output.ts`
3. NEW `src/backend/wasmgc/program/native-string-output.ts`
4. EXISTING `src/backend/wasmgc/program/native-string-values.ts`
5. NEW `tests/issue-3518-native-string-output-requirements.test.ts`
6. NEW `tests/issue-3518-native-string-output-resources.test.ts`

Parent retains physical planner, consumer, native-async program aggregate, public
options, ABI integration, boundary policy and whole-family tests. No E1 builder,
adapter, donor, scanner, unbox, AnyValue, ledger or ABI schema edits are implied.
Stop and request a named amendment if the six-file scope cannot implement this.

## 2. Explicit option

```ts
export interface NativeStringOutputOptions {
  readonly emptyIdentity: boolean;
}
```

Parent resolves optional physical option `stringConcatEmptyIdentity?: boolean`
once, default **true**, and retains the resolved value in acceptance/currentness.
Canonical modules never read environment variables. Historical codegen retains
`JS2WASM_STR_CONCAT_EMPTY_IDENTITY !== "0"`; no compatibility rewrite or claim
of typed-option/environment equivalence. The option is not provider admission.

## 3. Pure requirements API

In the new IR program module, using existing canonical imported types:

```ts
export type NativeStringOutputUse =
  | { readonly occurrence: number; readonly kind: "binary-concat" }
  | { readonly occurrence: number; readonly kind: "batched-concat"; readonly arity: number }
  | { readonly occurrence: number; readonly kind: "stdout-append" };
export interface NativeStringOutputRequirements {
  readonly demands: NativeStringValueDemands;
  readonly options: NativeStringOutputOptions;
  readonly uses: readonly NativeStringOutputUse[];
  readonly binaryConcat: boolean;
  readonly batchArities: readonly number[];
  readonly stdout: boolean;
}
export function deriveNativeStringOutputRequirements(
  demands: NativeStringValueDemands, options: NativeStringOutputOptions,
): NativeStringOutputRequirements | PreparedIrProgramFailure;
export function assertNativeStringOutputRequirementsCurrent(
  requirements: NativeStringOutputRequirements,
): void;
```

Reuse the unchanged complete occurrence census: both views, blocks, async-plan,
async-runtime and nested coordinates. Preserve all owners and the complete
allocation snapshot, including unknown metadata. Occurrence indices refer to
actual borrowed instructions, not a second reconstructed instruction population.

Authenticate canonical selected provider, attachment/call binding, logical
signature and arity. Names/prefixes are never evidence. Admit only immutable binary
concat, canonical batch concat and canonical string-only console. Existing closed
batch range is 3..8; the original family requires 5. Batch arities are unique in
first-occurrence order. Binary concat is also required by batches or stdout.
Stdout requires append, prepare and char together. Empty uses is valid but never
allocates an output pack. Other string operations retain located failures.

Currentness rederives selections and compares exact borrowed program, projection,
buffers, instructions and metadata identities plus option values. Decoding creates
fresh requirements; copied records do not grant authority. Reuse canonical
callable/provider definitions, not a duplicate signature catalog. Pre- and
post-provider views must be reconciled without counting duplicate views as executions.

## 4. Pure physical plan and one recipe

The backend program module exports:

```ts
export interface NativeStringOutputPhysicalPlan {
  readonly key: string;
  readonly stringKey: string;
  readonly flattenKey: string;
  readonly options: NativeStringOutputOptions;
  readonly binaryConcat: boolean;
  readonly batchArities: readonly number[];
  readonly stdout: boolean;
  readonly declarations: readonly NativeStringValueDeclaration[];
  readonly reservationSteps: readonly NativeStringValueReservationStep[];
}
export function planNativeStringOutputResources(
  requirements: NativeStringOutputRequirements,
  keys: { readonly key: string; readonly stringKey: string; readonly flattenKey: string },
): NativeStringOutputPhysicalPlan;
```

The resource module exports the single recipe algorithm used by planning/reserving:

```ts
export function declareNativeStringOutputResources(
  key: string, stringKey: string,
  selection: {
    readonly binaryConcat: boolean;
    readonly batchArities: readonly number[];
    readonly stdout: boolean;
  },
): NativeResourceRecipe;
```

Reject contradictory selection, duplicate/out-of-range arities and invalid keys
before mutation. The pure planner validates current requirements and returns a
frozen descriptive plan; the resource owner retains the exact admitted plan.
Resource code imports the physical-plan interface type-only, never its planner
implementation. Do not create a value import cycle between these two modules.

Output-local order: binary concat; demanded batches in first-occurrence order;
accumulator global; append; flat global; prepare; char. Omit undemanded groups.
Full-family output has five functions and two globals. Use existing recipe
intern/reserve semantics, preserving named stdout signatures
`$stdout_append_type`, `$stdout_prepare_type`, `$stdout_char_type` and optional
name presence. For each of these three stdout functions, use one explicit named
`intern-signature` step followed by its function reservation. The existing ledger
always performs an unnamed intern lookup inside `reserveFunction`: this is two
actual calls, but only one type allocation on a cold miss and none on a preseeded
hit. Preserve first-allocation naming; do not rename an existing matching type.
Binary/batch reservations retain only their implicit lookup. Do not add a ledger
API, schema change or duplicate ABI type entry to hide the second call.
Pin the complete operation trace. This deterministic new aggregate order is not
a claim of equality with every legacy lazy-registration interleaving.

This narrow Astra High correction supersedes the original contradictory
no-explicit-plus-implicit sentence. Exact stdout order is accumulator global,
named append intern, append reservation/implicit lookup, flat global, named
prepare intern, prepare reservation/implicit lookup, named char intern, char
reservation/implicit lookup. Tests must pin both calls and argument presence,
cold/preseeded cache behavior, names, indices and allocation order; do not claim
donor-identical intern invocation counts. Parent verified the actual ledger,
recipe executor and three named legacy stdout declarations before adoption.

All type references are symbolic issued string-type keys before allocation:

- Binary: `(ref AnyString, ref AnyString) -> ref AnyString`.
- Batch N: N nonnull AnyString parameters, one nonnull AnyString result.
- Append: `(ref null AnyString) -> []`.
- Prepare: `[] -> i32`; char: `(i32) -> i32`.
- Accumulator: mutable nullable AnyString; flat: mutable nullable FlatString.
  Both have exactly typed null initializers.

Defensive batch null guards do not authorize nullable parameter signatures.
Logical strings and generic provider externref signatures require explicit
native-carrier realization, not equality by name/index with physical AnyString.

## 5. Issued resource API and phase authority

```ts
export interface NativeStringOutputDependencies {
  readonly strings: NativeStringLiteralReservations;
  readonly flatten: NativeStringFlattenReservations;
}
export interface NativeStringOutputReservations {
  readonly concat: FunctionReservation;
  readonly batches: readonly { readonly arity: number; readonly function: FunctionReservation }[];
  readonly stdout?: {
    readonly accumulator: GlobalReservation;
    readonly flat: GlobalReservation;
    readonly append: FunctionReservation;
    readonly prepare: FunctionReservation;
    readonly char: FunctionReservation;
  };
}
export function reserveNativeStringOutputResources(
  tx: PhysicalModuleReservations, requirements: NativeStringOutputRequirements,
  plan: NativeStringOutputPhysicalPlan, dependencies: NativeStringOutputDependencies,
): NativeStringOutputReservations;
export function requireNativeStringOutputReservations(
  tx: PhysicalModuleReservations, pack: NativeStringOutputReservations,
): NativeStringOutputReservations;
export function nativeStringOutputReservationInventory(
  tx: PhysicalModuleReservations, pack: NativeStringOutputReservations,
  expectedPlan: NativeStringOutputPhysicalPlan,
): readonly NativeDeclaredReservation[];
export function fillNativeStringOutputResources(
  tx: PhysicalModuleReservations, pack: NativeStringOutputReservations,
): void;
export function requireCompletedNativeStringOutput(
  tx: PhysicalModuleReservations, pack: NativeStringOutputReservations,
): NativeStringOutputReservations;
export function publishNativeStringOutput(
  tx: PhysicalModuleReservations, pack: NativeStringOutputReservations,
): void;
```

One private issued-owner association retains exact tx/requirements/plan/strings/
flatten, recipe records and fill/publication state. No replacement dependencies
at fill. Before first allocation: currentness, complete recipe reconciliation,
issued string inventory, existing flatten reservation authentication, exact
`flatten.stringPack === strings`, type-pack configuration, required literals.
Reject empty output selection at reserve. Reject copied/foreign/stale prerequisites
without consuming keys/ordinals. Use existing phase-appropriate ownership APIs;
no pre-freeze physicalIndex/completion, token-shape authority or second ledger.

Inventory includes every output-owned declaration in recipe order; shared string
and flatten resources stay with their existing owners. Reauthenticate captured
associations/currentness at inventory, fill, completion and publication.

## 6. Internal literals and shared flatten

Flatten requires `""` with explicit `"wtf16"` encoding. Batches require the genuine
string literal `"undefined"` through existing string-literal selection, NOT the
AnyValue/tag-1 undefined token. Main fulfillment remains a separate value obligation.

Aggregate adds internal demands before ABI sealing and literal-pack consumption;
reuse interning, preserve source occurrence/allocation/storage/materializer evidence.
Each batch operand receives a fresh literal instruction sequence resolving the
authenticated binding; no shared mutable arrays or arbitrary callback.

Output-only: strings -> flatten -> output. Number-only: original order unchanged.
Combined: strings -> ONE flatten -> existing scanner/values sequence -> output.
If a top-level flatten field is added, retain `number.flatten` as the exact same
pack for compatibility. No-output modes gain no literals, functions, globals,
exports or reordered declarations. Currentness must preserve this dependency
selection as well as planning; never infer numeric demand merely from flatten.

## 7. Fill and publication

After the parent's one freeze: complete strings and flatten; fill typed-null
globals; fill binary/batches; fill append/prepare/char; authenticate all fills.
Use unchanged E1 `buildStringConcatDefinition`, `buildStringBatchedConcatDefinition`,
`buildStdoutAppendDefinition`, `buildStdoutPrepareDefinition`, `buildStdoutCharDefinition`.
Calls use stable handles; globals use final indices where builders require them.
Preserve E1 locals, body order, thresholds and UTF16 offset semantics exactly.

`requireCompletedNativeStringOutput` means canonical output fills are complete,
NOT that the whole module ledger is sealed. It succeeds in the filling phase
before publication/seal and remains usable after seal. It rejects reserving,
unfilled or partly filled owners. Recheck exact issued owner/requirements/plan/
dependency associations, completed strings/flatten, all output token coordinates
through existing ledger physicalIndex authentication, and the recorded canonical
filled descriptors/bodies/initializers. Do not reduce completion to a filled flag:
mutated actual resource content must fail before publication as well as after seal.
Use existing ledger validation plus private producer snapshots where needed; no
new ledger authority. Completion does not require publication, avoiding a cycle.
Set the private filled state only after every canonical output fill succeeds.

Publication requires this filled/pre-seal completion and uses `tx.defineExport` in prepare-then-char
order for real `__stdout_prepare` and `__stdout_char`. No direct exports mutation,
fabricated indices or exports for append/concat. A genuine non-stdout pack has a
no-op publication; stdout repeat publication rejects. Partial failure is not a
successful fill or rollback/retry guarantee.

## 8. Parent integration contract

Authenticate program/projection; derive output requirements; add internal literals;
compose all recipes; append supplemental declarations to SAME ProgramAbiMap;
reuse compatible canonical binary/batch/console bindings and aliases; seal the
complete ABI BEFORE allocation. Exact full declarations include internal globals.

Reserve once and reconcile symbolic inventories to accepted rows while reserving;
then freeze reservations ONCE, resolve final coordinates and bind every actual
reservation in the SAME ProgramAbiMap, finishBinding, fill dependencies/output,
publish, and finally seal the module ledger. No physicalIndex call or final-index
binding occurs before freeze. The complete semantic/supplemental ABI planning seal
still precedes allocation; it is distinct from finishBinding and the final module
ledger seal. Share string types with scanner/formatter.
Replace the old no-unbox-implies-literals assumption with independent exact feature
checks, not a bypass. Parent owner resolver supplies actual `emitStringConcat`;
canonical batch/console calls use authenticated resolveFunc bindings. No encoded-ID
parsing or name lookup grants ownership. Preserve original literal resolution and
include all output resources/exports in completion census. Admission of a nullable
logical operand must not silently violate the fixed nonnull concat ABI.

Parent retains async refusal until actual invocation/frame/Promise resources are
complete. E2 moves its own frontier, never deletes unrelated refusals or owners.

## 9. Required evidence

Requirements: unchanged real family, original/decoded x GVN off/on x UTF8 off/on;
independent coordinates, canonical providers, arity5 and binary newline concat;
complete owners/state/nested views; positive-first wrong provider/signature/arity,
missing/extra owner, stale instruction/metadata/options and unsupported operations.
Recount actual 5/22 -> 16/33 stages without treating duplicate views as executions.

Resources: real strings+flatten+output WITHOUT scanner/unbox; both UTF8 modes;
mixed ropes/offsets; 63/64/65; all arities3..8; both empty-identity options; empty
sink/four newline appends/repeated readout/bounds/Unicode code units/fresh instances.
Pin signatures, globals, initializers, full declaration/intern trace, identities,
exports, bodies/locals and unchanged E1 receipts. Use actual bytes/WAT and execution.
Positive-first missing fills, duplicate publication, foreign/copied/stale packs,
required literal absence, wrong handles/descriptors/plan; unchanged preallocation
population and pristine-twin ordinal probes. Parent preserves exact no-output
old/new bytes/WAT/order controls and separately records any actual next refusal.

Full acceptance still requires all original family behavior: 70 and 3e9 delays,
sequential/reverse-parallel order, rejection/empty timing, four exact newline lines,
once-only main fulfillment with canonical undefined, original/decoded fresh
source-free consumer execution. Resource execution is not full async retirement.

## 10. Phase-clarification acceptance controls

Require a genuine filled owner to pass completion before publication/module seal;
then publish prepare/char and seal, and require completion again. Reserving and
partial-fill owners fail completion. A changed filled body, initializer or
signature fails completion/publication before seal. Publication before fill,
a second stdout publication, and publication after module seal reject without
claiming rollback. Verify the parent sequence reserve/reconcile -> freeze ->
final-index bind/finishBinding -> fill -> publish -> module seal, while the ABI
planning seal remains before the first allocation.
