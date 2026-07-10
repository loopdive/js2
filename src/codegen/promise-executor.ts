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
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { ensureExnTag } from "./registry/imports.js";
import { coerceType, emitGuardedFuncRefCast, pushDefaultValue } from "./type-coercion.js";
import { emitNullCheckThrow } from "./property-access.js";
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

  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches: [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: pLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: rejectFuncIdx },
          { op: "drop" },
        ],
      },
    ],
  } as Instr);

  // 6. Result: the pending/settled $Promise as externref.
  fctx.body.push({ op: "local.get", index: pLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return true;
}
