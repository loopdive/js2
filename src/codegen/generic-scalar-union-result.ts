// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureAnyFromExternHelper } from "./any-helpers.js";

/** Recover scalar tags after a generic call's erased externref result. */
export function emitGenericScalarUnionResult(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (!ctx.nativeStrings || !ts.isCallExpression(expr)) return false;
  const signature = ctx.checker.getResolvedSignature(expr);
  if (!signature?.declaration?.typeParameters?.length) return false;
  const type = ctx.checker.getTypeAtLocation(expr);
  if (!type.isUnion()) return false;
  const scalarFlags = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike;
  if (!type.types.every((part) => (part.flags & scalarFlags) !== 0)) return false;
  // Boolean itself is true|false in the checker. Single-brand unions already
  // have a scalar ABI; only heterogeneous primitives require a tagged result.
  const brands = new Set(
    type.types.map((part) =>
      part.flags & ts.TypeFlags.StringLike ? "string" : part.flags & ts.TypeFlags.NumberLike ? "number" : "boolean",
    ),
  );
  if (brands.size < 2) return false;
  const helper = ensureAnyFromExternHelper(ctx, { forceHonest: true });
  if (helper === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: helper });
  return true;
}
