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

const cache = new WeakMap<ts.SourceFile, ReadonlyMap<string, UncurriedObjectAliasMethod>>();

function collectAliases(sourceFile: ts.SourceFile): ReadonlyMap<string, UncurriedObjectAliasMethod> {
  const cached = cache.get(sourceFile);
  if (cached) return cached;
  const candidates = new Map<string, UncurriedObjectAliasMethod>();
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
      if (method !== undefined) candidates.set(name, method);
    }
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
  if (!ts.isIdentifier(callee) || shadowed(callee.text)) return undefined;
  const sourceFile = callee.getSourceFile();
  if (!sourceFile) return undefined;
  return collectAliases(sourceFile).get(callee.text);
}
