// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6774 S17) A tag whose closure the compiler cannot type — an IIFE result
// `(function(){ return function(){…}; })()\`…\`` — used to reach the HOST
// `__tagged_template` bridge (plus `__js_array_new`/`__js_array_push`), which a
// standalone module cannot import. Call it through the host-free
// `__apply_closure(fn, undefined, argv)` bridge instead, with argv the
// `$ObjVec` `[templateObject, ...substitutions]` (§13.3.11.1 step 4).
import type { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { coerceType, compileExpression } from "../shared.js";
// Late-bound: direct imports of these owners would close an import cycle (#6797).
import { emitUndefined, ensureObjVecBuilders, reserveApplyClosure } from "../registry/expression-helper-delegates.js";

/** Emits the call; the tag value is on the stack as externref. Returns the externref result type. */
export function emitStandaloneDynamicTagCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stringsLocal: number,
  substitutions: readonly ts.Expression[],
): ValType {
  const ext: ValType = { kind: "externref" };
  const tagLocal = allocLocal(fctx, `__tt_dyn_tag_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: tagLocal });
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const argvLocal = allocLocal(fctx, `__tt_dyn_argv_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: argvLocal });
  fctx.body.push({ op: "local.get", index: argvLocal });
  fctx.body.push({ op: "local.get", index: stringsLocal }, { op: "extern.convert_any" });
  fctx.body.push({ op: "call", funcIdx: pushIdx });
  for (const sub of substitutions) {
    fctx.body.push({ op: "local.get", index: argvLocal });
    const t = compileExpression(ctx, fctx, sub);
    if (t === null || t === undefined) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, ext);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx });
  }
  fctx.body.push({ op: "local.get", index: tagLocal });
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.get", index: argvLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
  return ext;
}
