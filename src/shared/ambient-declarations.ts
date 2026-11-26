// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

/** Whether `node` is ambient: it or an enclosing declaration is `declare`, or it sits in a `.d.ts` file. */
export function isAmbientDeclaration(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const modifiers = (current as { modifiers?: readonly ts.Node[] }).modifiers;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return node.getSourceFile().isDeclarationFile;
}
