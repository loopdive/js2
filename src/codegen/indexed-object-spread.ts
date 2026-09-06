// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Index signatures cannot supply a complete static CopyDataProperties list. */
export function objectLiteralHasIndexedSpread(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  return expr.properties.some((property) => {
    if (!ts.isSpreadAssignment(property)) return false;
    const type = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(property.expression));
    return type.getStringIndexType() !== undefined || type.getNumberIndexType() !== undefined;
  });
}
