# Frozen D2 delta: native formatter in the existing prepared-program consumer

Status: implementation specification, not an implementation or execution receipt. High inspected the complete current planner, consumer, native-string/value aggregate, requirements and scratch aggregate, and Euclid's final formatter resource implementation read-only. This document refines the frozen D2 contract; it does not supersede its source-population, ownership, preservation or full-async requirements. Parent owns all proposed source changes and claim reconciliation. No tests, typechecks, hooks or source edits were performed for this specification.

## 1. Pins and the concrete result

Parent is `/private/tmp/js2-3518-number-format-consumer-20260909`, HEAD `445f65523b9b8023339ef344e0eed7a62e1a7bcb`. Inspected SHA256:

- `src/ir/program-consumer.ts`: `3a73462da6a22468023bdce07a71dda21eaa536fcebc6548b86980e36d089bcb`.
- `src/ir/program-physical-plan.ts`: `8529ddbce0557ab08ae6abed7e42d335f19aa5d34edf139e5136d658cc6ac157`.
- `src/backend/wasmgc/program/native-string-values.ts`: `4ab8b0935c226e01f5d8ff5682a5631291243fb966b413bfe31f7e75ba749b0c`.
- `src/backend/wasmgc/program/native-number-format.ts`: `fa420d785cb532635e37674ac4a4eb818399a79d6ea6f074f3f05d53b214eac9`.
- `src/ir/program/native-number-format-requirements.ts`: `cf31b5035416374d3240ba2ef56e979004ebdea4b65a4c05476caa494ce65022`.

Euclid final sources are in `/private/tmp/js2-3518-native-number-format-20260909`, on `57b4ee9ebd67f04251fe467d708e4990202b6ca7`. In particular the final resource owner is `src/backend/wasmgc/resources/native-number-format.ts`, SHA256 `19952b62d0c36e3a0b70b09faf344f550342cc7ebbfab60a72aa407187d49fff`; the inline literal owner is `src/runtime/wasmgc/values/string-literal-bodies.ts`, SHA256 `c5cd6dad450a3eaffa4d07c5864ec89bd09b2170d544c0373faa2773a42fcafa`. Compose the entire reviewed F source checkpoint and its tests, not just these two files. R is already composed in parent; preserve its actual named/unnamed interning behavior.

The deliverable is a production branch in `acceptPreparedIrProgram` -> `planPhysicalSetup` -> `emitAcceptedIrProgram` that reserves the complete formatter closure, binds its actual resources to the existing ABI, lowers the genuine transported D1 body into its reserved support slot, and checks completion in the same module transaction. It must not stop at another callable resource test or unused planning helper.

Current concrete omissions:

- Acceptance's string selection at consumer 232–253 returns no owner for zero literal/unbox demand. Formatter demand is independent of that selection.
- `nativeStringSetup` already joins the scratch root, but only when that string selection exists; it does not map the six D1 callables or the canonical native formatter callable.
- The physical plan still rejects the six support function entries and formatter runtime entry. Its reserved-call sets contain no formatter closure.
- `AcceptanceRecord` retains no formatter requirements or provider-prepared D1 body. The consumer fills only primary projection bodies, string/value resources and vectors.
- F intentionally does not fill `radix-body`. Its sealed-completion check therefore cannot succeed until the consumer supplies the real body.

## 2. Authority and population constraints

Use the existing module-private `acceptances` WeakMap and the existing single-use `emissions` WeakSet. No new acceptance registry, synthetic ordinary unit, codegen context, frontend callback, ABI class change or codec field is needed.

`NativeNumberFormatRequirements` is borrowed descriptive evidence. Reuse `deriveNativeNumberFormatRequirements` and `assertNativeNumberFormatRequirementsCurrent`; do not clone its program/projection/batch/instruction/metadata associations and treat that clone as authority. The public physical plan is deep-frozen descriptive data; the private acceptance record retains the original requirements and prepared body.

Retain three disjoint ownership sets: all original selected primary functions; the single D1 support implementation; other runtime resource functions. The D1 body is not added to `program.ir.functions`, `runtime.prepared.functions`, `derivedUnits`, startup or `emittedUnitIds`. Its existing support callable entry, not `irUnitCallableBindingId(body.unitId)`, owns the physical slot. A real support-body object and all runtime objects must nevertheless be present in the final module ownership census.

The six D1 callable mappings are five kernels plus one body, NOT the six unrelated native-async public contracts. Separately, exactly one existing native-async formatter contract is implemented by this checkpoint. Delay, all, clock, console and concat do not become supported through that association.

## 3. Exact additions to the existing backend aggregate

Extend `src/backend/wasmgc/program/native-number-format.ts`; do not move lowering or provider preparation into this clean aggregate. Preserve `planNativeNumberFormatScratch` and its existing callers. Reuse canonical `NativeResourceRecipe`, `NativeStringLiteralRequirements`, `NativeNumberFormatResourceInput`, `IrUnitId` and the existing scratch-plan type.

Proposed exports are frozen as follows:

```ts
export interface NativeNumberFormatStringLayoutPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly mode: "formatter-layout";
  readonly literalRequirements: NativeStringLiteralRequirements;
  readonly literalUses: readonly [];
}

export interface NativeNumberFormatPhysicalPlan extends NativeResourceRecipe {
  readonly input: NativeNumberFormatResourceInput;
  readonly scratch: NativeNumberFormatScratchPlan;
  readonly supportUnitId: IrUnitId;
}

export function planNativeNumberFormatStringLayout(
  requirements: NativeNumberFormatRequirements,
  utf8Storage: boolean,
): NativeNumberFormatStringLayoutPlan;

export function planNativeNumberFormatPhysical(
  requirements: NativeNumberFormatRequirements,
  stringKey: string,
  strings: NativeResourceRecipe,
): NativeNumberFormatPhysicalPlan;
```

Both call the existing currentness assertion before returning data. Validate `utf8Storage` as an actual boolean. Define the formatter key once privately here as `"native-number-format:v1:" + JSON.stringify(requirements.batch.sourceId)`. This generates a structural owner-qualified key; it never parses an encoded ID. F's input is `{ key, stringKey, integerBeforeScratch: requirements.integerBeforeScratch }`. The layout-only string key is `key + ":strings"`. When source string resources already exist, use their actual `literalRequirements.key`, never that fallback key.

The layout plan consists of `declareNativeStringLiteralTypes(stringKey, utf8Storage)` followed by `declareNativeStringLiteralResources({key:stringKey, utf8Storage, literals:[]})`, with exact concatenated declarations/steps. Its `literalUses` is empty. This is a real empty literal pack with a real type owner, not a fake empty-string demand. It allocates no literal global/materializer, scanner, value box, undefined or flatten pack merely for formatting. D1's four literals remain inline and are not inserted here.

The formatter plan calls `planNativeNumberFormatScratch(requirements,stringKey,strings)` and `declareNativeNumberFormatResources(input)`. It returns the exact recipe without regrouping its declarations or steps. Do not copy F's signatures, generate dummy physical indices, or reserve a scratch module to discover them. No new private issuance registry is appropriate for these descriptive functions.

The existing `native-string-values.ts` and `collectNativeStringValueDemands` need NO production edit for this integration. Their `none` outcome is still truthful. In particular, do not force `planNativeStringValuePhysical` to claim a source demand that does not exist, or feed a fabricated input to `reserveNativeStringValueResources` whose `checkInput` correctly rejects it.

## 4. Exact physical-plan and private-record shape

In the already mixed `program-physical-plan.ts`, widen only `PhysicalNativeStringSetup.resources` to:

```ts
NativeStringValuePhysicalPlan | NativeNumberFormatStringLayoutPlan
```

The common fields used by descriptor reconciliation remain key, declarations, reservationSteps, literalRequirements and literalUses. The discriminant `mode` distinguishes the honest empty-layout case. Preserve `bindings` and the existing exact `formatterScratch` field.

Add:

```ts
export interface PhysicalNativeNumberFormatSetup {
  readonly resources: NativeNumberFormatPhysicalPlan;
  readonly bindings: readonly NativeStringValueAbiBinding[];
  readonly support: {
    readonly unitId: IrUnitId;
    readonly reference: IrFuncRef;
    readonly bindingId: IrBindingId;
    readonly resourceKey: string;
    readonly params: readonly PhysicalSignatureType[];
    readonly results: readonly PhysicalSignatureType[];
  };
}
// PhysicalSetupPlan:
readonly nativeNumberFormat?: PhysicalNativeNumberFormatSetup;
```

The `support` signature is derived from the canonical D1 declaration; `resourceKey` is obtained by unique role selection from F's recipe (`["number-format","radix-body"]`), not by searching display names. The physical plan does not carry a second body or provider authority.

The planner also needs the actual provider-prepared support body to check its dependencies, not merely the raw semantic body. Add this explicit descriptive input in the same mixed planner owner, importing the existing prepared-manifest type from its canonical runtime contract:

```ts
export interface PhysicalNativeNumberFormatInput {
  readonly requirements: NativeNumberFormatRequirements;
  readonly support: PreparedIrRuntimeManifest;
}
```

Extend the existing `planPhysicalSetup` argument list additively with a final optional `formatter?: PhysicalNativeNumberFormatInput`, after the existing optional native-string reservation input. Revalidate requirements currentness and exact program/projection association, and require the one support function/manifest to pass the full semantic/provider comparison in section 6. The consumer supplies the real result of that preparation, not a structural cast. This public planning function still issues no acceptance. Existing callers with no new argument retain their old behavior. If formatter demand exists but this argument is absent, the checked consumer must not suppress the existing missing-support/resource failure.

In `program-consumer.ts`, keep `AcceptanceRecord.nativeStrings` source-only. Add a private `nativeNumberFormat` record containing:

- the exact `NativeNumberFormatRequirements`;
- the actual `PreparedIrRuntimeManifest` returned by the existing support-body preparation described below;
- its one `PreparedIrFunction` and a complete frozen value snapshot of that prepared function.

Use these real existing types; no callback, raw resource index, `any`, erased body type or fabricated prepared function. A public clone of `PhysicalSetupPlan` conveys none of this authority. Layout-only string requirements live in the accepted descriptive plan and are rederived from the private formatter requirements; they need no second opaque pack before emission.

Update the current Boolean(native)/Boolean(record.nativeStrings) consistency check: a string setup is legitimate either with an exact source `NativeStringValueReservationInput`, or with `mode:"formatter-layout"` plus the exact retained formatter record and no source input. Reject missing, extra and contradictory combinations. Do not disable that check wholesale.

Layout-only currentness is a separate, explicit two-stage check. In `planPhysicalSetup`, rerun ordinary `planNativeStringValuePhysical` on the complete real source/selected census and require its result to be `none` before selecting the layout fallback; a failure or newly planned real demand is not interchangeable with `none`. Compare the fallback to freshly derived `planNativeNumberFormatStringLayout(requirements, options.utf8Storage)`. In `prepareNativeEmission`, repeat both checks and compare the entire accepted fallback recipe, literal requirements, key and empty uses to the new result before the first module allocation. Re-derive/compare the formatter recipe and scratch join too. This is what replaces source `checkInput` for this independent dependency; a Boolean, accepted mode label, or only validating the issued literal pack later is insufficient. For the ordinary source branch retain its exact existing `checkInput`/issued-value-plan checks unchanged.

## 5. Preallocation ABI: seven callable associations, one scratch root

Derive the source anchor through `preparedIrRuntimeAbiAnchor`; require it to equal `batch.sourceId`. Reuse `numberFormatRadixSupportDeclarations(batch.sourceId)` and the program's actual entries. For each of the six support declarations require one exact existing entry: required function slot, same structural ref/binding ID, complete callable contract, no Promise contract, support origin, exact sourceId and `preparedIrCallableSignature` matching the canonical params/results. Preserve the entire existing entry, including its order/display name, rather than minting a replacement.

Exact association to F roles:

- kernel `new` / `__nfd_new` -> `["number-format","new"]`.
- kernel `get` / `__nfd_get` -> `["number-format","get"]`.
- kernel `set` / `__nfd_set` -> `["number-format","set"]`.
- kernel `fin` / `__nfd_fin` -> `["number-format","fin"]`.
- kernel `trap` / `__num_fmt_trap` -> `["number-format","trap"]`.
- `declarations.implementation` / `__sh_num_toString_radix` -> `["number-format","radix-body"]`.

Canonical kernel order is new/get/set/fin/trap. Physical reservation order is finalize/new/get/set/trap/fin/body/thunk. Do not reorder either population to make the lists line up; join by canonical role, then preserve each ordering independently.

Compare the faithful symbolic projection of each semantic signature to the actual recipe signature before allocation: f64 remains f64; string -> nonnull ref to `nativeStringTypeKeys(stringKey).any`; the exact accepted scratch support-ref -> ref/ref_null to `.data` according to its own nullable bit. Reject other nominal support refs, guessed physical carriers and erased nullability. D1 B/new's result is nullable; Ryū toBuffer's data parameter is nonnull. These are intentionally different contracts, not a reason to widen one.

For the seventh association, obtain the unique canonical declaration with feature `async.native.number-to-string` through the existing native-callable catalog, and the selected canonical provider `native.async.number-to-string`. The declaration's ref is an **intrinsic** ref; its existing ABI intent origin is therefore `intrinsic`, not `runtime`. Compute its ID using `preparedIrRuntimeCallableBindingId(program.inventory, declaration.ref)`. Require its exact existing required function entry, structural key, no-Promise callable contract and canonical logical `(f64)->string` signature. Compare every accepted call and selected policy/provider as the requirements layer already does, and compare the provider's complete implementation/dependencies/targets/capabilities. `nativeAsyncProviderMismatch` is reused; never infer authorization from the symbol alone.

Map that declaration reference to `["number-format","native-to-string"]`, whose actual body is the carrier adapter. The provider implementation's `__ir_number_toString_native` symbol describes this canonical route; do not mint a second runtime-ref ABI entry merely because the canonical call ref is intrinsic. The raw `["number-format","to-string"]` is `(f64)->externref` and gets an independent supplemental internal support entry. Likewise the radix thunk's externref result is not the D1 body's AnyString result.

Scratch remains exactly the current approved join: the existing D1 type entry owns the canonical mutable i16 data-array resource. Register the D1 ref and the generated canonical string-data resolver ref against that same required entry/token. Suppress the generated second required entry; reject an independently required competing root before allocation. Preserve an already declared compatible alias only through existing ABI canonicalization; do not invent one. No type-intent `sourceId` schema addition is needed: exact canonical source-ref, required type contract, shape key and source order already authenticate this owner.

Every remaining F declaration receives an internal support/type/global entry from the existing reference factories and the full symbolic declaration key scheme. Reuse/refactor `internalNativeBinding`, `nativeRole`, `nativeDeclarationKey` and `nativeReferenceKey` in this mixed owner; do not copy them into a clean backend module or import `abi-bindings` upward. Their existing versioned role/key format can describe the distinct `number-format`/`number-ryu` roles unchanged. Reject incompatible preexisting entries, duplicate resource keys, inconsistent reference routes and any one required ID owning two tokens.

Append supplemental entries after all existing entries in deterministic combined declaration order: shared string recipe first, then F recipe. Existing semantic entries keep their original order. The recipe order includes its intern operations and is not an ABI-order shortcut. A resource must have exactly one required owner; multiple compatible resolver refs may share it. The F recipe contributes exactly 16 reservation rows: 13 functions, two globals and one type. All 16 must be covered, not just the seven semantically named functions. The implicit function-type cache entries are verified by actual function signatures/interner behavior, not promoted to invented required ABI resources.

Seal the **complete** joined planning vector as a unit. Planning-only validation maps may remain local, but no string-only successful partial seal may conceal a collision with the formatter entries. At emission there is precisely one authoritative `ProgramAbiMap`, fully planned and `sealPlan()` completed before `createEmptyModule` or any reservation. No post-allocation ABI discovery.

## 6. Support runtime preparation and diagnostics BEFORE allocation

The transported D1 body is semantic, not already provider-prepared for physical lowering. Euclid's real execution proof had to call `prepareIrRuntimeManifest`; copying the raw D1 body straight into `lowerIrFunctionBody` is not correct.

Add a bounded private acceptance helper in `program-consumer.ts` that calls existing `prepareIrRuntimeManifest` with exactly `[requirements.batch.implementation.body]`, the selected standalone policy and explicit support source identity for diagnostics. Use `includeEmpty:true` to require an actual one-function result, not a truthy optional fallback. No ordinary source/preparation/stdlib imports occur here. Omit ordinary stringConstDemand: the four support literals have their separate inline authority. Do not project fake builtin/vector demands into this body.

Retain the returned manifest and single prepared function in `AcceptanceRecord`. Check unit/name/signatures, full block/nested population, original call targets, allocation IDs and literal receipts against the transported body. Only canonical post-freeze intrinsic provider attachments from this preparation may differ. The D1 invariant checker already disallows async attachments; preparation must not produce them. Validate complete canonical provider content, not an arbitrary `provider`-stripping comparison. Run the existing backend-legality verifier on the prepared support body as well as all primary bodies, and scan its full nested calls/globals/intrinsic provider dependencies against the accepted resource closure. If an unexpected callable/global/provider/type is needed, acceptance fails rather than allocating it in the lowerer.

The policy has target, whereas `verifyIrBackendLegality` only has backend: explicitly retain the standalone policy check. Do not misstate the verifier as target authentication. Do not swallow provider exceptions or return an empty support population. Use the consumer's existing error convention. If a located failure is returned, locate it at a real recorded primary demand owner/source, with detail identifying the distinct support body/site. `preparedIrProgramOwner` does not make this separate support unit an ordinary inventory owner; never add a synthetic record merely to locate an error.

Before emission, rerun full program validation, requirements currentness and the support runtime preparation/validation against the same program/projection/options. Compare the entire prepared function and relevant prepared-manifest data to the stored values. This is read-only reauthentication, not allocation or a second source compilation. It detects changed provider attachments as well as stale metadata, not merely altered body text. Do not replace the accepted body silently with a new one after comparing an incomplete subset.

## 7. Concrete `planPhysicalSetup` changes

Derive formatter requirements independently of whether string demand planning yields `none`. If ordinary source string planning yields a located unsupported result, preserve that failure; the empty-layout path may not bypass an existing unsupported string operation/regex. Choose:

- source string plan present: use it and later borrow its exact issued literal pack;
- source plan `none`, formatter requirements present: use the explicit layout-only plan;
- neither: leave both physical fields absent and execute the historical path unchanged.

Generalize `NativeAbiContext.resources` only to the declaration-recipe surface it reads. Keep literal-use and native-unbox processing conditional on a real source reservation input; do not pass the new layout mode through `nativeUnboxBinding`/`checkInput`. Use one common binding-owner reconciliation across the shared-string and F recipes. Retain the current scratch hook but drive it from the explicit formatter requirements, rather than merely `program.runtimeSupport !== undefined` inside an optional source-string branch.

Extend `nativeIds`, reserved callable refs and reserved globals with the exact formatter bindings. Skip the existing required-entry gap only when that entry is joined to an authenticated planned resource. A blanket support/runtime skip is forbidden. Treat the one support body as a separately planned body whose calls and providers must close over those sets; no arbitrary support body is admitted.

Include its exact type/call/literal dependency checks and exception needs in planning. Current trap kernel is a real `unreachable`, not an EH import requirement. Preserve global/startup/export checks. Preserve every primary async-plan/runtime gap and all unimplemented delay/all/console/concat/object/closure dependencies. Adding the formatter mapping removes only the formatter-specific missing-resource gaps.

Deep-freeze descriptive `nativeStrings` and `nativeNumberFormat` plans as part of the existing outcome. Do not deep-clone borrowed requirements/provider-prepared functions into them.

## 8. Exact reserve -> reconcile -> freeze -> bind -> fill order

Keep `emitAcceptedIrProgram`'s single-use/observation ordering: mark consumed, raise emission-started, reauthenticate, materialize, then emitted. Failure at any point returns no successful reusable result. An emission-started listener failure still consumes the token; no retry capability is introduced.

Within `materializePhysicalProgram`:

1. `prepareNativeEmission` checks both records/plans and seals all semantic plus supplemental ABI entries before module creation. A native formatter may never take the old delayed ABI-sealing fallback. The genuinely no-native path retains that existing behavior for byte/order preservation.
2. Create one module and one `PhysicalModuleReservations`. Preserve exception-tag, vector-type and shared-string-type reservation ordering. Reserve all imported functions/globals before any defined resource functions/globals. There is exactly one string type pack.
3. Reserve ordinary native string/value resources as today, or call `reserveNativeStringLiteralResources(tx, emptyRequirements, stringTypes)` directly for the layout-only branch. Authenticate its complete issued inventory even when requests/globals/functions are empty. Never consume the type pack twice. Both branches yield the exact `NativeStringLiteralReservations` to pass to F.
4. Call `reserveNativeNumberFormatResources(tx, acceptedInput, exactStrings)` once, after that shared string resource step and before source defined globals/primary function slots. F owns all nested Ryū allocation. Do NOT separately reserve Ryū again or replay its signature steps a second time. Preserve F's actual sequence: finalize; new/get/set/trap/fin; radix-body; radix-thunk; Ryū mulShift, table, inverse, powers, digits, toBuffer; raw to-string; native-to-string.
5. Reconcile both complete producer-authenticated inventories. Refactor the current reconciliation helper to consume authenticated rows plus the matching recipe/bindings, instead of assuming every string owner is a `NativeStringValueReservations`. Source branch uses `nativeStringValueReservationInventory`; layout branch derives rows from `nativeStringLiteralReservationInventory`; F uses `nativeNumberFormatReservationInventory` and `requireNativeNumberFormatReservations` with the exact input/string pack. Compare key/space/population and ordered reserve-step projection; do not sort inventories or accept a count alone.
6. Build one dependency token map containing actual shared string types plus F's own table type. Compare declarations to actual module types/globals/function signatures with `compareNativeResourceDeclarationShape` and `indexPhysicalTypes`. F ref shapes reference the shared string keys outside F's own inventory; passing only F's type map is an integration bug. This comparator is descriptive; producer ownership authentication precedes it. Populate existing `functionsByKey`, `globalsByKey`, `typesByKey`, `resourcesByBinding` with duplicate/second-owner checks.
7. Continue source globals, all selected primary slots, vector helper, then startup adapter in their current order. Do not derive function ownership from numeric counts/names. Preserve stable handles, imported offsets and flat type coordinates.
8. `freezeReservations()` once. Bind every required semantic/supplemental entry exactly once to actual `physicalIndex` values, deduplicating shared resolver refs by required binding ID. `finishBinding()` once on the same map. No new reserve/import/declaration below this point. Existing `internFunctionType` is cache-only in filling; retain that fail-closed rule.
9. Fill source global defaults in their existing place. Fill the source string/value pack, or the empty literal pack directly. Then call F's `fillNativeNumberFormatResources` once. It fills tables/helpers/thunks but intentionally leaves radix-body pending. No completion predicate may claim F complete yet. Continue vector fill in a fixed documented position preserving no-F ordering.
10. Construct the ordinary resolver from the already reconciled maps. Lower the one retained provider-prepared D1 body through the support-specific resolver below, compare actual flattened params/results with its reserved signature, and fill exactly `formatterPack.functions["radix-body"]` once. Continue all original primary bodies through their existing owner-specific literal resolver. No parsing/re-lowering JS or copying a canned radix implementation.
11. Fill start/publication exactly as today, using actual final ABI indices. `seal()` once, then require completed strings/values and `requireCompletedNativeNumberFormat`. The ledger proves the omitted radix-body was really filled and validates all snapshots; the F filled flag alone is insufficient.
12. Walk actual module.functions and validate the disjoint primary/support/runtime/start/vector ownership sets and their accepted order. Add all 13 actual F function objects, including the one tagged as D1 support, to the complete census; do not add its unit to primary emittedUnitIds. Preserve exact observed binding IDs/final indices via existing `recordEmissionObservation`/`emittedProgramBindingIndex`, including aliases. No new observer registry or exposed token.

## 9. Support resolver: exact use, not an escape hatch

Use the ordinary map-backed resolver for exact function/type references, but close the support scope to its six canonical callable refs and single scratch ref. Require every actual support reference to match its D1 declaration; a same-named foreign source ref is rejected. Do not return indices from names or synthesize missing signatures.

`resolveType` maps the canonical scratch reference to the actual shared data TypeReservation; `wasmValueTypeConverter` preserves the support-ref's nullable bit. The body slot itself has `[f64,f64] -> nonnull AnyString`, unlike radix-thunk's externref result. Compare against the actual reserved function type before fill, not solely the declaration used to create it.

`emitStringConst` for this body is separate from `emitPreparedNativeStringLiteral`. Close over its exact accepted support unit/batch/evidence. Require an actual corresponding support literal tuple `(owner,value,originalAlloc)`; reject any own/present storage or materializer field. Original and canonical allocation IDs must remain live and metadata rows/currentness exact. Reject unexpected duplicate/ambiguous tuples if the lowerer interface cannot distinguish them. All current four tuples are backed by independently pinned occurrence paths. Invoke only `buildInlineNativeStringLiteral` with this issued pack's actual nativeStrDataTypeIdx/nativeStrTypeIdx. Preserve WTF16 code units, zero offset and inline array/struct construction; do not pool or UTF8-convert them. Validate any array.new_fixed capacity requirement before accepting; current four are short.

Support providers are those produced/validated during acceptance. A caller-supplied arbitrary provider/resolver callback is not accepted. An unexpected global/call_indirect/frame/object requirement is a located gap, not an opportunity to import a legacy resolver. `internFuncType` delegates to the ledger and may hit only already reserved signatures after freeze. A newly discovered missing signature is a blocker to add to the preallocation recipe/plan with a real source control, not permission to weaken the ledger.

## 10. Minimal source ownership and integration order

Parent's new integration write set is exactly three existing production paths:

1. `src/backend/wasmgc/program/native-number-format.ts`: the two descriptive plan additions above, retaining scratch validation. Clean backend owner, no mixed ABI/lowerer/provider import.
2. `src/ir/program-physical-plan.ts`: descriptive setup union/F setup, exact ABI associations, common owner/call/type closure and gap accounting.
3. `src/ir/program-consumer.ts`: private accepted dependencies, support provider preparation, empty-layout reservation branch, F reservation/reconciliation/fill/support lowering/completion/observations.

No changes to `program.ts` are needed: the resolved numberFormat option already exists. No source/preparation/codec/runtimeSupport schema/ABI class, generic provider catalog, native-string-value aggregate, ledger or paused P/C path is added by implication. Helpers must be genuinely bounded extractions in these owned files; normal file/function budgets apply. If a new helper module is necessary for those budgets, propose its precise imports/ownership before widening the set; do not put mixed logic in the clean aggregate or use an allowance.

First compose Euclid's complete frozen F checkpoint. Then implement the aggregate and physical ABI/planning changes, then consumer integration; parent may stage tests in parallel in separate claimed paths, but planner and consumer must have one writer. Claims for any sibling merge are parent's responsibility. Existing C/P release boundaries do not authorize restoring or overwriting their paused drafts. This delta does not modify async planning/frame/helper accounting or source capture.

Planning/ABI tests: extend `tests/issue-3518-native-number-format-requirements.test.ts`; add `tests/issue-3518-native-number-format-consumer-plan.test.ts`.

Execution integration: use the already frozen D2 paths `tests/issue-3518-prepared-number-format-execution.test.ts` and `tests/helpers/prepared-number-format-source-free.mjs`. Reuse the actual consumer's `tests/issue-3518-native-string-value-consumer-execution.test.ts` and `tests/issue-3518-program-module-completion.test.ts` patterns for emitted index/object assertions; do not turn the scanner/resource harness into purported whole-consumer proof. Boundary adjustments remain parent-owned in the current compiler-boundary policy/test, with all required roots/history/allowed edges preserved. This adds no new clean root beyond the already activated aggregate; mixed planner/consumer stay mixed.

## 11. Required proof and honest current blocking frontier

Planning/authority controls, each negative after a genuine passing plan/control:

- Original and independently decoded full D1 program; both fastpath booleans and UTF modes. Pin all ordinary/selected/support populations separately, including original 16 primary functions/33 calls and the separate support body/kernels. Re-derive requirements for each program, never reuse original identities after decode.
- Six exact D1 entries plus native adapter mapping; sourceId/ref/intent/signature/slot/alias negatives; raw externref versus AnyString substitution; scratch nullability; same-looking foreign program/provider/string recipe; duplicate required data roots.
- Complete 16-row F recipe, actual named intern operations/nested order, full combined ABI order before allocation. Missing/extra/reordered resource and foreign token/type-key negatives. String key/data identity shared by scratch, kernels and Ryū.
- Explicit empty-layout planning using genuine requirements and no fabricated literal demand: zero requests/globals/materializers, real issued type/literal owner, one consumption, no empty global. Label this as a dependency/planning control unless a real whole source packet reaches that branch. Separate from existing primary literals/unbox coexistence.
- Borrowed currentness, retired allocation, alias+metadata identity, altered support provider, absent/changed literal storage/materializer, deleted support body, missing fill, second fill, after-fill mutation, cross-transaction substitution; no success/result on failure.
- Existing sync/no-demand original/decoded ABI order, bytes/WAT/start/export and repeated executed values unchanged. Preserve the original unsupported and repaired-vector provenance of the current no-demand runner; do not invent a new clean baseline.

Actual resource/support execution remains mandatory with the genuine D1-produced original/decoded radix body and exact existing F/R corpora (Ryū edge cases/nonfinite/3e9/subnormals, issue1537 and issue3305/radices, both integer options and UTF modes). Fresh process forbids frontend/TS/stdlib source/legacy codegen; it must perform real provider preparation and use the actual inline helper, not hand IR. Imported global/function offsets and actual signatures/objects must be read from the emitted module. Preserve all F/R donor hashes/old receipts and their negative controls.

**Do not fabricate a whole-consumer formatter success at this source pin.** The current D1 source producer collects canonical `async.native.number-to-string` calls and the current source route produces those in the authenticated async family. It does not expose an ordinary synchronous formatter source entry. `planPhysicalSetup` still rejects those primary async bodies and other family resources. A consumer branch can be fully wired now, but a successful full-family run is blocked on A/B/C/E. Removing async owners, editing a packet's demand owners, injecting a source-looking formatter wrapper, or bypassing the acceptance WeakMap would turn the proof into a mock and is forbidden.

Accordingly the present actual-family integration test must retain its complete source packet and explicit async failure while verifying formatter-specific planning/ABI gaps are resolved; it must not assert a smaller total gap count if unrelated gaps changed. The existing genuine support/resource execution proves the body implementation, not the still-unreachable whole-program success branch. Keep the eventual end-to-end test obligation visible, not silently skipped or reported green. If parent wants a new ordinary synchronous source admission as an independent route, that is a separately scoped source change and release, not part of these three files.

When complete A/B/C/E plans are composed, use the already integrated branch without alternate test-only wiring: fresh decoded full family, GVN off/on, both UTF modes/options, timers 70 and 3e9, sequential/reverse parallel, empty timing, rejection, exact formatted/newline output and canonical undefined; 5/22 -> 16/33 primary census plus distinct D1 support. Remove the async refusal only for complete authenticated owner plans after that acceptance, never as a D2 expedient. Public compiler default cutover, ABI30 planningSealed witness, six/ten/twelve evidence distinctions and strict-closure/retirement unknowns remain unchanged.

This delta has no unresolved ABI/scratch/literal ownership decision. The remaining blockers are concrete implementation/composition and the separately tracked complete async/source-reachability frontier—not permission for a narrower formatter or a second authority.
