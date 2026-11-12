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
import type { IrBackendTargetCapability } from "./backend/legality.js";
import { objectStaticArity, objectStaticProvider } from "./object-statics.js";

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
export type StoredStaticAliasMethod = "getOwnPropertyDescriptor" | "getOwnPropertyNames" | "isArray";

/** The object-runtime provider a stored static lowers to. */
export type StoredStaticAliasProvider = "__getOwnPropertyDescriptor" | "__getOwnPropertyNames" | "__extern_is_array";

type CertifiedAliasCapability = Extract<
  IrBackendTargetCapability,
  "native-own-property-test" | "native-own-property-introspection" | "native-array-is-array"
>;

/** What a certified alias call lowers to: its result kind and the backend capability it needs. */
interface CertifiedAliasLowering {
  readonly result: "boolean" | "dynamic";
  readonly capability: CertifiedAliasCapability;
}

/** A stored `Object` static, lowered as the statics table's row of that name. */
function storedObjectStatic(method: "getOwnPropertyDescriptor" | "getOwnPropertyNames") {
  return {
    receiver: "Object",
    arity: objectStaticArity(method),
    result: "dynamic",
    capability: "native-own-property-introspection",
    provider: objectStaticProvider(method),
  } as const;
}

/** Each stored static: the namespace it reads, its arity, and its native lowering. */
const STORED_STATICS: Readonly<
  Record<
    StoredStaticAliasMethod,
    CertifiedAliasLowering & {
      readonly receiver: string;
      readonly arity: number;
      readonly provider: StoredStaticAliasProvider;
    }
  >
> = {
  // (#7338) The two `Object` rows are the statics table's: one helper and
  // arity for the stored form and the direct call. (#7283) The names list is
  // the object runtime's own-key list, a dynamic array value.
  getOwnPropertyDescriptor: storedObjectStatic("getOwnPropertyDescriptor"),
  getOwnPropertyNames: storedObjectStatic("getOwnPropertyNames"),
  isArray: {
    receiver: "Array",
    arity: 1,
    result: "boolean",
    capability: "native-array-is-array",
    provider: "__extern_is_array",
  },
};

/** The uncurried Object.prototype predicates: two operands, an exact boolean, `dyn.own_property`. */
const UNCURRIED: CertifiedAliasLowering = { result: "boolean", capability: "native-own-property-test" };

type ObjectAlias =
  | { readonly form: "uncurried"; readonly method: UncurriedObjectAliasMethod }
  | { readonly form: "stored-static"; readonly method: StoredStaticAliasMethod };

/** A call of a certified alias with the arity its native lowering takes, and that lowering. */
export type CertifiedAliasCall = CertifiedAliasLowering &
  (
    | { readonly form: "uncurried"; readonly method: UncurriedObjectAliasMethod }
    | {
        readonly form: "stored-static";
        readonly method: StoredStaticAliasMethod;
        readonly provider: StoredStaticAliasProvider;
      }
  );

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
  withdrawShadowedOrMutatedNamespaces(sourceFile, declared, candidates);
  withdrawRewrittenAliases(sourceFile, candidates);
  cache.set(sourceFile, candidates);
  return candidates;
}

/**
 * A stored static reads its namespace once, at its declaration. A top-level
 * binding of the namespace (it then names a user value), or a write to the
 * namespace's member anywhere in the file (`Array.isArray = …`, `delete`,
 * `Object.defineProperty(Array, …)`), withdraws the namespace's aliases: the
 * slot may then hold something other than the builtin.
 */
function withdrawShadowedOrMutatedNamespaces(
  sourceFile: ts.SourceFile,
  declared: Set<string>,
  candidates: Map<string, ObjectAlias>,
): void {
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
    }
  }
  // `<Namespace>.<member>` for a named member write, `<Namespace>.*` for a
  // write the member name cannot be read off (computed, reflective, the
  // namespace binding itself).
  const mutated = new Set([...declared].map((name) => `${name}.*`));
  const visit = (node: ts.Node): void => {
    const target =
      ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
        ? node.left
        : ts.isDeleteExpression(node)
          ? node.expression
          : ts.isCallExpression(node) && isReflectiveDefinition(node.expression)
            ? node.arguments[0]
            : undefined;
    if (target && ts.isIdentifier(target)) mutated.add(`${target.text}.*`);
    else if (target && ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
      mutated.add(`${target.expression.text}.${target.name.text}`);
    } else if (target && ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression)) {
      mutated.add(`${target.expression.text}.*`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const [name, alias] of candidates) {
    if (alias.form !== "stored-static") continue;
    const { receiver } = STORED_STATICS[alias.method];
    if (mutated.has(`${receiver}.*`) || mutated.has(`${receiver}.${alias.method}`)) candidates.delete(name);
  }
}

const REFLECTIVE_DEFINITIONS = new Set([
  "Object.defineProperty",
  "Object.defineProperties",
  "Object.assign",
  "Object.setPrototypeOf",
  "Reflect.defineProperty",
  "Reflect.set",
  "Reflect.deleteProperty",
  "Reflect.setPrototypeOf",
]);

function isReflectiveDefinition(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    REFLECTIVE_DEFINITIONS.has(`${callee.expression.text}.${callee.name.text}`)
  );
}

function isAssignmentOperator(op: ts.SyntaxKind): boolean {
  return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
}

/**
 * Any write to the alias name anywhere in the file (assignment, update, a
 * nested re-declaration) withdraws the alias: the identity is no longer
 * immutable, which is the whole premise of the native lowering.
 */
function withdrawRewrittenAliases(sourceFile: ts.SourceFile, candidates: Map<string, ObjectAlias>): void {
  const visit = (node: ts.Node): void => {
    if (candidates.size === 0) return;
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      candidates.has(node.left.text) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      candidates.delete(node.left.text);
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
  if (alias.form === "uncurried") return call.arguments.length === 2 ? { ...alias, ...UNCURRIED } : undefined;
  const { arity, result, capability, provider } = STORED_STATICS[alias.method];
  return call.arguments.length === arity ? { ...alias, result, capability, provider } : undefined;
}

/** `call` invokes a certified alias whose native lowering answers an exact boolean. */
export function isCertifiedBooleanAliasCall(call: ts.CallExpression, shadowed: (name: string) => boolean): boolean {
  return certifiedAliasCall(call, shadowed)?.result === "boolean";
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
