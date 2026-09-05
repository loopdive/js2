// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4653) A name declared by MORE THAN ONE body-bearing `function` declaration.
 *
 * ES §14.1.23 FunctionDeclarationInstantiation hoists every declaration and lets
 * the LAST one win, so `function f(){return 1} … function f(){return 'A'}` is
 * one binding holding the second body — and every call, including calls written
 * ABOVE the second declaration, answers `'A'`. TypeScript disagrees: it resolves
 * `f()` through the FIRST declaration's signature. The compiler emits the last
 * body (correctly), so the two views split, and the split lands wherever a slot
 * is typed from the checker's answer instead of the emitted one:
 *
 *     function __func(){return 1};
 *     var __1 = __func();            // slot typed `number` -> (mut f64)
 *     function __func(){return 'A'};
 *     var __A = __func();            // same
 *     __1                            // NaN  (the string coerced into f64)
 *
 * measured on this branch's base, where `__func` itself compiles to
 * `(func $__func (result (ref null 6)))` returning the `'A'` constant — i.e. the
 * function is right and only the receiving slot is wrong.
 *
 * The remedy is representation-neutral storage, not a better guess at the type:
 * the live body's result is whatever the LAST declaration returns, which no
 * checker query on the call site reports. Widening is confined to this
 * already-pathological shape, so a name with a single declaration (including
 * ordinary TS overloads, where only the implementation carries a body) is
 * untouched.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** Unwrap parenthesized / `as` / `!` wrappers. */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * True when `expr` is a direct call `f(…)` whose callee resolves to a name with
 * two or more body-bearing `function` declarations — i.e. the checker's result
 * type for the call is NOT the type the emitted body produces.
 */
export function callTargetIsRedeclaredFunction(ctx: CodegenContext, expr: ts.Expression): boolean {
  const call = unwrap(expr);
  if (!ts.isCallExpression(call)) return false;
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return false;
  let bodies = 0;
  for (const decl of ctx.oracle.declarationsOf(callee)) {
    if (decl.getSourceFile().isDeclarationFile) continue;
    if (ts.isFunctionDeclaration(decl) && decl.body) bodies++;
    if (bodies > 1) return true;
  }
  return false;
}
