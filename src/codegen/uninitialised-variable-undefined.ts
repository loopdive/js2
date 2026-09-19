// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { TypeFact } from "../checker/oracle.js";

function excludesNullAndUnknown(fact: TypeFact): boolean {
  if (fact.kind === "union") return !fact.nullable && fact.parts.every(excludesNullAndUnknown);
  return fact.kind !== "null" && fact.kind !== "any" && fact.kind !== "unknown" && fact.kind !== "unresolvable";
}

/** A typed reference slot whose declaration starts at JavaScript undefined. */
export function readsUninitialisedVariableSlot(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(expression);
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer || !declaration.type)
    return false;
  // A concrete ref.null cannot distinguish null from undefined when both are
  // permitted. Leave that carrier to its existing representation policy.
  return excludesNullAndUnknown(ctx.oracle.typeFactOf(declaration.type));
}
