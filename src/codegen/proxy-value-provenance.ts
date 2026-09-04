// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268) "This expression may evaluate to a Proxy exotic object."
 *
 * ## Why a syntactic trace and not a type question
 *
 * TypeScript types `new Proxy(target, handler)` and `Proxy.revocable(t, h).proxy`
 * as the TARGET's type. So `Array.isArray(o.proxy)` on a `Proxy.revocable([],
 * {})` handle sees the static type `never[]`, folds to the constant `true`, and
 * never runs §7.2.2 step 3 — which for a REVOKED proxy must throw a TypeError.
 * No type-level query can recover that: the checker's answer is the target's,
 * and the target really is an array.
 *
 * The trace is deliberately narrow and conservative in the SAFE direction: a
 * false answer keeps the caller's existing lowering exactly as it was, and a
 * true answer only ever routes a value to a runtime predicate that is correct
 * for non-proxies too. It follows single-initializer variable bindings (the
 * shape every test262 Proxy row uses — `var o = Proxy.revocable(…); o.proxy`)
 * and stops at a bounded depth.
 */
import { ts } from "../ts-api.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js";
import type { CodegenContext } from "./context/types.js";

const TRACE_DEPTH_LIMIT = 4;

/** Unwrap parenthesized / `as` / non-null / satisfies wrappers. */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** True for the call `Proxy.revocable(target, handler)` with `Proxy` unshadowed. */
function isProxyRevocableCall(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  return (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === "Proxy" &&
    e.expression.name.text === "revocable"
  );
}

/** True when `expr` traces to a `Proxy.revocable(…)` RESULT object. */
function tracesToRevocableHandle(ctx: CodegenContext, expr: ts.Expression, depth: number): boolean {
  if (depth > TRACE_DEPTH_LIMIT) return false;
  const e = unwrap(expr);
  if (isProxyRevocableCall(e)) return true;
  if (ts.isIdentifier(e)) {
    const init = ctx.oracle.variableInitializerOf(e);
    if (init && init !== e) return tracesToRevocableHandle(ctx, init, depth + 1);
  }
  return false;
}

/**
 * True when `expr` may evaluate to a Proxy exotic object: `new Proxy(…)`,
 * `<handle>.proxy` where `<handle>` traces to `Proxy.revocable(…)`, or a
 * single-initializer variable that traces to either.
 */
export function tracesToProxyValue(ctx: CodegenContext, expr: ts.Expression, depth = 0): boolean {
  if (depth > TRACE_DEPTH_LIMIT) return false;
  const e = unwrap(expr);
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Proxy") return true;
  if (ts.isPropertyAccessExpression(e) && e.name.text === "proxy") {
    return tracesToRevocableHandle(ctx, e.expression, depth + 1);
  }
  if (ts.isIdentifier(e)) {
    const init = ctx.oracle.variableInitializerOf(e);
    if (init && init !== e) return tracesToProxyValue(ctx, init, depth + 1);
  }
  return false;
}

/**
 * (#5268 review F2) The DIRECT-BINDING half of {@link tracesToProxyValue}: the
 * expression is itself Proxy-producing, or an identifier whose OWN initializer
 * is — one hop, never an alias CHAIN.
 *
 * Why a second, narrower predicate rather than a depth argument: the two call
 * sites carry different risk. `Array.isArray` routes a maybe-proxy to a RUNTIME
 * predicate that is correct for every value, so following an alias chain there
 * can only improve the answer. `Object.{keys,values,entries}` routes it AWAY
 * from the compile-time closed-struct field expansion and into a runtime read
 * of the value — and an alias of a `$Proxy`-over-object-literal binding is
 * nulled by a widening defect that predates this change-set.
 *
 * Measured 2026-09-02, standalone, `var t={a:1}; var pt=new Proxy(t,{}); var
 * qt=pt`: `qt === null` is **true on this tree AND on `origin/main`**, so the
 * runtime read answers `[]` where the field expansion still printed `"a"`
 * without ever loading the value. The direct `Object.keys(pt)` is `"a"` either
 * way, and the array-typed twin (`new Proxy([1,2],{})`) is NOT nulled — which
 * is why `Array.isArray` keeps the wider trace.
 *
 * Restricting rather than repairing the nulling is deliberate: the defect is in
 * alias widening, is pre-existing, and owning it here would put a value-
 * representation fix inside a conformance slice.
 */
export function isDirectProxyBinding(ctx: CodegenContext, expr: ts.Expression): boolean {
  // (#5268 review R2-3) `new Proxy(…)` ONLY — a `<handle>.proxy` read is
  // excluded for exactly the reason the alias chain is. `var r =
  // Proxy.revocable({a:1},{}); var proxy = r.proxy` binds through the same
  // widening seam, so `proxy === null` is true (measured on this tree AND on
  // `origin/main`) and routing it to the runtime enumerator turned base's
  // correct `Object.keys(proxy)` → "a" into a silent `[]`. A silent wrong
  // answer is the worst of the three outcomes, so the hop stays out until the
  // nulling itself is repaired. `tracesToProxyValue` keeps accepting it: its
  // consumer is a runtime predicate that is correct for every value.
  const direct = (e: ts.Expression): boolean =>
    ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Proxy";
  const e = unwrap(expr);
  if (direct(e)) return true;
  if (ts.isIdentifier(e)) {
    const init = ctx.oracle.variableInitializerOf(e);
    if (init && init !== e) return direct(unwrap(init));
  }
  return false;
}

/**
 * (#5196 R3 review F1/F3) The single-assignment proof `variableInitializerOf`
 * demands but does not itself perform.
 *
 * `oracle.variableInitializerOf` is documented as "the binding-resolution seam
 * for analyses that SEPARATELY PROVE single assignment" (`src/checker/oracle.ts`).
 * An analysis that treats its answer as the binding's value without that proof
 * reads a REASSIGNED binding as its declaration initializer. Measured
 * 2026-09-04, standalone: `var P = Proxy; class K {…}; P = K; new P(5, 6)`
 * routed the `new` through the Proxy constructor path and produced
 * `undefined false object` where node and the base tree both produce
 * `5 true object`.
 *
 * The proof is `const`, or a `var`/`let` declarator that no in-file syntax
 * writes. The write scan is over-approximating by NAME (the `cjs-rewrite`
 * rationale): a same-named binding in another scope can make us DECLINE a
 * valid claim, which costs only the optimisation, but can never make us accept
 * a binding that is genuinely written.
 */
export function isSingleAssignmentBinding(ctx: CodegenContext, id: ts.Identifier): boolean {
  // A second declaration of the same binding (`var r = a; var r = b;`) is a
  // write under another name, and the declarator scan below cannot see it.
  const decls = ctx.oracle.declarationsOf(id);
  if (decls.length !== 1) return false;
  const decl = decls[0]!;
  if (!ts.isVariableDeclaration(decl) || decl.initializer === undefined) return false;
  // A destructuring binding, a `for (x of …)` head, or a `catch` parameter is
  // not a plain single-initializer declarator.
  if (!ts.isIdentifier(decl.name)) return false;
  if (!ts.isVariableDeclarationList(decl.parent) || !ts.isVariableStatement(decl.parent.parent)) return false;
  const sourceFile = decl.getSourceFile();
  if (sourceFile !== id.getSourceFile()) return false;
  if ((decl.parent.flags & ts.NodeFlags.Const) !== 0) return true;
  return !identifierIsWrittenTo(sourceFile, decl.name.text);
}

/**
 * (#5196 R3-0) True when `expr` evaluates to the `Proxy` CONSTRUCTOR itself —
 * the bare `Proxy` binding, a realm-global read of it
 * (`$262.createRealm().global.Proxy`, the shape every
 * `built-ins/Proxy/**\/*-realm*` row uses), or a single-initializer alias of
 * either.
 *
 * Distinct from {@link tracesToProxyValue}, which asks whether a value IS a
 * proxy. This asks whether `new <expr>(t, h)` MAKES one — so a binding
 * initialized from such a `new` is a proxy carrier and must keep the open
 * externref representation, exactly as a syntactic `new Proxy(t, h)` does.
 */
export function tracesToProxyConstructorValue(ctx: CodegenContext, expr: ts.Expression, depth = 0): boolean {
  if (depth > TRACE_DEPTH_LIMIT) return false;
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) {
    const init = ctx.oracle.variableInitializerOf(e);
    // (#5196 R3 review F1) An alias hop is only sound under a single-assignment
    // proof — otherwise `var P = Proxy; P = K; new P(5, 6)` constructs a proxy
    // from a binding that no longer holds `Proxy`. A reassigned alias DECLINES
    // (falls back to the base lowering) rather than claiming the wrong answer.
    if (init && init !== e) {
      if (!isSingleAssignmentBinding(ctx, e)) return false;
      return tracesToProxyConstructorValue(ctx, init, depth + 1);
    }
    return e.text === "Proxy";
  }
  // A `.Proxy` read is claimed ONLY off a realm global; a `.Proxy` property of
  // an arbitrary object keeps its existing lowering.
  if (ts.isPropertyAccessExpression(e) && e.name.text === "Proxy") {
    return isRealmGlobalExpression(ctx, e.expression, depth + 1);
  }
  return false;
}

/** `globalThis`, `$262.createRealm().global`, or a single-initializer alias. */
function isRealmGlobalExpression(ctx: CodegenContext, expr: ts.Expression, depth: number): boolean {
  if (depth > TRACE_DEPTH_LIMIT) return false;
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) {
    const init = ctx.oracle.variableInitializerOf(e);
    if (init && init !== e) return isRealmGlobalExpression(ctx, init, depth + 1);
    return e.text === "globalThis";
  }
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "global") return false;
  const call = unwrap(e.expression);
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "createRealm"
  );
}
