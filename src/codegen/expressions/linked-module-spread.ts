// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureNativeStrictSpreadRuntime } from "../iterator-native.js";
import { coerceType } from "../shared.js";
import { flushLateImportShifts } from "./late-imports.js";
import { compileInternalCallArgument } from "./internal-call-argument.js";

/** Materialize each spread before evaluating the next argument. All scratch
 * values are local, so nested calls cannot overwrite a partially built argv. */
export function emitLinkedModuleSpreadArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argumentsList: readonly ts.Expression[],
  argv: number,
): void {
  ensureNativeStrictSpreadRuntime(ctx);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! }, { op: "local.set", index: argv });
  for (const argument of argumentsList) {
    const spread = ts.isSpreadElement(argument);
    const value = spread ? argument.expression : argument;
    const type = compileInternalCallArgument(ctx, fctx, value, { kind: "externref" }, spread);
    if (type === null) throw new Error("Linked module spread argument could not be compiled");
    if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
    const items = allocLocal(fctx, "linkedSpreadItems", { kind: "externref" });
    flushLateImportShifts(ctx, fctx);
    if (spread) fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__array_from_iter_strict_native")! });
    fctx.body.push({ op: "local.set", index: items });
    if (!spread) {
      fctx.body.push(
        { op: "local.get", index: argv },
        { op: "local.get", index: items },
        { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
      );
      continue;
    }
    const index = allocLocal(fctx, "linkedSpreadIndex", { kind: "f64" });
    const length = allocLocal(fctx, "linkedSpreadLength", { kind: "f64" });
    fctx.body.push(
      { op: "local.get", index: items },
      { op: "call", funcIdx: ctx.funcMap.get("__extern_length")! },
      { op: "local.set", index: length },
      { op: "f64.const", value: 0 },
      { op: "local.set", index },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index },
              { op: "local.get", index: length },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: argv },
              { op: "local.get", index: items },
              { op: "local.get", index },
              { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx")! },
              { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
              { op: "local.get", index },
              { op: "f64.const", value: 1 },
              { op: "f64.add" },
              { op: "local.set", index },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    );
  }
}
