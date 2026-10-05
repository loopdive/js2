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

/**
 * (#6840) A node:fs path call (`readFileSync`/`writeFileSync`) that a host-free
 * `--target standalone` module reaches from DEPENDENCY code (a `node_modules`
 * source file). #1491 refuses the compile without `--allow-fs` so the JS-host
 * `__node_fs_*` import never leaks the host filesystem to third-party code; a
 * host-free module imports nothing, so there is nothing to leak and `--allow-fs`
 * cannot help either. The call lowers to a documented throw instead (the
 * #6659/#6664/#6675/#6691 contract). The program's own source keeps the #1491
 * compile error, as do WASI and the linked / JS-environment standalone regimes.
 */
function isStandaloneDependencyNodeFsCall(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  if (!ctx.standalone || ctx.wasi || ctx.targetProfile.environment !== "none") return false;
  if (ctx.standaloneGlobalThisImport !== undefined) return false;
  // A package-linker provider build (#5247) compiles one dependency package
  // with package-relative file keys, so its path carries no `node_modules`.
  if (ctx.exportsConsumedByWasm) return true;
  return /(?:^|[\\/])node_modules[\\/]/.test(expr.getSourceFile().fileName);
}

/**
 * (#6840) The message of the catchable `Error` such a call throws once its
 * arguments are evaluated (the ArgumentList runs before the callee) — the
 * shape Node's permission model uses for a denied fs call — or `undefined`
 * when the call is not a standalone dependency call (the #1491 path applies).
 * The caller emits the lowering, so this module stays out of the codegen
 * value-import cycle (#6797).
 */
export function standaloneDependencyNodeFsThrowMessage(
  ctx: CodegenContext,
  expr: ts.CallExpression,
  fnName: string,
): string | undefined {
  if (!isStandaloneDependencyNodeFsCall(ctx, expr)) return undefined;
  return `node:fs.${fnName} is not available in a standalone module: there is no filesystem (#6840)`;
}
