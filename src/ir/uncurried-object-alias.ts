// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 item 1, S1g) test262's propertyHelper.js binds the Object.prototype
 * predicates once at module level —
 *
 *   var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
 *   var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
 *
 * — and calls them as `__hasOwnProperty(obj, name)`. Legacy certifies exactly
 * this initializer (`resolveUncurriedBuiltinPrototypeMethod`,
 * `codegen/object-builtin-effects.ts`) and lowers the call to the lane's
 * `__hasOwnProperty` / `__propertyIsEnumerable` provider over two externref
 * arguments, never through the generic bound-function dispatch. This is the
 * checker-free twin of that resolution, shared by the selector, the
 * propagator and from-ast so all three agree on the same declaration: one
 * top-level `var`/`let`/`const` with that exact initializer and no other
 * write to the name anywhere in the file.
 */

import { ts } from "../ts-api.js";

export type UncurriedObjectAliasMethod = "hasOwnProperty" | "propertyIsEnumerable";

/**
 * (#7106 propertyHelper move-only arm) The STORED static form propertyHelper
 * uses for the descriptor read — `var __getOwnPropertyDescriptor =
 * Object.getOwnPropertyDescriptor;` — called as `__getOwnPropertyDescriptor(o,
 * k)`. Legacy certifies the same initializer (`resolveStoredObjectStaticMethod`)
 * and lowers the call to the lane's `__getOwnPropertyDescriptor(externref,
 * externref) -> externref` provider.
 */
export type StoredObjectStaticAliasMethod = "getOwnPropertyDescriptor";

type ObjectAlias =
  | { readonly form: "uncurried"; readonly method: UncurriedObjectAliasMethod }
  | { readonly form: "stored-static"; readonly method: StoredObjectStaticAliasMethod };

const cache = new WeakMap<ts.SourceFile, ReadonlyMap<string, ObjectAlias>>();

function collectAliases(sourceFile: ts.SourceFile): ReadonlyMap<string, ObjectAlias> {
  const cached = cache.get(sourceFile);
  if (cached) return cached;
  const candidates = new Map<string, ObjectAlias>();
  const declared = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (declared.has(name)) {
        candidates.delete(name);
        continue;
      }
      declared.add(name);
      const method = uncurriedObjectMethodOfInitializer(declaration.initializer);
      if (method !== undefined) candidates.set(name, { form: "uncurried", method });
      const staticMethod = storedObjectStaticMethodOfInitializer(declaration.initializer);
      if (staticMethod !== undefined) candidates.set(name, { form: "stored-static", method: staticMethod });
    }
  }
  // A top-level binding of `Object` itself makes the initializer read a
  // user value, not the builtin: no stored-static alias survives it.
  if (declared.has("Object")) {
    for (const [name, alias] of candidates) if (alias.form === "stored-static") candidates.delete(name);
  }
  // Any write to the name anywhere in the file (assignment, update, a
  // nested re-declaration) withdraws the alias: the identity is no longer
  // immutable, which is the whole premise of the native lowering.
  const visit = (node: ts.Node): void => {
    if (candidates.size === 0) return;
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && candidates.has(node.left.text)) {
      const op = node.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) candidates.delete(node.left.text);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      candidates.has(node.operand.text)
    ) {
      candidates.delete(node.operand.text);
    } else if (
      node.parent !== undefined &&
      node.parent !== sourceFile &&
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      candidates.has(node.name.text) &&
      !(ts.isVariableDeclaration(node) && node.parent.parent?.parent === sourceFile)
    ) {
      candidates.delete(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  cache.set(sourceFile, candidates);
  return candidates;
}

function storedObjectStaticMethodOfInitializer(
  init: ts.Expression | undefined,
): StoredObjectStaticAliasMethod | undefined {
  if (!init || !ts.isPropertyAccessExpression(init) || init.questionDotToken) return undefined;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== "Object") return undefined;
  return init.name.text === "getOwnPropertyDescriptor" ? "getOwnPropertyDescriptor" : undefined;
}

function uncurriedObjectMethodOfInitializer(init: ts.Expression | undefined): UncurriedObjectAliasMethod | undefined {
  if (!init || !ts.isCallExpression(init) || init.arguments.length !== 1) return undefined;
  const callee = init.expression;
  // Function.prototype.call.bind(<target>)
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "bind" ||
    !ts.isPropertyAccessExpression(callee.expression) ||
    callee.expression.name.text !== "call" ||
    !ts.isPropertyAccessExpression(callee.expression.expression) ||
    callee.expression.expression.name.text !== "prototype" ||
    !ts.isIdentifier(callee.expression.expression.expression) ||
    callee.expression.expression.expression.text !== "Function"
  ) {
    return undefined;
  }
  // Object.prototype.hasOwnProperty | Object.prototype.propertyIsEnumerable
  const target = init.arguments[0]!;
  if (
    !ts.isPropertyAccessExpression(target) ||
    !ts.isPropertyAccessExpression(target.expression) ||
    target.expression.name.text !== "prototype" ||
    !ts.isIdentifier(target.expression.expression) ||
    target.expression.expression.text !== "Object"
  ) {
    return undefined;
  }
  const method = target.name.text;
  return method === "hasOwnProperty" || method === "propertyIsEnumerable" ? method : undefined;
}

/**
 * The Object.prototype predicate `callee` is an immutable module-level
 * uncurried alias of, or undefined. `shadowed` tells whether a local binding
 * of the same name is in scope at the call (the selector's scope set).
 */
export function uncurriedObjectAliasMethod(
  callee: ts.Expression,
  shadowed: (name: string) => boolean,
): UncurriedObjectAliasMethod | undefined {
  const alias = objectAliasOf(callee, shadowed);
  return alias?.form === "uncurried" ? alias.method : undefined;
}

/**
 * The `Object` static `callee` is an immutable module-level stored alias of
 * (`var x = Object.getOwnPropertyDescriptor;`, no other write), or undefined.
 */
export function storedObjectStaticAliasMethod(
  callee: ts.Expression,
  shadowed: (name: string) => boolean,
): StoredObjectStaticAliasMethod | undefined {
  const alias = objectAliasOf(callee, shadowed);
  return alias?.form === "stored-static" ? alias.method : undefined;
}

/**
 * (#7106 propertyHelper) `alias(obj, name)` where `alias` is the immutable
 * stored `Object.getOwnPropertyDescriptor`: exactly two plain arguments.
 */
export function isStoredObjectDescriptorAliasCall(
  call: ts.CallExpression,
  shadowed: (name: string) => boolean,
): boolean {
  return (
    call.arguments.length === 2 &&
    !call.questionDotToken &&
    !call.arguments.some(ts.isSpreadElement) &&
    storedObjectStaticAliasMethod(call.expression, shadowed) === "getOwnPropertyDescriptor"
  );
}

/**
 * (#7190) `alias(obj, name).<attribute>`: a named member read off the stored
 * descriptor alias call — a dynamic carrier (`undefined` when absent), never a
 * module storage slot.
 */
export function isStoredObjectDescriptorMemberRead(expr: ts.Expression, shadowed: (name: string) => boolean): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    !expr.questionDotToken &&
    ts.isIdentifier(expr.name) &&
    ts.isCallExpression(expr.expression) &&
    isStoredObjectDescriptorAliasCall(expr.expression, shadowed)
  );
}

function objectAliasOf(callee: ts.Expression, shadowed: (name: string) => boolean): ObjectAlias | undefined {
  if (!ts.isIdentifier(callee) || shadowed(callee.text)) return undefined;
  const sourceFile = callee.getSourceFile();
  if (!sourceFile) return undefined;
  return collectAliases(sourceFile).get(callee.text);
}
