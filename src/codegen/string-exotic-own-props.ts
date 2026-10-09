// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4232) §10.4.3 String-exotic OWN properties for `hasOwnProperty` /
 * `Object.hasOwn` in standalone mode.
 *
 * ## The gap
 *
 * `__hasOwnProperty` casts the receiver to `$Object` and asks `__obj_find` for
 * a hash-table entry. A String wrapper IS a `$Object` — but its `length` and
 * its index properties are not table entries. They are DERIVED from the
 * [[StringData]] native string parked in the `[[PrimitiveValue]]` internal slot
 * (object-runtime.ts), which the table walk cannot see. So every own-property
 * query on `new String("globglob")` answered `false`, including the two the
 * spec spends a whole section on: `length` (§10.4.3.6, own, non-enumerable,
 * non-writable, non-configurable) and the canonical indices (§10.4.3.5).
 *
 * ## CanonicalNumericIndexString, done properly rather than approximately
 *
 * The neighbouring for-in / `__extern_get` vec arms parse numeric keys with
 * `__str_to_number` and note in their own comments that this is "a benign
 * superset" — fine there, because those keys are machine-produced and always
 * canonical. Here the key comes straight from user code, so the superset is a
 * source of WRONG `true` answers: `__str_to_number("")` is `+0`,
 * `__str_to_number(" 1")` is `1`, and `"01"`, `"+1"`, `"1e0"` all parse. None of
 * those is a canonical numeric index string, and §10.4.3.5 answers `undefined`
 * for every one.
 *
 * So this scans the key's characters directly: non-empty, at most 9 digits (so
 * the accumulator cannot overflow i32 — a 10-digit index cannot be in range for
 * any string that fits in memory anyway), ASCII digits only, and no leading
 * zero unless the key is exactly `"0"`. That is exactly the set of strings `s`
 * for which `ToString(ToNumber(s)) === s` and the value is a non-negative
 * integer, which is what CanonicalNumericIndexString asks. Anything else — and
 * every non-string key — answers `false` and the ordinary table walk runs.
 *
 * ## Why a native, and why it is only consulted, never authoritative
 *
 * The prologue spliced into `__hasOwnProperty` is three instructions plus a
 * `call`: everything else lives here, so the shared native's body does not grow
 * with the spec section. The prologue answers `1` and returns, or falls
 * through to the untouched original body — it never answers `0` authoritatively
 * — so a wrapper carrying an ordinary own expando still finds it, and every
 * non-wrapper receiver is byte-identical to before.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { ensureExnTag } from "./registry/physical-imports.js";
import { ensureDefineRejectionGlobal } from "./object-model/define-rejection-channel.js"; // (#6651 W1a)
import { STRING_EXOTIC_PUSH_KEYS_FN } from "./object-model/native-names.js"; // (#6770) leaf-shared name

/** MUST equal `WRAPPER_PRIMITIVE_KEY` in object-runtime.ts (ESM-cycle-free). */
const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";
/** `$PropEntry.$value` field index (object-runtime.ts layout). */
const ENTRY_VALUE = 1;
/** `$NativeString` layout: (len i32, off i32, data (array i16)). */
const STR_LEN = 0;
const STR_OFF = 1;
const STR_DATA = 2;
/** Longest key we will treat as an index: 9 digits keeps the accumulator in i32. */
const MAX_INDEX_DIGITS = 9;
/** i31 abstract heap type (signed LEB -20) — small-int boxed numbers (#3673). */
const I31_HEAP_TYPE = -20;

export const STRING_EXOTIC_HASOWN_FN = "__strexo_hasown";

/**
 * Register `__strexo_hasown(obj externref, key externref) -> i32`: 1 when
 * `key` names a §10.4.3 own property of a String-exotic `obj`, else 0.
 *
 * Call from `ensureObjectRuntime` BEFORE the `__hasOwnProperty` bodies are
 * assembled, so the prologue can bake this funcIdx. Answers `undefined`
 * (registers nothing) when the native-string subsystem is not present.
 */
export function registerStringExoticHasOwn(
  ctx: CodegenContext,
  deps: {
    objectTypeIdx: number;
    propEntryTypeIdx: number;
    objFindIdx: number;
  },
): number | undefined {
  if (!ctx.standalone) return undefined;
  if (ctx.funcMap.get(STRING_EXOTIC_HASOWN_FN) !== undefined) {
    return ctx.funcMap.get(STRING_EXOTIC_HASOWN_FN);
  }
  const anyStr = ctx.anyStrTypeIdx;
  const natStr = ctx.nativeStrTypeIdx;
  const dataIdx = ctx.nativeStrDataTypeIdx;
  if (anyStr < 0 || natStr < 0 || dataIdx < 0) return undefined;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return undefined;
  const { objectTypeIdx, propEntryTypeIdx, objFindIdx } = deps;

  // params: 0 obj, 1 key. locals below start at 2.
  const L_ANY = 2;
  const L_SLOT = 3;
  const L_STR = 4;
  const L_KEY = 5;
  const L_N = 6;
  const L_I = 7;
  const L_C = 8;
  const L_VAL = 9;
  const L_F = 10;
  const boxNum = ctx.nativeBoxNumberTypeIdx;
  const locals: { name: string; type: ValType }[] = [
    { name: "any", type: { kind: "anyref" } },
    { name: "slot", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    { name: "sdata", type: { kind: "ref_null", typeIdx: anyStr } },
    { name: "fkey", type: { kind: "ref_null", typeIdx: natStr } },
    { name: "n", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "c", type: { kind: "i32" } },
    { name: "val", type: { kind: "i32" } },
    { name: "f", type: { kind: "f64" } },
  ];

  const returnZero: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  /** `fkey.data[fkey.off + <i on stack>]` as an unsigned char code. */
  const charAt = (idxLocal: number): Instr[] => [
    { op: "local.get", index: L_KEY },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_DATA },
    { op: "local.get", index: L_KEY },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_OFF },
    { op: "local.get", index: idxLocal },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: dataIdx },
  ];

  const body: Instr[] = [
    // A String exotic object is a `$Object`; anything else is not ours.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // …carrying a [[PrimitiveValue]] whose value is a string.
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    ...nativeStringLiteralInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: L_SLOT },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: L_SLOT },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: L_SLOT },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "local.set", index: L_STR },
    // A BOXED-NUMBER key (`s.hasOwnProperty(0)`) never reaches the character
    // scan: ToPropertyKey would stringify it and the scan would re-parse it, so
    // answer it directly from the f64. Canonicality is free here — a number's
    // ToString is canonical by construction — leaving only the integral
    // round-trip and the range test.
    ...(boxNum >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: boxNum },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: boxNum },
              { op: "struct.get", typeIdx: boxNum, fieldIdx: 0 },
              { op: "local.tee", index: L_F },
              { op: "i32.trunc_sat_f64_s" },
              { op: "local.tee", index: L_VAL },
              { op: "f64.convert_i32_s" },
              { op: "local.get", index: L_F },
              { op: "f64.eq" },
              { op: "local.get", index: L_VAL },
              { op: "local.get", index: L_STR },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: anyStr, fieldIdx: STR_LEN },
              { op: "i32.lt_u" },
              { op: "i32.and" },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    // (#3673) A small integer key is an `i31`, not a `$__box_number` struct —
    // and that is the shape `s.hasOwnProperty(0)` actually produces, so the
    // boxed-struct arm above is NOT the common case. No integral test is
    // needed: an i31 is an integer by construction.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: I31_HEAP_TYPE },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: I31_HEAP_TYPE },
        { op: "i31.get_s" },
        { op: "local.get", index: L_STR },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: anyStr, fieldIdx: STR_LEN },
        { op: "i32.lt_u" },
        { op: "return" },
      ],
    },
    // Otherwise the key must be a string — a symbol key is never an index.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_KEY },
    // §10.4.3.6 — `length` is an own property of every String exotic object.
    { op: "local.get", index: L_KEY },
    { op: "ref.as_non_null" },
    ...nativeStringLiteralInstrs(ctx, "length"),
    { op: "call", funcIdx: equalsIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
    // CanonicalNumericIndexString, character-exact (see the module note).
    { op: "local.get", index: L_KEY },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_LEN },
    { op: "local.tee", index: L_N },
    { op: "i32.eqz" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: MAX_INDEX_DIGITS },
    { op: "i32.gt_s" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // No leading zero, unless the key is exactly "0".
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 1 },
    { op: "i32.gt_s" },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    ...charAt(L_I),
    { op: "i32.const", value: 0x30 },
    { op: "i32.eq" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // Accumulate the digits; any non-digit disqualifies the whole key.
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_VAL },
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
            { op: "local.get", index: L_N },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...charAt(L_I),
            { op: "local.set", index: L_C },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 0x30 },
            { op: "i32.lt_s" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 0x39 },
            { op: "i32.gt_s" },
            { op: "i32.or" },
            { op: "if", blockType: { kind: "empty" }, then: returnZero },
            { op: "local.get", index: L_VAL },
            { op: "i32.const", value: 10 },
            { op: "i32.mul" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 0x30 },
            { op: "i32.sub" },
            { op: "i32.add" },
            { op: "local.set", index: L_VAL },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // §10.4.3.5 — own iff the index is inside the [[StringData]]. Length is
    // field 0 of `$AnyString`, valid for both the flat and the cons shape.
    { op: "local.get", index: L_VAL },
    { op: "local.get", index: L_STR },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: STR_LEN },
    { op: "i32.lt_s" },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(STRING_EXOTIC_HASOWN_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: STRING_EXOTIC_HASOWN_FN,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}

export { STRING_EXOTIC_PUSH_KEYS_FN }; // (#6770) defined in object-model/native-names.ts

/**
 * (#4491) Register `__strexo_push_keys(obj externref, vec externref) -> i32` —
 * the ENUMERATION half of §10.4.3, the counterpart to
 * {@link registerStringExoticHasOwn}'s presence half.
 *
 * `hasOwnProperty` has answered String-exotic own properties correctly since
 * #4232, but `Object.keys` / `getOwnPropertyNames` never did: their key list is
 * built by walking the `$Object` own-props TABLE, and a String exotic's indices
 * are DERIVED from the `[[PrimitiveValue]]` [[StringData]], not table entries.
 * Measured on this branch, `--target standalone`, before this native existed:
 *
 * ```js
 * Object.keys("abc");                          // []                    ← ["0","1","2"]
 * Object.keys(new String("abc"));              // []                    ← ["0","1","2"]
 * Object.getOwnPropertyNames(new String("abc"));// ["[[PrimitiveValue]]"] ← ["0","1","2","length"]
 * ```
 *
 * Pushes `"0" … "len-1"` into `vec` and answers 1 when `obj` is a String
 * exotic, else pushes nothing and answers 0 — so a non-String receiver is
 * byte-identical to the pre-existing walk.
 *
 * **Order.** §10.4.3.6 OrdinaryOwnPropertyKeys puts the integer indices first,
 * ascending, then the other string keys in creation order. The string's own
 * indices are always the LOWEST — an index below `[[StringData]].length` is
 * non-configurable (§10.4.3.5), so a `defineProperty` there can never create a
 * competing table entry — which is why pushing them all up front, before the
 * table walk, is the spec order rather than an approximation of it.
 *
 * `length` is NOT pushed here: it is a non-index string key, so it belongs
 * AFTER the table's index entries (`Object.getOwnPropertyNames(str)` with
 * `str[5] = "de"` is `["0","1","2","5","length"]`), and it is non-enumerable so
 * `Object.keys` must not have it at all. The gOPN caller appends it once the
 * table walk is done, keyed on this native's return value.
 *
 * **Two receiver shapes.** A `new String(…)` wrapper is a `$Object` carrying
 * the reserved slot; a PRIMITIVE string reaching `Object.keys("abc")` is the
 * `$AnyString` itself (the ToObject at the call site is not materialized in the
 * standalone lane). Both resolve to the same [[StringData]] here.
 */
export function registerStringExoticPushKeys(
  ctx: CodegenContext,
  deps: {
    objectTypeIdx: number;
    propEntryTypeIdx: number;
    objFindIdx: number;
    objVecPushIdx: number;
  },
): number | undefined {
  if (!ctx.standalone) return undefined;
  const already = ctx.funcMap.get(STRING_EXOTIC_PUSH_KEYS_FN);
  if (already !== undefined) return already;
  const anyStr = ctx.anyStrTypeIdx;
  if (anyStr < 0) return undefined;
  // The canonical index key is ToString(i) — the sealed `number_toString`, the
  // same formatter every other index-key producer uses (`__extern_get_idx`'s
  // `$Object` arm, the overlay's companion lookup, `emitArrayForIn`). Resolved
  // here rather than threaded in from `ensureObjectRuntime` so the
  // coercion-sites grant names THIS module, not the shared god-file.
  const numToStringIdx = ctx.funcMap.get("number_toString");
  if (numToStringIdx === undefined) return undefined;
  const { objectTypeIdx, propEntryTypeIdx, objFindIdx, objVecPushIdx } = deps;

  // params: 0 obj, 1 vec. locals below start at 2.
  const L_ANY = 2;
  const L_SLOT = 3;
  const L_STR = 4;
  const L_N = 5;
  const L_I = 6;

  const returnZero: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      // Wrapper: [[StringData]] lives in the reserved [[PrimitiveValue]] slot.
      then: [
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        ...nativeStringLiteralInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: objFindIdx },
        { op: "local.tee", index: L_SLOT },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: returnZero },
        { op: "local.get", index: L_SLOT },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
        { op: "ref.test", typeIdx: anyStr },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: returnZero },
        { op: "local.get", index: L_SLOT },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
        { op: "ref.cast", typeIdx: anyStr },
        { op: "local.set", index: L_STR },
      ],
      // Primitive string receiver — it IS the [[StringData]].
      else: [
        { op: "local.get", index: L_ANY },
        { op: "ref.test", typeIdx: anyStr },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: returnZero },
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: anyStr },
        { op: "local.set", index: L_STR },
      ],
    },
    // n = [[StringData]].length (field 0 of `$AnyString`, valid for the flat
    // and the cons shape alike); i = 0.
    { op: "local.get", index: L_STR },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: STR_LEN },
    { op: "local.set", index: L_N },
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
            { op: "local.get", index: L_N },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 1 },
            { op: "local.get", index: L_I },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: numToStringIdx },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 1 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(STRING_EXOTIC_PUSH_KEYS_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: STRING_EXOTIC_PUSH_KEYS_FN,
    typeIdx,
    locals: [
      { name: "any", type: { kind: "anyref" } },
      { name: "slot", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      { name: "sdata", type: { kind: "ref_null", typeIdx: anyStr } },
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * The prologue spliced into `__object_keys` / `__getOwnPropertyNames` right
 * after they mint their result vector: push the String-exotic index keys and
 * park the "was a String exotic" answer in `flagLocal` (pass `undefined` to
 * discard it — `Object.keys` has no `length` tail to gate).
 *
 * Empty when the native was never registered, so a non-standalone or
 * native-string-less build is byte-identical.
 */
export function stringExoticPushKeysPrologue(ctx: CodegenContext, vecLocal: number, flagLocal?: number): Instr[] {
  const funcIdx = ctx.funcMap.get(STRING_EXOTIC_PUSH_KEYS_FN);
  if (funcIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: vecLocal },
    { op: "call", funcIdx },
    flagLocal === undefined ? { op: "drop" } : { op: "local.set", index: flagLocal },
  ];
}

/**
 * The prologue spliced at the FRONT of `__hasOwnProperty` / `__object_hasOwn`:
 * consult the native, return 1 on a hit, otherwise fall through untouched.
 */
export function stringExoticHasOwnPrologue(funcIdx: number | undefined): Instr[] {
  if (funcIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
  ];
}

/** `__defineProperty_value` host flag bits (object-runtime-descriptors.ts). */
const DP_W = 1 << 0;
const DP_E = 1 << 1;
const DP_C = 1 << 2;
const DP_W_SPEC = 1 << 3;
const DP_E_SPEC = 1 << 4;
const DP_C_SPEC = 1 << 5;
const DP_HAS_VALUE = 1 << 7;

/**
 * (#6651 W1a) The MUTATION half of §10.4.3 for a String WRAPPER, spliced at
 * finalize (after every other `__reflect_set` / `__extern_set_strict` /
 * `__defineProperty_*` arm) by `unshiftRegExpAccessorSetGuard`, keyed on the
 * same {@link registerStringExoticHasOwn} predicate that already answers
 * presence, gOPD and the sloppy `__extern_set` no-op — so presence and
 * mutability cannot disagree.
 *
 * Every String-exotic own property (`length`, the in-range indices) is a
 * non-writable, non-configurable data property (§10.4.3.5 / §22.1.4.1):
 *
 * - **[[Set]]** (§10.1.9.2 step 2.a): OrdinarySet answers `false` —
 *   `Reflect.set` returns it, a strict assignment throws.
 * - **[[DefineOwnProperty]]** (§10.4.3.2 → §10.1.6.3
 *   ValidateAndApplyPropertyDescriptor against the immutable current
 *   descriptor): `{configurable: true}`, a changed `enumerable`,
 *   `{writable: true}`, a different `value` (SameValue) or ANY accessor
 *   descriptor is rejected; a compatible descriptor changes nothing. A
 *   rejection parks its TypeError in the #6770 S4 rejection global before the
 *   throw, so `Reflect.defineProperty` answers `false` and
 *   `Object.defineProperty` throws.
 *
 * Any other key (an expando such as `s[4]`) falls through to the ordinary
 * `$Object` table, which is where a String wrapper keeps its own expandos.
 */
export function installStringExoticMutationGuards(ctx: CodegenContext): void {
  const predIdx = ctx.funcMap.get(STRING_EXOTIC_HASOWN_FN);
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  if (predIdx === undefined || ctorIdx === undefined) return;
  const tagIdx = ensureExnTag(ctx);
  const rejectionGlobal = ensureDefineRejectionGlobal(ctx);
  const throwTypeError = (msg: string, park: boolean): Instr[] => [
    ...nativeStringLiteralInstrs(ctx, msg),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: ctorIdx },
    ...(park && rejectionGlobal !== undefined
      ? ([
          { op: "global.set", index: rejectionGlobal },
          { op: "global.get", index: rejectionGlobal },
        ] satisfies Instr[])
      : []),
    { op: "throw", tagIdx },
  ];
  const unshift = (fnName: string, then: Instr[]): void => {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === fnName);
    if (!fn) return;
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: predIdx },
      { op: "if", blockType: { kind: "empty" }, then },
    );
  };
  unshift("__reflect_set", [{ op: "i32.const", value: 0 }, { op: "return" }]);
  unshift("__extern_set_strict", throwTypeError("Cannot assign to read only property of a String object", false));
  const redefine = "Cannot redefine property of a String object";
  unshift("__defineProperty_accessor", throwTypeError(redefine, true));
  const defineIdx = registerStringExoticDefine(ctx, () => throwTypeError(redefine, true));
  if (defineIdx === undefined) return;
  unshift("__defineProperty_value", [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: defineIdx },
    { op: "return" },
  ]);
}

/**
 * `__strexo_define(obj, value, flagsF64, key) -> obj`: ValidateAndApplyPropertyDescriptor
 * for a data descriptor over a String-exotic own property (current descriptor
 * `{value, writable: false, enumerable: <is index>, configurable: false}`).
 * Throws through `reject` on an incompatible descriptor; otherwise a no-op.
 */
function registerStringExoticDefine(ctx: CodegenContext, reject: () => Instr[]): number | undefined {
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const getIdx = ctx.funcMap.get("__extern_get");
  const objectIsIdx = ctx.funcMap.get("__object_is");
  if (gopdIdx === undefined || getIdx === undefined || objectIsIdx === undefined || ctx.anyStrTypeIdx < 0) {
    return undefined;
  }
  const HF = 4;
  const CUR = 5;
  const hf = (bit: number): Instr[] => [
    { op: "local.get", index: HF },
    { op: "i32.const", value: bit },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
  ];
  const rejectIf = (): Instr => ({ op: "if", blockType: { kind: "empty" }, then: reject() });
  const body: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: HF },
    // Current [[Value]]: the 1-char string at an index, the length number otherwise.
    { op: "local.get", index: 0 },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: gopdIdx },
    ...nativeStringLiteralInstrs(ctx, "value"),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: getIdx },
    { op: "local.set", index: CUR },
    // §10.1.6.3 step 4.a — {configurable: true} on a non-configurable property.
    ...hf(DP_C_SPEC),
    ...hf(DP_C),
    { op: "i32.and" },
    rejectIf(),
    // step 4.b — a changed enumerable (indices are enumerable, `length` is not).
    ...hf(DP_E_SPEC),
    ...hf(DP_E),
    { op: "local.get", index: CUR },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    { op: "i32.ne" },
    { op: "i32.and" },
    rejectIf(),
    // step 7.a — non-writable, non-configurable: no {writable: true}, no new value.
    ...hf(DP_W_SPEC),
    ...hf(DP_W),
    { op: "i32.and" },
    rejectIf(),
    ...hf(DP_HAS_VALUE),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "local.get", index: CUR },
        { op: "call", funcIdx: objectIsIdx },
        { op: "i32.eqz" },
        rejectIf(),
      ],
    },
    { op: "local.get", index: 0 },
  ];
  const EXT: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [EXT, EXT, { kind: "f64" }, EXT], [EXT]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__strexo_define", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__strexo_define",
    typeIdx,
    locals: [
      { name: "hf", type: { kind: "i32" } },
      { name: "cur", type: EXT },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
