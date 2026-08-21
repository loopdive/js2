// (#1373b C-1) Pure-syntactic async helpers, extracted from async-cps.ts into a
// LEAF module (imports only ts-api) so the IR front-end (`src/ir/select.ts`,
// `src/ir/from-ast.ts`) can consume them without creating an import cycle:
// async-cps.ts imports `resolveWasmType` from codegen/index.ts, which imports
// ir/select.ts — so `ir/* → async-cps` would close a module-init cycle (the
// #3324 hazard class). async-cps.ts re-exports these for its existing callers;
// behaviour is byte-identical to the pre-extraction definitions.
//
// (#3113 S2) The extraction landed this in `src/codegen/`, which left the two
// primary consumers — both under `src/ir/` — importing UPWARD across the layer
// boundary. It now lives below the IR, where the leaf argument above always
// pointed: these are predicates over `ts` syntax nodes with no codegen state,
// no CodegenContext, and no codegen imports. The three codegen consumers
// (index.ts, async-frame.ts, async-cps.ts) import down-stack instead, which is
// the intended direction (emit <- ir <- codegen).

import { ts } from "../ts-api.js";

/**
 * Conservative compile-time predicate: is the operand of an `await` already a
 * *settled* value, so that `await operand` performs no observable suspension?
 *
 * Per §27.7.5.3, `await V` ≡ `PromiseResolve(%Promise%, V)` then a job. When `V`
 * is not a thenable the resumption is a single microtask carrying `V` unchanged;
 * when `V` is `Promise.resolve(x)` with a non-thenable `x` it likewise settles
 * to `x`. In both cases the *value* is statically known to be the operand (or
 * its resolve-argument); only the scheduling differs. js2wasm's synchronous
 * model already collapses that scheduling, so these awaits are safe to treat as
 * pass-through.
 *
 * Recognised static forms (intentionally narrow — over-approximating here would
 * mis-elide a genuinely-suspending await):
 *   - numeric / string / boolean / null literals
 *   - `void`-prefixed, unary `+`/`-`/`!` over a static operand
 *   - binary arithmetic / comparison where BOTH operands are static
 *   - parenthesised / `as`-cast wrappers around a static operand
 *   - `Promise.resolve(<static>)` and `Promise.resolve()` (settles to undefined)
 *
 * Everything else — a call result, a member access, a bare identifier (which may
 * hold a pending Promise) — returns `false`.
 */
export function awaitIsStaticallyResolved(operand: ts.Expression): boolean {
  // Unwrap transparent wrappers first.
  let expr: ts.Expression = operand;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }

  // Literals: numeric / string / no-substitution template / true / false / null.
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  // `undefined` as an identifier is a settled value too.
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;

  // Unary `+x` / `-x` / `!x` / `void x` over a static operand.
  if (ts.isPrefixUnaryExpression(expr)) {
    return awaitIsStaticallyResolved(expr.operand);
  }
  if (ts.isVoidExpression(expr)) {
    return awaitIsStaticallyResolved(expr.expression);
  }

  // Binary arithmetic/comparison where both sides are static.
  if (ts.isBinaryExpression(expr)) {
    return awaitIsStaticallyResolved(expr.left) && awaitIsStaticallyResolved(expr.right);
  }

  // `Promise.resolve(<static?>)` — settles to the (static) argument, or undefined.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    expr.expression.name.text === "resolve"
  ) {
    if (expr.arguments.length === 0) return true; // resolves to undefined
    if (expr.arguments.length === 1) return awaitIsStaticallyResolved(expr.arguments[0]!);
    return false;
  }

  return false;
}

/**
 * (#3227 S2) When an awaited operand is the `Promise.resolve(...)` form that
 * {@link awaitIsStaticallyResolved} recognises, return the expression the
 * `await` actually settles to: the single resolve argument, or `"undefined"`
 * for the zero-arg form. Unwraps transparent wrappers and NESTED
 * `Promise.resolve(Promise.resolve(x))` chains (PromiseResolve is idempotent:
 * resolving a promise returns it, so `await` settles to the innermost value).
 *
 * Returns `null` when the operand is not a `Promise.resolve` call — callers
 * then compile the operand itself.
 *
 * Why this exists: the JS-host legacy await passthrough compiled the OPERAND
 * for statically-resolved awaits, but `Promise.resolve(7)` compiles to a host
 * call returning the Promise OBJECT (externref) — not the settled value — so
 * a numeric consumer's externref→f64 coercion read NaN (the await-NaN cluster
 * behind ~875 honest fails in the #3227 S1 census). Substituting the resolve
 * argument delivers the settled value (§27.7.5.3 Await + §27.2.4.7
 * Promise.resolve: for non-thenable x, `await Promise.resolve(x)` ≡ x up to
 * scheduling, which js2wasm's synchronous model collapses).
 */
export function staticPromiseResolveSettledExpr(operand: ts.Expression): ts.Expression | "undefined" | null {
  let expr: ts.Expression = operand;
  let settled: ts.Expression | "undefined" | null = null;
  for (;;) {
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      expr = expr.expression;
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Promise" &&
      expr.expression.name.text === "resolve"
    ) {
      if (expr.arguments.length === 0) return "undefined";
      if (expr.arguments.length === 1) {
        settled = expr.arguments[0]!;
        expr = settled;
        continue; // keep unwrapping nested Promise.resolve(Promise.resolve(x))
      }
      return settled; // >1 args: not the recognised form; keep last match (or null)
    }
    return settled;
  }
}

/**
 * (#1373b C-1) Syntactic `Promise<T>` → `T` unwrap over a TYPE NODE. Used by
 * the IR selector / from-ast / override-map to register an IR-claimed async
 * function with the same raw-`T` wasm signature the legacy declaration
 * pre-pass registers via the checker-based `unwrapPromiseType`
 * (declarations.ts). For the sync-pass-through async model an async fn's wasm
 * result is the UNWRAPPED value type; the #1796 call-site consumption
 * contract wraps thenable consumers.
 *
 * Returns the `T` type node for `Promise<T>`, or `null` when the node is not
 * a single-type-argument `Promise<...>` reference (callers then reject the
 * claim — C-1 requires an explicit `Promise<T>` annotation).
 */
export function unwrapPromiseTypeNode(node: ts.TypeNode | undefined): ts.TypeNode | null {
  if (!node) return null;
  if (!ts.isTypeReferenceNode(node)) return null;
  if (!ts.isIdentifier(node.typeName) || node.typeName.text !== "Promise") return null;
  if (!node.typeArguments || node.typeArguments.length !== 1) return null;
  return node.typeArguments[0]!;
}
