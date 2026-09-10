// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./expressions.js";

/** Argument-list literals keep their supplied length, not a contextual tuple ABI. */
export function compileReflectArgumentValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  argumentList: boolean,
): ValType | null {
  const flags = ctx as unknown as { _arrayLiteralForceVec?: boolean };
  const force = argumentList && ts.isArrayLiteralExpression(arg);
  const previous = flags._arrayLiteralForceVec;
  if (force) flags._arrayLiteralForceVec = true;
  try {
    return compileExpression(ctx, fctx, arg, { kind: "externref" });
  } finally {
    if (force) flags._arrayLiteralForceVec = previous;
  }
}
