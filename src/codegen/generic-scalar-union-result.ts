// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureAnyFromExternHelper } from "./any-helpers.js";

/** Recover scalar tags after a generic call's erased externref result. */
export function emitGenericScalarUnionResult(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (!ctx.nativeStrings || !ts.isCallExpression(expr)) return false;
  const declaration = ctx.oracle.resolvedCallDeclarationOf(expr);
  if (!declaration?.typeParameters?.length) return false;
  const type = ctx.oracle.typeFactOf(expr);
  if (type.kind !== "union" || type.nullable || type.undefinable) return false;
  if (!type.parts.every((part) => part.kind === "string" || part.kind === "number" || part.kind === "boolean"))
    return false;
  // Boolean itself is true|false in the checker. Single-brand unions already
  // have a scalar ABI; only heterogeneous primitives require a tagged result.
  const brands = new Set(type.parts.map((part) => part.kind));
  if (brands.size < 2) return false;
  const helper = ensureAnyFromExternHelper(ctx, { forceHonest: true });
  if (helper === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: helper });
  return true;
}
