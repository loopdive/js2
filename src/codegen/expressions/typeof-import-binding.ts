// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6417) Does `typeof ident` read a DECLARED binding?
 *
 * The `typeof` lowering folds an identifier with no value declaration to
 * "undefined" (§13.5.3, an unresolvable Reference). An IMPORT binding's symbol
 * is the alias, which carries no valueDeclaration of its own, so every
 * `typeof importedName` folded to "undefined" — axios' own
 * `expect(typeof encode).toBe('function')` for
 * `import buildURL, { encode } from '../../../lib/helpers/buildURL.js'`.
 * Resolve through the alias before deciding.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

export function typeofOperandIsDeclared(
  ctx: CodegenContext,
  ident: ts.Identifier,
  sym: ts.Symbol | undefined,
): boolean {
  // Local import syntax decides whether the binding survives type erasure.
  // A runtime import stays declared even when target resolution is unavailable.
  const declaration = ctx.oracle.valueDeclarationOf(ident);
  if (declaration !== undefined) {
    if (ts.isImportClause(declaration)) return !declaration.isTypeOnly;
    if (ts.isNamespaceImport(declaration)) return !declaration.parent.isTypeOnly;
    if (ts.isImportSpecifier(declaration)) {
      return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
    }
  }
  if (sym?.valueDeclaration) return true;
  if (sym === undefined || (sym.flags & ts.SymbolFlags.Alias) === 0) return false;
  return ctx.oracle.aliasedValueDeclarationOf(ident) !== undefined;
}
