// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

/** (#6987) Is `declaration` a top-level binding of its source file (a `var` anywhere outside a function)? */
export function isModuleScopeBinding(declaration: ts.Declaration | undefined): boolean {
  if (declaration === undefined) return false;
  if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    return ts.isSourceFile(declaration.parent);
  }
  if (!ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)) return false;
  const lexical = (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
  for (let node: ts.Node = declaration.parent.parent; ; node = node.parent) {
    if (ts.isSourceFile(node)) return true;
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node) || ts.isModuleBlock(node)) return false;
    // `let`/`const` belong to their enclosing statement; only a top-level one is module scope.
    if (lexical && !ts.isVariableStatement(node)) return false;
  }
}
