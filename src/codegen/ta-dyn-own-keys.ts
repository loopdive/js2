// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E2) The OWN-PROPERTY SURFACE of a `$__ta_dyn_view`
 * in the standalone dynamic-object runtime — §10.4.5.6 `[[OwnPropertyKeys]]`
 * and the own-ness predicates that read it.
 *
 * `ta-dyn-mop.ts` (#3177) gave the dynamic view arms for
 * `[[Get]]/[[Set]]/[[HasProperty]]/[[Delete]]/[[DefineOwnProperty]]/
 * [[GetOwnProperty]]/[[PreventExtensions]]` and for `__object_keys`
 * (the ENUMERABLE-key list behind `Object.keys` / `for…in`). It did NOT touch
 * the four natives that answer the *reflective* own-key questions:
 *
 *   `__getOwnPropertyNames`   (`Object.getOwnPropertyNames`, and the names
 *                              half of `Reflect.ownKeys`)
 *   `__getOwnPropertySymbols` (`Object.getOwnPropertySymbols`, and the symbol
 *                              half of `Reflect.ownKeys`)
 *   `__hasOwnProperty` / `__object_hasOwn` / `__propertyIsEnumerable`
 *
 * A `$__ta_dyn_view` subtypes `$__vec_base` (#3057), so each of those fell
 * through to the generic vec arm and answered as if the view were an Array.
 * Measured on this branch's base (`.tmp/6651/p2.js`, `.tmp/6651/p4.js`,
 * Float64Array, `--standalone`), with a view carrying one string expando and
 * one symbol expando:
 *
 *   Reflect.ownKeys(sample)                    →  0,1,2,length     (spec: 0,1,2,test262,@@s)
 *   Object.getOwnPropertySymbols(sample).length→  0                (spec: 1)
 *   hasOwnProperty.call(sample, 0)             →  false            (spec: true)
 *   hasOwnProperty.call(sample, "foo")         →  false            (spec: true)
 *
 * Two independent errors in one answer: `"length"` is reported as an OWN key
 * (a TypedArray's `length` is an accessor on `%TypedArray%.prototype`, never
 * an own property — §23.2.3.19), and the view's own expandos are invisible
 * because the generic vec arm has no idea the side-table exists. The
 * own-ness predicates were worse: they answered `false` for EVERY key,
 * including a valid integer index.
 *
 * The consequence is not limited to key listings. `propertyHelper.js`'s
 * `verifyNotConfigurable` deletes the key and then asks
 * `hasOwnProperty` whether it survived — a blanket `false` reads as "the
 * property was configurable after all", which is how
 * `internals/DefineOwnProperty/key-is-symbol.js` failed with
 * "Expected obj[102] NOT to be configurable, but was" even though the
 * descriptor it defined was byte-correct (`.tmp/6651/p3.js` shows the
 * descriptor round-trips `w=false e=false c=false` on a dyn view already).
 *
 * Shape of the fix — the SAME split `ta-dyn-mop.ts` already uses everywhere:
 * a canonical numeric index takes integer-indexed-exotic semantics
 * (`__ta_dyn_has_idx`, i.e. §10.4.5.14 IsValidIntegerIndex), and every other
 * key is delegated to the view's expando side-table (`$__ta_dyn_view` field 4,
 * a lazily-created `$Object` boxed as externref) by a RECURSIVE self-call on
 * the same native. The expando is a `$Object`, so the arm's own `ref.test`
 * declines one level down and the untouched ordinary body runs — the
 * termination argument is the one from `ta-dyn-mop.ts`'s ordinary-key
 * delegate, unchanged.
 *
 * Kept in its own module rather than spliced into `ta-dyn-mop.ts` because that
 * file is a tracked god-file at its LOC ceiling and `fillTaDynViewMopArms` is
 * already a 966-line unit; this is a self-contained fill over four natives.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { pushElemSizeForKind, pushTaDynViewInBoundsLen } from "./dataview-native.js";
import { definedFuncAt } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { ensureTaDynMopElemHelpers } from "./ta-dyn-mop.js";

/** A finalize-time mutable native body (the `ta-dyn-mop.ts` `findFn` shape). */
type FilledFn = { locals: { name: string; type: ValType }[]; body: Instr[] };

/** Everything the arms below need, resolved once (absent ⇒ no fill at all). */
type OwnKeyDeps = {
  dynIdx: number;
  anyStrTypeIdx: number;
  tpkIdx: number;
  strToNumIdx: number;
  numToStringIdx: number;
  strFlattenIdx: number;
  strEqualsIdx: number;
  hasIdx: number;
};

/** i32: the (already `__to_property_key`-normalized) key is an `$AnyString`
 *  whose text is a CanonicalNumericIndexString (§7.1.21). Writes `nLocal`. */
function keyIsStringCanonical(ctx: CodegenContext, d: OwnKeyDeps, keyLocal: number, nLocal: number): Instr[] {
  const flattenKey: Instr[] = [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
    { op: "call", funcIdx: d.strFlattenIdx },
  ];
  return [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: keyLocal },
        { op: "call", funcIdx: d.strToNumIdx },
        { op: "local.set", index: nLocal },
        { op: "local.get", index: nLocal },
        { op: "call", funcIdx: d.numToStringIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.anyStrTypeIdx },
        { op: "call", funcIdx: d.strFlattenIdx },
        ...flattenKey,
        { op: "call", funcIdx: d.strEqualsIdx },
        // "-0" is canonical too (§7.1.21) even though ToString(-0) is "0".
        ...flattenKey,
        ...nativeStringLiteralInstrs(ctx, "-0"),
        { op: "call", funcIdx: d.strEqualsIdx },
        { op: "i32.or" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * Prepend `inner` to `fn` under a `ref.test $__ta_dyn_view` guard on param 0.
 * Every non-view receiver falls through to the untouched ordinary body.
 */
function unshiftViewGuard(fn: FilledFn, dynIdx: number, inner: Instr[]): void {
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dynIdx },
    { op: "if", blockType: { kind: "empty" }, then: inner },
  );
}

/**
 * Own-ness predicate arm for `(obj, key) -> i32` natives: a canonical index
 * answers IsValidIntegerIndex, any other key answers off the expando via a
 * recursive self-call (no expando ⇒ `false`).
 *
 * The same body serves `__propertyIsEnumerable`: an integer-indexed element
 * that exists is ALWAYS enumerable (§10.4.5.1 builds its descriptor with
 * `[[Enumerable]]: true`), and a non-index key's enumerability is exactly the
 * expando's answer.
 */
function fillOwnPredicateArm(ctx: CodegenContext, d: OwnKeyDeps, name: string): void {
  const idx = ctx.funcMap.get(name);
  if (idx === undefined) return;
  const fn = definedFuncAt(ctx, idx) as FilledFn | undefined;
  if (!fn) return;
  const base = 2 + fn.locals.length;
  const lDv = base;
  const lKey = base + 1;
  const lN = base + 2;
  const lExp = base + 3;
  fn.locals.push(
    { name: "__tak_dv", type: { kind: "ref_null", typeIdx: d.dynIdx } },
    { name: "__tak_key", type: { kind: "externref" } },
    { name: "__tak_n", type: { kind: "f64" } },
    { name: "__tak_exp", type: { kind: "externref" } },
  );
  const inner: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.dynIdx },
    { op: "local.set", index: lDv },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: d.tpkIdx },
    { op: "local.set", index: lKey },
    ...keyIsStringCanonical(ctx, d, lKey, lN),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: lN },
        { op: "call", funcIdx: d.hasIdx },
        { op: "return" },
      ],
    },
    { op: "local.get", index: lDv },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.dynIdx, fieldIdx: 4 },
    { op: "local.set", index: lExp },
    { op: "local.get", index: lExp },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: lExp },
    { op: "local.get", index: lKey },
    { op: "call", funcIdx: idx },
    { op: "return" },
  ];
  unshiftViewGuard(fn, d.dynIdx, inner);
}

/**
 * `__getOwnPropertyNames(view)` — §10.4.5.6 steps 1–3: every integer index in
 * ASCENDING order, then the own string keys of the expando in creation order
 * (the expando's own `__getOwnPropertyNames` already answers in creation
 * order). `"length"`/`"byteLength"`/… are prototype accessors and must NOT
 * appear, which is exactly what building a FRESH vec instead of falling
 * through to the generic vec arm achieves.
 */
function fillOwnNamesArm(ctx: CodegenContext, d: OwnKeyDeps, nativeName: string, delegateName: string): void {
  const idx = ctx.funcMap.get(nativeName);
  const delegateIdx = ctx.funcMap.get(delegateName);
  const vecNewIdx = ctx.funcMap.get("__objvec_new");
  const vecPushIdx = ctx.funcMap.get("__objvec_push");
  const lenIdx = ctx.funcMap.get("__extern_length");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  if (idx === undefined || delegateIdx === undefined || vecNewIdx === undefined || vecPushIdx === undefined) return;
  if (lenIdx === undefined || getIdxIdx === undefined) return;
  const fn = definedFuncAt(ctx, idx) as FilledFn | undefined;
  if (!fn) return;
  const base = 1 + fn.locals.length;
  const lDv = base;
  const lKind = base + 1;
  const lEs = base + 2;
  const lLen = base + 3;
  const lVec = base + 4;
  const lI = base + 5;
  const lExp = base + 6;
  const lNames = base + 7;
  const lCnt = base + 8;
  const lJ = base + 9;
  fn.locals.push(
    { name: "__tak_dv", type: { kind: "ref_null", typeIdx: d.dynIdx } },
    { name: "__tak_kind", type: { kind: "i32" } },
    { name: "__tak_es", type: { kind: "i32" } },
    { name: "__tak_len", type: { kind: "i32" } },
    { name: "__tak_vec", type: { kind: "externref" } },
    { name: "__tak_i", type: { kind: "i32" } },
    { name: "__tak_exp", type: { kind: "externref" } },
    { name: "__tak_names", type: { kind: "externref" } },
    { name: "__tak_cnt", type: { kind: "f64" } },
    { name: "__tak_j", type: { kind: "f64" } },
  );
  const inner: Instr[] = [];
  const fctxLike = {
    body: inner,
    locals: fn.locals,
    params: [{ name: "p", type: { kind: "externref" } }],
    localMap: new Map(),
  } as unknown as FunctionContext;
  inner.push({ op: "local.get", index: 0 });
  inner.push({ op: "any.convert_extern" });
  inner.push({ op: "ref.cast", typeIdx: d.dynIdx });
  inner.push({ op: "local.set", index: lDv });
  inner.push({ op: "local.get", index: lDv });
  inner.push({ op: "ref.as_non_null" });
  inner.push({ op: "struct.get", typeIdx: d.dynIdx, fieldIdx: 3 });
  inner.push({ op: "local.set", index: lKind });
  pushElemSizeForKind(fctxLike, lKind);
  inner.push({ op: "local.set", index: lEs });
  pushTaDynViewInBoundsLen(ctx, fctxLike, lDv, lEs);
  inner.push({ op: "local.set", index: lLen });
  inner.push({ op: "call", funcIdx: vecNewIdx });
  inner.push({ op: "local.set", index: lVec });
  inner.push({ op: "i32.const", value: 0 });
  inner.push({ op: "local.set", index: lI });
  inner.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: lI },
          { op: "local.get", index: lLen },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: lVec },
          { op: "local.get", index: lI },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: d.numToStringIdx },
          { op: "call", funcIdx: vecPushIdx },
          { op: "local.get", index: lI },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: lI },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });
  // Expando string keys, in creation order, after every index (§10.1.11.1 step 3).
  inner.push({ op: "local.get", index: lDv });
  inner.push({ op: "ref.as_non_null" });
  inner.push({ op: "struct.get", typeIdx: d.dynIdx, fieldIdx: 4 });
  inner.push({ op: "local.set", index: lExp });
  inner.push({ op: "local.get", index: lExp });
  inner.push({ op: "ref.is_null" });
  inner.push({ op: "i32.eqz" });
  inner.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lExp },
      // The expando is a `$Object`, so this call's own dyn-view guard declines
      // and the ordinary body answers — the recursion terminates one level down.
      { op: "call", funcIdx: delegateIdx },
      { op: "local.set", index: lNames },
      { op: "local.get", index: lNames },
      { op: "call", funcIdx: lenIdx },
      { op: "local.set", index: lCnt },
      { op: "f64.const", value: 0 },
      { op: "local.set", index: lJ },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: lJ },
              { op: "local.get", index: lCnt },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: lVec },
              { op: "local.get", index: lNames },
              { op: "local.get", index: lJ },
              { op: "call", funcIdx: getIdxIdx },
              { op: "call", funcIdx: vecPushIdx },
              { op: "local.get", index: lJ },
              { op: "f64.const", value: 1 },
              { op: "f64.add" },
              { op: "local.set", index: lJ },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ],
  });
  inner.push({ op: "local.get", index: lVec });
  inner.push({ op: "return" });
  unshiftViewGuard(fn, d.dynIdx, inner);
}

/**
 * `__getOwnPropertySymbols(view)` — a view has no intrinsic symbol-keyed own
 * property, so the answer is exactly the expando's (empty vec when the view
 * never took an ordinary write).
 */
function fillOwnSymbolsArm(ctx: CodegenContext, d: OwnKeyDeps): void {
  const idx = ctx.funcMap.get("__getOwnPropertySymbols");
  const vecNewIdx = ctx.funcMap.get("__objvec_new");
  if (idx === undefined || vecNewIdx === undefined) return;
  const fn = definedFuncAt(ctx, idx) as FilledFn | undefined;
  if (!fn) return;
  const base = 1 + fn.locals.length;
  const lExp = base;
  fn.locals.push({ name: "__tak_exp", type: { kind: "externref" } });
  const inner: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.dynIdx },
    { op: "struct.get", typeIdx: d.dynIdx, fieldIdx: 4 },
    { op: "local.set", index: lExp },
    { op: "local.get", index: lExp },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: vecNewIdx }, { op: "return" }] },
    { op: "local.get", index: lExp },
    { op: "call", funcIdx: idx }, // recursive: the expando is a $Object
    { op: "return" },
  ];
  unshiftViewGuard(fn, d.dynIdx, inner);
}

/**
 * (#6651 E2) Finalize-time fill. MUST run after every generic `$__vec_base`
 * fill (each prepends at body[0]; last fill wins the front slot) — in
 * particular after `fillVecLengthDynamicArms`, which splices the vec
 * own-`"length"` arm into `__hasOwnProperty`/`__object_hasOwn`. Standalone
 * only; a module with no dynamic view registers no `$__ta_dyn_view` type and
 * this is a no-op (byte-inert).
 */
export function fillTaDynViewOwnKeyArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx < 0) return;
  const helpers = ensureTaDynMopElemHelpers(ctx);
  if (!helpers) return;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return;
  const tpkIdx = ctx.funcMap.get("__to_property_key");
  const strToNumIdx = ctx.funcMap.get("__str_to_number");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    tpkIdx === undefined ||
    strToNumIdx === undefined ||
    numToStringIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined
  ) {
    return; // object runtime not in this module — nothing routes here anyway
  }
  const d: OwnKeyDeps = {
    dynIdx,
    anyStrTypeIdx,
    tpkIdx,
    strToNumIdx,
    numToStringIdx,
    strFlattenIdx,
    strEqualsIdx,
    hasIdx: helpers.hasIdx,
  };
  fillOwnPredicateArm(ctx, d, "__hasOwnProperty");
  fillOwnPredicateArm(ctx, d, "__object_hasOwn");
  fillOwnPredicateArm(ctx, d, "__propertyIsEnumerable");
  fillOwnNamesArm(ctx, d, "__getOwnPropertyNames", "__getOwnPropertyNames");
  // The ENUMERABLE-key twins behind `Object.keys` and `for…in`. #3177 gave
  // `__object_keys` an indices-only arm and parked expandos as "a follow-on",
  // and never touched `__object_keys_forin` at all. The same emitter serves
  // all three because the DELEGATE carries the filter: `__object_keys(expando)`
  // lists exactly the enumerable own string keys. For the for-in native the
  // delegate is deliberately `__object_keys`, not itself — a view's prototype
  // chain (`%TypedArray%.prototype`) has nothing enumerable to contribute, so
  // walking it would only risk duplicates.
  fillOwnNamesArm(ctx, d, "__object_keys", "__object_keys");
  fillOwnNamesArm(ctx, d, "__object_keys_forin", "__object_keys");
  fillOwnSymbolsArm(ctx, d);
}
