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
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  emitTaDynSpeciesCreate,
  emitTaDynViewToVec,
  emitTaDynViewValidate,
  i32ByteVec,
  makeTaDynHelperFctx,
  pushTaDynMethodPreamble,
  pushTaDynRelativeIndex,
  pushTaDynViewInBoundsLen,
} from "./dataview-native.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { getOrRegisterTaIterVecType } from "./array/ta-iter-detach.js"; // (#6651 V3)
import { getArrTypeIdxFromVec } from "./index.js";
import {
  ensureNativeIteratorRuntime,
  getOrRegisterIterRecType,
  ITER_FAMILY_ARRAY,
  ITER_KIND_VEC,
} from "./iterator-native.js";
import { buildThrowJsErrorInstrs, emitThrowTypeError, noJsHost } from "./js-errors.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { emitStableMergeSort } from "./merge-sort.js"; // (#6769 S6)
import { ensureObjectRuntime, ensureObjVecBuilders } from "./object-runtime.js";
import { addFuncType, getOrRegisterTaDynViewType, getOrRegisterVecType } from "./registry/types.js";
import { ensureTaDynMopElemHelpers } from "./ta-dyn-mop.js";
import {
  beginTaDynProducer,
  ensureTaDynMapFilterHelper,
  finishTaDynProducer,
  taDynCountedLoop,
  taDynResultStoreInstrs,
} from "./ta-hof-map-filter.js"; // (#6769 S4) live-receiver species producers
import { compileArrowAsClosure, compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
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
  if (method === "subarray") return ensureTaDynSubarrayHelper(ctx);
  if (method === "map" || method === "filter") return ensureTaDynMapFilterHelper(ctx, method);
  if (method === "slice") return ensureTaDynSliceHelper(ctx);
  if (method === "sort") return ensureTaDynSortHelper(ctx);
  return undefined;
}

/** (#6769 S4/S6) The live-receiver producers (`sort` rewrites in place). */
const PRODUCER_METHODS = new Set(["map", "filter", "slice", "sort"]);

/**
 * (#6769 S4) Call-site half of the producers: `helper(recv, a0, a1, a2, argc)`
 * with the arguments evaluated left to right as §13.3.6 requires (every one of
 * them, even past the three ABI slots — the extras are evaluated and dropped).
 * A function-literal callback in slot 0 is compiled as a closure value. The
 * result lands in a fresh externref local, whose index is returned; `null`
 * (nothing emitted) for a spread argument list.
 */
export function emitTaDynProducerCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExtLocal: number,
  callExpr: ts.CallExpression,
  helperIdx: number,
  callbackInSlot0: boolean,
): number | null {
  const args = callExpr.arguments;
  if (args.some((a) => ts.isSpreadElement(a))) return null;
  const ext: ValType = { kind: "externref" };
  const pushArg = (arg: ts.Expression, asClosure: boolean): void => {
    const t =
      asClosure && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
        ? compileArrowAsClosure(ctx, fctx, arg)
        : compileExpression(ctx, fctx, arg, ext);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, ext);
  };
  fctx.body.push({ op: "local.get", index: recvExtLocal });
  for (let i = 0; i < 3; i++) {
    const arg = args[i];
    if (arg === undefined) fctx.body.push({ op: "ref.null.extern" });
    else pushArg(arg, callbackInSlot0 && i === 0);
  }
  for (let i = 3; i < args.length; i++) {
    pushArg(args[i]!, false);
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: args.length }, { op: "call", funcIdx: helperIdx });
  const out = allocLocal(fctx, `__tadp_out_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: out });
  return out;
}

/** Does a native dyn-view helper exist (or can it be minted) for `method`? */
export function hasTaDynProtoMethodHelper(method: string): boolean {
  return (
    SEARCH_METHODS.has(method) || ITERATOR_METHODS.has(method) || method === "subarray" || PRODUCER_METHODS.has(method)
  );
}

/**
 * (#6651 RS1) §23.2.3.30 `%TypedArray%.prototype.subarray` over a
 * `$__ta_dyn_view`, for the receiver shapes the CALL-SITE two-arm cannot serve.
 *
 * ## Why a ladder helper when a two-arm already exists
 *
 * `array-methods.ts::emitDynViewSpeciesMethodTwoArm` already implements the
 * species-aware version, and it stays the path for every receiver it can take.
 * Its gate requires the receiver to be a plain IDENTIFIER, and that requirement
 * is not incidental: three of its four members (`map`/`filter`/`slice`) work by
 * temporarily rebinding that identifier in `fctx.localMap` to the materialized
 * f64 vec and RE-COMPILING the same call AST, which has nothing to rebind when
 * the receiver is an expression. So
 *
 * ```js
 * new TA(4).subarray(2)        // test262's spelling — a NewExpression receiver
 * ```
 *
 * declined the two-arm and fell through to the generic externref path, which
 * answers **null**. Measured on this branch's base, standalone, `TA` arriving as
 * a parameter: `var a = new TA(4); a.subarray(2)` → a length-2 view (the two-arm
 * fires), while `new TA(4).subarray(2)` and `(new TA(4)).subarray(2)` → `null`.
 *
 * That null is what the three `TypedArrayConstructors/internals/OwnPropertyKeys/*`
 * rows actually fail on. Their reported error is
 * `TypeError: Reflect.ownKeys called on non-object` and the plan file recorded
 * the cause as `emitNativeReflectTargetGuard` refusing a dyn view plus a missing
 * integer-index enumeration — **two fixes for three rows**. Re-probed here:
 * `Reflect.ownKeys(new TA([42,42,42]))` already answers `["0","1","2"]`, and with
 * two string expandos already answers `["0","1","2","test262","ecma262"]` in
 * creation order. The `non-object` receiver is `sample3 = new TA(4).subarray(2)`,
 * i.e. `Reflect.ownKeys(null)`. One fix, and it is not in `Reflect`.
 *
 * ## Shape
 *
 * `subarray` is the one member of the species four that the two-arm serves
 * WITHOUT the identifier rebind — it copies nothing, it just re-windows the
 * backing buffer — so the helper is the same arithmetic against the same fields:
 * `length = max(end - begin, 0)`, `buf` shared by reference, `byteOffset`
 * advanced by `begin * elementSize`, `kind` inherited. §23.2.4.4 is deliberately
 * NOT run (see `TA_DYN_VALIDATE_METHOD_NAMES`: `subarray/detached-buffer.js`
 * asserts it does not throw), and `expando`/`constructProto` start null because
 * the new view is a fresh object with no own non-index properties.
 *
 * ## Two documented residuals, both "still absent", never "now wrong"
 *
 * - **No SpeciesConstructor.** The helper builds the intrinsic view directly.
 *   Rows that install `@@species` and call `subarray` use the identifier
 *   spelling, so they keep the two-arm's species path; a non-identifier receiver
 *   went from `null` to the default-species answer.
 * - **No `emitSymbolIndexArgThrow`.** That §7.1.4 guard lives at the call site,
 *   where the static type of the argument is known; here a Symbol index coerces
 *   through the shared f64 path. Same reasoning: the rows that measure it
 *   (`subarray/return-abrupt-from-*-symbol.js`) use an identifier receiver.
 */
function ensureTaDynSubarrayHelper(ctx: CodegenContext): number | undefined {
  const helperName = "__ta_dyn_subarray";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const dynIdx = getOrRegisterTaDynViewType(ctx);
  if (dynIdx < 0) return undefined;
  const byteVecIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  if (byteVecIdx < 0) return undefined;

  const fctx = makeTaDynHelperFctx(helperName, [
    { name: "recv", type: { kind: "externref" } },
    { name: "begin", type: { kind: "externref" } },
    { name: "end", type: { kind: "externref" } },
    { name: "unused", type: { kind: "externref" } },
    { name: "argc", type: { kind: "i32" } },
  ]);

  // Dependencies first, while a late import can still shift indices.
  ensureObjectRuntime(ctx);
  flushLateImportShifts(ctx, fctx);
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");

  const params: ValType[] = [
    { kind: "externref" },
    { kind: "externref" },
    { kind: "externref" },
    { kind: "externref" },
    { kind: "i32" },
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], "$ta_dyn_subarray_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const dvLocal = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const lenLocal = allocLocal(fctx, "len", { kind: "i32" });
  const lenF64 = allocLocal(fctx, "lenF64", { kind: "f64" });
  const scratch = allocLocal(fctx, "scratch", { kind: "f64" });
  const beginLocal = allocLocal(fctx, "beginIdx", { kind: "i32" });
  const endLocal = allocLocal(fctx, "endIdx", { kind: "i32" });
  const countLocal = allocLocal(fctx, "count", { kind: "i32" });

  pushTaDynMethodPreamble(ctx, fctx, dynIdx, dvLocal, kindLocal, esLocal, lenLocal);
  fctx.body.push({ op: "local.get", index: lenLocal }, { op: "f64.convert_i32_s" }, { op: "local.set", index: lenF64 });

  // step 4-5: relativeStart = ToIntegerOrInfinity(start), clamped into [0, len].
  // An ABSENT argument is `0` (§23.2.3.30 step 4 reads the omitted parameter as
  // undefined → ToIntegerOrInfinity → 0), which is what the shared resolver
  // answers for a null/undefined externref, so no `argc` arm is needed here.
  pushTaDynRelativeIndex(ctx, fctx, 1, beginLocal, scratch, lenF64);

  // step 6-7: `end` UNDEFINED (absent or explicit) means `len`, NOT 0 — the one
  // place the two arguments differ, and the reason `argc` is in the ABI.
  const endAbsent: Instr[] = [
    { op: "local.get", index: lenLocal },
    { op: "local.set", index: endLocal },
  ];
  const resolveEnd: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.body = resolveEnd;
    pushTaDynRelativeIndex(ctx, fctx, 2, endLocal, scratch, lenF64);
    fctx.body = saved;
  }
  fctx.body.push(
    { op: "local.get", index: 4 },
    { op: "i32.const", value: 2 },
    { op: "i32.lt_s" },
    ...(nullishToNullIdx === undefined
      ? ([] satisfies Instr[])
      : ([
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: nullishToNullIdx },
          { op: "ref.is_null" },
          { op: "i32.or" },
        ] satisfies Instr[])),
    { op: "if", blockType: { kind: "empty" }, then: endAbsent, else: resolveEnd },
  );

  // step 8: newLength = max(end - begin, 0)
  fctx.body.push(
    { op: "local.get", index: endLocal },
    { op: "local.get", index: beginLocal },
    { op: "i32.sub" },
    { op: "local.set", index: countLocal },
    { op: "local.get", index: countLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: countLocal },
      ],
    },
  );

  // view = { length: count, buf: <shared>, byteOffset: off + begin*es, kind,
  //          expando: null, constructProto: null }
  fctx.body.push(
    { op: "local.get", index: countLocal },
    { op: "local.get", index: dvLocal },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
    { op: "local.get", index: dvLocal },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 },
    { op: "local.get", index: beginLocal },
    { op: "local.get", index: esLocal },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.get", index: kindLocal },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: dynIdx },
    { op: "extern.convert_any" },
  );

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
 * (#6769 S4) §23.2.3.27 `%TypedArray%.prototype.slice(start, end)` over a
 * `$__ta_dyn_view`, on the LIVE receiver — see the producer notes in
 * `ta-hof-map-filter.ts`.
 *
 * ValidateTypedArray → `start`/`end` (ToIntegerOrInfinity, relative, clamped;
 * an `undefined` end — absent or explicit — is `len`) → A =
 * TypedArraySpeciesCreate(O, «count») → when `count > 0`: re-validate O (the
 * species constructor may have detached it), clamp `end` to the current
 * length, then copy. A same-kind dyn-view result takes the spec's FORWARD
 * byte-by-byte copy — which is what makes a species result over O's own buffer
 * at a higher offset read `[20, 20, 20, 60]` (the copy re-reads bytes it has
 * just written) and what `array.copy`'s memmove semantics would get wrong; any
 * other result takes the element loop `Set(A, n, Get(O, k))`.
 */
function ensureTaDynSliceHelper(ctx: CodegenContext): number | undefined {
  const helperName = "__ta_dyn_slice";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  if (ensureLateImport(ctx, "__extern_is_undefined", [ext], [i32]) === undefined) return undefined;
  const kit = beginTaDynProducer(ctx, helperName, ["start", "end", "unused"]);
  if (kit === undefined) return undefined;
  const { fctx, dynIdx, dv, es, len } = kit;
  const { vecTypeIdx: byteVecIdx, arrTypeIdx: byteArrIdx } = i32ByteVec(ctx);
  const f64: ValType = { kind: "f64" };
  const lenF64 = allocLocal(fctx, "lenF64", f64);
  const scratch = allocLocal(fctx, "scratch", f64);
  const start = allocLocal(fctx, "startIdx", i32);
  const end = allocLocal(fctx, "endIdx", i32);
  const count = allocLocal(fctx, "count", i32);
  const countBox = allocLocal(fctx, "countBox", ext);
  const n = allocLocal(fctx, "n", i32);
  const resDv = allocLocal(fctx, "resDv", { kind: "ref_null", typeIdx: dynIdx });
  const src = allocLocal(fctx, "srcByte", i32);
  const dst = allocLocal(fctx, "dstByte", i32);
  const limit = allocLocal(fctx, "limitByte", i32);
  const srcArr = allocLocal(fctx, "srcArr", { kind: "ref_null", typeIdx: byteArrIdx });
  const dstArr = allocLocal(fctx, "dstArr", { kind: "ref_null", typeIdx: byteArrIdx });
  const clampNonNeg = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: local },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "select" },
    { op: "local.set", index: local },
  ];
  const countFromBounds: Instr[] = [
    { op: "local.get", index: end },
    { op: "local.get", index: start },
    { op: "i32.sub" },
    { op: "local.set", index: count },
    ...clampNonNeg(count),
  ];

  fctx.body.push({ op: "local.get", index: len }, { op: "f64.convert_i32_s" }, { op: "local.set", index: lenF64 });
  pushTaDynRelativeIndex(ctx, fctx, 1, start, scratch, lenF64);
  const resolveEnd: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.body = resolveEnd;
    pushTaDynRelativeIndex(ctx, fctx, 2, end, scratch, lenF64);
    fctx.body = saved;
  }
  fctx.body.push(
    { op: "local.get", index: 4 },
    { op: "i32.const", value: 2 },
    { op: "i32.lt_s" },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined")! },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: len },
        { op: "local.set", index: end },
      ],
      else: resolveEnd,
    },
    ...countFromBounds,
    { op: "local.get", index: count },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: kit.boxNum },
    { op: "local.set", index: countBox },
  );
  const result = emitTaDynSpeciesCreate(ctx, fctx, { dvLocal: dv, argLocals: [countBox], requestedLengthLocal: count });
  if (result === null) return undefined;

  // count > 0: re-validate, re-clamp, copy.
  const copy: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.savedBodies.push(saved);
    fctx.body = copy;
    emitTaDynViewValidate(ctx, fctx, dv);
    pushTaDynViewInBoundsLen(ctx, fctx, dv, es);
    fctx.body = saved;
    fctx.savedBodies.pop();
  }
  const byteLoopBody: Instr[] = [
    { op: "local.get", index: dstArr },
    { op: "ref.as_non_null" },
    { op: "local.get", index: dst },
    { op: "local.get", index: srcArr },
    { op: "ref.as_non_null" },
    { op: "local.get", index: src },
    { op: "array.get_u", typeIdx: byteArrIdx },
    { op: "array.set", typeIdx: byteArrIdx },
    { op: "local.get", index: src },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: src },
    { op: "local.get", index: dst },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: dst },
  ];
  const byteCopy: Instr[] = [
    { op: "local.get", index: dv },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 },
    { op: "local.get", index: start },
    { op: "local.get", index: es },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.set", index: src },
    { op: "local.get", index: resDv },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 },
    { op: "local.tee", index: dst },
    { op: "local.get", index: count },
    { op: "local.get", index: es },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.set", index: limit },
    { op: "local.get", index: dv },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
    { op: "struct.get", typeIdx: byteVecIdx, fieldIdx: 1 },
    { op: "local.set", index: srcArr },
    { op: "local.get", index: resDv },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
    { op: "struct.get", typeIdx: byteVecIdx, fieldIdx: 1 },
    { op: "local.set", index: dstArr },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: dst },
            { op: "local.get", index: limit },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...byteLoopBody,
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
  const elementCopy: Instr[] = taDynCountedLoop(
    n,
    count,
    taDynResultStoreInstrs(kit, result, n, [
      { op: "local.get", index: 0 },
      { op: "local.get", index: start },
      { op: "local.get", index: n },
      { op: "i32.add" },
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: kit.getElem },
    ]),
  );
  copy.push(
    { op: "local.set", index: len },
    { op: "local.get", index: end },
    { op: "local.get", index: len },
    { op: "local.get", index: end },
    { op: "local.get", index: len },
    { op: "i32.lt_s" },
    { op: "select" },
    { op: "local.set", index: end },
    ...countFromBounds,
    // same-kind dyn-view result → the spec's forward byte copy
    { op: "local.get", index: result },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dynIdx },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: result },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: dynIdx },
        { op: "local.tee", index: resDv },
        { op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 },
        { op: "local.get", index: kit.kind },
        { op: "i32.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "if", blockType: { kind: "empty" }, then: byteCopy, else: elementCopy },
  );
  fctx.body.push(
    { op: "local.get", index: count },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "if", blockType: { kind: "empty" }, then: copy },
  );
  return finishTaDynProducer(ctx, kit, result);
}

/**
 * (#6769 S6) §23.2.3.29 `%TypedArray%.prototype.sort(comparefn)` over a
 * `$__ta_dyn_view`.
 *
 * The receiver used to fall to the dispatcher's generic `$__vec_base` arm — an
 * ARRAY sort: the default comparator compared the ToString forms (`[20, 100,
 * 3]` → `[100, 20, 3]`, and `-0`/`+0` kept input order), and a comparator's
 * object result became NaN without ever running its `@@toPrimitive`.
 *
 * Steps, in order: (1) a present, non-`undefined`, non-callable `comparefn`
 * throws TypeError — BEFORE ValidateTypedArray; (3) ValidateTypedArray; then
 * SortIndexedProperties: read every element once (the f64 snapshot), sort it
 * with the stable merge sort, and write each value back through the element
 * setter. §23.2.4.7 TypedArraySortCompare with no comparator: numeric order,
 * `-0` before `+0`, NaN last; with one: `ToNumber(Call(comparefn, undefined,
 * «x, y»))`, NaN as `+0`. The write-back is `! Set(obj, j, v)`, which is a
 * no-op on an index the comparator invalidated — a comparator that detaches
 * the buffer makes `sort` return normally (`sort-tonumber.js`).
 */
function ensureTaDynSortHelper(ctx: CodegenContext): number | undefined {
  const helperName = "__ta_dyn_sort";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  if (ensureLateImport(ctx, "__extern_is_undefined", [ext], [i32]) === undefined) return undefined;
  const kit = beginTaDynProducer(ctx, helperName, ["comparefn", "unused1", "unused2"], false);
  if (kit === undefined) return undefined;
  const { fctx, dv } = kit;
  const applyClosureIdx = ctx.funcMap.get("__apply_closure")!;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;
  const hasCmp = allocLocal(fctx, "hasCmp", i32);
  const x = allocLocal(fctx, "x", f64);
  const y = allocLocal(fctx, "y", f64);
  const args = allocLocal(fctx, "args", ext);
  const j = allocLocal(fctx, "j", i32);
  const n = allocLocal(fctx, "n", i32);

  // step 1: comparefn is not undefined and not callable → TypeError.
  const throwArm: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.savedBodies.push(saved);
    fctx.body = throwArm;
    emitThrowTypeError(ctx, fctx, "TypeError: %TypedArray%.prototype.sort: comparefn is not a function");
    fctx.body = saved;
    fctx.savedBodies.pop();
  }
  fctx.body.push(
    { op: "local.get", index: 4 },
    { op: "i32.const", value: 1 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined")! },
        { op: "i32.eqz" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "local.tee", index: hasCmp },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: ctx.funcMap.get("__typeof_function")! },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwArm },
      ],
    },
  );
  // step 3: ValidateTypedArray; step 7: read every element once.
  emitTaDynViewValidate(ctx, fctx, dv);
  const f64VecIdx = emitTaDynViewToVec(ctx, fctx, dv);
  const f64ArrIdx = getArrTypeIdxFromVec(ctx, f64VecIdx);
  const vec = allocLocal(fctx, "vec", { kind: "ref", typeIdx: f64VecIdx });
  const data = allocLocal(fctx, "data", { kind: "ref_null", typeIdx: f64ArrIdx });
  fctx.body.push(
    { op: "local.tee", index: vec },
    { op: "struct.get", typeIdx: f64VecIdx, fieldIdx: 0 },
    { op: "local.set", index: n },
    { op: "local.get", index: vec },
    { op: "struct.get", typeIdx: f64VecIdx, fieldIdx: 1 },
    { op: "local.set", index: data },
  );
  const signBit = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "i64.reinterpret_f64" },
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" },
  ];
  // §23.2.4.7 with no comparator, as `cmp(x, y) > 0`.
  const defaultGt: Instr[] = [
    { op: "local.get", index: x },
    { op: "local.get", index: x },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      // x is NaN: > 0 unless y is NaN too.
      then: [{ op: "local.get", index: y }, { op: "local.get", index: y }, { op: "f64.eq" }],
      else: [
        { op: "local.get", index: x },
        { op: "local.get", index: y },
        { op: "f64.gt" },
        // x == y == 0 with x = +0 and y = -0
        { op: "local.get", index: x },
        { op: "local.get", index: y },
        { op: "f64.eq" },
        ...signBit(y),
        { op: "i32.and" },
        ...signBit(x),
        { op: "i32.eqz" },
        { op: "i32.and" },
        { op: "i32.or" },
      ],
    },
  ];
  // ToNumber through the coercion engine (ToPrimitive hint "number", then the
  // unbox) — the comparator's object result must run its `@@toPrimitive`.
  const toNumber: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.savedBodies.push(saved);
    fctx.body = toNumber;
    coerceType(ctx, fctx, ext, f64);
    fctx.body = saved;
    fctx.savedBodies.pop();
  }
  // ToNumber(Call(comparefn, undefined, «x, y»)) > 0 — NaN compares false.
  const comparatorGt: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.tee", index: args },
    { op: "local.get", index: x },
    { op: "call", funcIdx: kit.boxNum },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: args },
    { op: "local.get", index: y },
    { op: "call", funcIdx: kit.boxNum },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: 1 },
    ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" as const }]),
    { op: "local.get", index: args },
    { op: "call", funcIdx: applyClosureIdx },
    ...toNumber,
    { op: "f64.const", value: 0 },
    { op: "f64.gt" },
  ];
  emitStableMergeSort(fctx, {
    arrTypeIdx: f64ArrIdx,
    getOp: "array.get",
    dataLocal: data,
    lenLocal: n,
    buildCompareGtZero: (pushLeft, pushRight) => [
      ...pushLeft,
      { op: "local.set", index: x },
      ...pushRight,
      { op: "local.set", index: y },
      { op: "local.get", index: hasCmp },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: comparatorGt.map((i) => ({ ...i })),
        else: defaultGt.map((i) => ({ ...i })),
      },
    ],
  });
  // step 8: `! Set(obj, j, sortedList[j], true)` — silently skipped on an
  // index the comparator made invalid.
  fctx.body.push(
    ...taDynCountedLoop(j, n, [
      { op: "local.get", index: 0 },
      { op: "local.get", index: j },
      { op: "f64.convert_i32_s" },
      { op: "local.get", index: data },
      { op: "ref.as_non_null" },
      { op: "local.get", index: j },
      { op: "array.get", typeIdx: f64ArrIdx },
      { op: "call", funcIdx: kit.boxNum },
      { op: "call", funcIdx: kit.setElem },
      { op: "drop" },
    ]),
  );
  return finishTaDynProducer(ctx, kit, 0);
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
  // (#6651 V3) the snapshot vec carries the view, so `__iterator_next` can
  // throw once the buffer is detached mid-iteration (§23.1.5.2.1 step 6.b).
  const taIterVecIdx = getOrRegisterTaIterVecType(ctx, canonVecTypeIdx, canonArrTypeIdx, dynIdx);
  fctx.body.push({ op: "i32.const", value: ITER_KIND_VEC });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: outLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.new", typeIdx: taIterVecIdx });
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
