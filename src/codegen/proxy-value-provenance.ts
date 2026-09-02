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
