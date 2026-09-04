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
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addFuncType, getOrRegisterTaDynViewType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** The three §23.2.3 search methods this module serves. */
const SEARCH_METHODS = new Set(["includes", "indexOf", "lastIndexOf"]);

/**
 * Mint (or reuse) the native helper for `method` on a dynamic view receiver.
 * Returns the function index, or `undefined` when the method has no helper yet
 * or a dependency is missing — the caller then keeps its current path.
 */
export function ensureTaDynProtoMethodHelper(ctx: CodegenContext, method: string): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  if (SEARCH_METHODS.has(method)) return ensureTaDynSearchHelper(ctx, method);
  return undefined;
}

/** Does a native dyn-view helper exist (or can it be minted) for `method`? */
export function hasTaDynProtoMethodHelper(method: string): boolean {
  return SEARCH_METHODS.has(method);
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
