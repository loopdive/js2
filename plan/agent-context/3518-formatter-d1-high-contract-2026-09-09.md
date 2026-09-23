# Frozen D1 contract: index-free radix IR and typed support transport

Status: High implementation specification, not claim acquisition, implementation, execution evidence, D2 acceptance or retirement proof. Written only in this High-owned scratch directory. Parent may publish and assign the named scopes after its live claim checks.

## 1. Evidence and decisions

Inspected production in `/private/tmp/js2-3518-native-async-integration-20260909`, observed HEAD `721cd33a828c89cfc04c851b011f910b76a4d2c5`. Independently hashed all **28** donor/evidence files in the published Maxwell census: all match its recorded bytes. Census JSON parsed-content SHA256, using `JSON.stringify(JSON.parse(text))`, is `f26c233a20bc2d1beaf0f24c06691c00b5d452022554e74d07c4778dc1ade3c0`; its formatting is not source authority. The accompanying Markdown and JSON are `plan/agent-context/3518-formatter-d1-transport-census-2026-09-09.{md,json}`. Their 17 selected-declaration receipts remain the original receipts, not a new denominator.

Freeze two distinct contracts:

1. **R: a nominal, index-free support-reference leaf in semantic IR.** It carries an existing structural support type reference and explicit nullability, not a physical index or formatter catalog. This is the minimal faithful representation of the radix scratch value. It is not a JavaScript vector, string, externref, anonymous object, or `val` with a fabricated index.
2. **T: an optional, explicitly typed compiler runtime-support batch in the program handoff.** It contains the actual fully built radix IR, its closed declarations and provenance; it is jointly captured with the original allocation registry. It is not an unknown payload, slotless support intent, extra ordinary source body, or backend compilation callback.

R must be usable by the genuine frontend builder before T can execute. T is a real source-to-prepared-program implementation: the existing legacy builder calls the extracted kernel, and `prepareWholeIrProgram` supplies the support batch before its single typed transaction. D1 does **not** make a formatter physical implementation exist. D2 must still declare/fill the five kernels, radix body, thunk and full formatter dependencies and wire real consumer emission. No async guard is removed in D1.

This design fits the approved semantic-core/program/backend separation; it requires parent approval of this new API and scoped claims, not a new host/linear or general opaque-IR feature decision.

## 2. Non-negotiable donor facts

`src/stdlib/number-format.ts:51–110` contains the original `TOSTRING_RADIX_SOURCE`, 1,618 UTF8 bytes, SHA256 `7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6`. Its declaration receipt is `6664ed185bf6117a93ef311eefdb941b38a3feb8b8ef3ef5ef208c0dedbbb664`; `numToStringRadixDef:116–131` is `3917470d4016fb92105cdb72babb4ebe627ddc83f6addd19dbc553b49cbb99cb`. Keep source and definition bodies unchanged. Import/type-owner changes are separately checked inverse edits, not permission to reseed these hashes.

One original function, `__sh_num_toString_radix(value:number, radix:number):string`. Exactly sixteen **source** calls: Math.floor four, trap one, new one, set seven, get two, fin one. Four source literal occurrences, ordered `NaN`, `Infinity`, `-Infinity`, `0`. Math.floor remains the actual existing intrinsic lowering, not a sixth support kernel. Do not claim these source counts are post-pass or executed call counts.

Let B be the nullable reference to the selected string pack's mutable packed-i16 data array. The five declarations, in `calleeTypes` order, are:

- new: `(f64) -> B`;
- get: `(B,f64) -> f64`, with unsigned packed reads;
- set: `(B,f64,f64) -> void`;
- fin: `(B,f64) -> string`, a tight prefix copy at offset zero;
- trap: `() -> void`, implemented by `unreachable` later.

Legacy physical order is **new/get/set/trap/fin**, then radix body, then thunk. Preserve this separately from the logical declaration order. `number-format-selfhost.ts:54–148` owns the five bodies today. `emitSelfHostedToStringRadix:157–171` creates the current context-indexed B. Preserve its physical donor unchanged in D1. Its thunk is `(f64,f64)->externref`: argument0, argument1, call body, extern.convert_any.

Preserve nonfinite tests, radix floor, negative zero, MAX_SAFE_INTEGER refusal, integer digit/reversal order, fractional loop and its 100-digit bound. Existing fractional non-V8-shortest behavior stays explicit. Radix is not Ryū, fixed/exponential/precision, full native ToString, or the full async formatter.

## 3. R: exact semantic reference interface

Add this named interface/constructor to `src/ir/core/types.ts` and add the interface to its existing `IrType` union:

```ts
export interface IrSupportRefType {
  readonly kind: "support-ref";
  readonly ref: IrTypeRef & {
    readonly binding: Extract<IrTypeBinding, { readonly kind: "support" }>;
  };
  readonly nullable: boolean;
}

export function irSupportRef(ref: IrTypeRef, nullable: boolean): IrSupportRefType;
```

The constructor validates an actual `kind: type` reference, support binding, nonempty type-domain binding ID, and a boolean nullability. Reuse the core `requireBindingId` primitive; do not import mixed `ir/abi-bindings.ts` into core. Program ownership is validated later; the constructor's brand/prefix check is not ownership proof.

No `val`, `typeIdx`, packed layout, runtime feature, provider, source object, callback or physical token is in this leaf. Formatter-specific storage/role restrictions live in the program contract below. Both nullabilities exist for faithful type operations, but **D1 admits B only with `nullable:true`**, exactly as the donor. No signature narrowing because new happens to construct a nonnull value.

Equality uses support binding identity plus nullability, never `ref.name`. The semantic type key must be unambiguous and index-free: a length-delimited support binding ID and explicit nullability. `preparedIrTypeKey` must normalize this new arm consistently instead of reintroducing the display name through `preparedIrDataKey`; all old type keys remain byte-for-byte unchanged. Do not parse the encoded ID into guessed owner/role components: rederive canonical refs from the separately recorded owner and role.

There is one necessary factory-owner correction: `irSupportTypeRef` and its `typeRef` helper currently live in mixed `src/ir/abi-bindings.ts`, which imports the old nodes facade. Move **those two existing function bodies** unchanged to new `src/ir/core/type-references.ts`, with canonical core types, core binding-key primitives and foundation identity imports. Preserve `irSupportTypeRef`'s old exported identity by import/reexport; all other old ABI factories call the same moved `typeRef` helper. Do not copy a second implementation into the program factory or import mixed ABI bindings into clean program/core code. Existing `irSupportFuncRef` already has a canonical core owner. This is a bounded R prerequisite, not a migration of the whole ABI module.

`asVal(supportRef)` returns null. At `lowerIrTypeToValType` in `src/ir/lower.ts:4319`, use the existing `resolver.resolveType(ref)` and only then create `{kind: nullable ? "ref_null" : "ref", typeIdx: actualResolvedIndex}`. Missing/unowned/incompatible type resolution remains a failure. No second resolver API, allocator, placeholder index or index-bearing source-build type.

Do not inherit generic reference-shaped leniency. Current `verify.ts:556`, branch checks around 1530, `checkDeclaredCarrier:2178`, and declared-call result checks around 2250 collapse non-val types to null/unknown. For this new arm, explicitly check full identity/nullability on returns, branch arguments and declared call arguments/results; reject support-ref slot flows as specified below. Where a support-ref participates, an absent type/declaration is not evidence of compatibility. Preserve historical conservative checks for all existing arms. D1 permits only exact identity/nullability flows; no support-ref boxing, numeric conversion, object/vector methods, unions or arbitrary reference promotion.

**Actual API limits, frozen amendment:** `verifyIrBackendLegality` receives a backend, not a target. R rejects support-ref on non-WasmGC backends using that existing API; it cannot certify standalone selection. T must separately check the actual selected runtime policy is `backend:"wasmgc", target:"standalone"` before support admission, and recheck selected projection policy at replay/acceptance. No new legality flag or target argument is authorized. `IrSlotDef` in `core/nodes.ts:1775–1779` stores only physical `ValType`. R therefore rejects support-ref `slot.read`/`slot.write` or producer slot promotion; it must not extend the slot union, invent a physical index, cast the semantic reference into a slot descriptor, or silently erase its identity. The genuine unchanged radix source uses a const scratch binding expected to remain SSA. R+F must prove that actual build succeeds; if it requires a scratch slot, report a concrete blocker for a separately reviewed slot contract rather than bypassing this limit. Scalar loop slots and existing SSA-local physical allocation remain unchanged.

### Exact R owner map

The R worker owns these existing paths, restricted to the new arm and its rejection/identity behavior:

- `src/ir/core/types.ts`: union, constructor, equality.
- `src/ir/core/type-references.ts` (new) and `src/ir/abi-bindings.ts`: exact two-body canonical factory relocation and compatibility forwarding above; retain all other ABI declarations, private-helper order and behavior.
- `src/ir/type-key.ts`: explicit leaf before the current boxed fallthrough.
- `src/ir/from-ast.ts`: preserve supplied callee/local support types; explicit nullability; reject unsupported coercion. No new JavaScript source syntax or checker-name heuristic.
- `src/ir/lower.ts`: symbolic resolution as above.
- `src/ir/verify.ts`: support-ref-only strict joins; no waiver of existing rules.
- `src/ir/physical-ref-support.ts`: preserve the leaf; never pass it through the legacy physical-index attachment callback.
- `src/ir/prepared-callable-boundary.ts`, `src/ir/prepared-closure-support.ts`: explicit leaf in existing recursive type traversals; no new closure admission.
- `src/ir/passes/monomorphize.ts`: its separate private key gains the same identity rule; existing keys unchanged.
- `src/ir/vec-layout.ts`, `src/ir/string-carrier.ts`: their exhaustive mapType switches must return the same support leaf, not uninitialized `mapped` or a new carrier.
- `src/ir/backend/legality.ts`: reject the new surface for non-WasmGC backends through the existing backend-only API; T owns the separate explicit standalone-policy check. No new flags/signature expansion.
- `src/ir/fnctor-abi.ts`: concrete post-freeze scope amendment for the TS2366 exhaustive-switch failure at `validateTypeGraph` (line 76 in the inspected source). Add only an explicit `support-ref` rejection returning an explanatory diagnostic. This is not `irTypeAbiKey`; no key construction, fnctor admission, resolver or ABI contract change is authorized. Preserve all existing-arm behavior.
- `src/ir/analysis/linear-memory-plan.ts`: explicit unsupported case in its exhaustive type-key path only. This is a fail-closed compatibility update, not new linear implementation.

R does **not** own `program-abi-contracts.ts` or `prepared-component-dependencies.ts`; T owns their coordinated changes below. It does not change `ir/nodes.ts`'s old forwarding identities. The initial read-only fnctor inspection was not a whole-project typecheck; the subsequently reported concrete diagnostic authorizes only the rejection case above. Inline-small and linear-integration are not additional write targets. Any further concrete exhaustive switch diagnostic requires an exact parent scope amendment, not open-ended ownership.

New R test: `tests/issue-3518-symbolic-support-ref.test.ts`. Required controls: same ID/different display name, foreign ID, nullability, wrong binding domain, physical fields absent, missing declaration/resolver, same-key clone versus actual program ownership, unconditional support-ref slot-flow rejection, branch/call/return mismatches, and real original radix lowering through the source kernel with scratch remaining SSA. Reject non-WasmGC at R; test host-gc/WASI/linear policy refusal separately at T without adding legality flags. Exercise two genuine physical type layouts with different preceding reservations to prove resolution is index-independent. That physical lowering control is not prepared-program execution or D2 completion.

## 4. Source kernel and real production trigger

New frontend files (one F worker):

- `src/frontend/builtins/contracts.ts`: relocate the existing `SelfHostedFuncDef` interface/docs unchanged, using canonical IR types. It is frontend data, not a new backend or runtime catalog.
- `src/frontend/builtins/build-ir.ts`: own the existing parse/lower/verify/hygiene kernel, not memoization, physical lowering or context access.
- `src/frontend/builtins/prepare-number-format.ts`: the one genuine D1 producer using the original definition and the source preparation's allocation registry.

Existing F writes: `src/codegen/stdlib-selfhost.ts` and `src/stdlib/number-format.ts`. No `number-format-selfhost.ts` or `number-format-native.ts` body edits. Move the interface/imports and call the extracted kernel from the existing `buildSelfHostedIr`; retain its export, error text, memo checks/fingerprint/template/materialization, native-string resolver adapter and all old physical callers. Radix remains non-memoized. A program-qualified support-ref is not eligible for a process-global memo merely because it lacks an index.

Freeze the new frontend kernel API (all names here are proposed exports, not claims of existing APIs):

```ts
export interface SelfHostedIrBuildInput {
  readonly definition: SelfHostedFuncDef;
  readonly ownerUnitId: IrUnitId;
  readonly callees: ReadonlyMap<string, IrDirectCallTarget>;
  readonly resolver?: IrFromAstResolver; // legacy typed resolver, never CodegenContext
  readonly allocRegistry?: AllocSiteRegistry;
}
export function buildSelfHostedIrBody(input: SelfHostedIrBuildInput): IrFunction;

export function prepareNumberFormatRuntimeSupport(
  source: IrProgramSourcePreparation,
  policy: RuntimeManifestPolicy,
): IrRuntimeSupport | undefined;
```

Use actual existing `IrDirectCallTarget`, `IrFromAstResolver`, `AllocSiteRegistry` types; the new kernel cannot import a codegen module. The compatibility wrapper supplies its existing exact direct refs and resolver. D1 supplies the closed five support targets, an actual shared registry and no context-bearing resolver. Do not derive targets from names/prefixes in the kernel. Allocation remains optional solely for unchanged historical callers, mandatory for the D1 producer.

Sequence remains parse exact `stdlib/${name}.ts` -> matching declaration/arity -> existing direct-call-plan builder -> `lowerFunctionAstToIr` -> reject lifted -> verify -> at most ten `constantFold/deadCode/simplifyCFG` iterations -> verify. Pass the exact supplied registry through existing `AstToIrOptions.allocRegistry`. Add declared signatures for strict support-ref validation without altering old diagnostic ordering or introducing a second build. Do not materialize an identity-free template for D1 and then lose its allocation owner; the D1 result retains the same owner used while minting allocations. The legacy wrapper retains its old template reconstruction behavior.

For this checkpoint the closed trigger is an actual canonical native-async number-to-string reference: `irNativeAsyncCallableDeclaration(ref)?.feature === "async.native.number-to-string"`, **plus** selected `wasmgc:standalone` native policy/provider demand. This uses the existing six-declaration catalog, not spelling `__ir_number_toString_native`, operand guesses, a helper export or host `js.number.box`. Scan every executable source buffer, including existing semantic async states, by canonical traversal. Revalidate against every transformed/final primary body before finalization. Do not let removing both support data and its own claimed demand vector disable the independent primary-body scan.

Other formatter demand families are explicit follow-on D2/producer work, not silently authorized by this trigger. New demand discovered only after passes must produce an explicit missing-support failure, not backend parsing, a lazy callback or a second full typed transaction. This trigger is sufficient to build radix support for the existing original native-family main; it does not certify that the rest of that formatter or async consumer can execute.

New F test: `tests/issue-3518-number-format-source-support.test.ts`. Reuse the actual original source and real frontend builder; preserve all original source/declaration receipts and existing memo/string/math tests. Add positive-first source/template/callee/owner/alloc-registry mutations. Verify source facts separately from the actual post-pass IR census. No manufactured caller, altered template or unconditional Math resolver.

## 5. T: frozen typed transport data

New pure program modules are `src/ir/program/runtime-support.ts` and `src/ir/program/formatter-support.ts`. They may import canonical core/foundation/program and existing canonical semantic catalog/analysis dependencies allowed by the approved layer, never TypeScript, frontend, stdlib source, codegen, backend resources or physical tokens. Keep declaration data separate from the frontend implementation. Do not widen boundary policy to make a mixed import pass.

Use the following exact public data names/shape. `IrFunction` means canonical semantic core function, not a prepared async extension; `IrFuncRef`, `IrTypeRef`, IDs and allocation IDs are existing canonical types.

```ts
export type IrFormatterKernelRole = "new" | "get" | "set" | "fin" | "trap";

export interface IrRuntimeSupportCallable {
  readonly ref: IrFuncRef; // validator requires a support binding
  readonly params: readonly IrType[];
  readonly results: readonly IrType[];
}

export interface IrRuntimeSupportCallOccurrence {
  readonly path: readonly (string | number)[];
  readonly target: IrFuncRef;
}

export interface IrRuntimeSupportLiteralOccurrence {
  readonly path: readonly (string | number)[];
  readonly value: string;
  readonly alloc: AllocSiteId;
}

export interface IrNumberFormatRadixSupport {
  readonly kind: "number-format-radix-v1";
  readonly sourceId: IrSourceId;
  readonly demandOwners: readonly IrUnitId[];
  readonly source: {
    readonly definition: "numToStringRadixDef";
    readonly functionName: "__sh_num_toString_radix";
    readonly utf8Bytes: 1618;
    readonly sha256: "7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6";
  };
  readonly scratch: {
    readonly type: IrSupportRefType;
    readonly storage: { readonly kind: "array"; readonly element: "i16"; readonly mutable: true };
    readonly stringDataRole: readonly ["string-type", "data"];
  };
  readonly kernels: readonly [
    IrRuntimeSupportCallable & { readonly role: "new" },
    IrRuntimeSupportCallable & { readonly role: "get" },
    IrRuntimeSupportCallable & { readonly role: "set" },
    IrRuntimeSupportCallable & { readonly role: "fin" },
    IrRuntimeSupportCallable & { readonly role: "trap" },
  ];
  readonly implementation: {
    readonly declaration: IrRuntimeSupportCallable;
    readonly body: IrFunction;
  };
  readonly calls: readonly IrRuntimeSupportCallOccurrence[];
  readonly literals: readonly IrRuntimeSupportLiteralOccurrence[];
}

export interface IrRuntimeSupport {
  readonly schema: "ir-runtime-support-v1";
  readonly batches: readonly IrNumberFormatRadixSupport[];
}
```

For D1 require exactly one batch when demanded; otherwise omit `runtimeSupport` entirely. Empty arrays, own-property undefined and unknown batch kinds are not alternate no-demand spellings. Keep outer prepared/codec versions unchanged; the optional field has its own closed version and old/no-demand serialization stays exact. Broader support families require additive reviewed discriminants, not `unknown`/`any` payloads.

The `calls` and `literals` are **post-kernel-hygiene occurrence receipts**, regenerated and exactly compared against the actual body. Paths are own-property paths through the canonical body/instruction-buffer structure, including array ordinals; not instruction names, allocation-name matches or arbitrary substring searches. Enumerate DAG occurrences per executable position, not globally deduplicated objects. The source facts of section 2 remain an independent producer preservation obligation; do not force sixteen surviving IR calls or fabricate four live literals after transformations.

Do not duplicate allocation metadata in a normalized second schema. Each literal receipt points into the **single complete program allocation snapshot**, which also contains the fin string-result allocation and all original source sites, live/aliased/retired state and metadata. Existing capture preserves unknown native payloads; existing final validator restrictions remain restrictions. No new namespace filtering, metadata dropping or relaxation of validation is permitted.

`formatter-support.ts` owns a single closed factory/validator for this schema:

```ts
export function numberFormatRadixSupportDeclarations(sourceId: IrSourceId): {
  readonly ownerUnitId: IrUnitId;
  readonly scratch: IrNumberFormatRadixSupport["scratch"];
  readonly kernels: IrNumberFormatRadixSupport["kernels"];
  readonly implementation: IrRuntimeSupportCallable;
};
```

No stored source text or TS parser belongs here. This factory is the one semantic kernel-signature authority consumed by both frontend production and independent program validation. The actual physical bodies remain D2's donor-backed responsibility. A source hash is provenance/currentness evidence under the internal compiler-data contract, not cryptographic proof against an attacker who rewrites arbitrary IR and receipts together.

`runtime-support.ts` supplies `assertIrRuntimeSupport(input, support)` and `irRuntimeSupportFunctions(support)`. `input` is the narrow structural projection `{inventory, ir, derivedUnits, allocations}` from the existing typed/prepared contracts, not a legacy context; `support` is `IrRuntimeSupport | undefined`. The assertion independently derives demand owners from primary IR and validates exact support population, source anchor, refs, body/type/declaration joins, complete instruction/call/literal/allocation census and prohibited D1 attachments. The function accessor returns actual support bodies in batch order, never an artificial source module. Keep this accessor honest: it is an additional population, not a replacement for primary/async traversal.

Keep this pure assertion's implementation structural: canonical traversal, closed declaration comparison, snapshot membership and provenance. It must not import mixed `verify.ts`, `program-validation.ts`, `type-key.ts`, `abi-bindings.ts`, the registry facade, or source-middleend helpers. General SSA/dominance verification and live allocation analyses remain calls in their **existing mixed T orchestration owners**, using this explicit support vector. Use the moved canonical type-ref factory and existing core callable factory. This preserves the distinction between clean data/structural validation and still-unmigrated full preparation implementation.

### Identity rules

Anchor the batch at the one actual inventory source with `kind:"entry"`, as existing `preparedIrRuntimeAbiAnchor` does. Demand owners are distinct real source/derived owner IDs in canonical body order; resolve them through existing source/derived ancestry, not encoded-ID parsing. Recompute the vector after async transformation/optimization; the original source ownership still resolves through that ancestry.

Factory roles, all ordinal zero, are frozen:

- body unit ID: `createDerivedIrUnitId({parentId: sourceId, role: "runtime-support:number-format-radix", ordinal: 0})`;
- scratch ref: `irSupportTypeRef(sourceId, "number-format-radix:scratch", "__nfd_buffer")`;
- kernel refs: `irSupportFuncRef(sourceId, "number-format-radix:" + role, exactDonorName)` for the five closed roles;
- body callable ref: `irSupportFuncRef(sourceId, "number-format-radix:body", "__sh_num_toString_radix")`.

The body unit ID is validated by this **support** contract. It is not inserted in ordinary `inventory`, `derivedUnits`, `units`, startup, or `ir.functions`; do not use `irUnitFuncRef`/unit-callable ID for its ABI entry. No `@compiler/stdlib-selfhost` fake source or terminal. Global/class/closure/async/generator attachments on this D1 body are rejected. Source five-owner and transformed sixteen-function/thirty-three-call counts retain their original scopes; report support body/kernel/source-occurrence counts separately.

**Exact identity amendment, confirmed after the initial freeze:** `src/shared/contracts/ir-identity.ts:27–32` currently has a closed `IrSyntheticUnitRole` union and does not include this body role. T owns one additional foundation edit: append the single literal `"runtime-support:number-format-radix"`. Do not cast it, reuse a false `stdlib-selfhost` role, or widen to `runtime-support:${string}`/`string`. `CreateDerivedIrUnitIdInput.parentId` already accepts `IrSourceId`; no input-domain change is needed. `src/shared/contracts/identity-values.ts:15–17` already encodes the role and validates its ordinal; its implementation is unchanged and it has no runtime role-enumeration guard to extend. This new literal identifies a support body, not permission to insert it into ordinary derived/source population. T's support validator must reject such contamination, including a matching counterfeit ordinary derived record.

The storage role is the actual `declareNativeStringLiteralTypes` role `["string-type","data"]`, whose canonical recipe uses `createStringDataType()`. D2 must reconcile it with the actual selected issued string pack and complete declaration, not construct another same-shaped but independently required type. Select one canonical ABI required root, or an explicitly compatible alias to an existing root, before reservations. Two required entries later interned onto one token are not a valid alias proof. D1 does not import the backend recipe into pure program validation.

## 6. T transaction, allocations, ABI and codec integration

The following are the **eleven existing T paths**, now explicitly released by P for these changes in a separate worktree:

1. `src/ir/program/input-contracts.ts`: add optional `readonly runtimeSupport?: IrRuntimeSupport`.
2. `src/ir/program/prepared-contracts.ts`: same optional finalized typed field; keep candidate and prepared schemas distinct.
3. `src/ir/program/input.ts`: add the optional allowed key, dense/exact shape checks, and joint copy/restore. No supplied prepared async attachments inside support functions.
4. `src/ir/program-preparation.ts`: after successful real source preparation and before capture, call the new frontend producer exactly once. Enforce explicit standalone-WasmGC policy before admitting its batch; backend-only legality is insufficient. Then capture, resolve controls, enter the existing single typed transaction/finally counter path, and observe only a successful prepared result. Preserve existing policy failures and original thrown-error identity; do not wrap unrelated errors or double count failed preparation.
5. `src/ir/program-prepare-ir.ts`: carry support through each object reconstruction and the **same semantic freeze before runtime attachment authentication**. Validate explicit standalone-WasmGC policies and initial/final primary-demand joins even when the caller directly supplies typed input, bypassing the historical wrapper. Keep support bodies on their inherited self-host CF/DCE/CFG pipeline; do not silently feed them through ordinary source inlining/GVN or add fake source units. Run the required final allocation analyses for their real string sites with resolved existing controls, then freeze them jointly. Existing source GVN counters/failure/finally behavior remains unchanged.
6. `src/ir/program-abi-contracts.ts`: accept the optional batch, normalize new support-ref keys (including the recursive support-ref case of `preparedIrDataKey`) and add exact support type/callable entries, including support `sourceId` ownership. All old-arm keys remain unchanged. No changes to the ABI class or generic catalog.
7. `src/ir/program-validation.ts`: independently validate support population and each function using the full declared-signature table. Reuse body call/global/provenance validation over the separate support vector, with its own exact callable owner rather than a unit-callable lookup. Do not put support bodies into the primary `functions` map used for startup/population. Primary validation remains unchanged in scope.
8. `src/ir/program-allocations.ts`: additional support-body traversal and metadata analysis, preserving every original primary and async-state traversal, snapshot size/state/alias/namespace checks and source references.
9. `src/ir/program-codec.ts`: shape-check and explicitly include support in `reauthenticatePreparedIrProgram`'s reconstructed result (currently lines 432–445), then complete validation. No TS rebuilding on decode, no opaque field silently retained only by generic JSON encoding. Re-encode exact canonical bytes and retain all current special-value/alias rules.
10. `src/ir/prepared-component-dependencies.ts`: record support type references and the complete separate support-body dependencies. Preserve old raw-ref handling and existing callable/type dependency failures. This is the shared R/T join owned solely by T.
11. `src/ir/program-source.ts`: only `captureTypedIrProgramInput(source, runtimeSupport?)` and its explicit projection change. Include the batch in the existing `allocations.capturePreparationData(...)` graph. Do not append an independently cloned batch or change source lowering/options here.

`program/data.ts`, the registry's capture/restore implementation, `program-population.ts`, startup, async schema/attachment/codec authority, canonical ABI class and global runtime declaration catalogs are not new write targets. No new prepared-closure or P schema-v2 transport is adopted. Any genuine newly discovered requirement must be named for parent scope reconciliation before editing it.

The single-literal edit in `src/shared/contracts/ir-identity.ts` is an explicit **additional T-owned path outside the eleven released P paths**, requested and approved for this contract; it is not a wider P release or an R/F ownership transfer. Add to existing `tests/issue-3521-pure-identity-values.test.ts` an actual canonical source-parent/new-role/ordinal-zero output assertion while retaining both old controls and public re-export identity. Add a compiler-checked closed-role control (new literal accepted, misspelled sibling/general runtime-support string rejected without a cast) and source-free support replay/foreign-role negatives in T's tests. No new global runtime role validator or identity factory is required.

Allocation sequence: source lowering first; support lowering against that same live registry next; one joint capture/restore; inherited support hygiene already complete; final source/support analysis; one semantic freeze/snapshot; runtime attachment producer authenticates final existing primary identities. No authenticated attached object is cloned afterward. Actual static producer accounting is four literal sites plus fin's string-result allocation; post-pass registry state must explain any retirement/alias. `__nfd_new`'s internal Wasm allocation is not a fake semantic object/JS-vector site: `AllocKind` excludes black-box builtin internals.

ABI order: keep all old non-runtime entries in their original relative order. Insert D1 support entries **before the canonical runtime tail** in this fixed order: scratch type, new/get/set/fin/trap kernel callables, body callable. Their source-order/declaration-order slots use the same existing counter/entry anchor. This adds seven typed entries, not seven source units. Update complete runtime-order reconstruction accordingly: `validateRuntimeCallables` currently calculates its tail start by counting all non-runtime entries at the anchor. Appending support after the tail but leaving that calculation unchanged is wrong. The canonical runtime formatter entry keeps its existing owner-free declaration; do not add support source ownership to it. All no-demand entry vectors remain exact.

Prepared support type/callable entries use real required type/function slots, except an explicitly validated compatible alias selected by the later physical plan; never `kind:support` slotless intents as executable authority. Keys/signatures come from the one semantic factory, not body usage guesses. Supplemental physical kernel/thunk/local-type recipes are D2 and must reconcile to these entries before the same ABI plan seals and the same module ledger reserves/freezes/fills.

### Exact type-ownership and dependency-caller amendment

`ProgramAbiIntent`'s type arm is exactly `{kind:"type", shapeKey}`; do not add `sourceId` or edit `src/ir/program/abi.ts`. The six callable intents use their existing `sourceId` field. Scratch type ownership is a program-validation proof: derive the actual entry-source anchor independently, rebuild its canonical formatter declarations, and compare the scratch binding ID, structural reference key, complete semantic type/nullability/shape key, required type slot and exact support-group order. Validate the seven support entries before the runtime tail. A matching shape or numeric source order alone is insufficient; foreign binding/source substitution, alias/slotless replacement and reordered entries must fail. The generic ABI class is not claimed to independently authenticate type-source ownership.

The two current production calls to `derivePreparedComponentDependencies` are in `prepared-component-sealing.ts` (624 in the inspected tree) and `compiler-timer-shim-preparation.ts` (367). They are legacy source-terminal/physical-readiness paths, not T's whole-program transaction. Do not expand those callers or append support bodies to their module/terminal populations. Logical strings in D1 do not yet satisfy that collector's physical carrier requirements.

Within the already T-owned `src/ir/prepared-component-dependencies.ts`, keep the explicit support-ref arm for existing component callers and add a separate proposed export:

```ts
export function assertPreparedIrRuntimeSupportDependencies(
  input: Pick<PreparedIrProgram, "inventory" | "runtimeSupport" | "abi">,
): void;
```

This assertion traverses actual separate support bodies and their declared signatures, not only stored occurrence receipts. Reconcile every explicit symbolic type/callable reference with the validated ABI, including parameter/result types, block argument types, nested instructions and their type/reference fields. Reject unsupported dependency-bearing forms rather than ignoring them. Use the canonical formatter factory, not a second signature catalog. Keep semantic string/allocation requirements distinct from unfulfilled D2 physical carrier/materializer readiness; existing structural support, allocation and full SSA checks remain mandatory. No fake terminal, physical index or all-clear physical component report is produced.

The only new production caller is already T-owned `src/ir/program-validation.ts`: call this assertion after structural support and exact support ABI-entry reconciliation. `prepareTypedIrProgram`, codec reauthentication and backend admission already call `assertPreparedIrProgram`, so they reach the same check. No existing production path outside T's eleven requires a caller edit. Keep old component input/report shapes and no-support verdicts unchanged. Add the genuine-radix positive and missing/foreign type or callable, wrong shape/nullability/order, nested-reference and codec mutation controls in the already owned runtime-support transport/codec tests. A local static import/export projection of the current dependency module found 15 runtime modules, no listed frontend/codegen/from-ast path and no unresolved static specifier; this is not universal closure or an executed source-free test.

## 7. Ownership, ordering and real parallel work

Read and verified P's actual `.tmp/3527-p-handoff.md` first section on 2026-09-09. It explicitly releases the above eleven current paths **after this High freeze, in another worktree**, for typed support, once-only frontend production, joint allocation capture, existing ABI and codec validation. Paused P HEAD is `6037ac8bcf07be4f71839cea33cf8c90ecc87f94`; its twelve source drafts remain untouched. This is a scoped release, not absence of file overlap or permission to overwrite old P schema-v2 work. Other live claims still require parent checking.

Do not touch the current Hilbert declaration lane's seven production files: native-resource-declaration-types, native-resource-declarations, closure-layouts, argument-vector-bodies, native-closures, native-argument-vectors, native-promises; or its five tests. D1 scratch storage records are semantic contracts, not an excuse to alter that physical recipe lane. No C consumer/physical-plan implementation is included here.

Dispatch order:

1. R and F can work in disjoint isolated trees after parent claim checks. F may extract/verify the genuine legacy build kernel and preserve all existing callers while R lands the new leaf; no fake replacement type for pending R. Their joined original-radix positive is mandatory before declaring R usable.
2. T's owner can implement the two pure contract modules, schema/codec controls and source-free harness against these exact interfaces concurrently; its released eleven-file production integration consumes R+F only after their frozen hashes. F does not edit the eleven T paths. T alone integrates the real wrapper trigger, ABI insertion and dependency join.
3. Parent composes the frozen sources, exact original receipts and mandatory actual roots; runs scoped type checks and preservation suites, then fresh-process original/decoded preparation. Publish a bounded D1 checkpoint with explicit D2 physical refusal if that is still the actual next boundary. Do not label it full formatter acceptance.
4. D2 physically reserves/fills donor-backed scratch kernels/body/thunk and the remaining formatter resources through the existing one ABI/ledger; parent wires real consumer dispatch and tests full formatter/native family. No new unused helper checkpoint should stand in for this dependent execution obligation.

## 8. Tests and preservation contract

T owns new tests:

- `tests/issue-3518-runtime-support-transport.test.ts` — real whole-source original family plus no-demand controls; separate source/support populations, canonical refs/signatures/ABI order, global/startup/source-owner preservation.
- `tests/issue-3518-runtime-support-codec.test.ts` — actual encode/decode/re-encode, body/callee/literal/allocation identity and values, canonical reconstruction failures.
- `tests/helpers/runtime-support-source-free.mjs` and `tests/issue-3518-runtime-support-source-free.test.ts` — nonempty prepared/decoded support input, guarded fresh process, no TypeScript/ts-api/frontend/from-ast/stdlib/codegen loads; real complete validator. Not an emission claim while D2 is missing.

Parent-owned additive gate/receipt work is limited to the existing compiler-boundary policy/test and existing preservation ledgers actually affected by R/F/T. Keep all original active roots/history, allowed edges, N1 six/full-cut, core ten/full-cut, twelve execution witnesses and strict unknowns unchanged. New canonical modules must be mandatory, with deletion/import-type/type-query/barrel/runtime forbidden-edge negatives; classify mixed existing wrappers as existing debt. New exported function preservation needs real frontend/typed-program call paths, not class visitation or test-only fake callers. No baseline budget edits/growth credit. If a historical receipt touches changed bodies, use a checked exact relocation/inverse delta and retain the original hash/order/count rather than replacing it with a new snapshot.

Mandatory positive-first negative controls, across R/F/T:

- Exact genuine template/definition first, then altered source/callee order/signature/name/target/missing trap; all five declared roles and all sixteen source call occurrences remain counted independently.
- Wrong source anchor, foreign support ID, absent/reordered/duplicate kernel, wrong B nullability, width/mutability/string-data role, changed fin return, unknown callable, fabricated raw-index type, injected async/global/closure attachment.
- Real support body and complete source demand first; deletion of batch, deletion of both batch and its own demand receipt, or equal visible foreign owner still fails independent primary-demand reconciliation.
- Call target/result/argument, branch/slot/return mismatch; removed literal, changed literal value, missing/shared-foreign allocation, stale alias/retired/live metadata or extra unsupported namespace retains exact existing error behavior. Joint capture preserves actual aliases/unknown values before final admission; never silently filter them.
- Codec payload mutated at each support field; canonical bytes and no-demand roundtrip unchanged; no TS parsing/compile retry during replay. Symbolic scratch IDs survive changed physical reservation offsets without hidden index rewriting.
- One build/transaction/observer and original error identity, including failure; no new ambient option reads or double GVN accounting. Support hygiene order remains the donor order.

Use the actual `tests/issue-3305.test.ts` inputs as historical formatter controls, but not its permissive dummy-import construction for standalone execution acceptance. D2 must execute the actual prepared radix/full formatter on original and decoded programs, repeated instances, exact values/traps/binaries/WAT/resource order and empty UTF16 resource behavior; UTF8 policy is not inferred from the four ASCII literals. Preserve inherited fractional differences separately. Full original async-family acceptance still requires real timers70/3e9, sequential/reverse Promise.all/rejection, formatted output, void/undefined, complete selected-state/spill traversal and authentic native value/object/closure dependencies.

## 9. Remaining limits

### Bounded existing native-family fixture amendment

T may add `tests/helpers/native-family-runtime-support.ts` with the explicit helper `captureNativeFamilyRuntimeSupport(source: IrProgramSourcePreparation, policy: RuntimeManifestPolicy): TypedIrProgramInput`. It calls the real `prepareNumberFormatRuntimeSupport(source, policy)` exactly once, requires the one demanded batch, and then calls `captureTypedIrProgramInput(source, support)` once on that same source/registry. No policy defaults, repair-on-replay, hand-built IR, name-based demand, global memoization or independent support clone. The helper runs only on the frontend side of transport.

The source-grounded existing test write map is exactly: `tests/issue-3518-native-promise-resources.test.ts` (its full-family prepare helper); `tests/issue-3518-native-vector-resources.test.ts` (its full-family prepare helper); and `tests/issue-3518-native-family-source-contract.test.ts` (the typed original/decoded native-policy matrices and fresh-process packet construction). Keep source-only capture/identity controls source-only. Deliberately omitted-native-policy tests must start from a valid support-bearing packet produced with an explicit native policy, then pass the unchanged deficient options to typed preparation; preserve the exact existing located policy refusal. Do not substitute a missing-support failure for it. Preserve both source variants, GVN modes, replay forms, primary 5/22 and transformed 16/33 populations and every allocation; report support separately.

Do not change generic `tests/helpers/typed-program-fixtures.ts`, delay-only callable replay/certified-delay fixtures, ordinary string-number fixtures, or public/historical compiler fixtures merely to populate support. Those inspected paths do not carry the formatter demand. Do not load the new frontend helper inside a source-free child; serialize its complete result first and retain the existing child import guard unchanged. Existing T transport/codec tests retain their direct genuine producer route and positive-first missing-batch/deleted-demand controls. Add a genuine raw family source/capture without support as an explicit missing-support negative; never make absence a compatibility success. New dependencies exposed after valid capture remain failures, not permission to prune support allocations or alter resource expectations.

No tests, compiler runs or physical executions were performed for this specification. The exact source and declaration hashes were read/compared; static type-consumer inspection is not universal checker/graph closure. Additional concrete exhaustive switch failures require named ownership changes. Codec internal-IR validation is not authentication against deliberately fabricated hostile live JavaScript objects. No provider authorization is inferred from a name or source hash.

D1 closes two actual source/transport blockers while preserving separate source and support authorities. It does not complete D2/Ryū, full formatter physical resources, native async materialization/public default cutover, host/linear migration, the ABI30 missing planningSealed public witness, or direct-codegen retirement. Existing unknown-closure failures and holds remain.
