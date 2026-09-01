/**
 * (#5143) §27.2.3.1 NewTarget guards for the standalone `Promise` constructor.
 *
 * Two decisions that must happen BEFORE the native `new Promise(executor)`
 * lowerings in `promise-executor.ts` get a look, both of which used to fall
 * through to a host import (or, for the `.call` spelling, to the `__get_builtin`
 * standalone COMPILE-ERROR refusal):
 *
 *  - step 1, NewTarget is undefined — `Promise(fn)` / `Promise.call(x, fn)`;
 *  - step 2, `IsCallable(executor)` is false — `new Promise(1)`.
 *
 * Kept out of `expressions/new-builtin-globals.ts` (a god-file under the #3102
 * LOC ratchet) and out of `promise-executor.ts` (which `new-super.ts` imports,
 * so importing `resolvesToAmbientGlobal` back from there would be a cycle).
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { resolvesToAmbientGlobal } from "./expressions/new-super.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";

/**
 * (#5143) True when `expr` is a literal the compiler can prove is BOTH
 * non-callable and free of evaluation side effects — a number/string/boolean/
 * `null` literal, the unshadowed `undefined`, or an EMPTY object/array literal.
 *
 * Emptiness is load-bearing: `{ a: f() }` is provably non-callable too, but
 * discarding it would skip `f()`. Callers use this to claim a shape without
 * compiling the operand at all, so anything that could run user code is out.
 */
export function isInertNonCallableLiteral(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return true;
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return true;
  if (
    ts.isIdentifier(expr) &&
    expr.text === "undefined" &&
    !fctx.localMap.has("undefined") &&
    !(fctx.boxedCaptures?.has("undefined") ?? false) &&
    !ctx.classSet.has("undefined")
  ) {
    return true;
  }
  return false;
}

/**
 * (#5143 C5b) `Promise(executor)` / `Promise.call(thisArg, executor)` — called
 * WITHOUT `new`.
 *
 * §27.2.3.1 step 1: "If NewTarget is undefined, throw a TypeError exception."
 * The `this` value is irrelevant — `Promise.call(p, fn)` on a real promise
 * throws just like `Promise.call(null, fn)` — so both spellings are claimed by
 * one arm and every argument is evaluated (for its side effects) before the
 * throw.
 *
 * Before this arm the bare-call form fell into the generic builtin-identifier
 * terminal and the `.call` form reached the `__get_builtin` dynamic-shape
 * refusal (#1472 Phase B), which is a hard COMPILE ERROR in standalone mode —
 * so `built-ins/Promise/undefined-newtarget.js` never even built.
 *
 * Standalone-carrier gated ({@link isStandalonePromiseActive}) so the host/gc
 * lane, where `Promise` is the real host intrinsic and already throws, stays
 * byte-identical. A shadowed binding (`class Promise {}`, a local, an import)
 * keeps ordinary call semantics.
 */
export function tryCompilePromiseCallWithoutNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.questionDotToken) return undefined;
  if (!isStandalonePromiseActive(ctx)) return undefined;
  const callee = expr.expression;
  let promiseId: ts.Identifier;
  if (ts.isIdentifier(callee)) {
    promiseId = callee;
  } else if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "call" &&
    ts.isIdentifier(callee.expression)
  ) {
    promiseId = callee.expression;
  } else {
    return undefined;
  }
  if (promiseId.text !== "Promise") return undefined;
  if (ctx.classSet.has("Promise")) return undefined;
  if (!resolvesToAmbientGlobal(ctx, promiseId)) return undefined;

  for (const arg of expr.arguments ?? []) {
    const argResult = compileExpression(ctx, fctx, arg);
    if (argResult) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, "Constructor Promise requires 'new'");
  return { kind: "externref" };
}
