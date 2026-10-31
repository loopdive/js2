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
  return aliasUsesAreSafe(ctx, decl, decl.getSourceFile(), false) ? type : undefined;
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
/**
 * (#7166) The alias may share the source's externref-vec slot only when the
 * vec can never reach a place typed from the checker's `T[]`, which would
 * convert it by COPYING (`const t = r`, `[r]`, `{ v: r }`, `f(r)`, a return, a
 * `?:` branch, a reassignment). So this is an allow-list: the binding has one
 * declaration, the file has no `eval` / `with`, and every reference in
 * `scope` resolves (through the oracle) to `decl` and is a recognised use —
 * an element read, a plain element store (`r[i] = v`, never a destructuring
 * target), a length read or plain `r.length = v;` statement, a callback-free method that keeps the vec
 * in (`sort()` / `reverse()` only without a comparator, and only while their
 * own result is used the same way), an equality comparison, or a `for…of`.
 * Callback methods and spreads decline: a callback is compiled against the
 * checker's element type, a spread into an array literal loses mixed element
 * kinds, and a rest parameter receives the vec itself. Anything else declines.
 */
function aliasUsesAreSafe(ctx: CodegenContext, decl: ts.VariableDeclaration, scope: ts.Node, local: boolean): boolean {
  if (!ts.isIdentifier(decl.name) || ctx.oracle.declarationsOf(decl.name).length !== 1) return false;
  const sourceFile = decl.getSourceFile();
  if (fileHasDynamicScope(sourceFile)) return false;
  const name = decl.name.text;
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node) && node.text === name && node !== decl.name && isReference(node)) {
      const target = ctx.oracle.variableDeclarationOf(node);
      if (target === undefined) safe = false;
      else if (target === decl && (!isSafeUse(node) || mayRunBeforeDeclaration(node, decl, local))) safe = false;
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
  if (ts.isElementAccessExpression(parent)) return parent.expression === use && elementUseIsSafe(parent);
  if (ts.isForOfStatement(parent)) return parent.expression === use;
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
  if (!ts.isCallExpression(call) || call.expression !== parent) return method === "length" && lengthUseIsSafe(parent);
  if (RECEIVER_RETURNING.has(method)) {
    // A comparator is a callback: `sort(cmp)` / `reverse()` with arguments declines.
    if ((method === "sort" || method === "reverse") && call.arguments.length > 0) return false;
    return isSafeUse(call);
  }
  return NON_ESCAPING_METHODS.has(method) && !call.arguments.some(ts.isSpreadElement);
}

/**
 * A length read, or a plain `r.length = v;` statement. Other writes can
 * enter store paths typed from the copied vec, so the alias must decline.
 */
function lengthUseIsSafe(access: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = access;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isTypeAssertionExpression(node.parent) ||
    ts.isNonNullExpression(node.parent) ||
    ts.isSatisfiesExpression(node.parent)
  ) {
    node = node.parent;
  }
  if (isDestructuringTarget(node)) return false;
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isExpressionStatement(parent.parent);
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator !== ts.SyntaxKind.PlusPlusToken && parent.operator !== ts.SyntaxKind.MinusMinusToken;
  }
  return !ts.isDeleteExpression(parent);
}

/**
 * An element access on the alias: a read, or a plain `r[i] = v` store. A
 * compound store (`r[i] += v`), `++` / `--`, `delete`, and any destructuring
 * or `for…in` / `for…of` target decline: they mis-handle an externref element.
 */
function elementUseIsSafe(access: ts.ElementAccessExpression): boolean {
  if (isDestructuringTarget(access)) return false;
  let node: ts.Node = access;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator !== ts.SyntaxKind.PlusPlusToken && parent.operator !== ts.SyntaxKind.MinusMinusToken;
  }
  return !ts.isDeleteExpression(parent);
}

/** `node` sits inside a destructuring-assignment pattern (`[r[0], r[1]] = …`, `for ([r[0]] of …)`). */
function isDestructuringTarget(node: ts.Node): boolean {
  let inner = node;
  let parent = inner.parent;
  while (
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    ts.isParenthesizedExpression(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === inner) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === inner &&
      inner !== node &&
      (ts.isArrayLiteralExpression(parent.parent) || ts.isObjectLiteralExpression(parent.parent)))
  ) {
    inner = parent;
    parent = inner.parent;
  }
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === inner) return true;
  if (inner === node) return false;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    return parent.left === inner;
  return (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === inner;
}

/**
 * A reference that can run before the declaration initialises the binding:
 * one written before it (in a function too: `function early() { return r; }`
 * called first), or, for a local, one inside a nested function declaration,
 * which is hoisted.
 */
function mayRunBeforeDeclaration(ref: ts.Node, decl: ts.VariableDeclaration, local: boolean): boolean {
  if (ref.getStart() < decl.getEnd()) return true;
  if (!local) return false;
  const scope = enclosingFunction(decl);
  for (let n: ts.Node | undefined = ref.parent; n && n !== scope; n = n.parent) {
    if (ts.isFunctionDeclaration(n)) return true;
  }
  return false;
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
  return aliasUsesAreSafe(ctx, decl, enclosingFunction(decl), true) ? type : undefined;
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
