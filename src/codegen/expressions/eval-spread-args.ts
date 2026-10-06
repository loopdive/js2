// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6774 S18) `eval(...args)` on the standalone target. §13.3.6.1 runs
// ArgumentListEvaluation — the spread's iterator is stepped to completion —
// BEFORE PerformEval sees `argList[0]`; an empty list evaluates to `undefined`.
// The direct-eval arm compiled the spread as one plain argument (the iterable
// itself) and never stepped it. A non-constant source has no caller-scope
// splice, so a non-empty list evaluates the first element through the runtime
// eval route (the caller-environment half is #4238 / #5271).
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "../shared.js";
// Late-bound: direct imports of these owners would close an import cycle (#6797).
import {
  emitStandaloneIndirectEvalRuntime,
  emitUndefined,
  ensureNativeArrayFromIterN,
  ensureObjVecBuilders,
} from "../registry/expression-helper-delegates.js";

export function tryCompileStandaloneEvalSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone || !call.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  const ext: ValType = { kind: "externref" };
  const toArray = ensureNativeArrayFromIterN(ctx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  ensureLateImport(ctx, "__extern_length", [ext], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__extern_get_idx", [ext, { kind: "f64" }], [ext]);
  flushLateImportShifts(ctx, fctx);
  // argv = [...a0, b, ...] built in source order (§13.3.8.1).
  const argv = allocLocal(fctx, `__evspread_argv_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? newIdx }, { op: "local.set", index: argv });
  const len = allocLocal(fctx, `__evspread_len_${fctx.locals.length}`, { kind: "f64" });
  for (const arg of call.arguments) {
    const src = ts.isSpreadElement(arg) ? arg.expression : arg;
    const t = compileExpression(ctx, fctx, src);
    if (t === null || t === undefined) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, ext);
    if (!ts.isSpreadElement(arg)) {
      const one = allocLocal(fctx, `__evspread_one_${fctx.locals.length}`, ext);
      fctx.body.push(
        { op: "local.set", index: one },
        { op: "local.get", index: argv },
        { op: "local.get", index: one },
      );
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx });
      continue;
    }
    // Step the iterable to completion, then append its values.
    const items = allocLocal(fctx, `__evspread_items_${fctx.locals.length}`, ext);
    const i = allocLocal(fctx, `__evspread_i_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "f64.const", value: Infinity });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__array_from_iter_n") ?? toArray });
    fctx.body.push({ op: "local.tee", index: items });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length")! }, { op: "local.set", index: len });
    fctx.body.push({ op: "f64.const", value: 0 }, { op: "local.set", index: i });
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "local.get", index: len },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: argv },
            { op: "local.get", index: items },
            { op: "local.get", index: i },
            { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx")! },
            { op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx },
            { op: "local.get", index: i },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
  }
  // argList empty → undefined; else PerformEval(argList[0]).
  const first = allocLocal(fctx, `__evspread_first_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.get", index: argv }, { op: "call", funcIdx: ctx.funcMap.get("__extern_length")! });
  fctx.body.push({ op: "f64.const", value: 0 }, { op: "f64.eq" });
  const saved = fctx.body;
  fctx.body = [];
  emitUndefined(ctx, fctx);
  const thenArm = fctx.body;
  fctx.body = [
    { op: "local.get", index: argv },
    { op: "f64.const", value: 0 },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx")! },
    { op: "local.set", index: first },
  ];
  const evalType = emitStandaloneIndirectEvalRuntime(ctx, fctx, [], first);
  if (evalType === undefined) fctx.body.push({ op: "local.get", index: first });
  const elseArm = fctx.body;
  fctx.body = saved;
  fctx.body.push({ op: "if", blockType: { kind: "val", type: ext }, then: thenArm, else: elseArm });
  return ext;
}

/** (#6774 S18) A spread EXTRA argument of a folded eval: step its iterator to completion, keep nothing. */
export function emitDiscardedSpreadArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.SpreadElement): void {
  const toArray = ensureNativeArrayFromIterN(ctx);
  flushLateImportShifts(ctx, fctx);
  const t = compileExpression(ctx, fctx, arg.expression);
  if (t === null || t === undefined) fctx.body.push({ op: "ref.null.extern" });
  else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  fctx.body.push({ op: "f64.const", value: Infinity });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__array_from_iter_n") ?? toArray }, { op: "drop" });
}
