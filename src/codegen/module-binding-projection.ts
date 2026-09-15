// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Project exact source-owned cells into the legacy name-keyed readers/writers. */
export function projectModuleBindings(ctx: CodegenContext, source: ts.SourceFile): void {
  if (!ts.isExternalModule(source)) return;
  const project = (name: string, declaration: ts.Declaration | undefined): void => {
    if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration))) return;
    const binding = ctx.programAbiGlobals?.moduleBinding(declaration);
    if (!binding) return;
    const index = ctx.mod.globals.indexOf(binding.value);
    if (index < 0) return;
    ctx.moduleGlobals.set(name, ctx.numImportGlobals + index);
    if (binding.tdz) {
      ctx.tdzGlobals.set(name, ctx.numImportGlobals + ctx.mod.globals.indexOf(binding.tdz));
    } else {
      ctx.tdzGlobals.delete(name);
    }
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) project(declaration.name.text, declaration);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) project(clause.name.text, ctx.importBindingTargets?.get(clause));
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) {
          project(binding.name.text, ctx.importBindingTargets?.get(binding));
        }
      }
    }
  }
}
