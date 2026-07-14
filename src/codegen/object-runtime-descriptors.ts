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
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { undefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { emitSelfHostedFunc } from "./stdlib-selfhost.js";
import { SELF_HOSTED_OBJECT_RUNTIME } from "../stdlib/object-runtime.js";

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
              ...eflBit(FLAG_ACCESSOR),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: s4Throw(
                  "TypeError: Cannot redefine property: cannot convert a non-configurable accessor to a data property",
                ),
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

    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → return obj (lenient no-op,
      // matches the host import returning O unchanged)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
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
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → return obj (lenient no-op)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 6 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
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
      ],
      body,
    );
  }

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
    const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty")!;
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

    const keyRef = (key: string): Instr[] => [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
    const hasField = (key: string): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: hasOwnIdx },
    ];
    const getField = (key: string): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) normalize missing/undefined descriptor fields back to the
      // legacy null convention so downstream null-keyed logic is unchanged.
      ...(ctx.funcMap.has("__nullish_to_null")
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
    const throwUnsupported = (): Instr[] =>
      throwTypeError("Object.defineProperties unsupported descriptor shape in standalone mode (#1906)");
    const throwConflict = (): Instr[] =>
      throwTypeError("TypeError: Invalid property descriptor in Object.defineProperties (#1906)");
    const throwAccessor = (): Instr[] =>
      throwTypeError("TypeError: Object.defineProperties get/set must be callable (#1906)");

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
      // Dynamic Type(O) / ToObject(Properties) checks for the supported native
      // surface: both must be standalone `$Object`s.
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_OBJ_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: L_OBJ_ANY },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: L_OBJ },

      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_DESCS_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: L_DESCS_ANY },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: L_DESCS },

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

              // key = entry.key; rawDesc = entry.value.
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "local.set", index: L_KEY },
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              { op: "extern.convert_any" },
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
              { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
              { op: "local.get", index: L_RAW_DESC },
              { op: "call", funcIdx: typeofObjectIdx },
              { op: "local.get", index: L_RAW_DESC },
              { op: "call", funcIdx: typeofFunctionIdx },
              { op: "i32.or" },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },

              // Reset descriptor accumulators.
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_FLAGS },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_HAS_DATA },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_HAS_ACCESSOR },
              { op: "ref.null.extern" },
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
                  ...getField("value"),
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
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
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
      ],
      body,
    );
    void L_OBJ;
    void L_RAW_OBJ;
    void L_KEY;
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
    const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty")!;
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

    const keyRef = (key: string): Instr[] => [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
    const hasField = (key: string): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: hasOwnIdx },
    ];
    const getField = (key: string): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) normalize missing/undefined descriptor fields back to the
      // legacy null convention so downstream null-keyed logic is unchanged.
      ...(ctx.funcMap.has("__nullish_to_null")
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

      // Reset accumulators.
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_FLAGS },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_HAS_DATA },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_HAS_ACCESSOR },
      { op: "ref.null.extern" },
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
          ...getField("value"),
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
          { op: "drop" },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: L_VALUE },
          { op: "local.get", index: L_FLAGS },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: defineValueIdx },
          { op: "drop" },
        ],
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
    const undefRet: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
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
    const stringExoticArm: Instr[] = strExotic
      ? [
          // key must be a string property key (else no exotic own property).
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: 2 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet },
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
          { op: "if", blockType: { kind: "empty" }, then: undefRet },
          // sVal = slotEnt.value; a String wrapper's [[StringData]] is a string.
          { op: "local.get", index: L_SENT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
          { op: "local.tee", index: L_SVAL },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet },
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
          ...undefRet,
        ]
      : undefRet;

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
      // any = any.convert_extern(obj) ; if !$Object → return undefined (null)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
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
        then: [
          // desc.get = extern.convert_any(e.get)  (null anyref → undefined)
          ...setKey("get", [
            { op: "local.get", index: 4 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
            { op: "extern.convert_any" },
          ]),
          // desc.set = extern.convert_any(e.set)
          ...setKey("set", [
            { op: "local.get", index: 4 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
            { op: "extern.convert_any" },
          ]),
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

    const body: Instr[] = [
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 3 },
      // desc.get = get (param 0) ; desc.set = set (param 1)
      ...setKeyAcc("get", [{ op: "local.get", index: 0 }]),
      ...setKeyAcc("set", [{ op: "local.get", index: 1 }]),
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
  // locals: 1=any 2=o 3=arr(ordered) 4=cap 5=i 6=e 7=vec
  {
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
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
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
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
      ],
      body,
    );
  } else {
    // String-keyed runtime (host/gc, or no symbol keys): always [].
    const body: Instr[] = [{ op: "call", funcIdx: objVecNewIdx }];
    registerNative("__getOwnPropertySymbols", [{ kind: "externref" }], [{ kind: "externref" }], [], body);
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
  const emitIntegrityPredicate = (name: string, flagBit: number, invert: boolean, nonObjResult: number): void => {
    const testExpr: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: flagBit },
      { op: "i32.and" },
    ];
    if (invert) {
      testExpr.push({ op: "i32.eqz" });
    } else {
      testExpr.push({ op: "i32.const", value: 0 }, { op: "i32.ne" });
    }
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: testExpr,
        else: [{ op: "i32.const", value: nonObjResult }],
      },
    ];
    registerNative(name, [{ kind: "externref" }], [{ kind: "i32" }], [{ name: "any", type: { kind: "anyref" } }], body);
  };
  emitIntegrityPredicate("__object_isFrozen", OBJ_FLAG_FROZEN, false, 1);
  emitIntegrityPredicate("__object_isSealed", OBJ_FLAG_SEALED, false, 1);
  emitIntegrityPredicate("__object_isExtensible", OBJ_FLAG_NONEXTENSIBLE, true, 0);

  // ── Object integrity SET path (#1472 Phase B Blocker A Half 2) ────────────
  //
  // __object_preventExtensions / __object_seal / __object_freeze set the
  // object-level `$Object.flags` (field 4) integrity bits and return the
  // ORIGINAL externref (identity preserved — these return their argument per
  // ES §20.5.2.{5,18,6}). freeze ⊃ seal ⊃ preventExtensions, so each sets a
  // cumulative bit-mask:
  //   preventExtensions → NONEXTENSIBLE
  //   seal              → NONEXTENSIBLE | SEALED
  //   freeze            → NONEXTENSIBLE | SEALED | FROZEN
  // The write gates in __extern_set (FROZEN → refuse all) and __obj_insert
  // empty-slot (NONEXTENSIBLE → refuse new key) read these bits to enforce
  // immutability. Non-$Object receiver: returned unchanged (primitives are
  // already non-extensible; the predicate readers handle their query side).
  //
  // params: 0=obj(externref) ; locals: 1=any(anyref) 2=o(ref null $Object)
  const emitSetFlags = (name: string, bits: number): void => {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // o = cast<$Object>(any) ; o.flags |= bits
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: bits },
          { op: "i32.or" },
          { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
        ],
      },
      // return the original externref unchanged (identity preserved)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      name,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
      ],
      body,
    );
  };
  emitSetFlags("__object_preventExtensions", OBJ_FLAG_NONEXTENSIBLE);
  emitSetFlags("__object_seal", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED);
  emitSetFlags("__object_freeze", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED | OBJ_FLAG_FROZEN);
}
