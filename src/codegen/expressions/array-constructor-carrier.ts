// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared carrier decisions for the `Array(...)` and `new Array(...)` paths.
 * Keeping these small emitters out of their dispatchers preserves the
 * god-file/per-function budgets while both constructor spellings stay aligned.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "../registry/types.js";
import { compileExpression } from "../shared.js";

/** Dense Array constructors must keep an explicit null in a reference carrier. */
export function widenDenseArrayElementType(args: readonly ts.Expression[], elemWasm: ValType): ValType {
  if (args.length > 1 && elemWasm.kind !== "externref" && args.some((arg) => arg.kind === ts.SyntaxKind.NullKeyword)) {
    return { kind: "externref" };
  }
  return elemWasm;
}

/** Emit the one-element constructor form without narrowing a known ref to null. */
export function compileOneElementArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  elemWasm: ValType,
  vecTypeIdx: number,
): ValType {
  const typedReferenceElement = elemWasm.kind === "ref" || elemWasm.kind === "ref_null";
  const oneVecIdx = typedReferenceElement
    ? vecTypeIdx
    : elemWasm.kind === "externref"
      ? vecTypeIdx
      : getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const oneArrIdx = getArrTypeIdxFromVec(ctx, oneVecIdx);
  compileExpression(ctx, fctx, arg, typedReferenceElement ? elemWasm : { kind: "externref" });
  fctx.body.push({ op: "array.new_fixed", typeIdx: oneArrIdx, length: 1 });
  const oneData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: oneArrIdx });
  fctx.body.push({ op: "local.set", index: oneData });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.get", index: oneData });
  fctx.body.push({ op: "struct.new", typeIdx: oneVecIdx });
  return { kind: "ref_null", typeIdx: oneVecIdx };
}
