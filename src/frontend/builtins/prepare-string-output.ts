// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../typescript.js";
import { irIntrinsicFuncRef } from "../../ir/core/callable-bindings.js";
import { IR_ASYNC_CONSOLE_LOG_STRING_FN } from "../../ir/core/async-callables.js";
import type { IrFuncRef } from "../../ir/core/value-references.js";

/** Source-bound string-only console intent; runtime availability is checked after preparation. */
export function prepareNativeStringOutputResolver(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
): { readonly preparedAsyncConsoleTarget: (call: ts.CallExpression) => IrFuncRef | null } {
  const calls = new WeakSet<ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.add(node);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return {
    preparedAsyncConsoleTarget(call) {
      if (!calls.has(call)) return null;
      const target = call.expression;
      if (
        !ts.isPropertyAccessExpression(target) ||
        !ts.isIdentifier(target.expression) ||
        target.expression.text !== "console" ||
        target.name.text !== "log" ||
        target.questionDotToken ||
        call.questionDotToken ||
        call.typeArguments ||
        call.arguments.length !== 1 ||
        ts.isSpreadElement(call.arguments[0]!)
      )
        return null;
      const ambient = checker.resolveName("console", undefined, ts.SymbolFlags.Value, false);
      if (
        !ambient?.declarations?.length ||
        !ambient.declarations.every((node) => node.getSourceFile().isDeclarationFile) ||
        checker.getSymbolAtLocation(target.expression) !== ambient
      )
        return null;
      const member = checker.getSymbolAtLocation(target.name);
      const signature = checker.getResolvedSignature(call);
      if (
        !member?.declarations?.length ||
        checker.getTypeAtLocation(target.expression).getProperty("log") !== member ||
        !member.declarations.every((node) => node.getSourceFile().isDeclarationFile) ||
        !signature?.declaration ||
        !member.declarations.includes(signature.declaration) ||
        (checker.getTypeAtLocation(call.arguments[0]!).flags & ts.TypeFlags.StringLike) === 0
      )
        return null;
      return irIntrinsicFuncRef(IR_ASYNC_CONSOLE_LOG_STRING_FN);
    },
  };
}
