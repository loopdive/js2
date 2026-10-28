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
  if (!decl.initializer || decl.type || isExported(decl)) return undefined;
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
  return aliasUsesAreSafe(ctx, decl, decl.getSourceFile()) ? type : undefined;
}

/** Array methods whose result is never the receiver and that take no callback. */
const NON_ESCAPING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "slice",
  "concat",
  "indexOf",
  "lastIndexOf",
  "includes",
  "join",
  "toString",
  "at",
]);
/** Callback methods: safe while every callback sees only `(element, index)`, never the array. */
const CALLBACK_METHODS = new Set([
  "map",
  "filter",
  "forEach",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "reduce",
  "reduceRight",
]);

/**
 * (#7166) The alias may share the source's externref-vec slot only when the
 * vec can never reach a place typed from the checker's `T[]`, which would
 * convert it by COPYING (`const t = r`, `[r]`, `{ v: r }`, `f(r)`, a return, a
 * `?:` branch, a reassignment). So this is an allow-list: the binding has one
 * declaration, the file has no `eval` / `with`, and every reference in
 * `scope` resolves (through the oracle) to `decl` and is a recognised use —
 * an element read or write, `.length`, a method that keeps the vec in (a
 * receiver-returning one only while its own result is used the same way), an
 * equality comparison, a `for…of`, or a spread. Anything else declines.
 */
function aliasUsesAreSafe(ctx: CodegenContext, decl: ts.VariableDeclaration, scope: ts.Node): boolean {
  if (!ts.isIdentifier(decl.name) || ctx.oracle.declarationsOf(decl.name).length !== 1) return false;
  const sourceFile = decl.getSourceFile();
  if (fileHasDynamicScope(sourceFile)) return false;
  const name = decl.name.text;
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node) && node.text === name && node !== decl.name && isReference(node)) {
      const target = ctx.oracle.variableDeclarationOf(node);
      if (target === undefined ? true : target === decl && !isSafeUse(node)) safe = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return safe;
}

/** An identifier in a reference position (not a property name, label or key). */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id;
  if (ts.isQualifiedName(parent)) return parent.left === id;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

/** `node` evaluates to the alias's vec: is that value used only in a recognised way? */
function isSafeUse(node: ts.Expression): boolean {
  let use: ts.Expression = node;
  while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
  const parent = use.parent;
  if (ts.isElementAccessExpression(parent)) return parent.expression === use;
  if (ts.isForOfStatement(parent)) return parent.expression === use;
  if (ts.isSpreadElement(parent))
    return ts.isArrayLiteralExpression(parent.parent) || ts.isCallExpression(parent.parent);
  if (ts.isExpressionStatement(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    );
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== use) return false;
  const method = parent.name.text;
  const call = parent.parent;
  if (!ts.isCallExpression(call) || call.expression !== parent) return method === "length";
  if (RECEIVER_RETURNING.has(method)) return isSafeUse(call);
  if (NON_ESCAPING_METHODS.has(method)) return true;
  return CALLBACK_METHODS.has(method) && call.arguments.length >= 1 && callbackSeesNoArray(call.arguments[0]!);
}

function callbackSeesNoArray(callback: ts.Expression): boolean {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  // `reduce` passes (acc, element, index, array): the array is the fourth.
  const call = callback.parent as ts.CallExpression;
  const method = (call.expression as ts.PropertyAccessExpression).name.text;
  const limit = method === "reduce" || method === "reduceRight" ? 3 : 2;
  return callback.parameters.length <= limit && !callback.parameters.some((p) => p.dotDotDotToken);
}

function fileHasDynamicScope(sourceFile: ts.SourceFile): boolean {
  let dynamic = dynamicScopeFiles.get(sourceFile);
  if (dynamic === undefined) {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isWithStatement(node) || (ts.isIdentifier(node) && (node.text === "eval" || node.text === "arguments"))) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    dynamic = found;
    dynamicScopeFiles.set(sourceFile, dynamic);
  }
  return dynamic;
}

const dynamicScopeFiles = new WeakMap<ts.SourceFile, boolean>();

function isExported(decl: ts.VariableDeclaration): boolean {
  const statement = decl.parent?.parent;
  return (
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
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
  // `localMap` is keyed by name: only trust it when `sourceDecl` is the one
  // binding of that name in this function, so a shadow cannot be picked.
  if (!isOnlyBindingOfName(enclosingFunction(decl), sourceDecl)) return undefined;
  const index = fctx.localMap.get(source.text);
  const type = index === undefined ? undefined : getLocalType(fctx, index);
  if (!type || type.kind !== "ref_null" || !isExternrefElementVec(ctx, type.typeIdx)) return undefined;
  return aliasUsesAreSafe(ctx, decl, enclosingFunction(decl)) ? type : undefined;
}

function isOnlyBindingOfName(fn: ts.Node, binding: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(binding.name)) return false;
  const name = binding.name.text;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) count++;
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      count++;
    } else if (ts.isClassDeclaration(node) && node.name?.text === name) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return count === 1;
}

function enclosingFunction(node: ts.Node): ts.Node {
  let scope = node;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
