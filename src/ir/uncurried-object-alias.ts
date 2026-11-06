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
 *
 * (#7272) `var __isArray = Array.isArray;`, called as `__isArray(obj)`. Legacy
 * does not certify this one: it calls the stored builtin through the module
 * slot. The IR lowers it to the provider legacy's own `Array.isArray(x)` arm
 * uses for an erased operand (`__extern_is_array`), so both answer from the
 * same runtime predicate.
 */
export type StoredStaticAliasMethod = "getOwnPropertyDescriptor" | "isArray";

/** Each stored static: the builtin namespace it reads and its call arity. */
const STORED_STATICS: Readonly<Record<StoredStaticAliasMethod, { readonly receiver: string; readonly arity: number }>> =
  {
    getOwnPropertyDescriptor: { receiver: "Object", arity: 2 },
    isArray: { receiver: "Array", arity: 1 },
  };

type ObjectAlias =
  | { readonly form: "uncurried"; readonly method: UncurriedObjectAliasMethod }
  | { readonly form: "stored-static"; readonly method: StoredStaticAliasMethod };

/**
 * A call of a certified alias with the arity its native lowering takes, and
 * the kind of value that lowering produces: an exact boolean (the
 * Object.prototype predicates, `isArray`) or the dynamic descriptor.
 */
export type CertifiedAliasCall = ObjectAlias & { readonly result: "boolean" | "dynamic" };

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
      const staticMethod = storedStaticMethodOfInitializer(declaration.initializer);
      if (staticMethod !== undefined) candidates.set(name, { form: "stored-static", method: staticMethod });
    }
  }
  // A top-level binding of the namespace itself makes the initializer read a
  // user value, not the builtin: no stored-static alias of it survives.
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
    }
  }
  for (const [name, alias] of candidates) {
    if (alias.form === "stored-static" && declared.has(STORED_STATICS[alias.method].receiver)) candidates.delete(name);
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

function storedStaticMethodOfInitializer(init: ts.Expression | undefined): StoredStaticAliasMethod | undefined {
  if (!init || !ts.isPropertyAccessExpression(init) || init.questionDotToken) return undefined;
  if (!ts.isIdentifier(init.expression)) return undefined;
  const method = init.name.text;
  if (!Object.hasOwn(STORED_STATICS, method)) return undefined;
  const known = method as StoredStaticAliasMethod;
  return STORED_STATICS[known].receiver === init.expression.text ? known : undefined;
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
 * The certified alias `call` invokes, with its native arity, or undefined.
 * `shadowed` tells whether a local binding of the callee's name is in scope at
 * the call (the selector's scope set): such a call reads the local instead.
 */
export function certifiedAliasCall(
  call: ts.CallExpression,
  shadowed: (name: string) => boolean,
): CertifiedAliasCall | undefined {
  if (call.questionDotToken || call.arguments.some(ts.isSpreadElement)) return undefined;
  const alias = objectAliasOf(call.expression, shadowed);
  if (alias === undefined) return undefined;
  if (alias.form === "uncurried") return call.arguments.length === 2 ? { ...alias, result: "boolean" } : undefined;
  if (call.arguments.length !== STORED_STATICS[alias.method].arity) return undefined;
  return { ...alias, result: alias.method === "getOwnPropertyDescriptor" ? "dynamic" : "boolean" };
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
    certifiedAliasCall(expr.expression, shadowed)?.method === "getOwnPropertyDescriptor"
  );
}

function objectAliasOf(callee: ts.Expression, shadowed: (name: string) => boolean): ObjectAlias | undefined {
  if (!ts.isIdentifier(callee) || shadowed(callee.text)) return undefined;
  const sourceFile = callee.getSourceFile();
  if (!sourceFile) return undefined;
  return collectAliases(sourceFile).get(callee.text);
}
