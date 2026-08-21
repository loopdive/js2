// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3274, subtask of #3182) Object-runtime **descriptor + integrity** helper
 * builders, extracted verbatim from `ensureObjectRuntime` in `object-runtime.ts`
 * as WAVE-B slice 1 of the mega-function decomposition.
 *
 * This module owns the registration of the native (`--target standalone`)
 * property-descriptor and object-integrity runtime helpers:
 *
 *   - `__defineProperty_value` / `__defineProperty_accessor`  (define one prop)
 *   - `__defineProperties`                                    (plural define)
 *   - `__obj_define_from_desc`                                (dynamic descriptor apply)
 *   - `__getOwnPropertyDescriptor`                            (descriptor read-back)
 *   - `__create_descriptor` / `__create_accessor_descriptor` (descriptor objects)
 *   - `__getOwnPropertyNames` / `__getOwnPropertySymbols`     (own-key enumeration)
 *   - `__object_getOwnPropertyDescriptors` / `__object_fromEntries`
 *   - `__object_isFrozen` / `__object_isSealed` / `__object_isExtensible`
 *   - `__object_preventExtensions` / `__object_seal` / `__object_freeze`
 *
 * The block is a pure relocation: the code is byte-for-byte identical to the
 * inline block it replaced, so the emitted Wasm is unchanged (proved via
 * `scripts/prove-emit-identity.mjs`). Every value it reads from the enclosing
 * `ensureObjectRuntime` scope — the `registerNative` minter, the object-runtime
 * type indices / ValType aliases, the dependency func indices, and the shared
 * `$PropEntry.$flags` / `$Object.flags` bit constants — is threaded in through
 * the `ObjectDescriptorHelperState` bundle so the `registerNative` call ORDER
 * (and therefore the minted func-index sequence) is preserved exactly.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "./native-strings.js";
import { STRING_EXOTIC_PUSH_KEYS_FN, stringExoticPushKeysPrologue } from "./string-exotic-own-props.js"; // (#4491) §10.4.3 own keys
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { ensureAnyValueType, undefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { emitSelfHostedFunc } from "./stdlib-selfhost.js";
import { SELF_HOSTED_OBJECT_RUNTIME } from "../stdlib/object-runtime.js";
import { getOrRegisterVecBaseType } from "./registry/types.js";
import { reserveVecOverlayHelpers } from "./vec-overlay.js";
import { buildIntegrityPredicate, registerIntegrityBagResolver } from "./object-integrity-carrier.js";
import { buildIntegrityDerivation, integrityDerivationLocals } from "./object-integrity-test-level.js";
import { buildObjectIntegrityMutationHelpers } from "./object-runtime-integrity.js";
import { bagGopdBetween, bagKeysIf } from "./carrier-bag-visibility.js"; // (#4010 S3) visibility over the bags
import {
  defineCarrierBagSubstitutionArm,
  definePropertiesCarrierBagArm,
  isDefineCarrierInstrs,
} from "./carrier-bag-define.js";
// (#4230) VEC `Properties` maps — a complete own-key source built from the
// #3537 bag ∪ the #3251 overlay companion.
import { reserveVecPropsKeySource, vecPropertiesKeySourceArm } from "./vec-props-key-source.js";
import { protoIndexOwnViewSubstituteInstrs } from "./proto-index-store.js"; // (#2175 P2) own-view companion substitution

/**
 * Everything the descriptor/integrity block reads from the enclosing
 * `ensureObjectRuntime` scope. Threading it through this bundle (rather than
 * re-deriving) keeps the extracted code textually identical to the original and
 * preserves the `registerNative` minting order.
 */
export interface ObjectDescriptorHelperState {
  /** The defined-func minter from `ensureObjectRuntime` (captures `ctx`). */
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number;
  // Object-runtime type indices.
  anyStrTypeIdx: number;
  nativeStrTypeIdx: number;
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  objectTypeIdx: number;
  symbolKeysEnabled: boolean;
  // Pre-built ValType aliases.
  objRefNull: ValType;
  propMapRef: ValType;
  entryRefNull: ValType;
  // Dependency func indices (already registered earlier in the pass).
  strFlattenIdx: number;
  strEqualsIdx: number;
  objFindIdx: number;
  objInsertIdx: number;
  objGrowIdx: number;
  objVecNewIdx: number;
  objVecPushIdx: number;
  objIndexOfKeyIdx: number;
  objOrderedIdx: number;
  objOrderedAllIdx: number;
  externSetIdx: number;
  boundaryObjectGetOwnPropertyDescriptorIdx?: number;
  boundaryObjectDefinePropertyValueIdx?: number;
  boundaryObjectDefinePropertyAccessorIdx?: number;
  boundaryObjectGetOwnPropertyNamesIdx?: number;
  boundaryObjectGetOwnPropertySymbolsIdx?: number;
  // Reserved builtin-fn metadata natives (standalone only → may be undefined).
  bfnGopdIdx: number | undefined;
  bfnPushOwnNamesIdx: number | undefined;
  // Shared bit constants ($PropEntry.$flags / $Object.flags layout).
  NONE_HEAP: number;
  FLAG_WRITABLE: number;
  FLAG_ENUMERABLE: number;
  FLAG_CONFIGURABLE: number;
  FLAG_ACCESSOR: number;
  OBJ_FLAG_NONEXTENSIBLE: number;
  OBJ_FLAG_SEALED: number;
  OBJ_FLAG_FROZEN: number;
  WRAPPER_PRIMITIVE_KEY: string;
}

/**
 * Register the property-descriptor + object-integrity native helpers. Called
 * once, in place, from `ensureObjectRuntime` (standalone/host both — the
 * gc/host-mode paths are no-op-guarded inside exactly as before).
 */
export function buildObjectDescriptorHelpers(ctx: CodegenContext, s: ObjectDescriptorHelperState): void {
  const {
    registerNative,
    anyStrTypeIdx,
    nativeStrTypeIdx,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    symbolKeysEnabled,
    objRefNull,
    propMapRef,
    entryRefNull,
    strFlattenIdx,
    strEqualsIdx,
    objFindIdx,
    objInsertIdx,
    objGrowIdx,
    objVecNewIdx,
    objVecPushIdx,
    objIndexOfKeyIdx,
    objOrderedIdx,
    objOrderedAllIdx,
    externSetIdx,
    boundaryObjectGetOwnPropertyDescriptorIdx,
    boundaryObjectDefinePropertyValueIdx,
    boundaryObjectDefinePropertyAccessorIdx,
    boundaryObjectGetOwnPropertyNamesIdx,
    boundaryObjectGetOwnPropertySymbolsIdx,
    bfnGopdIdx,
    bfnPushOwnNamesIdx,
    NONE_HEAP,
    FLAG_WRITABLE,
    FLAG_ENUMERABLE,
    FLAG_CONFIGURABLE,
    FLAG_ACCESSOR,
    OBJ_FLAG_NONEXTENSIBLE,
    OBJ_FLAG_SEALED,
    OBJ_FLAG_FROZEN,
    WRAPPER_PRIMITIVE_KEY,
  } = s;

  // ── (#3251 S1) Array-descriptor overlay entry points ─────────────────────
  // Standalone only (host mode routes defineProperty/gOPD through the JS
  // sidecar imports and MUST stay byte-identical). The three helpers are
  // reserved as safe-no-op placeholders whose bodies are filled at finalize
  // (`fillVecOverlayHelpers`, after every `__vec_*` carrier type exists); the
  // `$__vec_base` arms below bake a plain `call <reserved idx>` — the
  // accessor-driver reserve/fill funcIdx discipline (#1888 S5b, #329/#1899).
  const vecOverlay = ctx.standalone ? reserveVecOverlayHelpers(ctx) : null;
  const vecOverlayBaseIdx = vecOverlay ? getOrRegisterVecBaseType(ctx) : -1;
  /** `if (anyLocal is a $__vec_base) → return <helper>(params...)` (or []). */
  const vecOverlayArm = (anyLocal: number, helperIdx: number, paramCount: number): Instr[] => {
    if (!vecOverlay) return [];
    const args: Instr[] = [];
    for (let p = 0; p < paramCount; p++) args.push({ op: "local.get", index: p });
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: vecOverlayBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...args, { op: "call", funcIdx: helperIdx }, { op: "return" }],
      },
    ];
  };

  // ── __defineProperty_value (#1629 S6 — native data-descriptor define) ─────
  //
  // `Object.defineProperty(obj, key, { value, writable?, enumerable?,
  // configurable? })` and `Reflect.defineProperty` for a DATA descriptor under
  // `--target standalone`. In JS-host mode this is the `env::__defineProperty_value`
  // host import backed by the JS descriptor sidecar; standalone has no host, so we
  // store the value + attribute flags directly into the `$Object`/`$PropEntry`
  // runtime that the native `__extern_get` already reads back.
  //
  // The compiler passes `flags` as an f64 in the host encoding
  // (`computeRuntimeFlags`, object-ops.ts):
  //   bit 0: writable          bit 3: writable specified
  //   bit 1: enumerable        bit 4: enumerable specified
  //   bit 2: configurable      bit 5: configurable specified
  //   bit 6: is accessor       bit 7: has value
  // We translate to the native `$PropEntry.flags` bits (FLAG_WRITABLE / _ENUMERABLE
  // / _CONFIGURABLE). Per CompletePropertyDescriptor (ES §6.2.6.4) a NEW
  // property's omitted attributes default to false — and the host f64 encoding
  // already reflects that (an unspecified attr has neither its specified-bit nor
  // its value-bit set, so the `& value-bit` test yields 0 → false). So the
  // translation is a straight per-attribute mask of bits 0/1/2 onto the native
  // bit positions, which happen to coincide (native WRITABLE=0x1, ENUMERABLE=0x2,
  // CONFIGURABLE=0x4 == host value bits 0,1,2). The only divergence from
  // __extern_set is the explicit flag word instead of FLAG_DEFAULT.
  //
  // Accessor descriptors (`{ get, set }`, host flag bit 6) are NOT handled here —
  // they stay refused under standalone (deferred S6 follow-up: accessor slots +
  // call_ref invocation). The accessor path keeps emitting __defineProperty_accessor,
  // which remains in STANDALONE_REFUSED_IMPORT.
  //
  // params: 0=obj 1=key 2=value 3=flagsF64
  // locals: 4=o(ref null $Object) 5=any(anyref) 6=cap 7=load 8=nflags(i32) 9=hf(i32)
  //         10=e(ref null $PropEntry) 11=efl(i32)  — #2042 S4 ValidateAndApply
  {
    const NATIVE_ATTR_MASK = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE; // 0x07

    // #2042 S4 — ValidateAndApplyPropertyDescriptor (§10.1.6.3) preflight for the
    // DATA-descriptor define. The host flags f64 carries, beyond the value bits
    // 0/1/2, "specified" bits 3/4/5 and a hasValue bit 7 (see encoding comment
    // above), so we can tell which attributes the descriptor actually mentions —
    // exactly what the spec's "Desc has a [[X]] field" conditions need. We throw a
    // catchable TypeError (same exn-tag pattern as __defineProperties) instead of
    // silently inserting when a (re)definition is invalid. Defaults
    // (CompletePropertyDescriptor, §6.2.6.4) are already correct on insert.
    addUnionImportsViaRegistry(ctx);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const s4TypeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const s4ExnTagIdx = ensureExnTag(ctx);
    const s4ObjectIsIdx = ctx.funcMap.get("__object_is")!;
    const HOST_WRITABLE_SPECIFIED = 1 << 3;
    const HOST_ENUMERABLE_SPECIFIED = 1 << 4;
    const HOST_CONFIGURABLE_SPECIFIED = 1 << 5;
    const HOST_HAS_VALUE = 1 << 7;
    const s4Throw = (message: string): Instr[] => {
      addStringConstantGlobal(ctx, message);
      return [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: s4TypeErrorCtorIdx },
        { op: "throw", tagIdx: s4ExnTagIdx },
      ];
    };
    // `(hf & valueBit) != 0` as an i32 0/1.
    const hfBit = (bit: number): Instr[] => [
      { op: "local.get", index: 9 },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    // `(efl & flagBit) != 0` as an i32 0/1 (existing entry's flag word, local 12).
    const eflBit = (bit: number): Instr[] => [
      { op: "local.get", index: 12 },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    // The preflight body, emitted after `o` (local 4) and `hf` (local 9) are set,
    // before the grow/insert. §10.1.6.3 in spec order.
    const s4Preflight: Instr[] = [
      // e = __obj_find(o, key)  (local 11)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 11 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // current is undefined (new property): §10.1.6.3 step 2 — reject if the
        // object is non-extensible.
        then: [
          { op: "local.get", index: 4 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: s4Throw("TypeError: Cannot define property, object is not extensible"),
          },
        ],
        // current exists: §10.1.6.3 step 4 — if current is non-configurable, gate
        // the forbidden transitions.
        else: [
          // efl = e.flags  (local 12)
          { op: "local.get", index: 11 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "local.set", index: 12 },
          // if (efl & FLAG_CONFIGURABLE) == 0  → current is non-configurable
          ...eflBit(FLAG_CONFIGURABLE),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 4.a: Desc specifies configurable:true → reject.
              ...hfBit(HOST_CONFIGURABLE_SPECIFIED),
              ...hfBit(1 << 2), // configurable value bit
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: s4Throw(
                  "TypeError: Cannot redefine property: configurable attribute of a non-configurable property",
                ),
              },
              // 4.b: Desc specifies enumerable that differs from current → reject.
              ...hfBit(HOST_ENUMERABLE_SPECIFIED),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...hfBit(1 << 1), // desc enumerable value
                  ...eflBit(FLAG_ENUMERABLE), // current enumerable
                  { op: "i32.ne" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: s4Throw(
                      "TypeError: Cannot redefine property: enumerable attribute of a non-configurable property",
                    ),
                  },
                ],
              },
              // 4.c: data↔accessor conversion. This is the DATA define path; if the
              // current entry is an accessor, converting it to data is forbidden.
              //
              // (#4491) …but only when Desc is NOT generic. Step 4.c reads "If
              // IsGenericDescriptor(Desc) is false and IsAccessorDescriptor(Desc)
              // is not IsAccessorDescriptor(current)" — a descriptor that mentions
              // neither [[Value]] nor [[Writable]] converts nothing, so
              // `Object.defineProperty(o, k, {})` (and an attributes-only
              // descriptor that agrees with the current attributes) over a
              // non-configurable accessor is a legal no-op, not a TypeError.
              // Steps 4.a/4.b above still reject a generic descriptor that asks
              // for configurable:true or a different enumerable, and step 5's
              // `keepAccessor` arm below already applies the generic case
              // correctly — this only removes a throw that pre-empted it
              // (`built-ins/Object/defineProperty/15.2.3.6-4-59`).
              ...hfBit(HOST_HAS_VALUE),
              ...hfBit(HOST_WRITABLE_SPECIFIED),
              { op: "i32.or" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...eflBit(FLAG_ACCESSOR),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: s4Throw(
                      "TypeError: Cannot redefine property: cannot convert a non-configurable accessor to a data property",
                    ),
                  },
                ],
              },
              // 4.d: both data, current non-writable (FLAG_WRITABLE clear) → reject
              // a writable:true request OR a value change (SameValue).
              ...eflBit(FLAG_WRITABLE),
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // writable false→true
                  ...hfBit(HOST_WRITABLE_SPECIFIED),
                  ...hfBit(1 << 0), // desc writable value
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: s4Throw(
                      "TypeError: Cannot redefine property: writable attribute of a non-configurable, non-writable property",
                    ),
                  },
                  // value change: Desc has a value (hasValue) AND
                  // !SameValue(descValue, e.value) → reject.
                  ...hfBit(HOST_HAS_VALUE),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // __object_is(descValue (param 2), e.value)
                      { op: "local.get", index: 2 },
                      { op: "local.get", index: 11 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                      { op: "extern.convert_any" },
                      { op: "call", funcIdx: s4ObjectIsIdx },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: s4Throw("TypeError: Cannot assign to read only property of a non-configurable property"),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    // (#4161, #4098) Carrier-bag substitution; bag local APPENDED at index 13
    // Runs AFTER the vec overlay (#3251 owns vec
    // receivers) and carries the lenient no-op as its bag-absent fallback.
    const dpValueClosureArm = defineCarrierBagSubstitutionArm(ctx, {
      recvLocalIdx: 0,
      anyLocalIdx: 5,
      bagLocalIdx: 13,
      fallback: [{ op: "local.get", index: 0 }, { op: "return" }],
    });
    const dpValueBoundaryLocal = 13 + (dpValueClosureArm ? 1 : 0);
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → vec receivers route to
      // the #3251 overlay (per-index/expando descriptor storage on a
      // companion $Object); a closure or native Error receiver defines into
      // its authoritative own-property bag and falls through into the unchanged
      // `$Object` path below — including the #2042-S4
      // ValidateAndApplyPropertyDescriptor preflight, which a function
      // receiver previously skipped entirely via the lenient no-op; anything
      // else keeps the lenient no-op (matches the host import returning O
      // unchanged).
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(boundaryObjectDefinePropertyValueIdx !== undefined
            ? [
                { op: "local.get", index: 0 } as Instr,
                { op: "local.get", index: 1 } as Instr,
                { op: "local.get", index: 2 } as Instr,
                { op: "local.get", index: 3 } as Instr,
                { op: "call", funcIdx: boundaryObjectDefinePropertyValueIdx } as Instr,
                { op: "local.tee", index: dpValueBoundaryLocal } as Instr,
                { op: "ref.is_null" } as Instr,
                { op: "i32.eqz" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: dpValueBoundaryLocal }, { op: "return" }],
                } as Instr,
              ]
            : []),
          ...vecOverlayArm(5, vecOverlay?.dpValueIdx ?? -1, 4),
          ...(dpValueClosureArm ?? [{ op: "local.get", index: 0 }, { op: "return" }]),
        ],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 5 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 4 },
      // hf = trunc_s(flagsF64)  (the host encoding is a small non-negative int)
      { op: "local.get", index: 3 },
      { op: "i32.trunc_f64_s" },
      { op: "local.set", index: 9 },
      // nflags = hf & (WRITABLE|ENUMERABLE|CONFIGURABLE)
      // Host value bits 0/1/2 line up with native FLAG_* bit positions, so a
      // direct mask is the translation. (Specified/hasValue/accessor bits 3-7
      // are dropped.)
      { op: "local.get", index: 9 },
      { op: "i32.const", value: NATIVE_ATTR_MASK },
      { op: "i32.and" },
      { op: "local.set", index: 8 },
      // #2042 S4 — ValidateAndApplyPropertyDescriptor preflight (throws on an
      // invalid (re)definition before any table mutation).
      ...s4Preflight,
      // (#2992 S3) EXISTING live entry → §10.1.6.3 steps 5-10 in-place MERGE.
      // A partial descriptor must PRESERVE every unspecified attribute and the
      // current [[Value]]; the old blanket `__obj_insert` reset unspecified
      // attrs to false, clobbered the value with the (null) value param on a
      // flags-only define, and wiped FLAG_ACCESSOR off accessor properties
      // (15.2.3.6-4-82-*, -107, -75; the "obj.prop stays 2010" family).
      // e (local 11) and efl (local 12) were resolved by the preflight.
      { op: "local.get", index: 11 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // spec = (hf >> 3) & 7 — the host "specified" bits 3/4/5 shift onto
          // the native W/E/C bit positions 0/1/2 (locals 6/7 are scratch here;
          // the merge path returns before the grow section reuses them).
          { op: "local.get", index: 9 },
          { op: "i32.const", value: 3 },
          { op: "i32.shr_u" },
          { op: "i32.const", value: 7 },
          { op: "i32.and" },
          { op: "local.set", index: 6 },
          // mergedWEC = ((efl & 7) & ~spec) | (hf & spec)
          { op: "local.get", index: 12 },
          { op: "i32.const", value: 7 },
          { op: "i32.and" },
          { op: "local.get", index: 6 },
          { op: "i32.const", value: -1 },
          { op: "i32.xor" },
          { op: "i32.and" },
          { op: "local.get", index: 9 },
          { op: "local.get", index: 6 },
          { op: "i32.and" },
          { op: "i32.or" },
          { op: "local.set", index: 7 },
          // nf = (efl & ~0x0F) | mergedWEC  (clears W/E/C + FLAG_ACCESSOR;
          // any other entry bits are preserved)
          { op: "local.get", index: 12 },
          { op: "i32.const", value: -16 },
          { op: "i32.and" },
          { op: "local.get", index: 7 },
          { op: "i32.or" },
          { op: "local.set", index: 8 },
          // keepAccessor = existing accessor AND a GENERIC desc (no [[Value]],
          // no [[Writable]]) — §10.1.6.3 step 6: generic descs only touch
          // attributes, the accessor halves stay live.
          ...eflBit(FLAG_ACCESSOR),
          { op: "local.get", index: 9 },
          { op: "i32.const", value: HOST_HAS_VALUE | HOST_WRITABLE_SPECIFIED },
          { op: "i32.and" },
          { op: "i32.eqz" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // flags-only update of an accessor: e.flags = nf | FLAG_ACCESSOR
              { op: "local.get", index: 11 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 8 },
              { op: "i32.const", value: FLAG_ACCESSOR },
              { op: "i32.or" },
              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
            ],
            else: [
              // data result: e.flags = nf (FLAG_ACCESSOR cleared)
              { op: "local.get", index: 11 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 8 },
              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              // [[Value]]: specified → overwrite; converting accessor→data →
              // undefined (null slot); otherwise PRESERVE the current value.
              ...hfBit(HOST_HAS_VALUE),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 11 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 2 },
                  { op: "any.convert_extern" },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                ],
                else: [
                  ...eflBit(FLAG_ACCESSOR),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: 11 },
                      { op: "ref.as_non_null" },
                      { op: "ref.null", typeIdx: NONE_HEAP },
                      { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                    ],
                  },
                ],
              },
              // converting accessor→data: clear the stale get/set slots.
              ...eflBit(FLAG_ACCESSOR),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 11 },
                  { op: "ref.as_non_null" },
                  { op: "ref.null", typeIdx: NONE_HEAP },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                  { op: "local.get", index: 11 },
                  { op: "ref.as_non_null" },
                  { op: "ref.null", typeIdx: NONE_HEAP },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                ],
              },
            ],
          },
          // merged in place — return O.
          { op: "local.get", index: 0 },
          { op: "return" },
        ],
      },
      // load = o.count + o.tombstones ; cap = o.props.len ; grow at LF 0.7
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 6 },
      // if (load + 1) * 10 >= cap * 7 → grow
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 4 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
      { op: "local.set", index: 10 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 10 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
      // __obj_insert(o, key, any.convert_extern(value), nflags, seq)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 10 },
      { op: "call", funcIdx: objInsertIdx },
      // return obj (host import returns O)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__defineProperty_value",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "nflags", type: { kind: "i32" } },
        { name: "hf", type: { kind: "i32" } },
        { name: "seq", type: { kind: "i32" } },
        { name: "e", type: entryRefNull }, // #2042 S4 — existing entry (local 11)
        { name: "efl", type: { kind: "i32" } }, // #2042 S4 — existing flags (local 12)
        // (#4161) closure own-property bag (local 13) — standalone/wasi only.
        ...(dpValueClosureArm
          ? ([{ name: "bag", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
        ...(boundaryObjectDefinePropertyValueIdx !== undefined
          ? ([{ name: "boundaryResult", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
      ],
      body,
    );
  }

  // ── __defineProperty_accessor (#1888 Slice 5 — native accessor-descriptor STORE) ─
  //
  // `Object.defineProperty(obj, key, { get?, set?, enumerable?, configurable? })`
  // and `Reflect.defineProperty` for an ACCESSOR descriptor under standalone /
  // WASI. The JS-host path is the `env::__defineProperty_accessor` import backed
  // by the JS descriptor sidecar; standalone has no host, so we store the boxed
  // getter/setter closures + attribute flags directly into the `$PropEntry`
  // accessor slots ($get field 4 / $set field 5).
  //
  // RUNTIME-LAYER GROUNDWORK (#1888 Slice 5). This + the native
  // `__getOwnPropertyDescriptor` below + the R3 `$PropEntry.$get/$set` layout are
  // the foundation for accessor descriptors under standalone. They are NOT yet
  // reached end-to-end (see the call-site note below), so they bank ~0 test262 on
  // their own — the value is de-risking the R3 layout change in isolation +
  // providing the runtime target the wiring follow-up calls.
  //
  // FOLLOW-UPS (both #329-gated — the late-shift / host-free-closure funcIdx
  // stability fix being driven now):
  //   - Call-site wiring: `Object.defineProperty(o,k,{get,set})` (object-ops.ts)
  //     compiles getter/setter via `compileArrowAsCallback` → `__make_getter_callback`
  //     (a JS-host import). Routing those to HOST-FREE closures so they reach this
  //     helper (and the GOPD readback can see real getter/setter) needs the #329
  //     funcIdx-stability fix.
  //   - LIVE get/set invocation on member read/write — the accessor arms in
  //     `__extern_get` / `__extern_set` invoke `$get`/`$set` with the original
  //     receiver bound as `this` via `__call_fn_method_0/1` (#1636-S1); also rides
  //     sd-1472c's #1224 `__call_fn_N` externref-arg coercion fix (now landed).
  //
  // Flag translation matches __defineProperty_value (host value bits 0/1/2 →
  // native FLAG_WRITABLE/_ENUMERABLE/_CONFIGURABLE) — but an accessor has no
  // writable attribute (ES §6.2.6.1), so we additionally OR in FLAG_ACCESSOR and
  // leave WRITABLE masked off via the same NATIVE_ATTR_MASK (the host accessor
  // encoding never sets bit 0). The data $value slot is cleared to null.
  //
  // params: 0=obj 1=key 2=getter(externref) 3=setter(externref) 4=flagsF64
  // locals: 5=o(ref null $Object) 6=any(anyref) 7=cap 8=load 9=nflags(i32) 10=hf(i32) 11=seq 12=e(ref null $PropEntry)
  //         13=efl(i32) 14=getSpec(i32) 15=setSpec(i32)  — #2992 S3 merge
  {
    const NATIVE_ATTR_MASK = FLAG_ENUMERABLE | FLAG_CONFIGURABLE; // 0x06 — accessors carry no WRITABLE
    // (#2992 S3) §10.1.6.3 ValidateAndApplyPropertyDescriptor for the accessor
    // define: partial descriptors MERGE into an existing entry (an absent
    // get/set half PRESERVES the live half; absent enumerable/configurable
    // preserve the current attribute), and a non-configurable current property
    // rejects the forbidden transitions with a catchable TypeError. The host
    // f64 flag word grows two "specified" bits for the halves:
    //   bit 8: [[Get]] specified      bit 9: [[Set]] specified
    // LEGACY compatibility: callers that set NEITHER bit (object-literal
    // accessor pairs, pre-slice emit sites) mean "both halves specified" —
    // the historical replace-both behavior.
    addUnionImportsViaRegistry(ctx);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const accTypeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const accExnTagIdx = ensureExnTag(ctx);
    const accObjectIsIdx = ctx.funcMap.get("__object_is")!;
    const ACC_HOST_ENUMERABLE_SPECIFIED = 1 << 4;
    const ACC_HOST_CONFIGURABLE_SPECIFIED = 1 << 5;
    const ACC_HOST_GET_SPECIFIED = 1 << 8;
    const ACC_HOST_SET_SPECIFIED = 1 << 9;
    const accThrow = (message: string): Instr[] => {
      addStringConstantGlobal(ctx, message);
      return [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: accTypeErrorCtorIdx },
        { op: "throw", tagIdx: accExnTagIdx },
      ];
    };
    // `(hf & bit) != 0` / `(efl & bit) != 0` as i32 0/1.
    const accHfBit = (bit: number): Instr[] => [
      { op: "local.get", index: 10 },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    const accEflBit = (bit: number): Instr[] => [
      { op: "local.get", index: 13 },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    // (#4161, #4098) Carrier-bag substitution; bag local APPENDED at index 16
    // (standalone/wasi only) — same shape as the `__defineProperty_value` arm.
    const dpAccessorClosureArm = defineCarrierBagSubstitutionArm(ctx, {
      recvLocalIdx: 0,
      anyLocalIdx: 6,
      bagLocalIdx: 16,
      fallback: [{ op: "local.get", index: 0 }, { op: "return" }],
    });
    const dpAccessorBoundaryLocal = 16 + (dpAccessorClosureArm ? 1 : 0);
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → vec receivers route to
      // the #3251 overlay; a closure or native Error receiver defines into its
      // own-property bag; anything else keeps the lenient no-op.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 6 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(boundaryObjectDefinePropertyAccessorIdx !== undefined
            ? [
                { op: "local.get", index: 0 } as Instr,
                { op: "local.get", index: 1 } as Instr,
                { op: "local.get", index: 2 } as Instr,
                { op: "local.get", index: 3 } as Instr,
                { op: "local.get", index: 4 } as Instr,
                { op: "call", funcIdx: boundaryObjectDefinePropertyAccessorIdx } as Instr,
                { op: "local.tee", index: dpAccessorBoundaryLocal } as Instr,
                { op: "ref.is_null" } as Instr,
                { op: "i32.eqz" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: dpAccessorBoundaryLocal }, { op: "return" }],
                } as Instr,
              ]
            : []),
          ...vecOverlayArm(6, vecOverlay?.dpAccessorIdx ?? -1, 5),
          // The carrier arm carries the lenient-no-op return as its own
          // bag-absent fallback and otherwise FALLS THROUGH to the `$Object`
          // path — so it must not be followed by an unconditional return.
          ...(dpAccessorClosureArm ?? [{ op: "local.get", index: 0 }, { op: "return" }]),
        ],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 6 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 5 },
      // hf = trunc_s(flagsF64)
      { op: "local.get", index: 4 },
      { op: "i32.trunc_f64_s" },
      { op: "local.set", index: 10 },
      // getSpec/setSpec — legacy fallback: no bit 8/9 set ⇒ both specified.
      { op: "local.get", index: 10 },
      { op: "i32.const", value: ACC_HOST_GET_SPECIFIED | ACC_HOST_SET_SPECIFIED },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...accHfBit(ACC_HOST_GET_SPECIFIED),
          { op: "local.set", index: 14 },
          ...accHfBit(ACC_HOST_SET_SPECIFIED),
          { op: "local.set", index: 15 },
        ],
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: 14 },
          { op: "i32.const", value: 1 },
          { op: "local.set", index: 15 },
        ],
      },
      // nflags = (hf & (ENUMERABLE|CONFIGURABLE)) | FLAG_ACCESSOR
      { op: "local.get", index: 10 },
      { op: "i32.const", value: NATIVE_ATTR_MASK },
      { op: "i32.and" },
      { op: "i32.const", value: FLAG_ACCESSOR },
      { op: "i32.or" },
      { op: "local.set", index: 9 },
      // (#2992 S3) e = __obj_find(o, key) — existing live entry → validate + merge in place.
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 12 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // efl = e.flags
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "local.set", index: 13 },
          // non-configurable current → §10.1.6.3 step 7 rejections
          ...accEflBit(FLAG_CONFIGURABLE),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 7.a configurable:true requested
              ...accHfBit(ACC_HOST_CONFIGURABLE_SPECIFIED),
              ...accHfBit(1 << 2),
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: accThrow(
                  "TypeError: Cannot redefine property: configurable attribute of a non-configurable property",
                ),
              },
              // 7.b enumerable flip requested
              ...accHfBit(ACC_HOST_ENUMERABLE_SPECIFIED),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...accHfBit(1 << 1),
                  ...accEflBit(FLAG_ENUMERABLE),
                  { op: "i32.ne" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: accThrow(
                      "TypeError: Cannot redefine property: enumerable attribute of a non-configurable property",
                    ),
                  },
                ],
              },
              // 7.c current is a data property → data→accessor conversion forbidden
              ...accEflBit(FLAG_ACCESSOR),
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: accThrow(
                  "TypeError: Cannot redefine property: cannot convert a non-configurable data property to an accessor",
                ),
              },
              // 7.d/e [[Get]]/[[Set]] change (SameValue) forbidden
              { op: "local.get", index: 14 },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 2 },
                  { op: "local.get", index: 12 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                  { op: "extern.convert_any" },
                  { op: "call", funcIdx: accObjectIsIdx },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: accThrow("TypeError: Cannot redefine property: get attribute of a non-configurable property"),
                  },
                ],
              },
              { op: "local.get", index: 15 },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 3 },
                  { op: "local.get", index: 12 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                  { op: "extern.convert_any" },
                  { op: "call", funcIdx: accObjectIsIdx },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: accThrow("TypeError: Cannot redefine property: set attribute of a non-configurable property"),
                  },
                ],
              },
            ],
          },
          // merge flags: spec = (hf >> 3) & 6 (E/C only — accessors carry no W)
          // nf = (efl & ~0x0F) | ((efl & 6 & ~spec) | (hf & spec)) | FLAG_ACCESSOR
          // (locals 7/8 are scratch here; this path returns before grow uses them)
          { op: "local.get", index: 10 },
          { op: "i32.const", value: 3 },
          { op: "i32.shr_u" },
          { op: "i32.const", value: 6 },
          { op: "i32.and" },
          { op: "local.set", index: 7 },
          { op: "local.get", index: 13 },
          { op: "i32.const", value: 6 },
          { op: "i32.and" },
          { op: "local.get", index: 7 },
          { op: "i32.const", value: -1 },
          { op: "i32.xor" },
          { op: "i32.and" },
          { op: "local.get", index: 10 },
          { op: "local.get", index: 7 },
          { op: "i32.and" },
          { op: "i32.or" },
          { op: "local.set", index: 8 },
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 13 },
          { op: "i32.const", value: -16 },
          { op: "i32.and" },
          { op: "local.get", index: 8 },
          { op: "i32.or" },
          { op: "i32.const", value: FLAG_ACCESSOR },
          { op: "i32.or" },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          // halves: specified → overwrite; absent → preserve (a data entry's
          // slots are already null, so conversion data→accessor is covered)
          { op: "local.get", index: 14 },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 12 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 2 },
              { op: "any.convert_extern" },
              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
            ],
          },
          { op: "local.get", index: 15 },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 12 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 3 },
              { op: "any.convert_extern" },
              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
            ],
          },
          // converting data→accessor: the data value slot dies.
          ...accEflBit(FLAG_ACCESSOR),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 12 },
              { op: "ref.as_non_null" },
              { op: "ref.null", typeIdx: NONE_HEAP },
              { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
            ],
          },
          // merged in place — return O.
          { op: "local.get", index: 0 },
          { op: "return" },
        ],
      },
      // NEW key on a non-extensible object → TypeError (§10.1.6.3 step 2,
      // matches the data-path preflight; previously a silent no-op).
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: accThrow("TypeError: Cannot define property, object is not extensible"),
      },
      // load = o.count + o.tombstones ; cap = o.props.len ; grow at LF 0.7
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 8 },
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 7 },
      // if (load + 1) * 10 >= cap * 7 → grow
      { op: "local.get", index: 8 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 5 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837)
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
      { op: "local.set", index: 11 },
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 11 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
      // __obj_insert(o, key, ref.null any, nflags, seq) — value slot stays null
      // for an accessor; this creates the entry (or updates flags in place) and
      // handles growth/tombstone reuse in one place.
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "ref.null", typeIdx: NONE_HEAP },
      { op: "local.get", index: 9 },
      { op: "local.get", index: 11 },
      { op: "call", funcIdx: objInsertIdx },
      // e = __obj_find(o, key) — re-locate the just-inserted/updated entry to
      // write the accessor slots. (__obj_insert does not take get/set params.)
      // It is always non-null here: either we just created it, or the update-in-
      // place branch matched an existing live entry. The only way to get null is
      // a non-extensible object refusing a NEW key — in which case there are no
      // accessor slots to write, so the null-guarded if is a correct no-op.
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 12 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // e.get = any.convert_extern(getter) ; e.set = any.convert_extern(setter)
          // A null externref (absent get/set) converts to a null anyref, which
          // GOPD reads back as `undefined` for that half of the descriptor.
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 },
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 3 },
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
          // e.value = null (clear any prior data value — accessors hold no value)
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "ref.null", typeIdx: NONE_HEAP },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
        ],
      },
      // return obj (host import returns O)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__defineProperty_accessor",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "nflags", type: { kind: "i32" } },
        { name: "hf", type: { kind: "i32" } },
        { name: "seq", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "efl", type: { kind: "i32" } },
        { name: "getSpec", type: { kind: "i32" } },
        { name: "setSpec", type: { kind: "i32" } },
        // (#4161) closure own-property bag (local 16) — standalone/wasi only.
        ...(dpAccessorClosureArm
          ? ([{ name: "bag", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
        ...(boundaryObjectDefinePropertyAccessorIdx !== undefined
          ? ([{ name: "boundaryResult", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
      ],
      body,
    );
  }

  const isVecCarrierIdx = ctx.funcMap.get("__is_vec_prop_carrier");

  // ── __defineProperties (#1906 — native plural descriptor apply) ─────────
  //
  // `Object.defineProperties(obj, Properties)` dynamic fallback under
  // `--target standalone`. The compiler's literal path already expands to
  // individual `Object.defineProperty` calls; this helper covers descriptor
  // maps that are themselves runtime `$Object`s (for example, dynamic or
  // computed-key maps that cannot be closed-shape inferred).
  //
  // Mirrors ECMA-262 §20.1.2.3.1 ObjectDefineProperties: pass 1 walks the
  // enumerable own keys of `Properties`, validates each `$Object` descriptor via
  // the supported ToPropertyDescriptor subset, and stores a compact descriptor
  // record in a temporary `$PropMap`; pass 2 applies the gathered records through
  // the existing native single-property helpers. Unsupported dynamic shapes
  // (non-`$Object` target/descriptor map/per-property descriptor, data+accessor
  // conflicts, non-callable get/set) throw before any target mutation.
  {
    addUnionImportsViaRegistry(ctx);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const exnTagIdx = ensureExnTag(ctx);
    // (#4055) `__hasOwnProperty` PLUS the #3468 closure bag — scoped to this
    // caller, because widening the helper itself cost 684 host-free passes
    // (#4017). Rationale in carrier-bag-hasown.ts; fallback for host/gc.
    const hasOwnIdx = ctx.funcMap.get("__desc_has_own") ?? ctx.funcMap.get("__hasOwnProperty")!;
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;
    const typeofObjectIdx = ctx.funcMap.get("__typeof_object")!;
    const defineValueIdx = ctx.funcMap.get("__defineProperty_value")!;
    const defineAccessorIdx = ctx.funcMap.get("__defineProperty_accessor")!;
    const externGetIdx = ctx.funcMap.get("__extern_get")!;

    const HOST_FLAG_WRITABLE_SPECIFIED = 1 << 3;
    const HOST_FLAG_ENUMERABLE_SPECIFIED = 1 << 4;
    const HOST_FLAG_CONFIGURABLE_SPECIFIED = 1 << 5;
    const HOST_FLAG_ACCESSOR = 1 << 6;
    const HOST_FLAG_HAS_VALUE = 1 << 7;

    const L_OBJ_ANY = 2;
    const L_OBJ = 3;
    const L_DESCS_ANY = 4;
    const L_DESCS = 5;
    const L_ORDERED = 6;
    const L_GATHERED = 7;
    const L_CAP = 8;
    const L_I = 9;
    const L_M = 10;
    const L_ENTRY = 11;
    const L_RAW_DESC = 12;
    const L_RAW_ANY = 13;
    const L_RAW_OBJ = 14;
    const L_FLAGS = 15;
    const L_HAS_DATA = 16;
    const L_HAS_ACCESSOR = 17;
    const L_KEY = 18;
    const L_VALUE = 19;
    const L_GETTER = 20;
    const L_SETTER = 21;
    // (#4161) closure `Properties` own-property bag — APPENDED (local 22),
    // standalone/wasi only.
    const L_BAG = 22;

    const keyRef = (key: string): Instr[] => [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
    const hasField = (key: string): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: hasOwnIdx },
    ];
    const getField = (key: string, nullishToNull = true): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) normalize missing/undefined fields to the legacy null convention.
      // (#3991) `value` opts OUT — there `undefined` is a real value, and null is not it.
      ...(nullishToNull && ctx.funcMap.has("__nullish_to_null")
        ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
        : []),
    ];
    const setFlag = (bit: number): Instr[] => [
      { op: "local.get", index: L_FLAGS },
      { op: "i32.const", value: bit },
      { op: "i32.or" },
      { op: "local.set", index: L_FLAGS },
    ];
    const throwTypeError = (message: string): Instr[] => {
      addStringConstantGlobal(ctx, message);
      return [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: typeErrorCtorIdx },
        { op: "throw", tagIdx: exnTagIdx },
      ];
    };
    const throwUnsupported = (site = ""): Instr[] =>
      throwTypeError(`Object.defineProperties unsupported descriptor shape in standalone mode (#1906)${site}`);
    const throwConflict = (): Instr[] =>
      throwTypeError("TypeError: Invalid property descriptor in Object.defineProperties (#1906)");
    const throwAccessor = (): Instr[] =>
      throwTypeError("TypeError: Object.defineProperties get/set must be callable (#1906)");
    // (#3957) ToObject(Properties) on null/undefined — §7.1.18 step 1/2.
    const throwPropertiesNotCoercible = (): Instr[] =>
      throwTypeError("TypeError: Cannot convert undefined or null to object");

    // (#4161, #4098) carrier `Properties` bag substitution (LOOKUP, never ensure).
    // `undefined` when every supported substrate is absent — the gate keeps its
    // pre-existing refusal and the local vector stays byte-identical.
    const propsClosureArm = definePropertiesCarrierBagArm(ctx, {
      propsLocalIdx: 1,
      descsAnyLocalIdx: L_DESCS_ANY,
      bagLocalIdx: L_BAG,
      emptyMapFallback: [{ op: "local.get", index: 0 }, { op: "return" }],
      nonClosureFallback: throwUnsupported(" [SITE-PROPS-BAG-NOT-AUTHORITATIVE]"),
    });

    // (#4230) VEC `Properties` map. Tried BEFORE the closure arm (a vec is
    // never a closure, so the order is only about which fallback wraps which)
    // The arms compose into one chain ending in the unchanged refusal. The key source is
    // the #3537 bag ∪ the #3251 overlay companion — see
    // `vec-props-key-source.ts` for why a UNION is as sound as the "one
    // authoritative store" the old comment demanded, and why an indexed vec
    // still refuses.
    reserveVecPropsKeySource(ctx);
    // Bag local (22) is appended only when the closure arm exists, so the key
    // source local lands at 22 or 23 accordingly — appended either way, so no
    // existing local index shifts.
    const L_VEC_KEYSRC = propsClosureArm ? 23 : 22;
    const propsVecArm = vecPropertiesKeySourceArm(ctx, {
      propsLocalIdx: 1,
      descsAnyLocalIdx: L_DESCS_ANY,
      keySrcLocalIdx: L_VEC_KEYSRC,
      indexedFallback: throwUnsupported(" [SITE-PROPS-VEC-INDEXED]"),
      nonVecFallback: propsClosureArm ?? throwUnsupported(" [SITE-PROPS-BAG-NOT-AUTHORITATIVE]"),
    });
    /** The composed carrier chain: vec → closure → refusal. */
    const propsCarrierArm = propsVecArm ?? propsClosureArm;

    // (#4230) `[] -> [i32]` — does receiver `O` have SOMEWHERE to store a
    // descriptor? Shared by the eager (non-standalone) and deferred
    // (standalone) forms of the `[SITE-O-NO-CARRIER]` refusal, so the two can
    // never drift apart.
    const oCarrierPresentTest: Instr[] = [
      ...(isVecCarrierIdx === undefined
        ? ([{ op: "i32.const", value: 0 }] satisfies Instr[])
        : ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: isVecCarrierIdx },
          ] satisfies Instr[])),
      ...(isDefineCarrierInstrs(ctx, 0) ?? ([{ op: "i32.const", value: 0 }] satisfies Instr[])),
      { op: "i32.or" },
    ];
    /**
     * Defer the receiver-carrier refusal past the key walk (standalone only —
     * gc/host keeps the exact prior instruction sequence AND local vector, so
     * its output stays byte-identical).
     */
    const deferOCarrierRefusal = ctx.standalone;
    /** Recorded verdict local — APPENDED last, standalone only. */
    const L_O_NOCARRIER = (propsClosureArm ? 23 : 22) + (propsVecArm ? 1 : 0);

    const readBooleanFlag = (key: string, specifiedBit: number, valueBit: number, marksData: boolean): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(marksData
            ? ([
                { op: "i32.const", value: 1 },
                { op: "local.set", index: L_HAS_DATA },
              ] satisfies Instr[])
            : []),
          ...setFlag(specifiedBit),
          ...getField(key),
          { op: "call", funcIdx: isTruthyIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: setFlag(valueBit),
          },
        ],
      },
    ];

    // (#2992 S3) get/set: mark hasAccessor + the half's "specified" bit
    // (8 = [[Get]], 9 = [[Set]]) so the `__defineProperty_accessor` applier
    // can MERGE a partial accessor descriptor. Distinguish present-undefined
    // (specified empty half) from explicit null (TypeError) under the
    // singleton regime — see the `__defineProperty_desc` twin.
    const HOST_FLAG_GET_SPECIFIED = 1 << 8;
    const HOST_FLAG_SET_SPECIFIED = 1 << 9;
    let dpUndefTagTypeIdx = -1;
    if (undefinedSingletonActive(ctx) && undefinedExternInstrs(ctx) !== undefined) {
      dpUndefTagTypeIdx = ctx.anyValueTypeIdx;
    }
    const rawField = (key: string): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
    ];
    const readAccessor = (key: "get" | "set", localIdx: number, specifiedBit: number): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: L_HAS_ACCESSOR },
          ...setFlag(specifiedBit),
          ...(dpUndefTagTypeIdx >= 0
            ? ([
                ...rawField(key),
                { op: "local.set", index: localIdx },
                { op: "local.get", index: localIdx },
                { op: "any.convert_extern" },
                { op: "local.tee", index: L_RAW_ANY },
                { op: "ref.test", typeIdx: dpUndefTagTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: L_RAW_ANY },
                    { op: "ref.cast", typeIdx: dpUndefTagTypeIdx },
                    { op: "struct.get", typeIdx: dpUndefTagTypeIdx, fieldIdx: 0 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.eq" },
                  ],
                  else: [{ op: "i32.const", value: 0 }],
                },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "ref.null.extern" }, { op: "local.set", index: localIdx }],
                  else: [
                    { op: "local.get", index: localIdx },
                    { op: "ref.is_null" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwAccessor(),
                    },
                    { op: "local.get", index: localIdx },
                    { op: "call", funcIdx: typeofFunctionIdx },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwAccessor(),
                    },
                  ],
                },
              ] satisfies Instr[])
            : ([
                ...getField(key),
                { op: "local.tee", index: localIdx },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: localIdx },
                    { op: "call", funcIdx: typeofFunctionIdx },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwAccessor(),
                    },
                  ],
                },
              ] satisfies Instr[])),
        ],
      },
    ];

    const body: Instr[] = [
      // ── Type(O) — §20.1.2.3.1 step 1 ──────────────────────────────────────
      //
      // (#4047) This used to be `ref.test $Object(O)` and refused everything
      // else. That was measurably the wrong question: 8 of the goal-scope
      // #1906 refusals are an ARRAY receiver, and `ref.test $Object` false does
      // not mean "not an object" (#4032, same idiom).
      //
      // `O` is otherwise UNUSED by this helper — the `L_OBJ` cast below was
      // dead (`void L_OBJ` at the end of the block) and pass 2 passes the raw
      // `local.get 0` externref to `__defineProperty_value` /
      // `__defineProperty_accessor`, which carry their OWN receiver dispatch
      // (`vecOverlayArm` → the #3251 per-index/expando companion). So the gate
      // had no downstream dependency at all; it only decided whether to refuse.
      //
      // What replaces it is the spec question plus an honesty check:
      //   Type(O) is not Object                  → TypeError (spec)
      //   `$Object` or a vec carrier             → proceed; the appliers store
      //   object with NO carrier (Date/RegExp/…) → keep the loud #1906 refusal
      // The last arm is load-bearing: `__defineProperty_value`'s terminal arm
      // for a carrier-less receiver is a LENIENT NO-OP (it returns O unchanged,
      // matching the host import). Letting such a receiver through would trade
      // a loud refusal for a silent wrong answer — the exact vacuity this
      // refusal exists to prevent.
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwTypeError("Object.defineProperties called on non-object") },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_OBJ_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Not the open-object representation. Type(O) must still be Object.
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: typeofObjectIdx },
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: typeofFunctionIdx },
          { op: "i32.or" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: throwTypeError("Object.defineProperties called on non-object"),
          },
          // An object, but is there anywhere to STORE a descriptor? The vec
          // carrier (#3251 overlay), closure carrier, and native Error carrier
          // (the appliers' own-property-bag arms) have applier arms; pass 2
          // passes the raw `local.get 0` receiver to the appliers, which carry
          // their own dispatch, so admission is all that is needed here.
          // Anything else (Date/RegExp/closed struct) keeps the loud refusal:
          // the appliers' terminal arm for a carrier-less receiver is a LENIENT
          // NO-OP, and letting one through would trade a loud refusal for a
          // silent wrong answer.
          //
          // (#4230) …but only when something is actually going to be DEFINED.
          // The receiver needs a store for a descriptor, not for the absence of
          // one: with `Properties` a primitive (`Object.defineProperties(o,
          // -12)`), ToObject yields a fresh wrapper with no own enumerable
          // properties, the key walk is empty, and "return O unchanged" is the
          // complete spec answer for ANY receiver. So under standalone the
          // verdict is RECORDED here and the throw is deferred to just before
          // pass 2, guarded on a non-empty gathered set. Strictly narrowing —
          // every input that refused before and still has work to do still
          // refuses, with the same message and the same tag.
          ...(deferOCarrierRefusal
            ? ([
                ...oCarrierPresentTest,
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: L_O_NOCARRIER },
                  ],
                },
              ] satisfies Instr[])
            : isVecCarrierIdx === undefined && isDefineCarrierInstrs(ctx, 0) === undefined
              ? throwUnsupported(" [SITE-O-NO-CARRIER]")
              : ([
                  ...oCarrierPresentTest,
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: throwUnsupported(" [SITE-O-NO-CARRIER]"),
                  },
                ] satisfies Instr[])),
        ],
      },

      // ── ToObject(Properties) + its own enumerable key source ──────────────
      //
      // (#3957 stated the constraint that shaped this; #4047 resolves the part
      // of it that is actually answerable.) Per §20.1.2.3.1 step 1 the argument
      // only has to be object-COERCIBLE, so a RegExp / Date / Array / Function
      // / arguments / Error / boxed-wrapper / primitive `Properties` is legal.
      // The old code answered every one of them with the #1906 refusal.
      //
      // #3957's objection to simply widening the gate was CORRECT and still
      // holds: the own-enumerable-key walk needs a real key source, and
      // `__object_keys` returns an EMPTY vec for every non-`$Object` receiver,
      // so a blanket widening trades a loud refusal for a SILENT no-op. (Both
      // halves re-measured 2026-08-02: `Object.keys([10,20,30]).length === 0`
      // and `Object.keys(fn-with-own-prop).length === 0` in standalone, while
      // the WRITES round-trip in both cases. Enumeration is the dead half.)
      //
      // The resolution is per-shape rather than blanket. Each arm below either
      // produces a COMPLETE key source or keeps refusing — no arm answers
      // "define nothing" unless "nothing" is what the spec says. The remaining
      // refusals are tagged so a future harvest reads the mechanism, not just
      // the family: STRING-INDICES, VEC-INDEXED, NO-CARRIER.
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwPropertiesNotCoercible() },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_DESCS_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: L_DESCS_ANY },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.set", index: L_DESCS },
        ],
        // (#4047) Not the open-object representation. The old code refused
        // outright; measured over the whole `built-ins/Object/{defineProperties,
        // create}` corpus (952 files, CI path) that single gate accounted for
        // 42 of the 50 goal-scope #1906 refusals, and NONE of them were the
        // descriptor-shape problem the message names. Resolve what CAN be
        // resolved, completely, and keep refusing only what genuinely has no
        // answer:
        else: [
          // (a) `Properties` is a native STRING. §7.1.18 ToObject("") is a
          //     String exotic with NO own enumerable keys, so the empty string
          //     is a complete, spec-correct NO-OP. A non-empty string has own
          //     enumerable index keys whose values are single-character
          //     STRINGS, and §6.2.5.6 ToPropertyDescriptor on a primitive is a
          //     TypeError — we cannot read those through the `$Object` walk, so
          //     that case KEEPS the loud refusal rather than defining nothing.
          ...(nativeStrTypeIdx >= 0
            ? ([
                { op: "local.get", index: L_DESCS_ANY },
                { op: "ref.test", typeIdx: nativeStrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: L_DESCS_ANY },
                    { op: "ref.cast", typeIdx: nativeStrTypeIdx },
                    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwUnsupported(" [SITE-PROPS-STRING-INDICES]"),
                    },
                    { op: "local.get", index: 0 },
                    { op: "return" },
                  ],
                },
              ] satisfies Instr[])
            : []),
          // (b) `undefined` — ToObject(undefined) is a TypeError (§7.1.18
          //     step 1). Under the #2106 singleton regime `undefined` is a
          //     STRUCT, not a null externref, so the `ref.is_null` guard above
          //     does not catch it and it would otherwise fall through to the
          //     primitive no-op below. Same tag test the accessor reader uses.
          ...(dpUndefTagTypeIdx >= 0
            ? ([
                { op: "local.get", index: L_DESCS_ANY },
                { op: "ref.test", typeIdx: dpUndefTagTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: L_DESCS_ANY },
                    { op: "ref.cast", typeIdx: dpUndefTagTypeIdx },
                    { op: "struct.get", typeIdx: dpUndefTagTypeIdx, fieldIdx: 0 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwPropertiesNotCoercible(),
                    },
                  ],
                },
              ] satisfies Instr[])
            : []),
          // (c) any other PRIMITIVE (boolean / number / symbol / bigint).
          //     ToObject creates a FRESH wrapper, which has zero own
          //     enumerable properties, so §20.1.2.3.1's key walk is empty and
          //     the whole operation is a no-op returning O. This is a COMPLETE
          //     answer, not a degraded one — it is the only shape in this
          //     block where "define nothing" is what the spec says.
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: typeofObjectIdx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: typeofFunctionIdx },
          { op: "i32.or" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
          // (d) a closure or native Error `Properties` map: substitute its
          //     authoritative own-property bag and fall through into the
          //     unchanged `$Object` key walk. SOUND NOW, and only now: the
          //     #4047-era measurement that reverted bag-enumeration found the
          //     bag was not the complete own-property store because
          //     `Object.defineProperty(props,"p",…)` on a Function landed
          //     NOWHERE (`__defineProperty_value`'s terminal arm was a lenient
          //     no-op for closures). With the #4161 applier arms, defines land
          //     in the same bag `__extern_set` writes, so the carrier bag IS
          //     the complete own-NAMED-property store. A carrier with no bag
          //     has no own enumerable named properties (builtin `name`/
          //     `length` metadata is non-enumerable), so "define nothing,
          //     return O" is the complete spec answer.
          //
          // (e) any OTHER object — Array, arguments, Date, RegExp, a
          //     closed struct — KEEPS REFUSING. The ARRAY half of the
          //     #4047-era unsoundness still holds: a vec's defines land in the
          //     SEPARATE #3251 overlay companion, not in its #3537 bag, so
          //     enumerating the bag would silently drop overlay-defined
          //     properties — the exact silent no-op #3957 forbade
          //     (`tests/issue-3957.test.ts`'s Array invariant case catches
          //     it). That arm becomes sound the moment ONE store is
          //     authoritative for a vec's own properties (#4010).
          //
          // (f) a VEC (Array / `arguments`) `Properties` map (#4230): substitute
          //     a merged key source built from BOTH of its stores. The (e) note
          //     above described this as blocked on ONE store becoming
          //     authoritative; #4230's finding is that COMPLETENESS is the real
          //     precondition and a union over the two enumerable stores supplies
          //     it. An INDEXED vec still refuses — its elements are own keys
          //     that live in neither side table.
          ...(propsCarrierArm === undefined
            ? throwUnsupported(" [SITE-PROPS-BAG-NOT-AUTHORITATIVE]")
            : ([
                ...propsCarrierArm,
                // Reached only on a substituted-map path (the other arms
                // return/throw): mirror the `$Object` branch's cast so the key
                // walk below reads a non-null L_DESCS.
                { op: "local.get", index: L_DESCS_ANY },
                { op: "ref.cast", typeIdx: objectTypeIdx },
                { op: "local.set", index: L_DESCS },
              ] satisfies Instr[])),
        ],
      },

      // ordered = enumerable own keys of Properties; gathered has the same
      // capacity and is filled compactly in pass 1.
      { op: "local.get", index: L_DESCS },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: L_ORDERED },
      { op: "array.len" },
      { op: "local.tee", index: L_CAP },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "local.set", index: L_GATHERED },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_M },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_I },

      // Pass 1: gather + validate.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: L_I },
              { op: "local.get", index: L_CAP },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: L_ORDERED },
              { op: "local.get", index: L_I },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: L_ENTRY },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },

              // key = entry.key.
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "local.set", index: L_KEY },

              // (#3957) rawDesc = Properties.[[Get]](key) — NOT the raw
              // `$PropEntry.value` SLOT the old code read.
              //
              // §20.1.2.3.1 step 3.b is a real `[[Get]]`, and the slot read was
              // observably wrong two ways:
              //   (1) an ACCESSOR entry has its value slot CLEARED TO NULL by
              //       `__defineProperty_accessor` ("accessors hold no value" —
              //       see the `struct.set fieldIdx 1 <- ref.null` above). So the
              //       slot read produced null and the null-descriptor guard
              //       below refused the whole call — even for a plain `{}`
              //       Properties map. `Object.create({}, props)` therefore threw
              //       "unsupported descriptor shape" whenever `props.prop` had
              //       been defined through a getter, which is the single most
              //       common way test262 builds a `Properties` map.
              //   (2) a getter that must run for its SIDE EFFECTS never ran.
              // `__extern_get` is the same accessor-aware [[Get]] the rest of
              // the runtime uses, and it proto-walks — which is correct here:
              // `__obj_ordered` already restricted the KEY set to own
              // enumerable keys, so the walk can only re-find the own property.
              { op: "local.get", index: 1 },
              { op: "local.get", index: L_KEY },
              { op: "call", funcIdx: externGetIdx },
              { op: "local.set", index: L_RAW_DESC },

              // (#3246) Per-property descriptor must be an OBJECT per
              // ToPropertyDescriptor §6.2.5.6 — ANY object (plain object,
              // function, array, wrapper), not only a native `$Object` struct.
              // The field reads below go through __hasOwnProperty/__extern_get,
              // which dispatch dynamically on any object externref, so accept
              // object|function and reject only primitives. (Pre-#3246 this
              // `ref.test $Object` gate over-rejected function/array descriptors
              // — e.g. `Object.create(o, {p: fn})` — as "unsupported shape".)
              // NOTE: `__typeof_object(null)` is 1 (typeof null === "object"),
              // but Type(null) is NOT Object, so a `null` descriptor value must
              // still throw (§6.2.5.6 step 2) — reject it explicitly first.
              { op: "local.get", index: L_RAW_DESC },
              { op: "ref.is_null" },
              { op: "if", blockType: { kind: "empty" }, then: throwUnsupported(" [SITE-DESC-NULL]") },
              { op: "local.get", index: L_RAW_DESC },
              { op: "call", funcIdx: typeofObjectIdx },
              { op: "local.get", index: L_RAW_DESC },
              { op: "call", funcIdx: typeofFunctionIdx },
              { op: "i32.or" },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: throwUnsupported(" [SITE-DESC-NOT-OBJ]") },

              // Reset descriptor accumulators. (#3319) The VALUE default is
              // `undefined` (§10.1.6.3 fresh-define [[Value]] default) — the
              // singleton under the #2106 regime, legacy null.extern
              // otherwise. The GETTER/SETTER null resets stay null: null is
              // the appliers' "absent half" convention (do not change).
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_FLAGS },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_HAS_DATA },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_HAS_ACCESSOR },
              ...(undefinedExternInstrs(ctx)?.map((i) => ({ ...i })) ?? [{ op: "ref.null.extern" } satisfies Instr]),
              { op: "local.set", index: L_VALUE },
              { op: "ref.null.extern" },
              { op: "local.set", index: L_GETTER },
              { op: "ref.null.extern" },
              { op: "local.set", index: L_SETTER },

              // Data descriptor fields.
              ...hasField("value"),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: 1 },
                  { op: "local.set", index: L_HAS_DATA },
                  ...setFlag(HOST_FLAG_HAS_VALUE),
                  ...getField("value", false),
                  { op: "local.set", index: L_VALUE },
                ],
              },
              ...readBooleanFlag("writable", HOST_FLAG_WRITABLE_SPECIFIED, FLAG_WRITABLE, true),
              ...readBooleanFlag("enumerable", HOST_FLAG_ENUMERABLE_SPECIFIED, FLAG_ENUMERABLE, false),
              ...readBooleanFlag("configurable", HOST_FLAG_CONFIGURABLE_SPECIFIED, FLAG_CONFIGURABLE, false),

              // Accessor descriptor fields.
              ...readAccessor("get", L_GETTER, HOST_FLAG_GET_SPECIFIED),
              ...readAccessor("set", L_SETTER, HOST_FLAG_SET_SPECIFIED),

              // Data/accessor conflict is a ToPropertyDescriptor TypeError.
              { op: "local.get", index: L_HAS_DATA },
              { op: "local.get", index: L_HAS_ACCESSOR },
              { op: "i32.and" },
              { op: "if", blockType: { kind: "empty" }, then: throwConflict() },
              { op: "local.get", index: L_HAS_ACCESSOR },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: setFlag(HOST_FLAG_ACCESSOR),
              },

              // gathered[m] = { key, value, flags, get, set } using the existing
              // $PropEntry layout as a compact descriptor-record carrier.
              { op: "local.get", index: L_GATHERED },
              { op: "local.get", index: L_M },
              { op: "local.get", index: L_KEY },
              { op: "any.convert_extern" },
              { op: "local.get", index: L_VALUE },
              { op: "any.convert_extern" },
              { op: "local.get", index: L_FLAGS },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: L_GETTER },
              { op: "any.convert_extern" },
              { op: "local.get", index: L_SETTER },
              { op: "any.convert_extern" },
              { op: "struct.new", typeIdx: propEntryTypeIdx },
              { op: "array.set", typeIdx: propMapTypeIdx },
              { op: "local.get", index: L_M },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_M },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // (#4230) The deferred `[SITE-O-NO-CARRIER]` verdict, now that the key
      // walk has run: refuse only if the receiver has no store AND there is at
      // least one descriptor to apply. An empty gathered set means the whole
      // operation is "return O", which every receiver can do.
      ...(deferOCarrierRefusal
        ? ([
            { op: "local.get", index: L_O_NOCARRIER },
            { op: "local.get", index: L_M },
            { op: "i32.and" },
            { op: "if", blockType: { kind: "empty" }, then: throwUnsupported(" [SITE-O-NO-CARRIER]") },
          ] satisfies Instr[])
        : []),

      // Pass 2: apply the gathered records through the existing single-property
      // helpers. No target mutation happened before this point.
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_I },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: L_I },
              { op: "local.get", index: L_M },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: L_GATHERED },
              { op: "local.get", index: L_I },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.set", index: L_ENTRY },
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "local.tee", index: L_FLAGS },
              { op: "i32.const", value: HOST_FLAG_ACCESSOR },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_FLAGS },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: defineAccessorIdx },
                  { op: "drop" },
                ],
                else: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_FLAGS },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: defineValueIdx },
                  { op: "drop" },
                ],
              },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      { op: "local.get", index: 0 },
    ];

    registerNative(
      "__defineProperties",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "objAny", type: { kind: "anyref" } },
        { name: "obj", type: objRefNull },
        { name: "descsAny", type: { kind: "anyref" } },
        { name: "descs", type: objRefNull },
        { name: "ordered", type: propMapRef },
        { name: "gathered", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "m", type: { kind: "i32" } },
        { name: "entry", type: entryRefNull },
        { name: "rawDesc", type: { kind: "externref" } },
        { name: "rawAny", type: { kind: "anyref" } },
        { name: "rawObj", type: objRefNull },
        { name: "flags", type: { kind: "i32" } },
        { name: "hasData", type: { kind: "i32" } },
        { name: "hasAccessor", type: { kind: "i32" } },
        { name: "key", type: { kind: "externref" } },
        { name: "value", type: { kind: "externref" } },
        { name: "getter", type: { kind: "externref" } },
        { name: "setter", type: { kind: "externref" } },
        // (#4161) closure Properties bag (local 22) — standalone/wasi only.
        ...(propsClosureArm
          ? ([{ name: "bag", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
        // (#4230) merged vec Properties key source — standalone/wasi only.
        ...(propsVecArm
          ? ([{ name: "vecKeySrc", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
        // (#4230) deferred receiver-carrier verdict — standalone only.
        ...(deferOCarrierRefusal
          ? ([{ name: "oNoCarrier", type: { kind: "i32" } }] as { name: string; type: ValType }[])
          : []),
      ],
      body,
    );
    void L_OBJ;
    void L_RAW_OBJ;
  }

  // ── __obj_define_from_desc (#1629b — native single dynamic-descriptor apply) ─
  //
  // `Object.defineProperty(obj, key, descVar)` where `descVar` is a runtime
  // value (not an inline `{...}` literal the compiler can statically expand).
  // The JS-host path routes to the `env::__defineProperty_desc` import; under
  // `--target standalone` there is no host, so this is the Wasm-native analogue
  // of host `_toPropertyDescriptorValidate` + apply (runtime.ts) over a
  // descriptor `$Object`. It mirrors EXACTLY the per-descriptor block in
  // `__defineProperties` above (same field reads, same conflict/callable
  // checks, same dispatch to `__defineProperty_value` / `__defineProperty_accessor`),
  // but for ONE (obj, key, desc) triple instead of a key-map.
  //
  // Spec: ES §6.2.5.6 ToPropertyDescriptor + §10.1.6.3 OrdinaryDefineOwnProperty.
  //   - non-object desc (here: not a standalone `$Object`) → TypeError §10.1.6.
  //     null/undefined desc → lenient empty-descriptor no-op (matches host
  //     leniency for absent struct reads; the call site already throws for a
  //     statically-non-object literal).
  //   - data (value|writable) + accessor (get|set) both present → TypeError.
  //   - get/set present and non-callable → TypeError.
  //
  // params: 0=obj(externref) 1=key(externref) 2=desc(externref)
  {
    addUnionImportsViaRegistry(ctx);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const exnTagIdx = ensureExnTag(ctx);
    // (#4055) `__hasOwnProperty` PLUS the #3468 closure bag — scoped to this
    // caller, because widening the helper itself cost 684 host-free passes
    // (#4017). Rationale in carrier-bag-hasown.ts; fallback for host/gc.
    const hasOwnIdx = ctx.funcMap.get("__desc_has_own") ?? ctx.funcMap.get("__hasOwnProperty")!;
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;
    const typeofObjectIdx = ctx.funcMap.get("__typeof_object")!;
    const defineValueIdx = ctx.funcMap.get("__defineProperty_value")!;
    const defineAccessorIdx = ctx.funcMap.get("__defineProperty_accessor")!;
    const externGetIdx = ctx.funcMap.get("__extern_get")!;

    // Host value-bit flag layout decoded by __defineProperty_value / _accessor.
    const HOST_FLAG_WRITABLE = FLAG_WRITABLE; // bit 0
    const HOST_FLAG_ENUMERABLE = FLAG_ENUMERABLE; // bit 1
    const HOST_FLAG_CONFIGURABLE = FLAG_CONFIGURABLE; // bit 2
    // (#2989) "Desc has a [[X]] field" specified-bits + hasValue bit — the
    // §10.1.6.3 ValidateAndApplyPropertyDescriptor preflight in
    // `__defineProperty_value` gates every spec TypeError on THESE bits (a
    // configurable/enumerable/writable change is only forbidden when the Desc
    // actually *specifies* that attribute). The inline-literal fast path
    // (`computeRuntimeFlags`, object-ops.ts) sets them; this dynamic-descriptor
    // applier previously set only the value bits 0/1/2, so the preflight read
    // "no attribute specified / no value" for every field → it never threw and
    // an invalid redefine silently no-op'd (array length non-writable→writable,
    // non-configurable redefine, non-extensible new prop via a `var` descriptor).
    const HOST_WRITABLE_SPECIFIED = 1 << 3;
    const HOST_ENUMERABLE_SPECIFIED = 1 << 4;
    const HOST_CONFIGURABLE_SPECIFIED = 1 << 5;
    const HOST_HAS_VALUE = 1 << 7;

    const L_DESC = 3; // desc as externref (after $Object validation)
    const L_DESC_ANY = 4;
    const L_FLAGS = 5;
    const L_HAS_DATA = 6;
    const L_HAS_ACCESSOR = 7;
    const L_VALUE = 8;
    const L_GETTER = 9;
    const L_SETTER = 10;
    const L_DEFINE_RESULT = 11; // (#3177 slice 4) dyn-view rejection-sentinel thread-out

    const keyRef = (key: string): Instr[] => [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
    const hasField = (key: string): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: hasOwnIdx },
    ];
    const getField = (key: string, nullishToNull = true): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) normalize missing/undefined descriptor fields back to the
      // legacy null convention so downstream null-keyed logic is unchanged.
      // (#4479) `value` opts OUT, exactly as the `__defineProperties` twin
      // already does since #3991 — for [[Value]] `undefined` is a REAL value
      // and null is not it. Collapsing it stored `ref.null`, so a descriptor
      // whose `value` field read back undefined defined a property holding
      // NULL: `typeof newObj.prop` answered "object" instead of "undefined"
      // (`built-ins/Object/create/15.2.3.5-4-162..165`, and the same shape
      // through `Object.defineProperty(o, k, descVar)`). The plural and
      // singular appliers must agree — this was the ONLY field read where
      // they disagreed.
      ...(nullishToNull && ctx.funcMap.has("__nullish_to_null")
        ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
        : []),
    ];
    const setFlag = (bit: number): Instr[] => [
      { op: "local.get", index: L_FLAGS },
      { op: "i32.const", value: bit },
      { op: "i32.or" },
      { op: "local.set", index: L_FLAGS },
    ];
    const throwTypeError = (message: string): Instr[] => {
      addStringConstantGlobal(ctx, message);
      return [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: typeErrorCtorIdx },
        { op: "throw", tagIdx: exnTagIdx },
      ];
    };
    // ToBoolean(getField(key)) → set valueBit; always set hasData when marksData.
    // (#2989) When the field is present, ALSO set its "specified" bit so the
    // `__defineProperty_value` §10.1.6.3 preflight can gate the spec TypeErrors.
    const readBooleanFlag = (key: string, valueBit: number, marksData: boolean, specifiedBit: number): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...setFlag(specifiedBit),
          ...(marksData
            ? ([
                { op: "i32.const", value: 1 },
                { op: "local.set", index: L_HAS_DATA },
              ] satisfies Instr[])
            : []),
          ...getField(key),
          { op: "call", funcIdx: isTruthyIdx },
          { op: "if", blockType: { kind: "empty" }, then: setFlag(valueBit) },
        ],
      },
    ];
    // (#2992 S3) get/set: mark hasAccessor + the half's "specified" bit
    // (8 = [[Get]], 9 = [[Set]]) so `__defineProperty_accessor` can MERGE a
    // partial accessor descriptor (absent half preserves the live half), then
    // classify the RAW field value:
    //   present-undefined → specified with an EMPTY half (null slot)
    //   explicit null     → TypeError (§6.2.5.6: not callable, not undefined)
    //   otherwise         → must be callable.
    // Under the legacy (pre-#2106-singleton) regime undefined reads back as
    // null already, so null keeps its historical lenient absent-half meaning.
    const HOST_GET_SPECIFIED = 1 << 8;
    const HOST_SET_SPECIFIED = 1 << 9;
    let undefTagTypeIdx = -1;
    if (undefinedSingletonActive(ctx) && undefinedExternInstrs(ctx) !== undefined) {
      undefTagTypeIdx = ctx.anyValueTypeIdx;
    }
    const rawField = (key: string): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
    ];
    const readAccessor = (key: "get" | "set", localIdx: number, specifiedBit: number): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: L_HAS_ACCESSOR },
          ...setFlag(specifiedBit),
          ...(undefTagTypeIdx >= 0
            ? ([
                ...rawField(key),
                { op: "local.set", index: localIdx },
                // tag-1 $AnyValue box (the undefined singleton)?
                { op: "local.get", index: localIdx },
                { op: "any.convert_extern" },
                { op: "local.tee", index: L_DESC_ANY },
                { op: "ref.test", typeIdx: undefTagTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: L_DESC_ANY },
                    { op: "ref.cast", typeIdx: undefTagTypeIdx },
                    { op: "struct.get", typeIdx: undefTagTypeIdx, fieldIdx: 0 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.eq" },
                  ],
                  else: [{ op: "i32.const", value: 0 }],
                },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "ref.null.extern" }, { op: "local.set", index: localIdx }],
                  else: [
                    { op: "local.get", index: localIdx },
                    { op: "ref.is_null" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwTypeError("TypeError: Getter/setter must be a function"),
                    },
                    { op: "local.get", index: localIdx },
                    { op: "call", funcIdx: typeofFunctionIdx },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwTypeError("TypeError: Getter/setter must be a function"),
                    },
                  ],
                },
              ] satisfies Instr[])
            : ([
                ...getField(key),
                { op: "local.tee", index: localIdx },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: localIdx },
                    { op: "call", funcIdx: typeofFunctionIdx },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwTypeError("TypeError: Getter/setter must be a function"),
                    },
                  ],
                },
              ] satisfies Instr[])),
        ],
      },
    ];

    const body: Instr[] = [
      // desc null → empty-descriptor no-op, return obj.
      { op: "local.get", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 0 }, { op: "return" }] },
      // (#3246) desc must be an OBJECT per ToPropertyDescriptor §10.1.6 — ANY
      // object (plain object, function, array, wrapper), not only a native
      // `$Object` struct. The field reads below dispatch dynamically via
      // __hasOwnProperty/__extern_get on the externref, so accept
      // object|function and throw only for primitives. (Pre-#3246 this
      // `ref.test $Object` gate over-rejected a function/array descriptor —
      // e.g. `Object.create(o, {p: fnObj})` — with a spurious TypeError.)
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: typeofObjectIdx },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: typeofFunctionIdx },
      { op: "i32.or" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwTypeError("TypeError: Property description must be an object"),
      },
      { op: "local.get", index: 2 },
      { op: "local.set", index: L_DESC },

      // Reset accumulators. (#3319) The VALUE default is `undefined`
      // (§10.1.6.3 fresh-define [[Value]] default) — the singleton under the
      // #2106 regime, legacy null.extern otherwise. The GETTER/SETTER null
      // resets stay null: null is the appliers' "absent half" convention.
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_FLAGS },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_HAS_DATA },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_HAS_ACCESSOR },
      ...(undefinedExternInstrs(ctx)?.map((i) => ({ ...i })) ?? [{ op: "ref.null.extern" } satisfies Instr]),
      { op: "local.set", index: L_VALUE },
      { op: "ref.null.extern" },
      { op: "local.set", index: L_GETTER },
      { op: "ref.null.extern" },
      { op: "local.set", index: L_SETTER },

      // value present → hasData + hasValue bit (#2989), capture value.
      ...hasField("value"),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: L_HAS_DATA },
          ...setFlag(HOST_HAS_VALUE),
          ...getField("value", false),
          { op: "local.set", index: L_VALUE },
        ],
      },
      ...readBooleanFlag("writable", HOST_FLAG_WRITABLE, true, HOST_WRITABLE_SPECIFIED),
      ...readBooleanFlag("enumerable", HOST_FLAG_ENUMERABLE, false, HOST_ENUMERABLE_SPECIFIED),
      ...readBooleanFlag("configurable", HOST_FLAG_CONFIGURABLE, false, HOST_CONFIGURABLE_SPECIFIED),
      ...readAccessor("get", L_GETTER, HOST_GET_SPECIFIED),
      ...readAccessor("set", L_SETTER, HOST_SET_SPECIFIED),

      // data + accessor conflict → TypeError (§6.2.5.6 step 4).
      { op: "local.get", index: L_HAS_DATA },
      { op: "local.get", index: L_HAS_ACCESSOR },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwTypeError(
          "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
        ),
      },

      // Apply: accessor → __defineProperty_accessor(obj, key, get, set, flags);
      //        data     → __defineProperty_value(obj, key, value, flags).
      { op: "local.get", index: L_HAS_ACCESSOR },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: L_GETTER },
          { op: "local.get", index: L_SETTER },
          { op: "local.get", index: L_FLAGS },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: defineAccessorIdx },
          { op: "local.set", index: L_DEFINE_RESULT },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: L_VALUE },
          { op: "local.get", index: L_FLAGS },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: defineValueIdx },
          { op: "local.set", index: L_DEFINE_RESULT },
        ],
      },
      // (#3177 slice 4) Thread the [[DefineOwnProperty]] REJECTION sentinel
      // out: the dyn-view arms in __defineProperty_value/_accessor return
      // ref.null.extern on a §10.4.5.3 false (every ordinary path returns the
      // input obj, never null), so a null result propagates to the caller —
      // Reflect.defineProperty's `__is_truthy` reads it as the spec `false`.
      { op: "local.get", index: L_DEFINE_RESULT },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
    ];

    registerNative(
      "__obj_define_from_desc",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "desc", type: { kind: "externref" } },
        { name: "descAny", type: { kind: "anyref" } },
        { name: "flags", type: { kind: "i32" } },
        { name: "hasData", type: { kind: "i32" } },
        { name: "hasAccessor", type: { kind: "i32" } },
        { name: "value", type: { kind: "externref" } },
        { name: "getter", type: { kind: "externref" } },
        { name: "setter", type: { kind: "externref" } },
        { name: "defineResult", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __getOwnPropertyDescriptor (#1888 Slice 5 — native descriptor read-back) ─
  //
  // `Object.getOwnPropertyDescriptor(obj, key)` / `Reflect.getOwnPropertyDescriptor`
  // under standalone. Reads the own `$PropEntry` for `key` and materialises a
  // descriptor `$Object`:
  //   accessor (flags & FLAG_ACCESSOR) → { get, set, enumerable, configurable }
  //   data                            → { value, writable, enumerable, configurable }
  // A missing own property, or a non-`$Object` receiver, returns `undefined`
  // (the null externref). This is the read side of the Slice-5 store/round-trip:
  // a getter/setter installed via `__defineProperty_accessor` reads back here as
  // `{ get, set, … }`. The boxed getter/setter come straight out of the
  // `$PropEntry.$get/$set` anyref slots via `extern.convert_any` (a null anyref —
  // an absent half — reads back as `undefined`).
  //
  // Descriptor keys ("get"/"set"/"value"/"writable"/"enumerable"/"configurable")
  // are materialised as native `$NativeString`s (standalone forces nativeStrings)
  // and handed to `__extern_set` as externref — `$NativeString <: $AnyString`, so
  // the insert's `ref.cast $AnyString` succeeds. Attribute booleans are boxed via
  // `__box_boolean` (registered through addUnionImportsViaRegistry, same defined-
  // func, no-index-shift invariant as the rest of this runtime).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=any(anyref) 3=o(ref null $Object) 4=e(ref null $PropEntry)
  //         5=fl(i32) 6=desc(externref)
  {
    // __box_boolean is needed for the attribute flags — register the union
    // helpers (idempotent; defined funcs, no index shift) and resolve it.
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const boxNumIdx = ctx.funcMap.get("__box_number")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;

    // (#2987) String-wrapper exotic own-property synthesis. `new String("ab")`
    // is a `$Object` wrapper carrying its [[StringData]] native string in the
    // reserved FLAG_INTERNAL slot (#1910 S2). Its integer-index own properties
    // ("0".."n-1") and "length" are String-exotic (§10.4.3) and have NO ordinary
    // `$PropEntry`, so `__obj_find` misses them and gOPD returned `undefined`.
    // When the ordinary lookup misses we recover the slot string and synthesize
    // the spec descriptor: index → { value: char, writable:false, enumerable:true,
    // configurable:false }; "length" → { value: len, writable:false,
    // enumerable:false, configurable:false }. Standalone + nativeStrings only —
    // the gc/host lane keeps its host `getOwnPropertyDescriptor` (byte-inert).
    const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
    const strExotic = ctx.standalone && ctx.nativeStrings && anyStrTypeIdx >= 0 && charAtIdx !== undefined;
    const stringExternG = (value: string): Instr[] => {
      addStringConstantGlobal(ctx, value);
      return stringConstantExternrefInstrs(ctx, value);
    };
    const boxBoolConst = (v: number): Instr[] => [
      { op: "i32.const", value: v },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    // `__extern_set(desc, "<key>", <value externref>)` — desc is in local 6.
    // `valueInstrs` must leave one externref on the stack.
    const setKey = (key: string, valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: 6 }, // desc (externref)
      // key: native string → externref
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" },
      ...valueInstrs,
      { op: "call", funcIdx: externSetIdx },
    ];

    // Box `(e.flags & MASK) != 0` as a JS boolean externref.
    const boolAttr = (mask: number): Instr[] => [
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: mask },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    // (#3316) Materialize an accessor HALF (e.get = field 4 / e.set = field 5)
    // as an externref descriptor value. Under the `undefinedSingleton` regime a
    // NULL stored half must surface as the `$undefined` singleton (null ≠
    // undefined there); legacy lanes keep the bare `extern.convert_any`
    // byte-identical (null externref is their undefined representation).
    const undefExternGopd = undefinedSingletonActive(ctx) ? undefinedExternInstrs(ctx) : undefined;
    const readHalf = (fieldIdx: number): Instr[] => [
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx },
    ];
    const accessorHalfInstrs = (fieldIdx: number): Instr[] =>
      undefExternGopd
        ? [
            ...readHalf(fieldIdx),
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [...undefExternGopd],
              else: [...readHalf(fieldIdx), { op: "extern.convert_any" }],
            },
          ]
        : [...readHalf(fieldIdx), { op: "extern.convert_any" }];

    // (#2987) String-wrapper exotic own-property arm — runs when the ordinary
    // `__obj_find` misses. Locals: 7=sEnt(ref null $PropEntry) 8=sVal(anyref)
    // 9=wStr(ref null $NativeString) 10=wLen(i32) 11=kStr(ref null $NativeString)
    // 12=kIdx(i32). Always ends in a `return` on every control path.
    const L_SENT = 7;
    const L_SVAL = 8;
    const L_WSTR = 9;
    const L_WLEN = 10;
    const L_KSTR = 11;
    const L_KIDX = 12;
    // (#3319) A gOPD MISS (no own property / non-`$Object` receiver) answers
    // `undefined`. Under the `undefinedSingleton` regime (#2106 flip) that
    // must be the `$undefined` singleton — a bare null externref is `null`,
    // DISTINCT from `undefined` there, so `gOPD(o, missing) === undefined`
    // answered false (the issue-2874 typed-receiver and issue-2896
    // post-delete residual shapes documented in #3316). Legacy lanes keep the
    // byte-identical `[ref.null.extern, return]`. FACTORY returning fresh
    // instruction objects, not one shared array — the singleton arm carries
    // an index-bearing `global.get` and this sequence lands in several
    // branches (aliasing one Instr[] into branches double-remaps on shifts).
    const missUndefExtern = undefinedSingletonActive(ctx) ? undefinedExternInstrs(ctx) : undefined;
    const undefRet = (): Instr[] => [
      ...(missUndefExtern ? missUndefExtern.map((i) => ({ ...i })) : [{ op: "ref.null.extern" } satisfies Instr]),
      { op: "return" },
    ];
    // Build a fresh data descriptor into `desc` (local 6) and return it.
    const exoticDataDesc = (valueInstrs: Instr[], enumerable: number): Instr[] => [
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 6 },
      ...setKey("value", valueInstrs),
      ...setKey("writable", boxBoolConst(0)),
      ...setKey("enumerable", boxBoolConst(enumerable)),
      ...setKey("configurable", boxBoolConst(0)),
      { op: "local.get", index: 6 },
      { op: "return" },
    ];
    // (#2175 P2) Index of the companion scratch appended LAST to this native's
    // local vector. Fixed locals are any=2, o=3, e=4, fl=5, desc=6; the six
    // `strExotic` locals (7..12) are present only when that arm is active.
    // Empty when the proto-index store is unreserved, keeping modules that never
    // write a builtin prototype byte-identical. The substitution is a CALL to a
    // finalize-filled helper and bakes no type index here — see its reserve site
    // in proto-index-store.ts for why that matters.
    const gopdNpcArm = protoIndexOwnViewSubstituteInstrs(ctx, 0);
    const stringExoticArm: Instr[] = strExotic
      ? [
          // key must be a string property key (else no exotic own property).
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: 2 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet() },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.set", index: L_KSTR },
          // slotEnt = __obj_find(o, "[[PrimitiveValue]]") — absent ⇒ not a wrapper.
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          ...stringExternG(WRAPPER_PRIMITIVE_KEY),
          { op: "call", funcIdx: objFindIdx },
          { op: "local.tee", index: L_SENT },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet() },
          // sVal = slotEnt.value; a String wrapper's [[StringData]] is a string.
          { op: "local.get", index: L_SENT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
          { op: "local.tee", index: L_SVAL },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet() },
          // wStr = flatten([[StringData]]); wLen = wStr.len
          { op: "local.get", index: L_SVAL },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.tee", index: L_WSTR },
          { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: L_WLEN },
          // "length" → { value: len, writable:false, enumerable:false, configurable:false }
          { op: "local.get", index: L_KSTR },
          ...nativeStringLiteralInstrs(ctx, "length"),
          { op: "call", funcIdx: strEqualsIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: exoticDataDesc(
              [{ op: "local.get", index: L_WLEN }, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }],
              0,
            ),
          },
          // integer index in [0, len) → { value: char, writable:false, enumerable:true, configurable:false }
          { op: "local.get", index: L_KSTR },
          { op: "call", funcIdx: objIndexOfKeyIdx },
          { op: "local.tee", index: L_KIDX },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          { op: "local.get", index: L_KIDX },
          { op: "local.get", index: L_WLEN },
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: exoticDataDesc(
              [
                { op: "local.get", index: L_WSTR },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_KIDX },
                { op: "call", funcIdx: charAtIdx as number },
                { op: "extern.convert_any" },
              ],
              1,
            ),
          },
          // no exotic own property matched → undefined
          ...undefRet(),
        ]
      : undefRet();

    // (#2984 "primitive-string(s)") NON-`$Object` receiver arm. §19.1.2.8
    // ToObject-coerces the receiver: undefined/null THROW TypeError (step 1;
    // the ES5-era tests 15.2.3.3-1-{1,2} + gOPDs exception-not-object-coercible
    // assert exactly this), a primitive STRING answers its String-exotic own
    // properties (§10.4.3 — same synthesis as the #2987 wrapper arm, with
    // [[StringData]] = the receiver itself), and every other primitive (boxed
    // number/boolean/Symbol — wrappers own no properties) answers `undefined`.
    // Standalone+nativeStrings gated exactly like `strExotic` so the gc/host
    // registration of this runtime keeps byte-identical output.
    const gopdTypeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
    const gopdToPropertyKeyIdx = ctx.funcMap.get("__to_property_key");
    const gopdExnTagIdx = strExotic && gopdTypeErrorCtorIdx !== undefined ? ensureExnTag(ctx) : -1;
    // Under the `$undefined` singleton regime (#2106/#3316) the arm's own miss
    // returns must surface the singleton (a bare null externref is NOT observed
    // as `undefined` there), and an `undefined` RECEIVER arrives as the non-null
    // tag-1 `$AnyValue` box — so the ToObject-throw test is `ref.is_null` OR
    // tag-1-singleton (receiver-as-any is already tee'd in local 2).
    // (#3319 merge reconciliation) `undefRet` is now a singleton-aware
    // FACTORY (miss → $undefined singleton under the regime, legacy
    // null.extern) — exactly the dispatch #3154's `gopdUndefRet` open-coded
    // via `undefExternGopd`, so it simply delegates.
    const gopdUndefRet: Instr[] = undefRet();
    const gopdUndefSingletonOr: Instr[] = (() => {
      if (!undefinedSingletonActive(ctx)) return [];
      ensureAnyValueType(ctx);
      if (ctx.anyValueTypeIdx < 0) return [];
      const t = ctx.anyValueTypeIdx;
      return [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: t },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx: t },
            { op: "struct.get", typeIdx: t, fieldIdx: 0 },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
        { op: "i32.or" },
      ] satisfies Instr[];
    })();
    const primitiveReceiverArm: Instr[] =
      strExotic && gopdTypeErrorCtorIdx !== undefined && gopdExnTagIdx >= 0 && gopdToPropertyKeyIdx !== undefined
        ? [
            // undefined/null receiver → ToObject throws TypeError (§19.1.2.8).
            { op: "local.get", index: 0 },
            { op: "ref.is_null" },
            ...gopdUndefSingletonOr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...stringExternG("Cannot convert undefined or null to object"),
                { op: "call", funcIdx: gopdTypeErrorCtorIdx } as Instr,
                { op: "throw", tagIdx: gopdExnTagIdx } as Instr,
              ],
            },
            // Primitive string receiver → String-exotic own properties.
            { op: "local.get", index: 2 },
            { op: "ref.test", typeIdx: anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // wStr = flatten(cast<$AnyString>(receiver)); wLen = wStr.len
                { op: "local.get", index: 2 },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                { op: "call", funcIdx: strFlattenIdx },
                { op: "local.tee", index: L_WSTR },
                { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
                { op: "local.set", index: L_WLEN },
                // key = ToPropertyKey(key) — a numeric index arrives boxed
                // (`gOPD('foo', 0)`); non-string keys own nothing → undefined.
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: gopdToPropertyKeyIdx },
                { op: "any.convert_extern" },
                { op: "local.tee", index: L_SVAL },
                { op: "ref.test", typeIdx: anyStrTypeIdx },
                { op: "i32.eqz" },
                { op: "if", blockType: { kind: "empty" }, then: gopdUndefRet },
                { op: "local.get", index: L_SVAL },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                { op: "call", funcIdx: strFlattenIdx },
                { op: "local.set", index: L_KSTR },
                // "length" → { value: len, w:false, e:false, c:false }
                { op: "local.get", index: L_KSTR },
                ...nativeStringLiteralInstrs(ctx, "length"),
                { op: "call", funcIdx: strEqualsIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: exoticDataDesc(
                    [
                      { op: "local.get", index: L_WLEN },
                      { op: "f64.convert_i32_s" },
                      { op: "call", funcIdx: boxNumIdx },
                    ],
                    0,
                  ),
                },
                // integer index in [0, len) → { value: char, w:false, e:true, c:false }
                { op: "local.get", index: L_KSTR },
                { op: "call", funcIdx: objIndexOfKeyIdx },
                { op: "local.tee", index: L_KIDX },
                { op: "i32.const", value: 0 },
                { op: "i32.ge_s" },
                { op: "local.get", index: L_KIDX },
                { op: "local.get", index: L_WLEN },
                { op: "i32.lt_s" },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: exoticDataDesc(
                    [
                      { op: "local.get", index: L_WSTR },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: L_KIDX },
                      { op: "call", funcIdx: charAtIdx as number },
                      { op: "extern.convert_any" } as Instr,
                    ],
                    1,
                  ),
                },
                ...gopdUndefRet,
              ],
            },
            // Other primitives (boxed number/boolean/Symbol) → no own props.
            ...gopdUndefRet,
          ]
        : [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr];

    const body: Instr[] = [
      // (#2896) Builtin-fn metadata arm: gOPD over a builtin function value
      // synthesizes the spec data descriptor for its "name"/"length" own
      // properties ({writable:false, enumerable:false, configurable:true}).
      // The helper is filled at finalize; non-meta receivers return null and
      // fall through to the `$Object` path below.
      ...(bfnGopdIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnGopdIdx },
            { op: "local.tee", index: 6 }, // desc local (externref) — reused
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 6 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      ...(boundaryObjectGetOwnPropertyDescriptorIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: boundaryObjectGetOwnPropertyDescriptorIdx },
            { op: "local.tee", index: 6 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 6 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // any = any.convert_extern(obj) ; if !$Object → vec receivers consult
      // the #3251 overlay (companion entry / implicit element descriptor),
      // (#2175 P2) Substitute a `$NativeProto` receiver by its brand COMPANION
      // before the `$Object` test below, so an entry written by
      // `defineProperty(<Builtin>.prototype, …)` is described by the ordinary
      // path — including its REAL flag bits, which the #4176 write arm already
      // stored on the companion's `$PropEntry`. Without this the receiver failed
      // `ref.test $Object` and fell into the non-object arm, answering
      // `undefined` while a plain read of the same key returned its value.
      // Own-layer only, no chain walk; inert for every other receiver.
      ...gopdNpcArm,
      // then the primitive-receiver arm (#2984: nullish → TypeError, string →
      // §10.4.3 exotic, else undefined — where "undefined" is the #3319
      // singleton-aware miss return).
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // (#4010 S3) the FUNCTION receiver's closure bag sits between the vec overlay and the primitive arm
        then: bagGopdBetween(ctx, 6, vecOverlayArm(2, vecOverlay?.gopdIdx ?? -1, 2), primitiveReceiverArm),
      },
      // o = cast<$Object>(any) ; e = __obj_find(o, key)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 4 },
      // if e == null → try String-wrapper exotic own property (#2987), else undefined
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: stringExoticArm,
      },
      // fl = e.flags
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 6 },
      // accessor vs data branch
      { op: "local.get", index: 5 },
      { op: "i32.const", value: FLAG_ACCESSOR },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // accessor: { get, set, enumerable, configurable }
        //
        // (#3316) Empty accessor halves are stored as NULL anyref. Legacy
        // regime: null externref *is* the undefined representation, so a bare
        // `extern.convert_any` sufficed. Under the `undefinedSingleton` regime
        // (#2106) null is DISTINCT from undefined — `desc.get === undefined`
        // on an explicit `{get: undefined}` define read back null and answered
        // false (15.2.3.6-4-439 shape). Materialize a null half as the
        // singleton so gOPD observes `undefined`; non-null halves are
        // unchanged. Legacy lanes keep the byte-identical bare conversion.
        then: [
          // desc.get = e.get == null ? undefined : extern.convert_any(e.get)
          ...setKey("get", accessorHalfInstrs(4)),
          // desc.set = e.set == null ? undefined : extern.convert_any(e.set)
          ...setKey("set", accessorHalfInstrs(5)),
        ],
        // data: { value, writable }
        else: [
          // desc.value = extern.convert_any(e.value)
          ...setKey("value", [
            { op: "local.get", index: 4 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
            { op: "extern.convert_any" },
          ]),
          // desc.writable = box(fl & FLAG_WRITABLE)
          ...setKey("writable", boolAttr(FLAG_WRITABLE)),
        ],
      },
      // common: enumerable, configurable
      ...setKey("enumerable", boolAttr(FLAG_ENUMERABLE)),
      ...setKey("configurable", boolAttr(FLAG_CONFIGURABLE)),
      // return desc
      { op: "local.get", index: 6 },
    ];
    registerNative(
      "__getOwnPropertyDescriptor",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
        { name: "fl", type: { kind: "i32" } },
        { name: "desc", type: { kind: "externref" } },
        // (#2987) String-wrapper exotic own-property arm locals (7..12). Only
        // emitted when the arm is active (standalone) so every other lane — where
        // `stringExoticArm` is the original `[null.extern, return]` — keeps its
        // byte-identical function body + local vector.
        ...(strExotic
          ? ([
              { name: "sEnt", type: entryRefNull },
              { name: "sVal", type: { kind: "anyref" } },
              { name: "wStr", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
              { name: "wLen", type: { kind: "i32" } },
              { name: "kStr", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
              { name: "kIdx", type: { kind: "i32" } },
            ] as { name: string; type: ValType }[])
          : []),
      ],
      body,
    );
  }

  // ── __create_descriptor(value, flags) -> externref (#2874 standalone-native) ─
  //
  // Standalone-native carrier for the host `__create_descriptor` consumed by the
  // `Object.getOwnPropertyDescriptor` typed-receiver fast path
  // (`expressions/calls.ts:6652`/`:6808`). That fast path inlines `struct.get`
  // for a statically-typed receiver, then calls `__create_descriptor(value,
  // flags)` to wrap the field value in a data descriptor. The host import has no
  // standalone carrier, so the typed-receiver case leaked `env::__create_descriptor`
  // and the standalone module trapped (#2874; the `any`-typed / inline-literal
  // receiver already resolves natively).
  //
  // Builds a fresh DATA descriptor `$Object`
  // `{ value, writable, enumerable, configurable }` from the value externref +
  // the flag bits (1=writable, 2=enumerable, 4=configurable) — identical shape to
  // the host `runtime.ts:__create_descriptor` and to the data branch of the
  // native `__getOwnPropertyDescriptor` above. Keys are native `$AnyString`s; the
  // attribute booleans are boxed via `__box_boolean`.
  //
  // params: 0=value(externref) 1=flags(i32) ; locals: 2=desc(externref)
  {
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externSetCdIdx = ctx.funcMap.get("__extern_set")!;

    // `desc["<key>"] = <value externref>` — desc is in local 2.
    const setKeyCd = (key: string, valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: 2 },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" },
      ...valueInstrs,
      { op: "call", funcIdx: externSetCdIdx },
    ];

    // Box `(flags & mask) != 0` as a JS boolean externref.
    const boolFlagCd = (mask: number): Instr[] => [
      { op: "local.get", index: 1 },
      { op: "i32.const", value: mask },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    const body: Instr[] = [
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 2 },
      // desc.value = value (param 0)
      ...setKeyCd("value", [{ op: "local.get", index: 0 }]),
      // desc.writable / enumerable / configurable = box(flags & bit)
      ...setKeyCd("writable", boolFlagCd(FLAG_WRITABLE)),
      ...setKeyCd("enumerable", boolFlagCd(FLAG_ENUMERABLE)),
      ...setKeyCd("configurable", boolFlagCd(FLAG_CONFIGURABLE)),
      // return desc
      { op: "local.get", index: 2 },
    ];
    registerNative(
      "__create_descriptor",
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "externref" }],
      [{ name: "desc", type: { kind: "externref" } }],
      body,
    );
  }

  // ── __create_accessor_descriptor(get, set, flags) -> externref (#2885) ──────
  //
  // Accessor sibling of `__create_descriptor`. Builds a fresh ACCESSOR descriptor
  // `$Object` `{ get, set, enumerable, configurable }` from the get/set closure
  // externrefs (null → undefined) + the flag bits (2=enumerable, 4=configurable).
  // Used by the standalone builtin-proto descriptor-synthesis path in
  // `Object.getOwnPropertyDescriptor(<Builtin>.prototype, "<getter>")`
  // (expressions/calls.ts) so an intrinsic accessor reflects host-free, mirroring
  // the accessor branch of the native `__getOwnPropertyDescriptor` above and the
  // host `runtime.ts:__create_descriptor` shape. Keys are native `$AnyString`s;
  // attribute booleans are boxed via `__box_boolean`. Intrinsic accessors are
  // `{enumerable:false, configurable:true}` (flags = 0x04), so `writable` is
  // intentionally absent (accessor descriptors carry no `value`/`writable`).
  //
  // params: 0=get(externref) 1=set(externref) 2=flags(i32) ; locals: 3=desc(externref)
  {
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externSetCdIdx = ctx.funcMap.get("__extern_set")!;

    // `desc["<key>"] = <value externref>` — desc is in local 3.
    const setKeyAcc = (key: string, valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: 3 },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" },
      ...valueInstrs,
      { op: "call", funcIdx: externSetCdIdx },
    ];

    // Box `(flags & mask) != 0` as a JS boolean externref.
    const boolFlagAcc = (mask: number): Instr[] => [
      { op: "local.get", index: 2 },
      { op: "i32.const", value: mask },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    // (#3319) A NULL get/set param is every caller's "absent half →
    // undefined" convention (per §6.2.5.6 a present `{get: null}` throws
    // before reaching here, so null is unambiguous). Under the #2106
    // `undefinedSingleton` regime null ≠ undefined — `desc.set === undefined`
    // answered false for the @@species / intrinsic-accessor synthesis shapes —
    // so materialize a null half as the `$undefined` singleton; legacy lanes
    // keep the byte-identical raw store. (Mirrors the #3316 gOPD half fix.)
    const undefExternAcc = undefinedSingletonActive(ctx) ? undefinedExternInstrs(ctx) : undefined;
    const accHalf = (paramIdx: number): Instr[] =>
      undefExternAcc
        ? [
            { op: "local.get", index: paramIdx },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: undefExternAcc.map((i) => ({ ...i })),
              else: [{ op: "local.get", index: paramIdx }],
            },
          ]
        : [{ op: "local.get", index: paramIdx }];

    const body: Instr[] = [
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 3 },
      // desc.get = get (param 0) ; desc.set = set (param 1) — null → undefined
      ...setKeyAcc("get", accHalf(0)),
      ...setKeyAcc("set", accHalf(1)),
      // desc.enumerable / configurable = box(flags & bit)
      ...setKeyAcc("enumerable", boolFlagAcc(FLAG_ENUMERABLE)),
      ...setKeyAcc("configurable", boolFlagAcc(FLAG_CONFIGURABLE)),
      // return desc
      { op: "local.get", index: 3 },
    ];
    registerNative(
      "__create_accessor_descriptor",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
      [{ kind: "externref" }],
      [{ name: "desc", type: { kind: "externref" } }],
      body,
    );
  }

  // ── __getOwnPropertyNames(externref obj) -> externref (#2042 S3) ──────────
  //
  // `Object.getOwnPropertyNames(obj)` / `Reflect.ownKeys(obj)` (string subset)
  // under standalone. Mirrors `__object_keys` but **drops the enumerable
  // filter** — every LIVE (non-tombstone) own string entry is included, in
  // OrdinaryOwnPropertyKeys order, via `__obj_ordered_all`. A non-`$Object`
  // receiver returns an empty `$ObjVec` (`getOwnPropertyNames` on a primitive
  // throws ToObject at the call site; this is the open-object path). Symbol keys
  // are not represented by the string-keyed `$Object` runtime, so the result is
  // string keys only (matching the host `getOwnPropertyNames`, which never
  // returns symbols).
  //
  // params: 0=obj(externref)
  // locals: 1=any 2=o 3=arr(ordered) 4=cap 5=i 6=e 7=vec [8=boundaryResult] N=strexo
  {
    // (#4491) The String-exotic flag local is APPENDED after the optional
    // boundary local, so every index baked above stays valid.
    const strExoticLocal = boundaryObjectGetOwnPropertyNamesIdx !== undefined ? 9 : 8;
    // (#4491) MUST equal `FLAG_INTERNAL` in object-runtime.ts. Kept local
    // rather than threaded through `ObjectDescriptorHelperState` so this whole
    // slice is one contiguous region of this file (lane-C fence, 2026-08-21).
    const FLAG_INTERNAL_SLOT = 0x10;
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      ...(boundaryObjectGetOwnPropertyNamesIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: boundaryObjectGetOwnPropertyNamesIdx },
            { op: "local.tee", index: 8 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 8 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // (#2896) Builtin-fn metadata arm: a builtin function value's own string
      // keys are ["length", "name"] in spec order (minus deleted ones). The
      // filled helper pushes them into the vec and returns 1 on a hit.
      ...(bfnPushOwnNamesIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 7 },
            { op: "call", funcIdx: bfnPushOwnNamesIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 7 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // (#4491) §10.4.3 String-exotic own INDEX keys, derived from the
      // [[StringData]] rather than stored as table entries. They are the lowest
      // indices by construction, so they lead the OrdinaryOwnPropertyKeys
      // order; `length` is a NON-index key and is appended after the table
      // walk, gated on this same flag.
      ...stringExoticPushKeysPrologue(ctx, 7, strExoticLocal),
      // A PRIMITIVE string receiver has no table to walk, so the non-`$Object`
      // arm below returns before the `length` tail can run. Emit it here for
      // that shape only — the wrapper keeps the ordered tail.
      ...(ctx.funcMap.get(STRING_EXOTIC_PUSH_KEYS_FN) !== undefined
        ? ([
            { op: "local.get", index: strExoticLocal },
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: objectTypeIdx },
            { op: "i32.eqz" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 7 },
                ...nativeStringLiteralInstrs(ctx, "length"),
                { op: "extern.convert_any" },
                { op: "call", funcIdx: objVecPushIdx },
              ],
            },
          ] satisfies Instr[])
        : []),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      // (#4010 S3) non-`$Object` ⇒ the carrier bag's own string keys, enumerable filter DROPPED here
      bagKeysIf(ctx, { vecLocal: 7, includeNonEnum: true }),
      // o = cast<$Object>(any) ; arr = __obj_ordered_all(o) ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedAllIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // (#4491) A reserved INTERNAL slot is not an own property. The
              // only one today is `[[PrimitiveValue]]`, and it leaked into
              // every `Object.getOwnPropertyNames(new String(…))` answer
              // (measured: `["[[PrimitiveValue]]"]`). `Object.keys` never saw
              // it — its walk is `__obj_ordered`, which filters by
              // [[Enumerable]] — so only this all-keys walk needs the guard.
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_INTERNAL_SLOT },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 6 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "call", funcIdx: objVecPushIdx },
                ],
              },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // (#4491) §10.4.3.6 — `length` is an own, non-enumerable property of a
      // String exotic, and a NON-index string key, so it lands after the
      // table's index entries (`str[5] = "de"` ⇒ `[…,"5","length"]`).
      ...(ctx.funcMap.get(STRING_EXOTIC_PUSH_KEYS_FN) !== undefined
        ? ([
            { op: "local.get", index: strExoticLocal },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 7 },
                ...nativeStringLiteralInstrs(ctx, "length"),
                { op: "extern.convert_any" },
                { op: "call", funcIdx: objVecPushIdx },
              ],
            },
          ] satisfies Instr[])
        : []),
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__getOwnPropertyNames",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        ...(boundaryObjectGetOwnPropertyNamesIdx !== undefined
          ? ([{ name: "boundaryResult", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
        { name: "strExotic", type: { kind: "i32" } },
      ],
      body,
    );
  }

  // ── __getOwnPropertySymbols(externref obj) -> externref (#2042 S3, #2866 s3) ─
  //
  // §20.1.2.10 / OrdinaryOwnPropertyKeys §10.1.11.1 — own SYMBOL-keyed property
  // keys in creation (insertion) order.
  //
  // Without the native Symbol carrier (host/gc mode, or a standalone module with
  // no symbol keys in its type space) the `$Object` runtime holds no symbol keys,
  // so the list is always empty — return a fresh empty `$ObjVec` (the historical
  // #2042 S3 stub; lets the large body of symbol-free tests pass).
  //
  // With the carrier enabled (#2866 PR1: `$PropEntry.key` is `anyref` and may
  // hold a `$Symbol`), delegate selection + ordering to `__obj_ordered_symbols`
  // (live own symbol entries, incl. non-enumerable, in seq order), then push each
  // entry's key — the stored `$Symbol` carrier, `extern.convert_any`'d back to an
  // externref symbol VALUE — into the result vec. Identity is by the i32
  // `$Symbol.id`, so the returned carrier `===` the original symbol and re-indexes
  // the same own property. Non-`$Object` receivers return an empty vec.
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap
  //         5=i 6=e(ref null $PropEntry) 7=vec(externref)
  if (symbolKeysEnabled) {
    const objOrderedSymbolsIdx = ctx.funcMap.get("__obj_ordered_symbols")!;
    const body: Instr[] = [
      // vec = __objvec_new()
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      ...(boundaryObjectGetOwnPropertySymbolsIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: boundaryObjectGetOwnPropertySymbolsIdx },
            { op: "local.tee", index: 8 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 8 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      // any = any.convert_extern(obj); if !$Object → return empty vec
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered_symbols(o) ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedSymbolsIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= cap break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; ordered array is compacted — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // __objvec_push(vec, extern.convert_any(e.key))  — key is a $Symbol carrier
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // i++ ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__getOwnPropertySymbols",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        ...(boundaryObjectGetOwnPropertySymbolsIdx !== undefined
          ? ([{ name: "boundaryResult", type: { kind: "externref" } }] as { name: string; type: ValType }[])
          : []),
      ],
      body,
    );
  } else {
    // String-keyed runtime (host/gc, or no symbol keys): always [].
    const body: Instr[] = [
      ...(boundaryObjectGetOwnPropertySymbolsIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: boundaryObjectGetOwnPropertySymbolsIdx },
            { op: "local.tee", index: 1 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 1 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      { op: "call", funcIdx: objVecNewIdx },
    ];
    registerNative(
      "__getOwnPropertySymbols",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      boundaryObjectGetOwnPropertySymbolsIdx !== undefined
        ? [{ name: "boundaryResult", type: { kind: "externref" } }]
        : [],
      body,
    );
  }

  // ── __object_getOwnPropertyDescriptors / __object_fromEntries ─────────────
  //
  // (#3160 — self-hosted stdlib) These two helpers are the PUREST members of
  // the object runtime: thin COMPOSITIONS over the funcMap helpers registered
  // above (`__new_plain_object`, `__extern_length`, `__extern_get_idx`,
  // `__extern_set`, `__getOwnPropertyNames`, `__getOwnPropertyDescriptor`),
  // with NO direct `$Object`/`$PropEntry` struct access or identity/proto/MOP
  // entanglement. So they are compiled from ORDINARY TS SOURCE
  // (`src/stdlib/object-runtime.ts`) through the compiler's own IR pipeline
  // via the generalized self-hosting driver (#3161), exactly where the
  // hand-emitted `Instr[]` bodies used to be pushed — the porffor model.
  //
  //   - getOwnPropertyDescriptors(obj): fresh object mapping each own key
  //     (from `__getOwnPropertyNames`) to `__getOwnPropertyDescriptor(obj,key)`.
  //   - fromEntries(entries): fresh object, `out[pair[0]] = pair[1]` per pair
  //     (the call site normalises the arg to the indexable `$ObjVec`-of-pairs
  //     shape before calling — see `compileObjectAssignArg`).
  //
  // Behaviour mirrors the deleted hand bodies step-for-step (same enumeration
  // order, same per-key `__extern_set`); the only representational difference
  // is the f64 loop counter (the hand bodies used i32-with-convert — value-
  // equivalent). Every callee is registered EARLIER in this pass (leaf-first).
  // A non-`$Object` receiver still yields `{}` (the loop runs zero times).
  // Verified by tests/issue-3160.test.ts (host + standalone) + byte-inert SHA
  // containment for non-users.
  for (const def of SELF_HOSTED_OBJECT_RUNTIME.values()) {
    emitSelfHostedFunc(ctx, def);
  }

  // NOTE (#2042 S3): `__defineProperty_desc` (generic
  // `Object.defineProperty(o, k, runtimeDescObj)`) is intentionally NOT
  // registered here yet. Its body would delegate to the working native
  // `__defineProperties` (a one-entry `{ [key]: desc }` map — verified to work
  // via `Object.defineProperties` directly), but its sole call site
  // (`Object.create(o, descs)` with an identifier descriptor value) currently
  // trips the #2043 late-import index-shift emit bug, so registering it converts
  // a clean #1472-Phase-B refusal into a messier #2043 binary-emit error with no
  // test gain. It stays a loud refusal until #2043 is fixed (then this helper +
  // its OBJECT_RUNTIME_HELPER_NAMES entry land as a follow-up). The read-side
  // reflection natives above (__getOwnPropertyNames / __getOwnPropertySymbols /
  // __object_getOwnPropertyDescriptors) are the shipped S3 slice.

  // ── Object integrity predicates (#1472 Phase B Blocker A Half 1, PR #1074) ─
  //
  // __object_isFrozen / __object_isSealed / __object_isExtensible read the
  // object-level `$Object.flags` (field 4). On a never-frozen `$Object` the
  // flags field is 0 → isFrozen/isSealed read false, isExtensible reads true.
  // ES §20.5.2.13/14: isFrozen/isSealed on a NON-object return TRUE; §20.5.2.12:
  // isExtensible on a non-object returns FALSE. (Merged from main; preserved
  // here through the Blocker B merge so the standalone predicates remain native.)
  // (#4032) `ref.test $Object` false does NOT mean "not an object" — see
  // `object-integrity-carrier.ts` for the mechanism, the two halves of the fix,
  // and why this is byte-neutral in host mode (`integrityBagIdx === undefined`).
  const integrityBagIdx = registerIntegrityBagResolver(ctx, registerNative);
  const emitIntegrityPredicate = (
    name: string,
    flagBit: number,
    invert: boolean,
    terminalResult: number,
    // (#4491 wave-5 T2) §7.3.15 level, when this predicate has one. `undefined`
    // for `isExtensible` (a pure flag question, no per-property derivation) and
    // in host mode, where the body must stay byte-identical.
    level?: "frozen" | "sealed",
  ): void => {
    const derive =
      level === undefined || integrityBagIdx === undefined
        ? undefined
        : {
            locals: integrityDerivationLocals(propMapRef, entryRefNull),
            instrs: (objLocal: number): Instr[] =>
              buildIntegrityDerivation({
                objectTypeIdx,
                propMapTypeIdx,
                propEntryTypeIdx,
                objLocal,
                // 0 = param, 1 = `any`, 2 = `bag`; the derivation's five follow.
                localBase: 3,
                frozen: level === "frozen",
                nonExtensibleBit: OBJ_FLAG_NONEXTENSIBLE,
                flagWritable: FLAG_WRITABLE,
                flagConfigurable: FLAG_CONFIGURABLE,
                flagAccessor: FLAG_ACCESSOR,
              }),
          };
    const { locals, body } = buildIntegrityPredicate({
      objectTypeIdx,
      flagBit,
      invert,
      terminalResult,
      integrityBagIdx,
      derive,
    });
    registerNative(name, [{ kind: "externref" }], [{ kind: "i32" }], locals, body);
  };
  emitIntegrityPredicate("__object_isFrozen", OBJ_FLAG_FROZEN, false, 1, "frozen");
  emitIntegrityPredicate("__object_isSealed", OBJ_FLAG_SEALED, false, 1, "sealed");
  emitIntegrityPredicate("__object_isExtensible", OBJ_FLAG_NONEXTENSIBLE, true, 0);
  // Known-object variants: same body, terminal fallback flipped to the ORDINARY
  // OBJECT rule. Standalone/wasi only — host already answers these correctly.
  if (integrityBagIdx !== undefined) {
    emitIntegrityPredicate("__object_isFrozen_obj", OBJ_FLAG_FROZEN, false, 0, "frozen");
    emitIntegrityPredicate("__object_isSealed_obj", OBJ_FLAG_SEALED, false, 0, "sealed");
    emitIntegrityPredicate("__object_isExtensible_obj", OBJ_FLAG_NONEXTENSIBLE, true, 1);
  }

  // Register at the original minting point so every subsequent function index
  // remains byte-for-byte stable.
  buildObjectIntegrityMutationHelpers({
    registerNative,
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    objRefNull,
    propMapRef,
    entryRefNull,
    FLAG_WRITABLE,
    FLAG_CONFIGURABLE,
    OBJ_FLAG_NONEXTENSIBLE,
    OBJ_FLAG_SEALED,
    OBJ_FLAG_FROZEN,
    integrityBagIdx,
  });
}
