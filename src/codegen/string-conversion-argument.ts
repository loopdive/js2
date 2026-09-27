// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { usesHostBigIntCarrier } from "./host-bigint-carrier.js";
import { addUnionImports } from "./registry/imports.js";
import { compileExpression } from "./shared.js";

/** Compile String's operand without narrowing a proven native BigInt first. */
export function compileStringConversionArgument(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argument: ts.Expression,
): ValType | null {
  const isBigIntArg = ctx.oracle.staticJsTypeOf(argument) === "bigint";
  const hostBigIntArg = usesHostBigIntCarrier(ctx) && isBigIntArg;
  const nativeBigIntArg = ctx.standalone && ctx.nativeStrings && isBigIntArg;
  if (nativeBigIntArg) {
    // Wide lowering needs its carrier types before emission. Boxing an i64
    // afterward cannot recover the upper limbs already discarded by lowering.
    addUnionImports(ctx);
    flushLateImportShifts(ctx, fctx);
  }
  return compileExpression(ctx, fctx, argument, hostBigIntArg || nativeBigIntArg ? { kind: "externref" } : undefined);
}
