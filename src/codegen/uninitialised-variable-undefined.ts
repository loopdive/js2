// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** A typed reference slot whose declaration starts at JavaScript undefined. */
export function readsUninitialisedVariableSlot(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const declaration = ctx.checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer || !declaration.type)
    return false;
  const declaredType = ctx.checker.getTypeFromTypeNode(declaration.type);
  // A concrete ref.null cannot distinguish null from undefined when both are
  // permitted. Leave that carrier to its existing representation policy.
  const parts = declaredType.isUnion() ? declaredType.types : [declaredType];
  return !parts.some((part) => (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0);
}
