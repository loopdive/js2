// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7166) A module global initialised from another module global's array
// (`const r = keys`, `const r = keys.sort()`) must share that global's vec
// slot type.
//
// A top-level evolving `const keys = []` is typed from its declared `any[]`,
// so its global holds the dynamic carrier (an externref-element vec). The
// checker types a later `const r = keys` or `const r = keys.sort()` from the
// evolved flow type (`string[]`), so `r` got a typed vec slot and the store
// converted by COPYING: `r === keys` was false and `r.push(x)` never reached
// `keys`. A function-local `const a = []` pushed values of mixed kinds takes
// the same dynamic carrier while `const r = a` was typed `(string | number)[]`
// — the same copy, fixed by the local twin below.
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

/** Array methods that return their receiver: the result is the same vec. */
const RECEIVER_RETURNING = new Set(["sort", "reverse", "fill", "copyWithin"]);

/** The identifier whose vec `expression` yields, through wrappers and receiver-returning calls. */
function aliasedIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let node: ts.Expression = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
      node = node.expression;
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      RECEIVER_RETURNING.has(node.expression.name.text)
    ) {
      node = node.expression.expression;
    } else {
      return ts.isIdentifier(node) ? node : undefined;
    }
  }
}

/** True when `typeIdx` is a vec struct whose data array holds externref elements. */
function isExternrefElementVec(ctx: CodegenContext, typeIdx: number): boolean {
  const vec = ctx.mod.types[typeIdx];
  if (!vec || vec.kind !== "struct" || vec.fields.length !== 2) return false;
  const data = vec.fields[1]!.type;
  if (data.kind !== "ref" && data.kind !== "ref_null") return false;
  const array = ctx.mod.types[data.typeIdx];
  return array?.kind === "array" && array.element.kind === "externref";
}

/**
 * (#7166) The slot type of the module global `decl`'s initializer aliases,
 * when that global already holds an externref-element vec and `decl` is an
 * un-annotated binding of the same source file; otherwise `undefined`.
 */
export function aliasedModuleGlobalVecType(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  sourceType: (source: ts.VariableDeclaration) => ValType,
): ValType | undefined {
  if (!decl.initializer || decl.type) return undefined;
  const source = aliasedIdentifier(decl.initializer);
  if (!source) return undefined;
  const sourceDecl = ctx.oracle.variableDeclarationOf(source);
  const statement = sourceDecl?.parent?.parent;
  if (
    !sourceDecl ||
    sourceDecl === decl ||
    !ts.isIdentifier(sourceDecl.name) ||
    !statement ||
    !ts.isVariableStatement(statement) ||
    !ts.isSourceFile(statement.parent) ||
    statement.parent !== decl.getSourceFile()
  ) {
    return undefined;
  }
  // A hoisted `var` alias is registered before a `const` / `let` source, so
  // an unregistered array-literal source is typed the way its own
  // registration will be.
  const globalIdx = ctx.moduleGlobals.get(sourceDecl.name.text);
  let type: ValType | undefined;
  // Absolute → defined-global index inline: `registry/imports.ts` would join the import-cycle SCC.
  if (globalIdx !== undefined) type = ctx.mod.globals[globalIdx - ctx.numImportGlobals]?.type;
  else if (sourceDecl.initializer && ts.isArrayLiteralExpression(sourceDecl.initializer) && !typingSources.has(decl)) {
    typingSources.add(decl);
    try {
      type = sourceType(sourceDecl);
    } finally {
      typingSources.delete(decl);
    }
  }
  if (!type || type.kind !== "ref_null" || !isExternrefElementVec(ctx, type.typeIdx)) return undefined;
  return type;
}

/** Declarations whose alias source is being typed (breaks `var a = b, b = a` cycles). */
const typingSources = new Set<ts.VariableDeclaration>();

/**
 * (#7166) The local twin: `const r = a` / `const r = a.sort()` in a function
 * whose `a` local already holds an externref-element vec takes `a`'s slot type.
 */
export function aliasedLocalVecType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): ValType | undefined {
  if (!decl.initializer || decl.type) return undefined;
  const source = aliasedIdentifier(decl.initializer);
  if (!source) return undefined;
  const sourceDecl = ctx.oracle.variableDeclarationOf(source);
  if (!sourceDecl || sourceDecl === decl || enclosingFunction(sourceDecl) !== enclosingFunction(decl)) return undefined;
  if (ts.isSourceFile(enclosingFunction(decl))) return undefined;
  const index = fctx.localMap.get(source.text);
  const type = index === undefined ? undefined : getLocalType(fctx, index);
  if (!type || type.kind !== "ref_null" || !isExternrefElementVec(ctx, type.typeIdx)) return undefined;
  return type;
}

function enclosingFunction(node: ts.Node): ts.Node {
  let scope = node;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
