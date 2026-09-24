// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { emitMicrotaskEnqueue, ensureMicrotaskQueue, getOrInitState } from "../async-scheduler.js";
import { runtimeEvalStateMayShadowBinding } from "../direct-eval-environment.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { emitThrowTypeError } from "../js-errors.js";
import { reserveApplyClosure } from "../object-runtime.js";
import { compileExpression, VOID_RESULT, type InnerResult } from "../shared.js";
import { resolvesToAmbientGlobal } from "./non-constructable.js";

const WRAPPER_NAME = "__queue_microtask_dyn";

/**
 * The shared `$__mt_func_type` job for a queued callback:
 * `(caps = the callback value, value = unused) -> externref`, invoking the
 * callback with `this = undefined` and no arguments through the
 * `__apply_closure` arity bridge. Registered once per module.
 */
function ensureQueueMicrotaskWrapper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(WRAPPER_NAME);
  if (existing !== undefined) return existing;
  ensureMicrotaskQueue(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: WRAPPER_NAME,
    typeIdx: getOrInitState(ctx).microtaskFuncTypeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.null.extern" }, // this = undefined
      { op: "ref.null.extern" }, // no arguments
      { op: "call", funcIdx: applyIdx },
      { op: "drop" },
      { op: "ref.null.extern" },
    ],
    exported: false,
  });
  ctx.funcMap.set(WRAPPER_NAME, funcIdx);
  return funcIdx;
}

/**
 * (#6664) `queueMicrotask(callback)` in a host-free standalone module.
 *
 * The lib.dom declaration used to lower every call to an `env.queueMicrotask`
 * import (a standalone binary may import nothing). The module already owns a
 * microtask queue — the one native Promise reactions run on, drained by the
 * exported `__drain_microtasks` — so the callback is enqueued there, as a
 * runtime VALUE: react passes its own parameter
 * (`queueMicrotask(function () { return queueMicrotask(callback); })`), which
 * no static closure analysis can resolve.
 *
 * With no argument the WebIDL callback conversion throws a TypeError; extra
 * arguments are evaluated and ignored.
 */
export function tryStandaloneQueueMicrotaskCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.standalone || ctx.standaloneGlobalThisImport !== undefined) return undefined;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "queueMicrotask") return undefined;
  if (fctx.localMap.has(callee.text) || runtimeEvalStateMayShadowBinding(ctx, fctx, callee.text)) return undefined;
  if (!resolvesToAmbientGlobal(ctx, callee)) return undefined;

  const [callback, ...rest] = expr.arguments;
  if (callback === undefined) {
    emitThrowTypeError(ctx, fctx, "queueMicrotask requires a callback argument");
    return VOID_RESULT;
  }
  // Arguments evaluate left to right before the job is queued.
  compileExpression(ctx, fctx, callback, { kind: "externref" });
  const callbackLocal = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: callbackLocal });
  for (const extra of rest) {
    const type = compileExpression(ctx, fctx, extra);
    if (type !== null) fctx.body.push({ op: "drop" });
  }
  const wrapperIdx = ensureQueueMicrotaskWrapper(ctx);
  emitMicrotaskEnqueue(
    ctx,
    fctx,
    [{ op: "ref.func", funcIdx: wrapperIdx }],
    [{ op: "local.get", index: callbackLocal }],
    [{ op: "ref.null.extern" }],
  );
  releaseTempLocal(fctx, callbackLocal);
  return VOID_RESULT;
}
