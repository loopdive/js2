// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6450) Is a call's identifier callee a node-builtin NAMED import
 * (`import { createHash } from 'node:crypto'`)? The lowering that acts on it
 * is `tryCompileNodeBuiltinMemberCall` in `../host-method-args.ts`; see its
 * doc for the defect. This module is a leaf on purpose (only `ts-api`,
 * `import-resolver` and type imports), so the predicate can be shared with
 * `isAsyncCallExpression` without growing the codegen import cycle (#6797).
 */
import { ts } from "../../ts-api.js";
import { isNodeBuiltin } from "../../import-resolver.js";
import type { CodegenContext } from "../context/types.js";

/**
 * Does this call site's callee binding resolve to a named import specifier of a
 * node builtin module?
 *
 * The name-keyed `declaredGlobals`/`nodeBuiltinGlobals` registration is
 * module-GRAPH wide, so a bare-name hit alone would also claim a same-named
 * user binding in a file that never imported the builtin. The binding
 * declaration the checker reports for THIS call site is the thing that decides,
 * which is why the declaration has to be an `ImportSpecifier` whose
 * `ImportDeclaration` names a node builtin.
 */
export function bindingIsNodeBuiltinNamedImport(decl: ts.Declaration | undefined): boolean {
  if (decl === undefined || !ts.isImportSpecifier(decl)) return false;
  const namedImports = decl.parent;
  if (!ts.isNamedImports(namedImports)) return false;
  const importClause = namedImports.parent;
  if (!ts.isImportClause(importClause)) return false;
  const importDecl = importClause.parent;
  if (!ts.isImportDeclaration(importDecl)) return false;
  const specifier = importDecl.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return false;
  return isNodeBuiltin(specifier.text);
}

/**
 * Is `callee` (a call's identifier callee) bound to a node-builtin named
 * import? `isAsyncCallExpression`'s bare-name `ctx.asyncFunctions` check would
 * otherwise wrap `createHash('sha256')` in `Promise_resolve` whenever ANY
 * module of the graph declares an async `createHash` (hono's
 * `src/utils/crypto.ts`), turning the builtin's Hash into a Promise.
 */
export function isNodeBuiltinNamedImportCallee(ctx: CodegenContext, callee: ts.Identifier): boolean {
  return (
    !ctx.wasi &&
    ctx.nodeBuiltinGlobals.has(callee.text) &&
    bindingIsNodeBuiltinNamedImport(ctx.oracle.valueDeclarationOf(callee))
  );
}
