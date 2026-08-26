// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Whether an identifier is the first parameter of an inline template tag. */
export function isInlineTaggedTemplateParameter(ctx: CodegenContext, id: ts.Identifier): boolean {
  const declaration = ctx.oracle
    .declarationsOf(id)
    .find((decl): decl is ts.ParameterDeclaration => ts.isParameter(decl));
  if (!declaration || declaration.parent.parameters[0] !== declaration) return false;
  let owner: ts.Node = declaration.parent;
  while (ts.isParenthesizedExpression(owner.parent) && owner.parent.expression === owner) owner = owner.parent;
  return ts.isTaggedTemplateExpression(owner.parent) && owner.parent.tag === owner;
}
