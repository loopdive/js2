// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { GLOBAL_CONSTANTS } from "./ambient-intrinsics.js";

/**
 * The names a Script's top-level lexical declarations bind, in source order: the BoundNames of every `let`/`const`
 * (nested binding patterns included) and the names of class declarations. Only direct SourceFile children count: a
 * block or loop lexical has its own environment.
 */
export function scriptGlobalLexicalNames(sourceFile: ts.SourceFile): readonly ts.Identifier[] {
  const names: ts.Identifier[] = [];
  const recordName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.push(name);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordName(element.name);
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) continue;
      for (const declaration of statement.declarationList.declarations) recordName(declaration.name);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.push(statement.name);
    }
  }
  return names;
}

/**
 * The first top-level lexical name of a Script that is a restricted global (`undefined`, `NaN`, `Infinity`): such a
 * Script throws a SyntaxError at GlobalDeclarationInstantiation (§16.1.7). A Module has its own environment record.
 */
export function restrictedGlobalLexicalName(sourceFile: ts.SourceFile): ts.Identifier | undefined {
  if (ts.isExternalModule(sourceFile)) return undefined;
  return scriptGlobalLexicalNames(sourceFile).find((name) => GLOBAL_CONSTANTS.has(name.text));
}
