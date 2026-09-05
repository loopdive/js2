// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachChild, ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { tracesToProxyConstructorValue } from "../proxy-value-provenance.js"; // (#5196 R3-0)
export { variableStatementContainsPromiseSubclass } from "../expressions/promise-subclass.js";

/**
 * The direct initializer shapes whose result carrier is Proxy-owned.
 *
 * (#5196 R3-0) With a `ctx`, `new <Proxy-constructor value>(t, h)` counts too —
 * `var OProxy = $262.createRealm().global.Proxy; var p = new OProxy(t, h)`
 * produces exactly the same `$Proxy` carrier as `new Proxy(t, h)`, so the
 * binding must take the same open externref storage. Without it the closed
 * struct slot splits the binding from the carrier and later MOP operations on
 * the binding (`Object.getOwnPropertyDescriptor(p, k)`, `delete p.k`) miss the
 * proxy. The `ctx`-less overload keeps the pre-#5196 syntactic answer for
 * callers that have no context to query the oracle with.
 */
export function isDirectProxyConstruction(expression: ts.Expression, ctx?: CodegenContext): boolean {
  if (ts.isNewExpression(expression)) {
    if (ts.isIdentifier(expression.expression) && expression.expression.text === "Proxy") return true;
    return ctx !== undefined && tracesToProxyConstructorValue(ctx, expression.expression);
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

/**
 * `proxyBindingIsTarget` is queried for every variable declaration, including
 * both module-global declaration passes.  Index actual Proxy targets once per
 * source instead of walking an enclosing scope for every queried declaration.
 *
 * The cached raw-text checks keep the overwhelmingly common no-Proxy query
 * path constant-time after one cheap source prefilter. A `\u` spelling still
 * needs the scanner because escaped identifiers such as `P\u0072oxy` have the
 * normalized AST text `Proxy`. Raw-text false positives only trigger the exact
 * cached AST scan and cannot change the semantic answer.
 */
const sourceHasProxyIdentifierCache = new WeakMap<ts.SourceFile, boolean>();
const proxyTargetBindingsByContext = new WeakMap<
  CodegenContext,
  WeakMap<ts.SourceFile, WeakSet<ts.VariableDeclaration>>
>();

function sourceHasProxyIdentifier(sourceFile: ts.SourceFile): boolean {
  const cached = sourceHasProxyIdentifierCache.get(sourceFile);
  if (cached !== undefined) return cached;

  const text = sourceFile.text;
  let found = text.includes("Proxy");
  if (!found && text.includes("\\u")) {
    const scanner = ts.createScanner(sourceFile.languageVersion, true, sourceFile.languageVariant, text);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.Identifier && scanner.getTokenValue() === "Proxy") {
        found = true;
        break;
      }
    }
  }
  sourceHasProxyIdentifierCache.set(sourceFile, found);
  return found;
}

function proxyTargetBindings(ctx: CodegenContext, sourceFile: ts.SourceFile): WeakSet<ts.VariableDeclaration> {
  let bySource = proxyTargetBindingsByContext.get(ctx);
  if (bySource === undefined) {
    bySource = new WeakMap();
    proxyTargetBindingsByContext.set(ctx, bySource);
  }
  const cached = bySource.get(sourceFile);
  if (cached !== undefined) return cached;

  const targets = new WeakSet<ts.VariableDeclaration>();
  bySource.set(sourceFile, targets);
  if (!sourceHasProxyIdentifier(sourceFile)) return targets;

  const visit = (node: ts.Node): void => {
    let target: ts.Expression | undefined;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
      target = node.arguments?.[0];
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Proxy" &&
      node.expression.name.text === "revocable"
    ) {
      target = node.arguments[0];
    }
    if (target !== undefined) {
      const candidate = innermostTransparentExpression(target);
      if (ts.isIdentifier(candidate)) {
        const declaration = ctx.oracle.valueDeclarationOf(candidate);
        if (declaration !== undefined && ts.isVariableDeclaration(declaration)) targets.add(declaration);
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
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

function innermostTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * (#5140) Meta-object consumers whose providers take their arguments as raw
 * externref carriers and dispatch the MOP at runtime. Passing a Proxy binding
 * here does NOT require the nominal target struct a generic typed consumer
 * needs — and keeping that struct is actively wrong: the guarded cast of the
 * live `$Proxy`/host Proxy to its TypeScript target type yields **null**, so
 * `new Proxy(p, {})` silently created a proxy over null and every trap
 * disappeared.
 *
 * The families are the ones that are definitionally about the carrier:
 * `new Proxy` / `Proxy.revocable`, all of `Reflect.*`, and the `Object.*`
 * meta-object statics.
 */
const OBJECT_META_STATICS = new Set([
  "assign",
  "keys",
  "values",
  "entries",
  "freeze",
  "isFrozen",
  "seal",
  "isSealed",
  "preventExtensions",
  "isExtensible",
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "defineProperty",
  "defineProperties",
  "create",
]);

function consumesExternrefCarrier(parent: ts.CallExpression | ts.NewExpression): boolean {
  if (ts.isNewExpression(parent)) {
    return ts.isIdentifier(parent.expression) && parent.expression.text === "Proxy";
  }
  const callee = parent.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const namespace = callee.expression.text;
  const member = callee.name.text;
  if (namespace === "Reflect") return true;
  if (namespace === "Proxy") return member === "revocable";
  return namespace === "Object" && OBJECT_META_STATICS.has(member);
}

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
  if (consumesExternrefCarrier(parent)) return false;

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

/**
 * Whether a binding is passed directly as the target of a Proxy in the same
 * executable scope.
 *
 * ProxyConstructor is typed to return its target's structural type, but the
 * runtime value is an externref Proxy carrier.  A target binding therefore
 * has to stay on the dynamic object carrier too: a closed-struct slot would
 * split the object from the Proxy's target and make later reads/writes miss
 * the Proxy's MOP.  Keep this identity proof next to the escape analysis so
 * module and function declaration paths use the same rule.
 */
export function proxyBindingIsTarget(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  return proxyTargetBindings(ctx, declaration.getSourceFile()).has(declaration);
}

/** Tag direct Proxy results and target aliases for dynamic module storage. */
export function proxyBindingNeedsExternref(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const target = proxyBindingIsTarget(ctx, declaration);
  const result =
    declaration.initializer !== undefined &&
    isDirectProxyConstruction(declaration.initializer, ctx) &&
    !proxyBindingEscapesToCall(ctx, declaration);
  if (target || result) ctx.externrefAccessorVars.add(declaration.name.text);
  return target || result;
}
