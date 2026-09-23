# D2 High contract: complete native number formatter and prepared radix materialization

Status: FINAL frozen High implementation contract for scoped parent dispatch, not an acquired claim, implementation, execution receipt or publication authorization. Replaces the adjacent paused D2 working draft. Source was inspected read-only in `/private/tmp/js2-3518-runtime-support-transport-20260909`; the parent confirms published D1 PR5797 at `efe352fee8afc3feb6a28c34d00fc658dc1fb205`. Parent approved the overall mapping and explicit resolved numberFormat option. This revision incorporates the reviewed Hilbert candidate at `/private/tmp/js2-3518-symbolic-support-ref-20260909/.tmp/ryu-d2-candidate-contract-2026-09-09.md`, with the exact file/signature amendment below. Parent still reconciles live ownership before writers start. No tests/hooks were run by High and no production files were changed.

The approved overarching plan is `plan/agent-context/3518-native-async-consumer-implementation-spec-2026-09-09.md`. D2 follows D1; the original five-owner async family still requires A/B/C/E and the complete consumer join. D2 must deliver real Ryū plus the genuine prepared radix body, not integer-only formatting, an imported host formatter, a resource-name stub, or removal of the async refusal.

## 1. Exact result and scope

Implement the entire dependency closure behind the existing native `(f64)->string` formatter: finalizer, five radix kernels, D1 radix body, radix externref thunk, Ryū tables and three functions, raw decimal formatter, and its actual native-carrier adapter. Both the legacy compiler and the new prepared resource path use the same canonical executable builders. Parent wires the resources and separate support body into the actual prepared consumer's preallocation ABI, single ledger and ownership census.

Keep the existing fixed/exponential/precision algorithms and their legacy callers intact while extracting shared formatting helpers. Move their executable construction into the same canonical body owner where required to avoid duplicating shared helpers. This does NOT newly admit those methods into the prepared program: D1 currently authorizes only the actual `async.native.number-to-string` contract. Their existing approximation debt is not repaired or hidden here.

Do not edit D1 source templates, support schema, semantic scratch type, typed capture/codec, source populations or global provider catalogs. Do not implement new host/linear behavior. No second ABI map as emission authority, scratch module, guessed index, generic callback carrying legacy context, or post-reservation discovery of required declarations.

### Measured donor pins

SHA256 of inspected complete files:

- `src/codegen/number-format-native.ts`: `780f229fa2ea01fb33c2abf3070271b9e8d401a6b6096eec19d05af7f9b7c4ff`.
- `src/codegen/number-format-selfhost.ts`: `179ef0f195aae80f68a9a2320e80514445d8c5a2ae3cce6d5da1c6ad3633a582`.
- `src/codegen/number-ryu.ts`: `053b4b0b4e6e3c600b4eccde3e68f507780dc12ad23ee8852541ffc052373724`.
- `src/codegen/number-ryu-portable.ts`: `ec0450015d106bdccac7f79edfff2be0f319e0437d1bffc729c3f3bcbe036d46`.
- `src/stdlib/number-format.ts`: `690ccc224e4a171e226baa532edba14cde56cacf29583c07be7a8bd0fd9e1ca6`.

Supplemental AST counts are non-import/export statements / top-level function declarations / all body-bearing function-like nodes: native-format 23/14/20; selfhost 5/3/4; Ryū 25/14/33; portable 2/1/4; stdlib definition 5/1/1. All have zero classes. These do not replace the existing D1 17-selected-declaration ledger or any older receipts. Pin nested helper bodies, constant initializers, documentation and unchanged adapter statements as well as moved bodies.

## 2. Shared interfaces: canonical bodies and declarations

Names below are proposed exports to implement; existing types named here must be imported from their canonical owners. Runtime body files may import only the already-permitted native-runtime/foundation/Wasm-model dependencies, never frontend, program preparation, codegen, physical allocator or provider-selection implementations.

Use `FuncHandle`, `Instr`, `LocalDef`, `ValType` from Wasm model. A body result is `{ readonly locals: LocalDef[]; readonly body: Instr[] }`; no function index, allocator, callback or module mutation is returned. Builders allocate fresh output arrays as the donors do. Numeric type/global coordinates are permitted only at this already-physical body layer, supplied by authenticated resource owners.

### Hilbert body APIs

New `src/runtime/wasmgc/values/number-ryu-tables.ts`:

- Move `pow5`, `log2floor`, `computePow5`, `computeInvPow5`, `toSignedI64`, `buildInvSplit`, `buildSplit` and their exact constants from `number-ryu.ts:47–115`.
- Export `buildRyuPowerTables(): { readonly inverse: readonly bigint[]; readonly powers: readonly bigint[] }` and `createRyuPowerArrayType(): ArrayTypeDef`. They use those single canonical implementations; do not maintain copied tables or a second arithmetic formula.
- Also export `buildRyuInverseSplit(): bigint[]` and `buildRyuSplit(): bigint[]` as the respective canonical generators, with exact source inverses to old `buildInvSplit`/`buildSplit`. `buildRyuPowerTables` calls these two once each. The legacy adapter calls each individually inside its original missing-global branch: an independently preexisting inverse or power global must not cause its table to be regenerated just because a combined API is convenient.
- Preserve 291 inverse / 326 ordinary entries, two signed i64 limbs per entry: 582 / 652 values, low limb before high limb. Array type is the donor immutable i64 array named `__ryu_i64_arr`.

New `src/runtime/wasmgc/values/number-ryu-bodies.ts`:

```ts
buildRyuMulShiftBody(): NativeRyuBody;
buildRyuDigitsBody(resources: {
  readonly mulShift: FuncHandle;
  readonly tableTypeIdx: number;
  readonly inverseGlobalIdx: number;
  readonly powersGlobalIdx: number;
}): NativeRyuBody;
buildRyuToBufferBody(resources: {
  readonly digits: FuncHandle;
  readonly stringDataTypeIdx: number;
}): NativeRyuBody;
```

`NativeRyuBody` is the two-field body result above. Move the exact instruction/local construction from `emitRyuMulShift:202`, `emitRyuDigits:387`, `emitRyuToBuf:1088`, including every nested emit helper. No arithmetic redesign, rounding change, global reads, table regeneration or registration inside a body builder.

Canonical shared signature constructors in this body owner must be reference-parameterized (physical ref or symbolic `typeKey` ref) so the old adapters and new recipes consume one signature definition. Exact signatures: mulShift `(i64,i64,i64,i32)->i64`; digits `(f64)->(i64,i32)`; toBuffer `(f64,i32,ref data,i32)->i32`. Preserve multi-result order and complete local order/names. A generic reference parameter describes layout substitution, not erased semantic values.

### Final Hilbert file-size and signature amendment

Do not assemble the >1400 lines of moved executable material in one file. The following three additional canonical files are approved in the proposed Hilbert map; no open-ended extra paths or LOC allowance:

- `src/runtime/wasmgc/values/number-ryu-digits.ts`: the digits body, fixed local coordinates and original expression/branch helpers. Export only `buildRyuDigitsBody` and its exact binding type. The four original blocks `emitE2NonNegative`, `emitE2Negative`, `emitCommonPath`, `emitSlowPath` become bounded module-private functions; add only the specific physical bindings formerly captured where actually used. Existing expression helpers remain pure instruction-fragment construction. The thin assembler preserves their call/spread order and terminal return. Keep all 26 locals, including pad13/pad14.
- `src/runtime/wasmgc/values/number-ryu-to-buffer.ts`: the to-buffer body, fixed local coordinates, existing writer expressions and four formatting cases. The prologue and four existing case fragments become bounded private functions with the specific data/digits bindings they read. Preserve 11 locals including digoff, offset-200 scratch use, position updates and every branch/return. No local allocator or callback/context parameter is introduced.
- `src/runtime/wasmgc/values/number-ryu-signatures.ts`: the exact signature constructors below, the shared two-field body and binding types, and the original I32/I64/F64 scalar objects exported as `RYU_I32`, `RYU_I64`, `RYU_F64`. This leaf imports only Wasm-model types. The tables/digits/to-buffer/mulShift owners consume these same scalar objects where the donor shared them; this leaf imports none of those body modules.

`number-ryu-bodies.ts` now contains the complete bounded mulShift builder and explicit reexports of the two other body builders/signatures. The actual implementation owners have real imports from this adapter surface; parent must activate and test all five new runtime files, not certify only a barrel. There is no reverse import from a private body module to this barrel, hence no new value-import cycle.

Freeze the shared signature type constraints and exports exactly as follows (fresh mutable tuples, readonly properties, to remain usable by existing `addFuncType`; `NativeDeclaredSignature` accepts these without casts):

```ts
export type RyuI32 = { kind: 'i32' };
export type RyuI64 = { kind: 'i64' };
export type RyuF64 = { kind: 'f64' };
export type RyuDataReference =
  | { readonly kind: 'ref'; readonly typeIdx: number; readonly typeKey?: never }
  | { readonly kind: 'ref'; readonly typeKey: string; readonly typeIdx?: never };
export interface NativeRyuBody {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}
export interface RyuDigitsResources {
  readonly mulShift: FuncHandle;
  readonly tableTypeIdx: number;
  readonly inverseGlobalIdx: number;
  readonly powersGlobalIdx: number;
}
export interface RyuToBufferResources {
  readonly digits: FuncHandle;
  readonly stringDataTypeIdx: number;
}
export function ryuMulShiftSignature(): {
  readonly params: [RyuI64, RyuI64, RyuI64, RyuI32];
  readonly results: [RyuI64];
};
export function ryuDigitsSignature(): {
  readonly params: [RyuF64];
  readonly results: [RyuI64, RyuI32];
};
export function ryuToBufferSignature<R extends RyuDataReference>(data: R): {
  readonly params: [RyuF64, RyuI32, R, RyuI32];
  readonly results: [RyuI32];
};
```

The signature constructor puts the supplied `data` object itself in parameter 2. Legacy calls pass `{kind:'ref',typeIdx:actualDataIdx}`; recipe construction passes `{kind:'ref',typeKey:actualDataKey}`. Never instantiate a broad `ValType | NativeDeclaredValType` parameter, accept ref_null/anyref/unknown, erase to a numeric placeholder, or cast a failed generic result. The scalar fields are exactly unbranded donor types, not an instruction to strip brands on other compiler values. Typed negative controls reject nullable/missing/both-coordinate refs; recipe runtime validation and producer authentication still handle untrusted shapes/currentness. This factory is descriptive and conveys no ownership authority.

The body-return contract remains locals/body; the candidate's alternative all-in-one function-definition return is not a second API. Compare shared signatures separately with actual old/new function types and resource declarations. The candidate's 16/26/11 local census and 125-bit/291/326 table census are adopted as supplementary exact controls.

Private splitting is literal extraction, not algorithm design: reconstruct all original headers, docs, constants, helper bodies, call sites, spreads, locals and final returned arrays by a narrow checked inverse. Positive-first mutations must cover a missing/reordered private block and an altered return as well as arithmetic. Preserve original helper construction order; do not hoist computed instruction arrays to shared module singletons or change alias/DAG relationships. Normal formatted file/function budgets apply; if these named files still cannot meet them, return the measured additional split proposal before adding a path. No baseline change or relocation allowance is approved.

### Euclid body APIs

New `src/runtime/wasmgc/values/number-format-radix-bodies.ts` exports:

```ts
interface NumberFormatStringTypes {
  readonly dataTypeIdx: number;
  readonly nativeStringTypeIdx: number;
  readonly anyStringTypeIdx: number;
}
buildNumberFormatNewBody(types: NumberFormatStringTypes): NativeNumberFormatBody;
buildNumberFormatGetBody(types: NumberFormatStringTypes): NativeNumberFormatBody;
buildNumberFormatSetBody(types: NumberFormatStringTypes): NativeNumberFormatBody;
buildNumberFormatFinBody(types: NumberFormatStringTypes): NativeNumberFormatBody;
buildNumberFormatTrapBody(): NativeNumberFormatBody;
buildNumberFormatRadixThunkBody(radixBody: FuncHandle): NativeNumberFormatBody;
```

`NativeNumberFormatBody` is the same two-field structural result, declared in the format body owner and type-imported where needed, not a new framework. Kernel signatures are built once from explicit `data`, `nullableData`, `anyString` reference parameters and used by both legacy adapters and the physical recipe. D1's semantic signature factory remains independent authority, and parent must compare its faithful physical projection with these signatures.

Preserve f64 index/value truncation, unsigned packed get, zero-filled new, fin's copy into a tight i16 array and offset-zero NativeString, and trap's actual `unreachable`. B remains `ref null data`, including for new's return; fin returns `ref AnyString`. The radix thunk is exactly local0, local1, call actual body handle, extern.convert_any.

New `src/runtime/wasmgc/values/number-format-bodies.ts` exports finalizer/default formatter/native adapter builders and the existing fixed/exponential/precision body builders:

```ts
buildNumberFormatFinalizeBody(types: NumberFormatStringTypes): NativeNumberFormatBody;
buildNumberFormatToStringBody(resources: {
  readonly types: NumberFormatStringTypes;
  readonly finalize: FuncHandle;
  readonly radix: FuncHandle;
  readonly ryuToBuffer: FuncHandle;
  readonly integerBeforeScratch: boolean;
}): NativeNumberFormatBody;
buildNumberFormatNativeAdapterBody(resources: {
  readonly toString: FuncHandle;
  readonly anyStringTypeIdx: number;
}): NativeNumberFormatBody;
```

The fixed builder takes explicit types/finalize and the donor optional toString handle; exponential takes types/finalize; precision takes types/finalize and the donor optional toFixed/toExponential/toString handles. Keep optionality only to reproduce existing legacy fallback construction; a complete newly admitted provider may not substitute a missing dependency with that fallback. Preserve the actual old field checks and branch order. Keep shared `putConst`, nonfinite prologue and integer-digit builder here as private functions. No `ctx` parameter remains, including the presently unused ctx parameter of the nonfinite prologue.

For both families, preserve existing function/type names, unnamed type-intern calls versus explicitly named calls, function-map registration timing, stable-handle mint/push order and initializer object identity. Do not create a second signature table in adapters. Function result casts must match the old bodies, not inferred from logical signature names.

## 3. Ryū pack: exact executable ownership and ordering

Hilbert implements new `src/backend/wasmgc/resources/native-number-ryu.ts` using existing `NativeResourceRecipe`, `NativeDeclaredValType`, `executeNativeResourceRecipe`, `PhysicalModuleReservations` and issued native-string resources. No ledger or shared declaration-schema edits.

```ts
declareNativeRyuResources(key: string, stringKey: string): NativeResourceRecipe;
interface NativeRyuReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly tableType: TypeReservation;
  readonly inverse: GlobalReservation;
  readonly powers: GlobalReservation;
  readonly mulShift: FunctionReservation;
  readonly digits: FunctionReservation;
  readonly toBuffer: FunctionReservation;
}
reserveNativeRyuResources(tx: PhysicalModuleReservations,
  key: string, strings: NativeStringLiteralReservations): NativeRyuReservations;
requireNativeRyuReservations(tx: PhysicalModuleReservations,
  pack: NativeRyuReservations, key: string, strings: NativeStringLiteralReservations): void;
fillNativeRyuResources(tx: PhysicalModuleReservations, pack: NativeRyuReservations): void;
requireCompletedNativeRyu(tx: PhysicalModuleReservations,
  pack: NativeRyuReservations, strings: NativeStringLiteralReservations): void;
```

Fixed resource roles: `['number-ryu','mul-shift']`, `table-type`, `inverse`, `powers`, `digits`, `to-buffer`. Keys are deterministically constructed from the supplied parent-qualified key and these roles. This is key generation, never parsing an encoded semantic ID. Complete recipe order is **mulShift function/signature → i64-array type → inverse global → powers global → digits function/signature → toBuffer function/signature**. The donor's second ensure-array call in toBuffer is a cache hit, not a new type. Global refs use final absolute global indices, including imported globals; function call operands use stable handles, not final indices.

Exactly six declarations and six `resources`-phase reserve steps: mulShift, table-type, inverse, powers, digits, to-buffer. `reserveFunction` already calls `internFunctionType` before minting; do NOT add explicit intern-signature steps duplicating these three operations. This full native pack always includes toBuffer because D2 needs it. It does not replace the lazy legacy emitRyuDigits entry: a legacy digits-only request must still omit toBuffer and its signature. No new partial-native-pack union or eager legacy allocation is authorized.

Authenticate the string pack through `nativeStringLiteralReservationInventory(tx, strings)` before any allocation; borrow its exact data token selected via `nativeStringTypeKeys(inventory.typePack.key).data`, not a shape/name-only match. Retain the exact pack/key/token associations in this producer's private owner record. Generic declaration comparison is descriptive, not ownership authentication. Before freeze, use the existing type assertion plus producer-authenticated inventory; after freeze use actual ledger coordinates. No `physicalIndex` request while reserving.

The second declaration argument remains the authenticated **string owner key**, not an arbitrary raw type key: `declareNativeRyuResources(key, stringKey)` derives the prerequisite through `nativeStringTypeKeys(stringKey).data`. Reserve derives that same stringKey from the authenticated inventory. Its borrowed token must have exactly that real key; do not remap the token under the semantic scratch reference's encoded ID. Section 6 aliases ABI references to the same required root without renaming ledger keys. Pack reservation requires issued strings/type integrity, not completed literal bodies; both packs participate in the one later freeze/fill/seal.

Fill tables with the exact signed bigint arrays and actual array.new_fixed type/length, then the three canonical functions. Tables/globals are immutable. Fill once, set canonical-filled state only after success, and use the ledger's full snapshot checks. No JSON.stringify numeric/presence loss, and no cold/global memo altering the donor's allocation/cache timing.

Old `number-ryu.ts` keeps cache checks, arrayTypeMap/module/global/import-coordinate mutation and registration helpers. Its real emitters call the new builders. `number-ryu-portable.ts` remains unchanged and still calls those adapted legacy emitters; it currently fabricates a legacy scratch context and is NOT a permissible new native pack implementation. No new linear implementation.

## 4. Formatter pack: complete recipe, not just the five kernels

Euclid implements `src/backend/wasmgc/resources/native-number-format.ts`.

```ts
interface NativeNumberFormatResourceInput {
  readonly key: string;
  readonly stringKey: string;
  readonly integerBeforeScratch: boolean;
}
declareNativeNumberFormatResources(input: NativeNumberFormatResourceInput): NativeResourceRecipe;
type NativeNumberFormatFunctionRole = 'finalize' | 'new' | 'get' | 'set' | 'trap' | 'fin'
  | 'radix-body' | 'radix-thunk' | 'to-string' | 'native-to-string';
interface NativeNumberFormatReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly ryu: NativeRyuReservations;
  readonly functions: Readonly<Record<NativeNumberFormatFunctionRole, FunctionReservation>>;
}
reserveNativeNumberFormatResources(tx: PhysicalModuleReservations,
  input: NativeNumberFormatResourceInput,
  strings: NativeStringLiteralReservations): NativeNumberFormatReservations;
requireNativeNumberFormatReservations(tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations, input: NativeNumberFormatResourceInput,
  strings: NativeStringLiteralReservations): void;
nativeNumberFormatReservationInventory(tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations): readonly NativeNumberFormatResourceRow[];
fillNativeNumberFormatResources(tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations): void;
requireCompletedNativeNumberFormat(tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations): void;
```

`NativeNumberFormatResourceRow` uses the existing key/space/reservation discriminated shape for type/global/function, declared locally rather than importing another aggregate's implementation. It includes all nested Ryū resources but not borrowed string resources. The owner authenticates the exact ordered recipe, dependency pack, options, function objects and nested Ryū pack; returned inventory is frozen observation, never a second registry.

Cold default closure: **13 defined functions**, **two immutable globals**, **one new i64-array type** in addition to shared strings and interned signatures. The thirteen function roles in physical order are finalize; new/get/set/trap/fin; radix-body; radix-thunk; mulShift/digits/toBuffer; to-string; native-to-string. Insert the Ryū type/globals between mulShift and digits as above. Do not claim a fixed type-index count: existing signature interning/cache populations determine it.

Compose the public complete declaration recipe from the same pre-Ryū recipe, Hilbert recipe and post-Ryū recipe that reservation executes. Execute prelude, call `reserveNativeRyuResources` once at its exact place, execute suffix. Do not execute all declarations then adopt unauthenticated rows into a fabricated Ryū pack. Preserve interleaved type requests and the old new/get/set/**trap/fin** physical order even though D1 logical entries use fin/trap.

`fillNativeNumberFormatResources` fills every canonical runtime body, including calling the Ryū fill, **except the reserved radix-body slot**. Parent lowers the already-prepared D1 body into that slot through the actual compiler, not a callback into frontend code. The radix thunk may reference the reserved body before its fill; no placeholder body is installed. At completion, require `tx.state === 'sealed'`: `physicalIndex` in filling state authenticates ownership/layout but does NOT by itself prove all functions were filled. The ledger's seal plus the pack's canonical runtime-fill receipt and exact parent support-body ownership supply completion. A failure leaves the accepted token consumed and no emitted result; do not restart the transaction with partial resources.

Preserve compatibility branches in `number-format-native.ts`: linked-runtime import dispatch, `usesNativeNumberFormat`, cache/which dependency closure, WASI/nativeStrings/host selection, native carrier fusion and optional historical fallback checks. Leave `ensureLateImport` and provider eligibility there. Retain `emitSelfHostedToStringRadix`'s real call to `emitSelfHostedFunc`; only its kernel/thunk instruction generation moves. Legacy bodies still compile through the same D1-extracted frontend kernel, with original exception/currentFunc restoration in stdlib-selfhost unchanged.

## 5. Parent semantic demand and physical acceptance interfaces

Parent owns new `src/ir/program/native-number-format-requirements.ts` and its focused test. It imports only canonical core/program/runtime/foundation contracts allowed by the existing ir-program layer. It must not import the full mixed program validator or backend resources.

```ts
interface NativeNumberFormatRequirementInput {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly integerBeforeScratch: boolean;
}
interface NativeNumberFormatRequirements {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly batch: IrNumberFormatRadixSupport;
  readonly integerBeforeScratch: boolean;
  readonly calls: readonly NativeNumberFormatCallUse[];
  readonly supportBuffers: readonly NativeNumberFormatSupportBuffer[];
  readonly literals: readonly NativeNumberFormatLiteralUse[];
}
deriveNativeNumberFormatRequirements(input: NativeNumberFormatRequirementInput):
  NativeNumberFormatRequirements | undefined;
assertNativeNumberFormatRequirementsCurrent(input: NativeNumberFormatRequirementInput,
  requirements: NativeNumberFormatRequirements): void;
```

These are descriptive borrowed joins, not acceptance capabilities. The checked parent boundary must first run full `assertPreparedIrProgram`, select its actual runtime projection, and authenticate provider policy/content. Recompute before emission and retain exact program/projection/batch identities in existing private acceptance state; never deep-copy an issued resource dependency and then treat that copy as issued. Original and decoded programs derive independent valid joins.

Reuse the existing pure `collectNativeStringValueDemands(program, projection)` **unchanged** for the primary/selected census. Its `occurrences` contains every instruction, not merely its separately filtered literals/intrinsics; each `bufferIndex` resolves the exact owner/view/root/nested coordinates. Select formatter calls from that complete occurrence array, retaining occurrences in both views and shared buffers, with no second primary traversal or swallowed census failure. This does not authenticate provider or full-program validity by itself. Traverse only the separate D1 support body independently, in the same canonical nested-buffer order and against the original joint allocation snapshot. Never insert that body into the collector's ordinary owners or buffers. Recompute the census/current call join before emission. Controls pin unchanged original census populations, the independently expected formatter subset, and separate support coordinates/allocation evidence.

Freeze the three row contracts as follows: call use carries exact owner unit ID, view (`program`/`projection`), root (`block`/`async-plan`/`async-runtime` with index/id), canonical nested child-buffer coordinates, instruction index and the borrowed actual call. Support buffer carries the distinct batch body unit ID, block index/id, nested child-buffer coordinates and borrowed instruction buffer. Literal use carries its support buffer/instruction coordinate, actual string.const, original allocation ID, resolved alias ID, original metadata row/presence, and `representation:'inline-wtf16'`. Use existing canonical nested-buffer order; reject holes/cycles without deduplicating distinct occurrences or stopping after the first call.

Reconcile complete canonical formatter call population in both views, including selected runtime state bodies; compare every call with the existing six-contract catalog and exact selected provider `native.async.number-to-string`, implementation `__ir_number_toString_native`, policy/backend/target/dependencies/host-capability set. Reuse `nativeAsyncProviderMismatch` and current program/provider authentication. A matching symbol, signature or body name alone is insufficient. D1's original demand owners and independently rebuilt support receipts remain authoritative; no new catalog entry or operand-derived signature.

Parent adds only `numberFormat?: Readonly<{ integerBeforeScratch: boolean }>` to `PreparedIrBackendOptions`. If formatter demand exists, this resolved field is mandatory and validated; no environment lookup/default inside typed preparation, acceptance, reserve or fill. No-demand callers need no new field and retain historical output. Legacy `emitToString` reads the existing environment switch at its old point and passes the boolean to the canonical builder. Future public source-option forwarding is parent-owned and must use an explicit resolved value; this plan does not equate fast/default flags with this switch. Prepared-codec data does not acquire ambient configuration.

New parent aggregate `src/backend/wasmgc/program/native-number-format.ts` produces the descriptive formatter physical setup from requirements plus the chosen string declaration recipe. It imports no legacy lowerer; actual lowering remains in the current mixed consumer until that boundary is separately extracted. Store support literal rows and the actual D1 batch separately from physical declaration rows; there is no synthetic ordinary unit or extra runtime state.

## 6. Frozen scratch/literal decisions and ABI mapping

**One string type owner.** If the existing native-string/value aggregate is needed, reuse its exact issued string pack. Otherwise reserve the same canonical string-type recipe and one literal pack with `literals:[]`; this is an explicit layout dependency, not a fabricated source literal. `nativeStringLiteralReservationInventory` authenticates even an empty issued literal pack. One type pack is consumed once; do not allocate another string hierarchy, consume it twice or invent a dependency literal merely to use its ownership guard. No generic string-demand scanner changes are needed just to insert support into ordinary populations.

**Scratch required root.** Reuse the existing D1 scratch ABI entry as the sole required owner of the chosen string recipe's `['string-type','data']` row. Re-derive the source anchor, exact support reference and required entry, and compare D1 storage `{array,i16,mutable:true}` with canonical `createStringDataType()`/recipe and nullable B signature projection. Suppress the otherwise generated supplemental required binding for that same row; map the canonical string-data reference to that same root in the resolver map. Do not mutate the prepared program's required entry, create a second required root, silently intern two owners together, or parse IDs. An already-existing incompatible second required root fails before allocation; an explicit preexisting alias must resolve compatibly through the existing ABI, never be synthesized after bind.

**Inline support literals.** Preserve the actual legacy `stdlib-selfhost.ts:573–587` body: length, zero offset, original UTF16 code units, array.new_fixed, struct.new NativeString. It does not use hashed strings, pooled globals or UTF8, even when the primary program requests UTF8 storage. The four source literals remain NaN/Infinity/-Infinity/0 with genuine allocation evidence; do not convert them to four new globals or mutate their storage/materializer fields. Export `buildInlineNativeStringLiteral(types: {nativeStrDataTypeIdx:number; nativeStrTypeIdx:number}, value:string): Instr[]` from the existing canonical `runtime/wasmgc/values/string-literal-bodies.ts`, moving this exact small body; both the existing stdlib resolver and parent support resolver call it. Keep the legacy native-string precondition check in its wrapper. Parent validates every actual support literal tuple/path/allocation before calling it and refuses any value exceeding its real array.new_fixed limit instead of inventing a fallback. The current genuine four literals are short; no claim is made for an arbitrary compiler-support string body.

Use D1's exact six callable entries (five kernels/body) unchanged, projected through the selected string types. The physical body slot uses the support callable binding, not `irUnitCallableBindingId(body.unitId)`. Reuse the existing canonical async formatter callable ABI entry for native-to-string after exact ref/intent/signature/provider reconciliation. It is NOT the raw externref-returning function's entry. All remaining functions, table type/globals receive parent-qualified support IDs from existing factories and symbolic declarations, appended after existing entries in declared order. Compute signatures from the one recipe; no copied table of numeric indexes. Reconcile all resource keys one-to-one with required roots before creating a module.

The emission `ProgramAbiMap` is fully planned/sealed before allocation, then bound once after the single ledger freeze. Scratch and helper calls resolve through existing `resolveType`/`resolveFunc`; logical support-ref nullability is preserved. `PhysicalSignatureType` needs only the exact support-ref leaf for D1 body/kernel conversion, validated against the accepted scratch mapping; do not admit arbitrary physical reference graphs or change IrSlotDef. Exports/start use actual final index spaces, never handles. Canonical native provider uses its real unwrap function; do not add fused-call behavior to the new consumer merely to suppress that slot.

## 7. Parent integration lifecycle and concrete scope

Parent exclusively owns existing `src/ir/program.ts`, `src/ir/program-physical-plan.ts`, `src/ir/program-consumer.ts`, new requirements/aggregate above, boundary policy and integration tests. Changes to the existing native-string aggregate are unnecessary for support literal pooling: they stay inline. Parent may need a narrow planner hook to choose the scratch root for its generated data binding; keep that in program-physical-plan, not the generic ABI class.

1. Authenticate full program/projection, D1 batch/currentness, provider and explicit option. Collect complete support and primary/selected call evidence. Derive all string/formatter declaration rows and reject every unsupported or contradictory dependency before allocation.
2. Compose semantic and supplemental ABI entries once. Shared string-data ownership is resolved now. Missing D1 body, wrong provider, unknown physical support type or incomplete selected async dependencies remain located failures.
3. Reserve shared string types/imports/literal pack using existing order, then the complete formatter recipe with exact nested Ryū interleaving. Keep no-demand reservation path byte-identical. Reconcile actual issued inventories to every accepted declaration; read real module signatures/objects, not names/counts.
4. Freeze reservations once; bind actual final indices into the same ABI and finish binding once. Fill shared string resources and canonical formatter/Ryū bodies.
5. Parent lowers `batch.implementation.body` via existing `lowerIrFunctionBody`, `WasmGcEmitter`, `wasmValueTypeConverter`, the accepted scratch/call maps and exact owner-qualified inline literal resolver. Compare lowered params/results against its already reserved signature; fill the exact radix-body token once. No parsing, frontend import, legacy resolver, fabricated CodegenContext, replacement hand-written radix, or unrestricted callback.
6. Continue ordinary selected-body/frame/startup/publication emission in the original transaction. Count support-body and runtime-helper objects separately from the primary emittedUnitIds; actual module membership/order must equal all three planned ownership sets. Do not make a new helper stand in for a missing primary function.
7. Seal the ledger; only then claim the formatter body plus runtime functions/tables are complete. Existing observation record exposes actual ABI indices without exposing tokens or another authority. Missing fill, post-fill mutation or event-listener failure returns no reusable successful token/result.

Keep the async guard unchanged until A/B/C/E are fully integrated. When those lanes are ready, remove only the located refusal for owners whose complete accepted plan exists, with all original family axes passing. D2 alone does not authorize a smaller emitted program.

## 8. Exclusive implementation maps

Hilbert, final proposed ten files (three-file bounded-helper amendment):

- New runtime `number-ryu-tables.ts`, `number-ryu-bodies.ts`, `number-ryu-digits.ts`, `number-ryu-to-buffer.ts`, `number-ryu-signatures.ts`.
- New backend resources `native-number-ryu.ts`.
- Existing `src/codegen/number-ryu.ts` adapter only.
- New `tests/issue-3518-native-ryu-ownership.test.ts`, `tests/issue-3518-native-ryu-resources.test.ts`, `tests/fixtures/issue-3518-native-ryu-donor.json`.

Euclid, proposed ten files:

- New runtime `number-format-radix-bodies.ts`, `number-format-bodies.ts`.
- Existing runtime `string-literal-bodies.ts`, only the exact inline helper addition.
- New backend resources `native-number-format.ts`.
- Existing `src/codegen/number-format-native.ts`, `src/codegen/number-format-selfhost.ts`, `src/codegen/stdlib-selfhost.ts` narrow adapters; no frontend-build changes.
- New `tests/issue-3518-native-number-format-ownership.test.ts`, `tests/issue-3518-native-number-format-resources.test.ts`, `tests/fixtures/issue-3518-native-number-format-donor.json`.

Parent integration tests:

- `tests/issue-3518-native-number-format-requirements.test.ts`.
- `tests/issue-3518-prepared-number-format-execution.test.ts`.
- `tests/helpers/prepared-number-format-source-free.mjs`.
- Existing `tests/issue-3518-compiler-boundaries.test.ts` plus applicable fixed-population boundary receipt updates, additive only.
- Full async consumer acceptance uses its already-owned integration suite; do not create a replacement reduced family.

Runtime paths above are all under `src/runtime/wasmgc/values/`; backend resource paths are under `src/backend/wasmgc/resources/`. No other existing file is implicitly authorized. Hilbert and Euclid can implement body/adapters concurrently against section 2; Euclid composes only frozen Hilbert APIs before resource tests. Parent implements requirements/ABI/planner work independently, then serializes source composition/tests. Parent rechecks current claims, especially stdlib-selfhost and string-literal-bodies, and the recorded P/C scoped releases. All paused P/C source remains untouched. No schema-v2, async-ABI or broader source-admission release is inferred.

## 9. Preservation and acceptance — three explicitly separate populations

**A. Canonical extraction and real legacy callers.** Independently pin old statement/doc/body/initializer populations and adapters. Exact checked inverses, not replacement git blobs, must reconstruct original donor receipts from live moved bodies and retained wrappers. Mutate imports, body headers, return/results, instruction immediates, local order, tables, constants and nested branches; each negative starts from a passing live reconstruction. Include legacy cold/cache-hit and partial preexisting-family paths; preserve old `which` closure, env integer-before-scratch both values, linked-runtime early exit, signature names/arity and actual funcMap/arrayTypeMap/global/mint/push order. Retain all original tests and source material. Do not reseed budget baselines; normal budgets apply. Any necessary relocation allowance requires a separate explicit parent decision with exact before/after bodies and old keys retired, never implied growth credit.

**B. Actual prepared support execution.** Produce the unchanged original playground family through D1's real source pipeline; encode/decode into a fresh process whose backend guard forbids frontend, ts-api/TypeScript, stdlib source and legacy codegen. Re-derive plans for each program object and execute the complete formatter resource recipe plus the genuinely lowered support body using the same ledger. A dedicated Wasm observation adapter may read actual string length/code units for tests, but it must be separately declared/reserved and labeled test-only—not an invented compiler caller. No hand IR or copied radix implementation. Full emitted binary validation/instantiation, exact code-unit strings, actual table descriptors/values, repeated calls and two instances are mandatory. This is **prepared support/resource execution**, not whole-program consumer execution while async remains blocked.

Use the real issue1537 boundaries and deterministic corpus (20k raw bit patterns, scaled magnitudes and subnormals), both integer-fastpath settings, -0/NaN/infinities, 70/3e9, 0.1+0.2, 1/3, 1e20/1e21, 1e-6/1e-7, min subnormal, min normal, max finite and safe-integer limits. Preserve mulShift limb/carry tests and multi-result digit/exponent probes. Use the issue3305 21-case radix matrix and all radices 2–36 with explicit unsafe-integer traps and inherited non-V8-shortest fraction cases. Baseline preservation and language correctness are distinct verdicts. That old suite's dummy import object is not a valid standalone acceptance harness; new probes may only supply actual declared services.

Positive-first failures: removed/swapped table/global/helper; corrupted signed limb or mutable array; reversed `(i64,i32)` results; foreign/copied/stale string/Ryū/formatter packs; wrong same-looking scratch token/key/width/nullability; duplicate required roots; wrong source anchor/canonical provider/ABI signature/result carrier; missing/retired literal allocation or changed support occurrence; unsupported storage/materializer attachment; late signature reservation; omitted radix-body fill; duplicate fill; post-fill locals/instruction/global mutation; imported-global/function offsets and explicit rec-group surroundings. Preserve every original source/selected/support population and unknown metadata namespace. Failed cases must not consume unrelated parent modules or create an emitted success.

**C. Actual combined consumer/public obligation.** The current D1 producer does not provide an ordinary synchronous formatter entry; do not fabricate one or strip the async owners to claim a consumer success. Parent must integrate this recipe/support-body emitter into the real program-consumer now and retain its honest async failure until A/B/C/E are ready. Final acceptance remains original/decoded full family, GVN off/on, both UTF storage settings, 5/22 -> 16/33 recount plus separate support body/kernels, delay 70 and 3e9, sequential/eager reverse-parallel order, empty timing, registration/rejection cases, exact four newline outputs and main resolving once to canonical undefined. No resource-only result may replace this pending requirement. Existing synchronous/no-demand old/new bytes/WAT/resources/ABI-index/startup and executed-value parity are also mandatory when parent wires D2.

## 10. Boundary/publication and remaining stops

Activate exact new canonical runtime/backend/program modules with missing/deleted roots and type/value/barrel/import-type negative controls under unchanged allowedEdges. Do not call the existing mixed lowerer/consumer frontend-clean because its new dependencies are clean. Preserve all old activation histories and failed evidence, six/ten static full/cut groups, twelve full-only execution witnesses, the two known dynamic-import unknowns, ABI30's unresolved planningSealed witness, and full retirement criteria.

No new architectural user choice is needed for the above physical mapping; it implements approved standalone separation. Parent approval/claims are still needed for exact writer paths and the explicit physical option. A newly observed real donor bug, unexpected support-body physical type, unavailable source-produced acceptance axis or incompatible live sibling API is a located blocker to report—not permission for approximation, emitter-guard removal, test weakening or a new ABI authority.

The separately reported E1 mixed-UTF8-rope copy-tree failure remains a real pending investigation/fix obligation. D2 inline support literals and NativeString formatter output do not certify that mixed-rope path or authorize removal of its UTF8 cases. Do not fold an unreviewed E1 decoder/order change into these writer scopes.

This final handoff is ready for scoped parent dispatch with the ten-file Hilbert amendment above. There are no unresolved D2 scratch/literal/option/body-handoff architecture choices in this contract. It is not evidence that D2, full async, public IR-only default or direct-codegen retirement is complete.
