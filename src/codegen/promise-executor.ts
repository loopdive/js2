// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2959 — native `new Promise(executor)` for standalone / WASI mode.
//
// Retires the unconditional `Promise_new` host import for the executor
// pattern. In standalone/WASI mode the whole Promise carrier is already
// native ($Promise struct, __promise_resolve_value assimilation,
// __promise_reject, microtask ring, native .then/.catch). The ONE remaining
// host leak was `new Promise((resolve, reject) => …)`, which always lowered
// to `call Promise_new`.
//
// This module synthesises the two capturing settle closures (`resolve` /
// `reject`) as WasmGC values the compiled executor body can invoke through
// its normal native `call_ref` dispatch, runs the executor synchronously
// (spec: the executor runs before `new Promise` returns), and rejects on an
// executor throw-before-settle.
//
// ABI (verified against current main, 2026-07-03):
//   - The executor arrow's `resolve` / `reject` parameters are BOTH externref
//     (a Promise-executor `resolve`/`reject` is always `(value) => void`, i.e.
//     the canonical `(externref) -> ()` closure signature — the `value` param
//     is `T | PromiseLike<T>` / `any`, which always resolves to externref).
//   - Inside the executor body a call `resolve(x)` lowers (in WASI mode) to:
//       any.convert_extern; ref.test (ref $wrap); [native] struct.get 0 ->
//       ref.cast $wrapFuncType -> call_ref ; [else] throw TypeError.
//     There is NO host `__call_function` fallback under WASI (that arm is
//     gated `!ctx.standalone && !ctx.wasi`). So a `resolve`/`reject` value
//     that IS a subtype of the canonical `(externref) -> ()` wrapper struct
//     dispatches natively; anything else throws. We therefore construct the
//     settle closures as subtypes of exactly that canonical wrapper struct,
//     with one extra immutable field carrying the captured `$Promise`.

import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { compileArrowAsClosure } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import { closureBagInitInstr } from "./closures/closure-header-layout.js"; // (#4241) $bag operand
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { ensureExnTag } from "./registry/imports.js";
import { coerceType, emitGuardedFuncRefCast, pushDefaultValue } from "./type-coercion.js";
import { emitNullCheckThrow } from "./property-access.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { buildStandardTryTable } from "../ir/try-table.js";
import {
  PROMISE_STATE_PENDING,
  // (#3125) `ensurePromiseExecutorClosures` + its interface moved to
  // async-scheduler.ts: the thenable-assimilation job (built inside
  // `ensurePromiseSettleFunctions`) needs the same settle closures, and this
  // module already imports from async-scheduler (the reverse import would be
  // an eval-time cycle).
  ensurePromiseExecutorClosures,
  isStandalonePromiseActive,
} from "./async-scheduler.js";

/**
 * #2959 — Emit the native standalone `new Promise(executor)` lowering.
 *
 * Returns `true` when it emitted a native path (leaving an externref `$Promise`
 * on the stack); returns `false` — having emitted NOTHING — when the native
 * path is not applicable (host/gc mode, or a non-resolvable executor). The
 * caller must then fall through to the existing `Promise_new` host path.
 *
 * Native only under `isStandalonePromiseActive` (WASI today), so host/gc mode is
 * byte-unchanged. The executor must be a plain arrow / function expression whose
 * `ClosureInfo` we can recover; anything else returns `false` (host fallback) —
 * never a partial native path.
 */
export function emitStandalonePromiseFromExecutor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  executorArg: ts.Expression,
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;

  // Start narrow: inline arrow / (non-async, non-generator) function expression.
  // Widen to identifier-bound closures later. Anything else → host fallback.
  if (!(ts.isArrowFunction(executorArg) || ts.isFunctionExpression(executorArg))) return false;
  const isAsync = executorArg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (isAsync) return false;
  if (ts.isFunctionExpression(executorArg) && executorArg.asteriskToken !== undefined) return false;

  // Ensure the exception tag exists BEFORE compiling the executor / minting the
  // trampolines, so no later tag/import registration perturbs indices mid-emit.
  const exnTag = ensureExnTag(ctx);

  // 1. Compile the executor into a scratch buffer and recover its ClosureInfo.
  //    Kept reachable to the late-import shifter via ctx.liveBodies + the
  //    savedBodies swap (mirrors compileStandalonePromiseThenCallback).
  const execInstrs: Instr[] = [];
  ctx.liveBodies.add(execInstrs);
  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);
  fctx.body = execInstrs;
  let closureInfo: ClosureInfo | undefined;
  try {
    const type = compileArrowAsClosure(ctx, fctx, executorArg);
    if (type && (type.kind === "ref" || type.kind === "ref_null")) {
      closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
    }
    // Normalise the scratch buffer to leave the executor closure as externref.
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
  } finally {
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
  if (!closureInfo) {
    execInstrs.length = 0;
    ctx.liveBodies.delete(execInstrs);
    return false;
  }

  const closures = ensurePromiseExecutorClosures(ctx);
  if (!closures) {
    execInstrs.length = 0;
    ctx.liveBodies.delete(execInstrs);
    return false;
  }
  const { resolveClFuncIdx, rejectClFuncIdx, capTypeIdx, promiseTypeIdx, rejectFuncIdx } = closures;

  // 2. Allocate the pending $Promise: {state: PENDING, value: null, callbacks: null}.
  const pLocal = allocLocal(fctx, `__pexec_p_${fctx.locals.length}`, { kind: "ref", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: pLocal });

  // 3. Materialise resolve / reject as capturing closure VALUES (externref):
  //    struct{ func: ref.func $cl, cap_promise: p } upcast to externref.
  const emitSettleValue = (clFuncIdx: number, dst: number): void => {
    fctx.body.push({ op: "ref.func", funcIdx: clFuncIdx });
    fctx.body.push({ op: "i32.const", value: 1 }); // (#3673) $arity — settle fns take 1 arg
    fctx.body.push(closureBagInitInstr()); // (#4241) $bag
    fctx.body.push({ op: "local.get", index: pLocal });
    fctx.body.push({ op: "struct.new", typeIdx: capTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.set", index: dst });
  };
  const rvLocal = allocLocal(fctx, `__pexec_rv_${fctx.locals.length}`, { kind: "externref" });
  emitSettleValue(resolveClFuncIdx, rvLocal);
  const rjLocal = allocLocal(fctx, `__pexec_rj_${fctx.locals.length}`, { kind: "externref" });
  emitSettleValue(rejectClFuncIdx, rjLocal);

  // 4. Recover the executor closure struct from the scratch buffer (externref).
  const execLocal = allocLocal(fctx, `__pexec_fn_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: closureInfo.structTypeIdx,
  });
  for (const i of execInstrs) fctx.body.push(i);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: closureInfo.structTypeIdx });
  fctx.body.push({ op: "local.set", index: execLocal });
  ctx.liveBodies.delete(execInstrs);

  // 5. Invoke the executor synchronously inside try/catch; an executor throw
  //    before settle rejects the promise (the settle guard makes it a no-op if
  //    the executor already settled). Build the invoke into a detached tryBody.
  const reasonLocal = allocLocal(fctx, `__pexec_reason_${fctx.locals.length}`, { kind: "externref" });
  const tryBody: Instr[] = [];
  fctx.savedBodies.push(fctx.body);
  fctx.body = tryBody;
  try {
    // call_ref stack: [self, ...userArgs, funcref]
    fctx.body.push({ op: "local.get", index: execLocal });
    const paramTypes = closureInfo.paramTypes;
    for (let i = 0; i < paramTypes.length; i++) {
      const pType = paramTypes[i]!;
      if (i === 0 || i === 1) {
        // param 0 = resolve, param 1 = reject (both externref in practice).
        fctx.body.push({ op: "local.get", index: i === 0 ? rvLocal : rjLocal });
        if (pType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, pType);
      } else {
        // Executors never declare >2 params in practice; pad defensively.
        pushDefaultValue(fctx, pType, ctx);
      }
    }
    fctx.body.push({ op: "local.get", index: execLocal });
    fctx.body.push({ op: "struct.get", typeIdx: closureInfo.structTypeIdx, fieldIdx: 0 });
    emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    if (closureInfo.returnType !== null) fctx.body.push({ op: "drop" });
  } finally {
    fctx.body = fctx.savedBodies.pop()!;
  }

  fctx.body.push(
    buildStandardTryTable({ kind: "empty" }, tryBody, [
      {
        kind: "catch",
        tagIdx: exnTag,
        payloadType: { kind: "externref" },
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: pLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: rejectFuncIdx },
          { op: "drop" },
        ],
      },
    ]),
  );

  // 6. Result: the pending/settled $Promise as externref.
  fctx.body.push({ op: "local.get", index: pLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return true;
}

/**
 * #2903 R1 — native standalone `new Promise(executorVALUE)` where the executor
 * is NOT a syntactic inline arrow/function-expression (an identifier / param /
 * any runtime closure value), so {@link emitStandalonePromiseFromExecutor}'s
 * `ClosureInfo`-based `call_ref` cannot apply. Instead of recovering the
 * executor's concrete closure struct type at compile time, we invoke the
 * runtime value through the open-`any` closure bridge `__apply_closure(exec,
 * undefined, [resolve, reject])` (arity-clamping per #2939), which dispatches
 * ANY closure struct shape natively — retiring the `Promise_new` +
 * `__make_callback` host leak for `function make(ex){ return new Promise(ex); }`
 * and `const ex = (r)=>r(x); new Promise(ex)` shapes.
 *
 * `compileExecutorValue` is a caller-provided thunk that leaves the executor as
 * an externref on `fctx.body` (kept as a callback to avoid an eval-time import
 * cycle with expressions.ts). Returns `true` having emitted the native path
 * (leaving an externref `$Promise` on the stack); `false` — emitting NOTHING —
 * when inapplicable (host/gc mode, deps unavailable), so the caller falls
 * through to the `Promise_new` host path byte-unchanged.
 *
 * BOUNDARY: a non-callable executor value is dispatched through
 * `__apply_closure` (which no-ops / returns undefined on a non-closure) rather
 * than throwing the spec §27.2.3.1-step-2 TypeError — the same no-throw
 * discipline as the other #2903 native bodies; the promise simply stays pending.
 */
export function emitStandalonePromiseFromExecutorValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  compileExecutorValue: () => void,
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;

  const exnTag = ensureExnTag(ctx);
  const closures = ensurePromiseExecutorClosures(ctx);
  if (!closures) return false;
  const { resolveClFuncIdx, rejectClFuncIdx, capTypeIdx, promiseTypeIdx, rejectFuncIdx } = closures;

  // Open-`any` closure bridge + the boxed-any args vec builders.
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (applyClosureIdx === undefined || objVecNewIdx === undefined || objVecPushIdx === undefined) return false;

  // 1. Compile the executor VALUE to externref, into a local (runs any side
  //    effects of the executor expression exactly once, before the invoke).
  const execLocal = allocLocal(fctx, `__pexecv_fn_${fctx.locals.length}`, { kind: "externref" });
  compileExecutorValue();
  fctx.body.push({ op: "local.set", index: execLocal });

  // 2. Allocate the pending $Promise.
  const pLocal = allocLocal(fctx, `__pexecv_p_${fctx.locals.length}`, { kind: "ref", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: pLocal });

  // 3. resolve / reject as capturing closure VALUES (externref), capturing p.
  const emitSettleValue = (clFuncIdx: number, dst: number): void => {
    fctx.body.push({ op: "ref.func", funcIdx: clFuncIdx });
    fctx.body.push({ op: "i32.const", value: 1 }); // (#3673) $arity — settle fns take 1 arg
    fctx.body.push(closureBagInitInstr()); // (#4241) $bag
    fctx.body.push({ op: "local.get", index: pLocal });
    fctx.body.push({ op: "struct.new", typeIdx: capTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.set", index: dst });
  };
  const rvLocal = allocLocal(fctx, `__pexecv_rv_${fctx.locals.length}`, { kind: "externref" });
  emitSettleValue(resolveClFuncIdx, rvLocal);
  const rjLocal = allocLocal(fctx, `__pexecv_rj_${fctx.locals.length}`, { kind: "externref" });
  emitSettleValue(rejectClFuncIdx, rjLocal);

  // 4. Invoke the executor synchronously via __apply_closure(exec, undefined,
  //    [resolve, reject]) inside try/catch; a throw-before-settle rejects p.
  const reasonLocal = allocLocal(fctx, `__pexecv_reason_${fctx.locals.length}`, { kind: "externref" });
  const argsLocal = allocLocal(fctx, `__pexecv_args_${fctx.locals.length}`, { kind: "externref" });
  const tryBody: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: rvLocal },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: rjLocal },
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: execLocal },
    { op: "ref.null.extern" }, // undefined `this`
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "drop" }, // executor return value is ignored (§27.2.3.1)
  ];
  fctx.body.push(
    buildStandardTryTable({ kind: "empty" }, tryBody, [
      {
        kind: "catch",
        tagIdx: exnTag,
        payloadType: { kind: "externref" },
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: pLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: rejectFuncIdx },
          { op: "drop" },
        ],
      },
    ]),
  );

  // 5. Result: the pending/settled $Promise as externref.
  fctx.body.push({ op: "local.get", index: pLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return true;
}
