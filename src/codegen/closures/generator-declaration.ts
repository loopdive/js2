// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

/** Open object methods retain their MethodDeclaration node in closure lowering. */
export function isGeneratorClosureDeclaration(node: ts.Node): node is ts.FunctionExpression | ts.MethodDeclaration {
  return (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.asteriskToken !== undefined;
}
