// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { FuncHandle } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Recover a fixed-arity source declaration without consulting bare-name maps. */
export function fixedSourceFunctionCallHandle(ctx: CodegenContext, expression: ts.Identifier): FuncHandle | undefined {
  let declaration = ctx.oracle.aliasedValueDeclarationOf(expression);
  if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    declaration = ctx.oracle.aliasedValueDeclarationOf(declaration.name);
  }
  if (
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    !declaration.body ||
    !ts.isSourceFile(declaration.parent) ||
    declaration.parameters.some((param) => param.dotDotDotToken || param.questionToken || param.initializer)
  )
    return undefined;
  return ctx.sourceFunctionHandleByDeclaration.get(declaration);
}
