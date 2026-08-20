// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { hasDeclareModifier } from "./ast-modifiers.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Whether an identifier is the binding created by an unaliased node:fs named
 * import. Single-file compilation replaces imports with ambient declarations;
 * compileMulti retains the ImportSpecifier. Checking both shapes prevents the
 * graph-wide name inventory from hijacking lexical or cross-module namesakes.
 */
export function isUnaliasedNodeFsImportBinding(ctx: CodegenContext, id: ts.Identifier): boolean {
  if (!ctx.wasiNodeFsFuncs.has(id.text)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(id);
  if (declaration === undefined) return false;

  if (ts.isImportSpecifier(declaration)) {
    if (declaration.propertyName && declaration.propertyName.text !== declaration.name.text) return false;
    const importDeclaration = declaration.parent.parent.parent;
    return (
      ts.isImportDeclaration(importDeclaration) &&
      ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
      (importDeclaration.moduleSpecifier.text === "fs" || importDeclaration.moduleSpecifier.text === "node:fs")
    );
  }

  // preprocessImports emits these declarations into the user's transformed
  // source. Do not accept arbitrary lib declarations with the same spelling.
  if (declaration.getSourceFile().isDeclarationFile) return false;
  if (hasDeclareModifier(declaration)) return true;
  return ts.isVariableDeclaration(declaration) && hasDeclareModifier(declaration.parent.parent);
}
