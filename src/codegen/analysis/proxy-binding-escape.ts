// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachChild, ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/** The two direct initializer shapes whose result carrier is Proxy-owned. */
export function isDirectProxyConstruction(expression: ts.Expression): boolean {
  if (ts.isNewExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === "Proxy";
  }
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "revocable" &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Proxy"
  );
}

function enclosingExecutableOrSource(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function isTransparentWrapperOf(parent: ts.Node, child: ts.Expression): parent is ts.Expression {
  return (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
    parent.expression === child
  );
}

function outermostTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (current.parent !== undefined && isTransparentWrapperOf(current.parent, current)) {
    current = current.parent;
  }
  return current;
}

/** (#5140) `Object.*` meta-object statics that consume an externref carrier. */
const OBJECT_MOP_STATICS = new Set([
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
  "isExtensible",
  "preventExtensions",
  "freeze",
  "isFrozen",
  "seal",
  "isSealed",
  "create",
]);

function expressionIsEscapingArgument(expression: ts.Expression): boolean {
  const outer = outermostTransparentExpression(expression);
  const parent = outer.parent;
  if ((!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) || parent.arguments === undefined) return false;

  // Object.assign's native and host providers both consume Proxy carriers as
  // externrefs and deliberately dispatch their MOP operations at runtime. A
  // source (or target) passed here therefore does not need the nominal target
  // struct that generic typed consumers require. Keeping that struct would
  // guarded-cast the actual `$Proxy`/host Proxy to its TypeScript target type,
  // replace it with null, and skip the getOwnPropertyDescriptor trap entirely.
  if (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    parent.expression.expression.text === "Object" &&
    parent.expression.name.text === "assign"
  ) {
    return false;
  }

  // (#5140) The same reasoning covers every consumer whose lowering already
  // takes a raw externref carrier: `new Proxy(p, h)` / `Proxy.revocable(p, h)`
  // (a proxy is a legal proxy target), the whole `Reflect` namespace, and the
  // `Object` meta-object statics. Keeping the nominal target struct for those
  // arguments guarded-casts the live `$Proxy` to null, which is what made
  // `new Proxy(new Proxy({foo: 1}, {}), {})` throw "Cannot create proxy with a
  // non-object as target or handler" at ProxyCreate.
  if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "Proxy") {
    return false;
  }
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const ns = parent.expression.expression;
    const member = parent.expression.name.text;
    if (ts.isIdentifier(ns)) {
      if (ns.text === "Reflect") return false;
      if (ns.text === "Proxy" && member === "revocable") return false;
      if (ns.text === "Object" && OBJECT_MOP_STATICS.has(member)) return false;
    }
  }

  // This includes argument zero of `.call` / `.apply`, the generic-method
  // receiver that motivated #2615. A member receiver (`p.method()`) is not in
  // the argument list and therefore remains non-escaping.
  return parent.arguments.some((argument) => argument === outer);
}

function nestedExecutableMayReferenceBinding(
  ctx: CodegenContext,
  executable: ts.SignatureDeclaration,
  declaration: ts.VariableDeclaration,
  bindingName: string,
): boolean {
  let mayReference = false;
  const visit = (node: ts.Node): void => {
    if (mayReference) return;
    if (ts.isIdentifier(node) && node.text === bindingName) {
      const resolved = ctx.oracle.valueDeclarationOf(node);
      // An unresolved same-spelled reference cannot prove non-escape. Descend
      // and let the main classifier fail closed if it is in argument position.
      if (resolved === declaration || resolved === undefined) {
        mayReference = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(executable, visit);
  return mayReference;
}

/**
 * Whether one exact Proxy result binding escapes into a call/new argument.
 *
 * The check deliberately proves declaration identity through the shared type
 * oracle instead of comparing display names. Transparent TypeScript wrappers
 * preserve the same binding. Assignment aliases and
 * `Proxy.revocable(...).proxy` declarations are outside this direct-flow
 * predicate; callers decide which initializer families are eligible.
 *
 * Unsupported binding patterns and unresolved same-spelled argument uses are
 * conservative escapes: when identity cannot be proved, storage widening must
 * decline rather than risk an externref-to-struct cast at a typed consumer.
 */
export function proxyBindingEscapesToCall(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return true;
  const scope = enclosingExecutableOrSource(declaration);
  if (scope === undefined) return true;

  const bindingName = declaration.name.text;
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) return;

    if (
      node !== scope &&
      ts.isFunctionLike(node) &&
      !nestedExecutableMayReferenceBinding(ctx, node, declaration, bindingName)
    ) {
      return;
    }

    if (ts.isIdentifier(node) && node.text === bindingName && expressionIsEscapingArgument(node)) {
      const resolved = ctx.oracle.valueDeclarationOf(node);
      if (resolved === declaration || resolved === undefined) {
        escapes = true;
        return;
      }
    }

    forEachChild(node, visit);
  };
  visit(scope);
  return escapes;
}
