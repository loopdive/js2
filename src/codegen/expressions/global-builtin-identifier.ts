// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Whether an identifier names a global built-in binding rather than a local shadow (`eval`, `JSON`, `Math`, …). */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

/** Returns true if the given `eval` identifier resolves to the global eval function (not a local shadow). */
export function isGlobalEvalIdentifier(ident: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return true; // unresolved → assume global eval
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  // Global eval is declared only in .d.ts files. A local shadow has at least one
  // declaration in a non-declaration (.ts) source file.
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * (#3145) True when `ident` refers to a GLOBAL builtin binding (declared only in
 * ambient .d.ts lib files) that is NOT shadowed by a local or captured variable
 * in the current function. Gates builtin-namespace call lowerings (e.g.
 * `Atomics.<m>(...)`) so a user `const Atomics = { … }` never hijacks the
 * fast path. Mirrors `isGlobalEvalIdentifier` with the extra local/capture
 * guard the namespace case needs.
 */
export function isGlobalBuiltinIdentifier(ctx: CodegenContext, fctx: FunctionContext, ident: ts.Identifier): boolean {
  if (fctx.localMap.has(ident.text)) return false;
  if (fctx.boxedCaptures?.has(ident.text)) return false;
  return isGlobalEvalIdentifier(ident, ctx.checker);
}
