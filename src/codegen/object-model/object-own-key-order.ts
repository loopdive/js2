// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S3) The SORT key of OrdinaryOwnPropertyKeys (§10.1.11.1) over the
 * FULL array-index domain `[0, 2^32 − 2]`.
 *
 * `__obj_index_of_key` deliberately caps array indices at `2^31 − 1` (its
 * answer is also a signed i32 element address for ~25 vec/array consumers —
 * see vec-index-domain.ts §1). For ORDERING that cap is observable:
 *
 * ```js
 * var o = {}; o[12345678900] = 1; o[4294967294] = 1;
 * Reflect.ownKeys(o);   // main: ["12345678900", "4294967294"]  spec: ["4294967294", "12345678900"]
 * ```
 *
 * `4294967294` is an array index (the largest), so it sorts with the indices
 * ahead of every string key; `4294967295` (2^32 − 1) is not, and keeps its
 * insertion position. The ordered walk (`__obj_ordered` / `_all`) is the only
 * consumer that needs the wider domain, so it gets its own i64 answer here
 * instead of widening the shared i32 address predicate.
 *
 * `__obj_order_index_of_key(ref $AnyString) -> i64`: the canonical index value
 * (no sign, no leading zero, `"0"` alone), else `-1`.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression } from "../shared.js";
import { getFuncRefWrapperRootTypeIdx } from "../closures/funcref-wrapper-types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { nativeStringLiteralInstrs } from "../native-string-literals.js";
import { addFuncType } from "../registry/types.js";
import { STRING_EXOTIC_PUSH_KEYS_FN } from "./native-names.js";
import { bound } from "./ports.js"; // (#6770/#6797) core helpers, injected — keeps this leaf out of the import SCC

const withArraySubclassReceiverAsVec = bound("withArraySubclassReceiverAsVec");

export const OBJ_ORDER_INDEX_OF_KEY_FN = "__obj_order_index_of_key";

/** 2^32 − 2, the largest array index (§6.1.7). */
const MAX_ARRAY_INDEX = 4294967294n;
/** Ten digits is the longest spelling that can stay ≤ MAX_ARRAY_INDEX. */
const MAX_DIGITS = 10;

/** The canonical array-index value of a compile-time key name, else -1. */
function staticArrayIndexOf(name: string): number {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(name)) return -1;
  const v = Number(name);
  return v <= Number(MAX_ARRAY_INDEX) ? v : -1;
}

/**
 * (#6770 S3) A closed struct's declared field order is its object literal's
 * SOURCE order, but §10.1.11.1 lists integer indices first, ascending:
 * `{b: 1, 2: 1, a: 1, 1: 1}` owns `["1", "2", "b", "a"]` (main answered the
 * source order from every compile-time and runtime field walk). A stable sort
 * of the declared names — indices first by value, the rest untouched — is the
 * whole fix; field INDICES are not affected, only the enumeration order.
 */
/**
 * (#6770 S5) `Object.getOwnPropertyNames(o).indexOf(k)` — a chained array
 * method on an own-key LIST call whose standalone result is the runtime
 * `$ObjVec` (externref), while the checker says `string[]`. The array-method
 * lowering then `ref.cast`s that externref to the string vec and traps
 * (`illegal cast`); a `var` binding in between worked because its initializer
 * coercion materializes the vec. The caller materializes the receiver the same
 * way (`withArraySubclassReceiverAsVec`) when this answers true.
 */
function isOwnKeyListCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee.expression)) return false;
  const owner = callee.expression.text;
  const name = callee.name.text;
  return (
    (owner === "Object" && (name === "keys" || name === "getOwnPropertyNames" || name === "getOwnPropertySymbols")) ||
    (owner === "Reflect" && name === "ownKeys")
  );
}

/**
 * (#6651 V6) Read-only methods, safe over the materialized COPY a binding
 * receiver gets (a mutating one must reach the binding's own vec).
 */
const READ_ONLY_KEY_LIST_METHODS = new Set(["indexOf", "lastIndexOf", "includes", "at", "slice", "every", "some"]);

/**
 * …or (#6651 V6) a binding initialized from one, read by a read-only method:
 * a module with a direct `eval` keeps `var keys = Reflect.ownKeys(o)` as an
 * externref global holding the raw `$ObjVec`, so `keys.indexOf(k)` traps on the
 * same cast. The coercion only copies a foreign value, so a reassigned binding
 * still reads correctly.
 */
function isStandaloneOwnKeyListCall(ctx: CodegenContext, expr: ts.Expression, methodName: string): boolean {
  if (!ctx.standalone) return false;
  if (isOwnKeyListCall(expr)) return true;
  if (!ts.isIdentifier(expr) || !READ_ONLY_KEY_LIST_METHODS.has(methodName)) return false;
  const decl = ctx.oracle.valueDeclarationOf(expr);
  return (
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer !== undefined &&
    isOwnKeyListCall(decl.initializer)
  );
}

/** Lower `<own-key list call>.<array method>(…)` over the materialized vec; `undefined` = not this shape. */
export function withOwnKeyListReceiverAsVec<T>(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  eligible: boolean,
  methodName: string,
  lower: () => T | undefined,
): T | undefined {
  if (!eligible || !isStandaloneOwnKeyListCall(ctx, receiverExpr, methodName)) return undefined;
  return withArraySubclassReceiverAsVec(
    ctx,
    fctx,
    receiverExpr,
    () => compileExpression(ctx, fctx, receiverExpr),
    lower,
  );
}

export function inOwnKeyOrder<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  const indexed = items.map((item, pos) => ({ item, pos, idx: staticArrayIndexOf(nameOf(item)) }));
  indexed.sort((a, b) => {
    if (a.idx >= 0 && b.idx >= 0) return a.idx - b.idx;
    if (a.idx >= 0) return -1;
    if (b.idx >= 0) return 1;
    return a.pos - b.pos;
  });
  return indexed.map((e) => e.item);
}

/**
 * (#6770 S3) §10.4.3.6 StringCreate defines `length` BEFORE any expando, so in
 * a String wrapper's `[[OwnPropertyKeys]]` it follows the integer indices and
 * precedes every other string key: `new String("ab")` + `.z` →
 * `["0","1","length","z"]` (main answered `…,"z","length"`). Spliced into the
 * `__getOwnPropertyNames` table walk in front of each push: while the
 * String-exotic flag is still set and the entry's key is NOT an array index,
 * push `"length"` and clear the flag — so the tail push after the walk only
 * fires when the wrapper has no named expando at all.
 */
export function stringExoticLengthBeforeNamedKeyInstrs(
  ctx: CodegenContext,
  flagLocal: number,
  entryLocal: number,
  vecLocal: number,
): Instr[] {
  const orderIdx = ctx.funcMap.get(OBJ_ORDER_INDEX_OF_KEY_FN);
  const pushIdx = ctx.funcMap.get("__objvec_push");
  const propEntryTypeIdx = ctx.objectRuntimeTypes?.propEntryTypeIdx;
  if (
    orderIdx === undefined ||
    pushIdx === undefined ||
    propEntryTypeIdx === undefined ||
    ctx.anyStrTypeIdx < 0 ||
    ctx.funcMap.get(STRING_EXOTIC_PUSH_KEYS_FN) === undefined
  ) {
    return [];
  }
  return [
    { op: "local.get", index: flagLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: entryLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: orderIdx },
        { op: "i64.const", value: 0n },
        { op: "i64.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: vecLocal },
            ...nativeStringLiteralInstrs(ctx, "length"),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: pushIdx },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: flagLocal },
          ],
        },
      ],
    },
  ];
}

/**
 * (#6770 S3) A FUNCTION's intrinsic own keys lead its bag keys.
 *
 * §10.2.4 / §10.2.9 create `length` then `name` when the function object is
 * created, so they precede every expando in `[[OwnPropertyKeys]]` — including
 * after `Object.defineProperty(fn, "length", {enumerable: true})`, which
 * redefines the property IN PLACE. The #3468 closure bag records that define as
 * a bag entry appended after the expandos (`fn.a = 1` first ⇒ bag `a, length`),
 * so `Object.keys(fn)` answered `["a", "length"]` (spec `["length", "a"]`).
 *
 * `__carrier_bag_push_keys` therefore walks a function receiver's ordered bag
 * in three PHASES — the `length` entry, the `name` entry, then the rest — and
 * any other receiver in the single last phase. `phaseKeep` is folded into the
 * walk's existing push condition (its de-dup skip bakes literal branch depths,
 * so no new block may enclose it); the phase loop wraps the whole walk.
 */
export function fnIntrinsicKeyPhases(
  ctx: CodegenContext,
  d: { phaseLocal: number; fnLocal: number; entryLocal: number; propEntryTypeIdx: number },
): { init: Instr[]; keep: Instr[]; next: Instr[] } | undefined {
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStr = ctx.anyStrTypeIdx;
  if (rootIdx === undefined || flattenIdx === undefined || equalsIdx === undefined || anyStr < 0) return undefined;
  const keyIs = (name: string): Instr[] => [
    { op: "local.get", index: d.entryLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.as_non_null" },
    ...nativeStringLiteralInstrs(ctx, name),
    { op: "call", funcIdx: equalsIdx },
  ];
  const i32: ValType = { kind: "i32" };
  // 0 = "length", 1 = "name", 2 = any other key (a symbol key included)
  const keyClass: Instr[] = [
    { op: "local.get", index: d.entryLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 0 },
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        ...keyIs("length"),
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "i32.const", value: 0 }],
          else: [
            ...keyIs("name"),
            {
              op: "if",
              blockType: { kind: "val", type: i32 },
              then: [{ op: "i32.const", value: 1 }],
              else: [{ op: "i32.const", value: 2 }],
            },
          ],
        },
      ],
      else: [{ op: "i32.const", value: 2 }],
    },
  ];
  return {
    init: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: rootIdx },
      { op: "local.tee", index: d.fnLocal },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [{ op: "i32.const", value: 0 }],
        else: [{ op: "i32.const", value: 2 }],
      },
      { op: "local.set", index: d.phaseLocal },
    ],
    keep: [
      { op: "local.get", index: d.fnLocal },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [...keyClass, { op: "local.get", index: d.phaseLocal }, { op: "i32.eq" }],
        else: [{ op: "i32.const", value: 1 }],
      },
    ],
    next: [
      { op: "local.get", index: d.phaseLocal },
      { op: "i32.const", value: 2 },
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: d.phaseLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: d.phaseLocal },
      { op: "br", depth: 0 },
    ],
  };
}

/**
 * (#6770 S3) `Object.values` / `Object.entries` over a NON-`$Object` receiver
 * (a closure with expandos, a String primitive, an any-typed closed struct)
 * answered `[]` while `Object.keys` on the same receiver already listed its
 * keys. §20.1.2.21/.5 are EnumerableOwnProperties(O, value | key+value): the
 * same key list with `Get(O, key)` per key. Reuse exactly that: keys from
 * `__object_keys` (enumerable, own, in order), values from `__extern_get`.
 * Emitted as the body of the natives' non-`$Object` early return, before the
 * existing `return vec`.
 */
export function nonObjectEnumerableOwnInstrs(ctx: CodegenContext, entries: boolean): Instr[] {
  // The two natives' shared local layout (object-runtime-enumeration.ts):
  // 4 cap / 5 i reused as count / index, 7 the result vec, 8 `pair` (entries
  // only), then the two externref scratch locals appended for this arm.
  const d = {
    entries,
    vecLocal: 7,
    countLocal: 4,
    indexLocal: 5,
    pairLocal: entries ? 8 : undefined,
    keysLocal: entries ? 9 : 8,
    keyLocal: entries ? 10 : 9,
  };
  const keysIdx = ctx.funcMap.get("__object_keys");
  const lengthIdx = ctx.funcMap.get("__extern_length");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const getIdx = ctx.funcMap.get("__extern_get");
  const newIdx = ctx.funcMap.get("__objvec_new");
  const pushIdx = ctx.funcMap.get("__objvec_push");
  if (
    !ctx.standalone ||
    keysIdx === undefined ||
    lengthIdx === undefined ||
    getIdxIdx === undefined ||
    getIdx === undefined ||
    newIdx === undefined ||
    pushIdx === undefined ||
    (d.entries && d.pairLocal === undefined)
  ) {
    return [];
  }
  const value: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: d.keyLocal },
    { op: "call", funcIdx: getIdx },
  ];
  const pushOne: Instr[] = d.entries
    ? [
        { op: "call", funcIdx: newIdx },
        { op: "local.set", index: d.pairLocal! },
        { op: "local.get", index: d.pairLocal! },
        { op: "local.get", index: d.keyLocal },
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: d.pairLocal! },
        ...value,
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: d.vecLocal },
        { op: "local.get", index: d.pairLocal! },
        { op: "call", funcIdx: pushIdx },
      ]
    : [{ op: "local.get", index: d.vecLocal }, ...value, { op: "call", funcIdx: pushIdx }];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: keysIdx },
    { op: "local.tee", index: d.keysLocal },
    { op: "call", funcIdx: lengthIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: d.countLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: d.indexLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: d.indexLocal },
            { op: "local.get", index: d.countLocal },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: d.keysLocal },
            { op: "local.get", index: d.indexLocal },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: getIdxIdx },
            { op: "local.set", index: d.keyLocal },
            ...pushOne,
            { op: "local.get", index: d.indexLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: d.indexLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/**
 * (#6770 S3) A RegExp's own `lastIndex` on the REFLECTIVE key surfaces.
 * RegExpAlloc (§22.2.3.1) defines `lastIndex` — `{writable: true, enumerable:
 * false, configurable: false}` — before any expando, so `Reflect.ownKeys(/x/)`
 * is `["lastIndex"]` and gOPD describes it. The `$NativeRegExp` carrier kept it
 * only on the [[Get]]/[[Set]]/[[DefineOwnProperty]] arms (#6651 B6); gOPN and
 * gOPD answered `[]` / `undefined`. Spliced by the same finalize installer,
 * AFTER the closed-struct gOPN arms (so this push runs first and falls through
 * to them for the expandos).
 */
export function installRegExpLastIndexReflectionArms(
  ctx: CodegenContext,
  d: { reTypeIdx: number; keyIdx: number; readIdx: number; nonWritableField: number },
): void {
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  const names = ctx.mod.functions.find((f) => f.name === "__getOwnPropertyNames");
  const gopd = ctx.mod.functions.find((f) => f.name === "__getOwnPropertyDescriptor");
  if (objVecNewIdx === undefined || objVecPushIdx === undefined || createDescIdx === undefined) return;
  if (names) {
    const anchor = names.body.findIndex(
      (instr, i) =>
        instr.op === "call" &&
        instr.funcIdx === objVecNewIdx &&
        names.body[i + 1]?.op === "local.set" &&
        (names.body[i + 1] as { index: number }).index === 7,
    );
    if (anchor >= 0) {
      names.body.splice(
        anchor + 2,
        0,
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: d.reTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 7 },
            ...nativeStringLiteralInstrs(ctx, "lastIndex"),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: objVecPushIdx },
          ],
        },
      );
    }
  }
  if (gopd) {
    gopd.body.unshift(
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.keyIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: d.readIdx },
          // flags: writable (bit 1) unless the carrier's non-writable bit is set
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: d.reTypeIdx },
          { op: "struct.get", typeIdx: d.reTypeIdx, fieldIdx: d.nonWritableField },
          { op: "i32.eqz" },
          { op: "call", funcIdx: createDescIdx },
          { op: "return" },
        ],
      },
    );
  }
}

export function registerObjOrderIndexOfKey(ctx: CodegenContext, strFlattenIdx: number): number {
  const existing = ctx.funcMap.get(OBJ_ORDER_INDEX_OF_KEY_FN);
  if (existing !== undefined) return existing;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  // params: 0 key. locals: 1 str, 2 data, 3 len, 4 off, 5 i, 6 c, 7 val(i64)
  const minusOne = (): Instr[] => [{ op: "i64.const", value: -1n }, { op: "return" }];
  const charAt = (idx: Instr[]): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "local.get", index: 4 },
    ...idx,
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];
  const notDigit = (): Instr[] => [
    { op: "local.get", index: 6 },
    { op: "i32.const", value: 0x30 },
    { op: "i32.lt_u" },
    { op: "local.get", index: 6 },
    { op: "i32.const", value: 0x39 },
    { op: "i32.gt_u" },
    { op: "i32.or" },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: strFlattenIdx },
    { op: "local.tee", index: 1 },
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
    { op: "local.tee", index: 3 },
    { op: "i32.eqz" },
    { op: "local.get", index: 3 },
    { op: "i32.const", value: MAX_DIGITS },
    { op: "i32.gt_u" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: minusOne() },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 2 },
    // A leading '0' is canonical only as the whole key "0".
    ...charAt([{ op: "i32.const", value: 0 }]),
    { op: "i32.const", value: 0x30 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i64.const", value: 0n }, { op: "return" }],
        },
        ...minusOne(),
      ],
    },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 5 },
            { op: "local.get", index: 3 },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...charAt([{ op: "local.get", index: 5 }]),
            { op: "local.set", index: 6 },
            ...notDigit(),
            { op: "if", blockType: { kind: "empty" }, then: minusOne() },
            // val = val * 10 + (c - '0') — ten digits cannot overflow i64
            { op: "local.get", index: 7 },
            { op: "i64.const", value: 10n },
            { op: "i64.mul" },
            { op: "local.get", index: 6 },
            { op: "i32.const", value: 0x30 },
            { op: "i32.sub" },
            { op: "i64.extend_i32_u" },
            { op: "i64.add" },
            { op: "local.set", index: 7 },
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
    { op: "i64.const", value: MAX_ARRAY_INDEX },
    { op: "i64.gt_u" },
    { op: "if", blockType: { kind: "empty" }, then: minusOne() },
    { op: "local.get", index: 7 },
  ];
  const locals: { name: string; type: ValType }[] = [
    { name: "str", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
    { name: "data", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
    { name: "len", type: { kind: "i32" } },
    { name: "off", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "c", type: { kind: "i32" } },
    { name: "val", type: { kind: "i64" } },
  ];
  const typeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }], [{ kind: "i64" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(OBJ_ORDER_INDEX_OF_KEY_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: OBJ_ORDER_INDEX_OF_KEY_FN, typeIdx, locals, body, exported: false });
  return funcIdx;
}
