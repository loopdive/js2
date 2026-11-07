// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A destructuring declaration, shared below both the IR (the #7106 binding
// pattern plan) and the module-initializer var-list classification
// (`module-init-var-lists.ts`), which codegen reads too.

import { ts } from "../ts-api.js";

/** A destructuring declaration: its name is a binding pattern. */
export type PatternDeclaration = ts.VariableDeclaration & { readonly name: ts.BindingPattern };

export function isPatternDeclaration(declaration: ts.VariableDeclaration): declaration is PatternDeclaration {
  return !ts.isIdentifier(declaration.name);
}
