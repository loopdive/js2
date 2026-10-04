// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6774 S15) A bare CALL `f(args)` whose name resolves through a `with`
// object environment. The identifier READ consults `resolveWithBinding`, but
// the call lowering never did: `with (obj) { method(); }` threw
// "method is not defined". §13.3.6.1 + §9.1.1.2.10 WithBaseObject: when the
// binding lives on the with-object, that object is the call's `this`.
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { coerceType, compileExpression } from "../shared.js";
// Late-bound: direct imports of these owners would close an import cycle (#6797).
import {
  emitCaptureWithHasBinding,
  emitUndefined,
  ensureObjVecBuilders,
  reserveApplyClosure,
  resolveWithBinding,
} from "../registry/expression-helper-delegates.js";

export function tryCompileWithRoutedCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone || !ts.isIdentifier(call.expression)) return undefined;
  if (call.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  const res = resolveWithBinding(fctx, call.expression.text);
  if (res === null) return undefined;
  const ext: ValType = { kind: "externref" };
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  // Reference resolution (HasBinding) precedes GetValue and the arguments.
  const recv = allocLocal(fctx, `__with_call_recv_${fctx.locals.length}`, ext);
  if (res.kind === "dynamic") {
    const has = emitCaptureWithHasBinding(ctx, fctx, res.scope, call.expression.text);
    const saved = fctx.body;
    fctx.body = [];
    emitUndefined(ctx, fctx);
    const absent = fctx.body;
    fctx.body = saved;
    fctx.body.push(
      { op: "local.get", index: has },
      {
        op: "if",
        blockType: { kind: "val", type: ext },
        then: [{ op: "local.get", index: res.scope.localIdx }],
        else: absent,
      },
    );
  } else {
    fctx.body.push({ op: "local.get", index: res.binding.scope.localIdx }, { op: "extern.convert_any" });
  }
  fctx.body.push({ op: "local.set", index: recv });
  const fnType = compileExpression(ctx, fctx, call.expression);
  if (fnType === null || fnType === undefined) fctx.body.push({ op: "ref.null.extern" });
  else if (fnType.kind !== "externref") coerceType(ctx, fctx, fnType, ext);
  const fn = allocLocal(fctx, `__with_call_fn_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: fn });
  const argv = allocLocal(fctx, `__with_call_argv_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? newIdx }, { op: "local.set", index: argv });
  for (const arg of call.arguments) {
    fctx.body.push({ op: "local.get", index: argv });
    const t = compileExpression(ctx, fctx, arg);
    if (t === null || t === undefined) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, ext);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx });
  }
  fctx.body.push(
    { op: "local.get", index: fn },
    { op: "local.get", index: recv },
    { op: "local.get", index: argv },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  );
  return ext;
}
