// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { VOID_RESULT } from "../shared.js";
import { wasmFuncReturnsVoid, wasmFuncTypeReturnsVoid } from "./helpers.js";

function lastInstructionIsVoidCall(ctx: CodegenContext, fctx: FunctionContext, bodyLenBefore: number): boolean {
  if (fctx.body.length <= bodyLenBefore) return true;
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (!lastInstr) return false;
  if (lastInstr.op === "call") return wasmFuncReturnsVoid(ctx, lastInstr.funcIdx);
  if (lastInstr.op === "call_ref") return wasmFuncTypeReturnsVoid(ctx, lastInstr.typeIdx);
  return false;
}

/** Compile a void operand for side effects and discard a produced value. */
export function emitVoidOperandSideEffects(
  ctx: CodegenContext,
  fctx: FunctionContext,
  compile: () => InnerResult,
): void {
  const bodyLenBefore = fctx.body.length;
  const operandType = compile();
  if (operandType !== null && operandType !== VOID_RESULT && !lastInstructionIsVoidCall(ctx, fctx, bodyLenBefore)) {
    fctx.body.push({ op: "drop" });
  }
}
