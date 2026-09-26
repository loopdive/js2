// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5194 r3-2) Native `%TypedArray%.prototype` method helpers for a
 * `$__ta_dyn_view` receiver, plus the registry the dispatch arm reads.
 *
 * These are the bodies behind `ta-dyn-method-call.ts`'s `__extern_method_call`
 * arm. Each one owns ONE method, is minted at reserve time (a defined function
 * appended while the call site compiles — the `ensureTaDynFillHelper`
 * discipline), and shares the five-slot ABI the #2872 mutators established:
 *
 * ```
 * __ta_dyn_<m>(recv: externref, a0: externref, a1: externref, a2: externref,
 *              argc: i32) -> externref
 * ```
 *
 * `argc` is the CALL-SITE arity, so an absent argument is distinguishable from
 * an explicit `undefined` — which several §23.2.3 methods observe differently.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  emitTaDynViewToVec,
  emitTaDynViewValidate,
  makeTaDynHelperFctx,
  pushTaDynMethodPreamble,
} from "./dataview-native.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { getArrTypeIdxFromVec } from "./index.js";
import {
  ensureNativeIteratorRuntime,
  getOrRegisterIterRecType,
  ITER_FAMILY_ARRAY,
  ITER_KIND_VEC,
} from "./iterator-native.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { ensureObjectRuntime, ensureObjVecBuilders } from "./object-runtime.js";
import { addFuncType, getOrRegisterTaDynViewType, getOrRegisterVecType } from "./registry/types.js";
import { ensureTaDynMopElemHelpers } from "./ta-dyn-mop.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** The three §23.2.3 search methods this module serves. */
const SEARCH_METHODS = new Set(["includes", "indexOf", "lastIndexOf"]);

/**
 * (#6651 IT3) The three §23.2.3 iterator factories: `values` / `keys` /
 * `entries`. Kept separate from {@link SEARCH_METHODS} because they share no
 * body shape at all — a search returns a boxed scalar, these return an
 * `$__IterRec`.
 */
const ITERATOR_METHODS = new Set(["values", "keys", "entries"]);

/**
 * Mint (or reuse) the native helper for `method` on a dynamic view receiver.
 * Returns the function index, or `undefined` when the method has no helper yet
 * or a dependency is missing — the caller then keeps its current path.
 */
export function ensureTaDynProtoMethodHelper(ctx: CodegenContext, method: string): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  if (SEARCH_METHODS.has(method)) return ensureTaDynSearchHelper(ctx, method);
  if (ITERATOR_METHODS.has(method)) return ensureTaDynIteratorHelper(ctx, method);
  return undefined;
}

/** Does a native dyn-view helper exist (or can it be minted) for `method`? */
export function hasTaDynProtoMethodHelper(method: string): boolean {
  return SEARCH_METHODS.has(method) || ITERATOR_METHODS.has(method);
}

/**
 * (§23.2.3.16 / .17 / .18) `includes` / `indexOf` / `lastIndexOf` over a
 * `$__ta_dyn_view`.
 *
 * Order matters and is asserted by the corpus:
 *
 * 1. ValidateTypedArray — a detached or out-of-bounds view throws TypeError
 *    BEFORE anything else is read (the `detached-buffer.js` row of each).
 * 2. `len` is the INTERNAL element count, never an expando `length`
 *    (`get-length-uses-internal-arraylength.js`).
 * 3. `len === 0` returns the miss result BEFORE `fromIndex` is touched
 *    (`length-zero-returns-false.js` — a `fromIndex` whose `valueOf` throws must
 *    NOT run).
 * 4. `fromIndex` is ToIntegerOrInfinity'd: a Symbol throws TypeError, an abrupt
 *    `valueOf` propagates unchanged, `-0` becomes `+0`, and ±∞ are handled in
 *    f64 before any i32 narrowing (`i32.trunc_sat` would fold ±∞ to the i32
 *    extremes and silently answer the wrong end of the array).
 * 5. Elements are compared as f64. `includes` uses SameValueZero (NaN matches
 *    NaN); `indexOf`/`lastIndexOf` use strict equality (NaN never matches).
 *
 * A non-numeric search element can never equal a typed-array element, so it is
 * NOT coerced — calling `__unbox_number` on it would invoke a user `valueOf`
 * the spec never invokes (`search-value-not-number` shapes, and the absent
 * argument of `indexOf()`).
 *
 * The element snapshot is taken AFTER the `fromIndex` coercion, because that
 * coercion can detach the buffer; the loop is bounded by the snapshot's own
 * length as well as by `len`, so positions that became unreadable simply do not
 * match (§10.4.5.4 returns undefined for them) instead of trapping.
 */
function ensureTaDynSearchHelper(ctx: CodegenContext, method: string): number | undefined {
  const helperName = `__ta_dyn_${method}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const dynIdx = getOrRegisterTaDynViewType(ctx);
  if (dynIdx < 0) return undefined;
  const backward = method === "lastIndexOf";
  const wantsBoolean = method === "includes";

  const fctx = makeTaDynHelperFctx(helperName, [
    { name: "recv", type: { kind: "externref" } },
    { name: "searchElement", type: { kind: "externref" } },
    { name: "fromIndex", type: { kind: "externref" } },
    { name: "unused", type: { kind: "externref" } },
    { name: "argc", type: { kind: "i32" } },
  ]);

  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__typeof_number", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  if (boxNumberIdx === undefined || boxBooleanIdx === undefined || typeofNumberIdx === undefined) {
    return undefined;
  }

  const params: ValType[] = [
    { kind: "externref" },
    { kind: "externref" },
    { kind: "externref" },
    { kind: "externref" },
    { kind: "i32" },
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$ta_dyn_${method}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const dvLocal = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const lenLocal = allocLocal(fctx, "len", { kind: "i32" });
  const lenF64Local = allocLocal(fctx, "lenf", { kind: "f64" });
  const nLocal = allocLocal(fctx, "n", { kind: "f64" });
  const kLocal = allocLocal(fctx, "k", { kind: "i32" });
  const targetLocal = allocLocal(fctx, "target", { kind: "f64" });
  const elemLocal = allocLocal(fctx, "elem", { kind: "f64" });
  const alenLocal = allocLocal(fctx, "alen", { kind: "i32" });

  const missResult = (): Instr[] =>
    wantsBoolean
      ? [{ op: "i32.const", value: 0 }, { op: "call", funcIdx: boxBooleanIdx }, { op: "return" }]
      : [{ op: "f64.const", value: -1 }, { op: "call", funcIdx: boxNumberIdx }, { op: "return" }];
  const hitResult = (): Instr[] =>
    wantsBoolean
      ? [{ op: "i32.const", value: 1 }, { op: "call", funcIdx: boxBooleanIdx }, { op: "return" }]
      : [
          { op: "local.get", index: kLocal },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: boxNumberIdx },
          { op: "return" },
        ];

  // 1/2. Receiver preamble + ValidateTypedArray + the internal length.
  pushTaDynMethodPreamble(ctx, fctx, dynIdx, dvLocal, kindLocal, esLocal, lenLocal);
  emitTaDynViewValidate(ctx, fctx, dvLocal);
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "f64.convert_i32_s" });
  fctx.body.push({ op: "local.set", index: lenF64Local });

  // 3. Empty view → miss, before `fromIndex` is observed.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: missResult() });

  // 4. n = argc >= 2 ? ToIntegerOrInfinity(fromIndex) : (backward ? len-1 : 0).
  const coerceArm: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.savedBodies.push(saved);
    fctx.body = coerceArm;
    if (ctx.symbolTypeIdx >= 0) {
      const symThrow = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a number", {
        flush: fctx,
      });
      fctx.body.push({ op: "local.get", index: 2 });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.test", typeIdx: ctx.symbolTypeIdx });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: symThrow });
    }
    fctx.body.push({ op: "local.get", index: 2 });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: nLocal });
    // NaN → +0 (this also normalises `undefined`), then truncate toward zero.
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "f64.ne" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: nLocal },
      ],
    });
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "f64.trunc" });
    // `-0` must become `+0`: adding zero normalises it without touching any
    // other value (`fromIndex-minus-zero.js`).
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.add" });
    fctx.body.push({ op: "local.set", index: nLocal });
    fctx.body = saved;
    fctx.savedBodies.pop();
  }
  fctx.body.push({ op: "local.get", index: 4 });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: coerceArm,
    else: backward
      ? [
          { op: "local.get", index: lenF64Local },
          { op: "f64.const", value: 1 },
          { op: "f64.sub" },
          { op: "local.set", index: nLocal },
        ]
      : [
          { op: "f64.const", value: 0 },
          { op: "local.set", index: nLocal },
        ],
  });

  // 5. Start index, decided entirely in f64 so ±∞ answer correctly.
  if (backward) {
    // n >= 0 ? min(n, len-1) : len + n ; a result below 0 is a miss.
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ge" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: nLocal },
        { op: "local.get", index: lenF64Local },
        { op: "f64.const", value: 1 },
        { op: "f64.sub" },
        { op: "f64.min" },
        { op: "local.set", index: nLocal },
      ],
      else: [
        { op: "local.get", index: lenF64Local },
        { op: "local.get", index: nLocal },
        { op: "f64.add" },
        { op: "local.set", index: nLocal },
      ],
    });
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.lt" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: missResult() });
  } else {
    // n >= len (including +∞) is a miss; a negative n counts from the end and
    // clamps at 0 (−∞ → 0).
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "local.get", index: lenF64Local });
    fctx.body.push({ op: "f64.ge" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: missResult() });
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.lt" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenF64Local },
        { op: "local.get", index: nLocal },
        { op: "f64.add" },
        { op: "f64.const", value: 0 },
        { op: "f64.max" },
        { op: "local.set", index: nLocal },
      ],
    });
  }
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: kLocal });

  // A non-number search element cannot equal any element — answer the miss
  // WITHOUT coercing it (no observable `valueOf`).
  fctx.body.push({ op: "local.get", index: 1 });
  fctx.body.push({ op: "call", funcIdx: typeofNumberIdx });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: missResult() });
  fctx.body.push({ op: "local.get", index: 1 });
  // Known to be a Number by the guard above, so this cannot run user code —
  // route it through the coercion engine rather than hand-rolling an unbox.
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: targetLocal });

  // Element snapshot (after the coercion, which may have detached the buffer).
  const f64VecIdx = emitTaDynViewToVec(ctx, fctx, dvLocal);
  const f64ArrIdx = getArrTypeIdxFromVec(ctx, f64VecIdx);
  const vecLocal = allocLocal(fctx, "vec", { kind: "ref", typeIdx: f64VecIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: f64VecIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: alenLocal });

  const compare: Instr[] = wantsBoolean
    ? [
        // SameValueZero on f64: equality, or both NaN.
        { op: "local.get", index: elemLocal },
        { op: "local.get", index: targetLocal },
        { op: "f64.eq" },
        { op: "local.get", index: elemLocal },
        { op: "local.get", index: elemLocal },
        { op: "f64.ne" },
        { op: "local.get", index: targetLocal },
        { op: "local.get", index: targetLocal },
        { op: "f64.ne" },
        { op: "i32.and" },
        { op: "i32.or" },
      ]
    : [{ op: "local.get", index: elemLocal }, { op: "local.get", index: targetLocal }, { op: "f64.eq" }];

  const probe: Instr[] = [
    { op: "local.get", index: kLocal },
    { op: "local.get", index: alenLocal },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: vecLocal },
        { op: "struct.get", typeIdx: f64VecIdx, fieldIdx: 1 },
        { op: "local.get", index: kLocal },
        { op: "array.get", typeIdx: f64ArrIdx },
        { op: "local.set", index: elemLocal },
        ...compare,
        { op: "if", blockType: { kind: "empty" }, then: hitResult() },
      ],
    },
  ];

  const loopBody: Instr[] = backward
    ? [
        { op: "local.get", index: kLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        { op: "br_if", depth: 1 },
        ...probe,
        { op: "local.get", index: kLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: kLocal },
        { op: "br", depth: 0 },
      ]
    : [
        { op: "local.get", index: kLocal },
        { op: "local.get", index: lenLocal },
        { op: "i32.ge_s" },
        { op: "br_if", depth: 1 },
        ...probe,
        { op: "local.get", index: kLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: kLocal },
        { op: "br", depth: 0 },
      ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
  fctx.body.push(...missResult());

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#6651 IT3) `%TypedArray%.prototype.{values,keys,entries}` (§23.2.3.31 /
 * .17 / .7) over a `$__ta_dyn_view` receiver.
 *
 * ## Why this had no helper before, and what the plan file got wrong
 *
 * The recorded premise was "`TA_DYN_METHOD_CALL_NAMES` already lists
 * values/keys/entries but no `__ta_dyn_*` helper exists" — true, but it
 * implied the missing piece was only this mint. Measured on `cb2e265852`, a
 * second defect sat behind it: the STATIC `arr.values()` lowering
 * (`compileNativeArrayIterator`, array-methods.ts) returns the bare canonical
 * externref `$Vec` and drops the `$__IterRec` on the floor — the dangling
 * `void iterRecTypeIdx` at the end of that function. So in standalone
 * `[7,8,9].values()` answers an object with `.length === 3` for which
 * `Array.isArray` is true, and `.next()` on it reads `null`. Routing this
 * helper through that shape would have produced exactly the same unusable
 * value, i.e. a measured no-op. It therefore builds the record itself.
 *
 * Probed on the same commit: a `$__IterRec` reached through a DYNAMIC receiver
 * already answers correctly — `x.next()` steps the record, and
 * `Object.getPrototypeOf(x)` is `===` the object
 * `Object.getPrototypeOf([][Symbol.iterator]())` yields. Both are #6484 S1/S2
 * machinery (`emitIteratorFamilyNextBody` + `__iter_rec_proto`), and both are
 * keyed on `family`, which is why the record is stamped `ITER_FAMILY_ARRAY`
 * rather than left `UNKNOWN`: an `UNKNOWN` record answers `ref.null.extern`
 * for its prototype, which is what the `iter-prototype.js` rows read.
 *
 * ## Shape
 *
 * ValidateTypedArray first (§23.2.4.4 — a detached or out-of-bounds view
 * throws a catchable TypeError before anything else is observable), then one
 * pass that materialises the yielded values into a canonical externref `$Vec`,
 * then `struct.new $__IterRec(ITER_KIND_VEC, vec, 0, null, ITER_FAMILY_ARRAY)`.
 *
 * `keys` boxes the index; `values` reads each element through the existing
 * `__ta_dyn_get_elem` (so element decode, including the per-kind dispatch,
 * lives in exactly one place); `entries` builds a two-slot `$ObjVec` pair per
 * index, the same carrier the static `.entries()` path uses, so the consumer's
 * `pair[0]` / `pair[1]` / `.length` reads keep routing through the native
 * `__extern_get_idx` / `__extern_length` `$ObjVec` arms.
 *
 * ## Known residual: the snapshot
 *
 * The vec is a SNAPSHOT taken at call time, so a buffer resized mid-iteration
 * is not observed. That is wrong for the `resizable-buffer*.js` /
 * `make-{in,out}-of-bounds-after-exhausted.js` rows — all of which already
 * fail (several on BOTH targets) and none of which are ES2015. Modelling a
 * live cursor needs the record to carry the view rather than a vec, which is a
 * `$__IterRec` substrate change (#6484), not a helper change.
 */
function ensureTaDynIteratorHelper(ctx: CodegenContext, method: string): number | undefined {
  const helperName = `__ta_dyn_${method}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const dynIdx = getOrRegisterTaDynViewType(ctx);
  if (dynIdx < 0) return undefined;

  const fctx = makeTaDynHelperFctx(helperName, [
    { name: "recv", type: { kind: "externref" } },
    { name: "unused0", type: { kind: "externref" } },
    { name: "unused1", type: { kind: "externref" } },
    { name: "unused2", type: { kind: "externref" } },
    { name: "argc", type: { kind: "i32" } },
  ]);

  // Dependencies FIRST, while a late import can still shift indices: the
  // record type, the iteration-protocol consumer natives (a module whose only
  // iterator comes from this helper registers none otherwise), the boxer, and
  // — for `entries` — the `$ObjVec` pair builders.
  ensureObjectRuntime(ctx);
  ensureNativeIteratorRuntime(ctx);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (boxNumberIdx === undefined) return undefined;
  const elemHelpers = ensureTaDynMopElemHelpers(ctx);
  if (elemHelpers === undefined) return undefined;
  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  const canonVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const canonArrTypeIdx = getArrTypeIdxFromVec(ctx, canonVecTypeIdx);
  if (canonArrTypeIdx < 0) return undefined;
  let objVecNewIdx = 0;
  let objVecPushIdx = 0;
  if (method === "entries") {
    const builders = ensureObjVecBuilders(ctx);
    objVecNewIdx = builders.newIdx;
    objVecPushIdx = builders.pushIdx;
  }
  flushLateImportShifts(ctx, fctx);

  const params: ValType[] = [
    { kind: "externref" },
    { kind: "externref" },
    { kind: "externref" },
    { kind: "externref" },
    { kind: "i32" },
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$ta_dyn_${method}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const dvLocal = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const lenLocal = allocLocal(fctx, "len", { kind: "i32" });
  const outLocal = allocLocal(fctx, "out", { kind: "ref", typeIdx: canonArrTypeIdx });
  const iLocal = allocLocal(fctx, "i", { kind: "i32" });
  const pairLocal = method === "entries" ? allocLocal(fctx, "pair", { kind: "externref" }) : -1;

  pushTaDynMethodPreamble(ctx, fctx, dynIdx, dvLocal, kindLocal, esLocal, lenLocal);
  // §23.2.4.4 ValidateTypedArray — step 1, before any element is read.
  emitTaDynViewValidate(ctx, fctx, dvLocal);

  // out = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: canonArrTypeIdx });
  fctx.body.push({ op: "local.set", index: outLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  /** `f64(i)` — the index in the shape `__box_number` / `__ta_dyn_get_elem` take. */
  const idxAsF64: Instr[] = [{ op: "local.get", index: iLocal }, { op: "f64.convert_i32_s" }];
  /** The value yielded at slot `i`, as an externref, left on the stack. */
  const yieldedValue = (): Instr[] => {
    if (method === "keys") return [...idxAsF64, { op: "call", funcIdx: boxNumberIdx }];
    if (method === "values") {
      return [{ op: "local.get", index: 0 }, ...idxAsF64, { op: "call", funcIdx: elemHelpers.getElem }];
    }
    // entries — a fresh two-slot `$ObjVec` holding [box(i), element].
    return [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: pairLocal },
      { op: "local.get", index: pairLocal },
      ...idxAsF64,
      { op: "call", funcIdx: boxNumberIdx },
      { op: "call", funcIdx: objVecPushIdx },
      { op: "local.get", index: pairLocal },
      { op: "local.get", index: 0 },
      ...idxAsF64,
      { op: "call", funcIdx: elemHelpers.getElem },
      { op: "call", funcIdx: objVecPushIdx },
      { op: "local.get", index: pairLocal },
    ];
  };

  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: outLocal },
    { op: "local.get", index: iLocal },
    ...yieldedValue(),
    { op: "array.set", typeIdx: canonArrTypeIdx },
    { op: "local.get", index: iLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // struct.new $__IterRec(kind, vec, idx, userIter, family) — field order is
  // load-bearing (see getOrRegisterIterRecType).
  fctx.body.push({ op: "i32.const", value: ITER_KIND_VEC });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: outLocal });
  fctx.body.push({ op: "struct.new", typeIdx: canonVecTypeIdx });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "i32.const", value: ITER_FAMILY_ARRAY });
  fctx.body.push({ op: "struct.new", typeIdx: iterRecTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}
