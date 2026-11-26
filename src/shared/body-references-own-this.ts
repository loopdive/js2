// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/**
 * Module-level memo cache. WeakMap keys die with their ts.Node when the
 * TS program is discarded between compiles — no explicit reset needed.
 */
const cache = new WeakMap<ts.Node, boolean>();

/** A non-arrow function-like: it binds its own `this`, where an arrow inherits the enclosing one. */
export function isReceiverBindingFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isDirectEvalCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  let callee: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) && callee.text === "eval";
}

/**
 * The first truthy `visit` result over the uses of `node`'s own `this`: each `this` keyword of its scope, and each
 * direct `eval` call, whose text may read `this` in source the outer AST does not hold (a runtime-built string
 * included). Iterative DFS, so deep ASTs stay within the CI cgroup's stack (as `bodyUsesArguments`).
 */
function forEachOwnThis<T>(node: ts.Node, visit: (use: ts.Expression) => T | undefined): T | undefined {
  const stack: ts.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === ts.SyntaxKind.ThisKeyword || isDirectEvalCall(current)) {
      const result = visit(current as ts.Expression);
      if (result) return result;
    }
    if (!isReceiverBindingFunction(current) && !ts.isClassLike(current))
      current.forEachChild((child) => void stack.push(child));
  }
  return undefined;
}

/**
 * Return one `this` node belonging to the scanned lexical function body. The node is used when codegen must
 * materialize a lexical receiver so source-sensitive sloppy-IIFE rules see the original AST position rather than a
 * detached synthetic node.
 */
export function findOwnThisReference(node: ts.Node): ts.Expression | undefined {
  return forEachOwnThis(node, (use) => (use.kind === ts.SyntaxKind.ThisKeyword ? use : undefined));
}

/**
 * #2152 — Check whether a node tree references `this` in its OWN function scope; a direct eval counts, so callable
 * dispatch preserves an explicit receiver (the eval bridge separately performs sloppy null/undefined substitution).
 *
 * Used to decide whether a (nested or top-level) function declaration body
 * should read the `__current_this` module global for `this` (#1636-S1 / #1702):
 * when such a function is passed by reference as an array-HOF callback
 * (`arr.filter(callbackfn, thisArg)`), the dispatcher installs the spec
 * `thisArg` into `__current_this` before the `call_ref`. For direct calls the
 * global is null and the null-guarded read falls back to `undefined`, so
 * enabling the read is behavior-preserving for ordinary calls.
 *
 * Memoized so overlapping subtrees stay O(N).
 */
export function bodyReferencesOwnThis(node: ts.Node): boolean {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  const found = forEachOwnThis(node, () => true) === true;
  cache.set(node, found);
  return found;
}

/**
 * (#7363 A4) The declaration's own `this`, in a parameter initializer or the body, can leave it as a value. A use
 * stays inside only as the left operand of `instanceof`, or as the object of a static property access whose name is
 * not in `globalAliases` (`this.globalThis` is the object again) that is read or written, never invoked: not the
 * callee of a call, `new` or tagged template (`this.valueOf()` returns the receiver; `this.m()` hands it to `m`), nor
 * the object of a `.call` / `.apply`. A direct `eval` escapes: its text may do anything with `this`.
 */
export function ownThisEscapes(declaration: ts.FunctionLikeDeclaration, globalAliases: ReadonlySet<string>): boolean {
  const escapes = (use: ts.Expression): boolean =>
    use.kind !== ts.SyntaxKind.ThisKeyword || !(isInstanceOfOperand(use) || isStaticMemberObject(use, globalAliases));
  return [...declaration.parameters.map((parameter) => parameter.initializer), declaration.body].some(
    (node) => node !== undefined && forEachOwnThis(node, escapes) === true,
  );
}

function isInstanceOfOperand(use: ts.Expression): boolean {
  const parent = use.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === use &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  );
}

function isStaticMemberObject(use: ts.Expression, globalAliases: ReadonlySet<string>): boolean {
  const access = use.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use || globalAliases.has(access.name.text))
    return false;
  const user = access.parent;
  return !(
    ((ts.isCallExpression(user) || ts.isNewExpression(user)) && user.expression === access) ||
    (ts.isTaggedTemplateExpression(user) && user.tag === access) ||
    (ts.isPropertyAccessExpression(user) && (user.name.text === "call" || user.name.text === "apply"))
  );
}

/** Whether any call-time parameter initializer reads this function's receiver. */
export function parametersReferenceOwnThis(parameters: readonly ts.ParameterDeclaration[]): boolean {
  return parameters.some((parameter) =>
    parameter.initializer === undefined ? false : bodyReferencesOwnThis(parameter.initializer),
  );
}

/** Receiver demand across both call-time parameter initialization and the body. */
export function functionLikeReferencesOwnThis(declaration: ts.FunctionLikeDeclaration): boolean {
  return (
    parametersReferenceOwnThis(declaration.parameters) ||
    (declaration.body !== undefined && bodyReferencesOwnThis(declaration.body))
  );
}

/**
 * (#6436) Does this declaration's `this` resolve through the ambient
 * `__current_this` module global?
 *
 * True when the body wants a receiver AND nothing else supplies one. A
 * TypeScript `this` parameter is an ordinary Wasm param, so such a declaration
 * never consults the global and must not be routed through the plain-call
 * receiver trampoline — the same exclusion `resolveNamedThisCallTarget` makes
 * for the `.call` trampoline.
 */
export function readsAmbientThisGlobal(declaration: ts.FunctionLikeDeclaration): boolean {
  const first = declaration.parameters[0];
  if (first !== undefined && ts.isIdentifier(first.name) && first.name.text === "this") return false;
  return functionLikeReferencesOwnThis(declaration);
}
