// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { FuncHandle } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Recover a fixed-arity source declaration without consulting bare-name maps. */
export function fixedSourceFunctionCallHandle(ctx: CodegenContext, expression: ts.Identifier): FuncHandle | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(expression);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = ctx.checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find(
    (decl): decl is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(decl) && !!decl.body && ts.isSourceFile(decl.parent),
  );
  if (
    !declaration ||
    declaration.parameters.some((param) => param.dotDotDotToken || param.questionToken || param.initializer)
  )
    return undefined;
  return ctx.sourceFunctionHandleByDeclaration.get(declaration);
}
