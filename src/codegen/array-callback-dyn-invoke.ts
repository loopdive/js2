// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6690 — signature-agnostic invocation of a DYNAMIC array-method callback on
 * the host-free lanes (`--target standalone` / `wasi`).
 *
 * A callback that compiles to an opaque `externref` (a variable, a parameter,
 * an import) is recovered by `resolveDynamicCallbackClosure`
 * (`array-methods.ts`, #3015) as the canonical funcref wrapper of its STATIC
 * signature, and the loop used to call it with one `call_ref` of that
 * signature. The static signature is only what the checker believes the
 * variable holds, not what the runtime value is:
 *
 * ```ts
 * function f(x: number): number { return x * 2; }       // lifted (self, f64) -> f64
 * const cb: (x: number) => number | string = f;          // static  (self, f64) -> union
 * [1, 2, 3].map(cb);                                     // funcref cast fails
 * ```
 *
 * (Same for a narrower arity `const cb: (x, i) => … = f`, a JS `let cb` that is
 * reassigned to a closure with a different return, …) The guarded funcref
 * cast nulled and the unconditional `ref.as_non_null` trapped "dereferencing a
 * null pointer" — for `map` / `forEach` / `filter` / `find*` / `some` / `every`
 * / `reduce` / `reduceRight` alike.
 *
 * The fix keeps the typed `call_ref` as the fast path when the runtime funcref
 * really has the static signature, and otherwise invokes the callback the way
 * the spec does — `Call(callbackfn, thisArg, «args»)` — through the native
 * `__apply_closure(fn, this, argsVec)` arity bridge, which dispatches on the
 * closure's ACTUAL signature and boxes the result; the result is then coerced
 * back to the static return carrier the loop consumes. The bridge also covers
 * a value that is not a wrapper-family closure at all (the struct cast is
 * guarded too), so no shape reaches a null dereference. Zero host imports.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyFromExternHelper } from "./any-helpers.js";
import { holeToUndefinedInstrs } from "./array-holes.js";
import { allocLocal } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { getClosureFuncSelfTypeIdx, getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { reserveApplyClosure } from "./object-runtime.js";
import { getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import { emitRuntimeEvalCarrierUnwrapAny } from "./runtime-eval-callable.js";
import { addUnionImportsViaRegistry, flushLateImportShifts } from "./shared.js";
import { emitToBoolean } from "./coercion-engine.js";
import { coercionInstrs, emitGuardedRefCast } from "./type-coercion.js";
import { f64HoleToUndefFor } from "./vec-f64-hole-presence.js";

/** Carrier state for the signature-agnostic fallback of one callback. */
export interface DynCallbackFallback {
  /** externref local holding the callback value exactly as the caller passed it. */
  rawTmp: number;
  /** The canonical externref vec (`__vec_externref`) the bridge reads its args from. */
  argsVecTypeIdx: number;
  argsArrTypeIdx: number;
}

/**
 * Store the externref callback on the stack as a NULLABLE wrapper-root closure
 * in a fresh local (null when the value is not a wrapper-family closure) and
 * keep the raw value for the bridge. Registers every helper the fallback arm
 * calls here, while the caller still owns `fctx.body`, so no late registration
 * fires inside the detached per-iteration instruction arrays.
 */
export function setupDynCallbackFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rootTypeIdx: number,
  tag: string,
): { closureTmp: number; fallback: DynCallbackFallback } {
  // The args carrier is the canonical externref vec `__apply_closure` reads
  // directly (#3673) — not the object runtime's `$ObjVec`, which would pull
  // the whole dynamic-object runtime into an otherwise static module.
  const argsVecTypeIdx = getOrRegisterVecType(ctx, "externref");
  const argsArrTypeIdx = getOrRegisterArrayType(ctx, "externref");
  reserveApplyClosure(ctx);
  addUnionImportsViaRegistry(ctx);
  flushLateImportShifts(ctx, fctx);
  const rawTmp = allocLocal(fctx, `__arr_${tag}_dynraw_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: rawTmp });
  fctx.body.push({ op: "any.convert_extern" });
  emitRuntimeEvalCarrierUnwrapAny(ctx, fctx);
  emitGuardedRefCast(fctx, rootTypeIdx);
  const closureTmp = allocLocal(fctx, `__arr_${tag}_dyncb_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: rootTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: closureTmp });
  return {
    closureTmp,
    fallback: { rawTmp, argsVecTypeIdx, argsArrTypeIdx },
  };
}

/**
 * The wrapper for a dynamic callback with no single static signature (an
 * `any`-typed value, an overload set): `arity` externref formals, externref
 * result. Its typed arm serves exactly that shape; anything else takes the
 * bridge, which is what makes the value callable at all on a host-free lane
 * (the alternative was the `__call_1_*` host import, which cannot bind).
 */
export function untypedDynCallbackClosure(
  ctx: CodegenContext,
  arity: number,
): { closureInfo: ClosureInfo; selfStructTypeIdx: number } | undefined {
  const externref: ValType = { kind: "externref" };
  const wrapper = getOrCreateFuncRefWrapperTypes(
    ctx,
    Array.from({ length: arity }, () => externref),
    [externref],
  );
  if (!wrapper) return undefined;
  return { closureInfo: wrapper.closureInfo, selfStructTypeIdx: wrapper.liftedSelfTypeIdx };
}

/** One spec argument: its load sequence and the carrier it leaves on the stack. */
export interface CallbackSpecArg {
  load: () => Instr[];
  type: ValType;
}

/**
 * The bridge answers a boxed externref. A union static return lowers to
 * `$AnyValue`, which a plain guarded cast would null for every boxed primitive
 * (and the loop's ToBoolean / result store would then dereference it), so it
 * is classified through the lane's `__any_from_extern` — `undefined`/`null`
 * included, which that helper boxes rather than leaving a null ref.
 */
function bridgeResultInstrs(ctx: CodegenContext, fctx: FunctionContext, ret: ValType, asBoolean: boolean): Instr[] {
  // A predicate consumer only needs ToBoolean of the real value; a numeric
  // static carrier would otherwise ToNumber a string/object result first
  // (`"yes"` → NaN → falsy).
  if (asBoolean && (ret.kind === "i32" || ret.kind === "f64")) {
    const truthy = emitToBoolean(ctx, { kind: "externref" }, []);
    return ret.kind === "f64" ? [...truthy, { op: "f64.convert_i32_u" }] : truthy;
  }
  const isAnyValue = (ret.kind === "ref" || ret.kind === "ref_null") && ret.typeIdx === ctx.anyValueTypeIdx;
  const fromExternIdx = isAnyValue ? ensureAnyFromExternHelper(ctx) : undefined;
  if (fromExternIdx === undefined || (ret.kind !== "ref" && ret.kind !== "ref_null")) {
    return coercionInstrs(ctx, { kind: "externref" }, ret, fctx);
  }
  const tmp = allocLocal(fctx, `__dyncb_ret_${fctx.locals.length}`, { kind: "externref" });
  return [
    { op: "local.tee", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ret.typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: ret.typeIdx } },
      then: [
        { op: "local.get", index: tmp },
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: ret.typeIdx },
      ],
      else: [
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: fromExternIdx },
      ],
    },
    ...(ret.kind === "ref" ? ([{ op: "ref.as_non_null" }] satisfies Instr[]) : []),
  ];
}

/**
 * `reduce` / `reduceRight` spec arguments `(accumulator, element, index,
 * array)` (§23.1.3.24 step 9.c.iii). A visited `$Hole` element reaches the
 * reducer as `undefined`, matching the typed arm.
 */
export function reduceSpecArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  accTmp: number,
  accType: ValType,
  l: { dataTmp: number; iTmp: number; vecTmp: number; getOp: "array.get" | "array.get_u" | "array.get_s" },
  arrTypeIdx: number,
  elemType: ValType,
  vecTypeIdx: number,
): CallbackSpecArg[] {
  return [
    { load: () => [{ op: "local.get", index: accTmp }], type: accType },
    {
      load: () => [
        { op: "local.get", index: l.dataTmp },
        { op: "local.get", index: l.iTmp },
        { op: l.getOp, typeIdx: arrTypeIdx },
        ...(ctx.usesArrayHoles && elemType.kind === "externref"
          ? holeToUndefinedInstrs(ctx, fctx)
          : f64HoleToUndefFor(ctx, fctx, elemType)),
      ],
      type: elemType,
    },
    { load: () => [{ op: "local.get", index: l.iTmp }], type: { kind: "i32" } },
    { load: () => [{ op: "local.get", index: l.vecTmp }], type: { kind: "ref_null", typeIdx: vecTypeIdx } },
  ];
}

/**
 * The callback invocation: `self, ...typedArgs, funcref → call_ref`, leaving
 * `closureInfo.returnType` (or nothing) on the stack. Without a `fallback` the
 * sequence is exactly the historical typed call (byte-identical output); with
 * one, a funcref of any other signature goes through `__apply_closure` with
 * the full spec argument list.
 */
export function callbackInvokeInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  p: {
    closureInfo: ClosureInfo;
    closureTypeIdx: number;
    closureTmp: number;
    typedArgs: Instr[];
    guardedCast: (funcTypeIdx: number) => Instr[];
    fallback?: DynCallbackFallback;
    specArgs?: () => CallbackSpecArg[];
    thisTmp?: number;
    /** The loop feeds the result to ToBoolean (filter / find* / some / every). */
    resultAsBoolean?: boolean;
  },
): Instr[] {
  const { closureInfo, closureTypeIdx, closureTmp, fallback } = p;
  const funcTypeIdx = closureInfo.funcTypeIdx;
  if (!fallback || !p.specArgs) {
    return [
      { op: "local.get", index: closureTmp },
      ...p.typedArgs,
      { op: "local.get", index: closureTmp },
      { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
      ...p.guardedCast(funcTypeIdx),
      { op: "ref.as_non_null" },
      { op: "call_ref", typeIdx: funcTypeIdx },
    ];
  }

  const funcTmp = allocLocal(fctx, `__dyncb_fn_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, funcTypeIdx) ?? closureTypeIdx;
  const typedArm: Instr[] = [
    { op: "local.get", index: closureTmp },
    { op: "ref.as_non_null" },
    ...(selfTypeIdx !== closureTypeIdx ? ([{ op: "ref.cast", typeIdx: selfTypeIdx }] satisfies Instr[]) : []),
    ...p.typedArgs,
    { op: "local.get", index: funcTmp },
    { op: "ref.cast", typeIdx: funcTypeIdx },
    { op: "call_ref", typeIdx: funcTypeIdx },
  ];

  const externref: ValType = { kind: "externref" };
  const specArgs = p.specArgs();
  const bridgeArm: Instr[] = [{ op: "local.get", index: fallback.rawTmp }];
  bridgeArm.push(p.thisTmp !== undefined ? { op: "local.get", index: p.thisTmp } : { op: "ref.null.extern" });
  bridgeArm.push({ op: "i32.const", value: specArgs.length });
  for (const arg of specArgs) {
    bridgeArm.push(...arg.load());
    if (arg.type.kind !== "externref") bridgeArm.push(...coercionInstrs(ctx, arg.type, externref, fctx));
  }
  bridgeArm.push(
    { op: "array.new_fixed", typeIdx: fallback.argsArrTypeIdx, length: specArgs.length },
    { op: "struct.new", typeIdx: fallback.argsVecTypeIdx },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
  );
  const ret = closureInfo.returnType;
  if (ret === null) bridgeArm.push({ op: "drop" });
  else if (ret.kind !== "externref") bridgeArm.push(...bridgeResultInstrs(ctx, fctx, ret, p.resultAsBoolean === true));

  return [
    // Typed only when the value IS a wrapper-family closure AND its funcref has
    // the static signature; everything else takes the spec `Call` bridge.
    { op: "local.get", index: closureTmp },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: closureTmp },
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
        { op: "local.tee", index: funcTmp },
        { op: "ref.test", typeIdx: funcTypeIdx },
      ],
    },
    {
      op: "if",
      blockType: ret === null ? { kind: "empty" } : { kind: "val", type: ret },
      then: typedArm,
      else: bridgeArm,
    },
  ];
}
