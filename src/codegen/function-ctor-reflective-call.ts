// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4483 family D) `Function.call(thisArg, …body)` / `Function.apply(thisArg,
 * [body])` — the reflective spellings of the `Function` CONSTRUCTOR.
 *
 * ## Why this is a pure reshape and not a semantic arm
 *
 * ES5 §15.3.1 / ES2015+ §20.2.1.1: `Function(…)` called as a function "creates
 * and initialises a new Function object" and is **identical in effect** to the
 * `new` form — the `this` value is never consulted. So for the intrinsic
 * `%Function%`, `Function.call(anything, …args)` denotes exactly `Function(…args)`
 * and `Function.apply(anything, [args])` exactly `Function(…args)`. The thisArg
 * is not merely ignorable in practice; the spec's [[Call]] for the constructor
 * discards it (`S15.3_A3_*` exist to pin precisely that).
 *
 * ## The defect this fixes
 *
 * `Function` is a builtin VALUE, so `Function.call` was a dynamic member read
 * on a builtin — the generic member path asked the host for it via
 * `env::__get_builtin`, which `--target standalone` refuses at COMPILE time
 * (#1472 Phase A, `late-imports.ts`). Measured on this branch's base with
 * `runTest262File(…, "standalone")`, the whole `built-ins/Function` `S15.3_A2_*`
 * / `S15.3_A3_*` family (8 files) was `compile_error` with
 * `'__get_builtin' … is not yet supported in --target standalone`, even though
 * the identical program spelled `Function("…")` compiles and runs.
 *
 * Rewriting the shape at the AST level puts those programs back on the ordinary
 * `Function(…)` route (`tryStaticFunctionCtorCall` / the runtime-eval boundary),
 * so the CE class disappears without adding any new lowering — a decline here
 * simply leaves the old refusal in place.
 *
 * ## Narrowing (absent-not-wrong)
 *
 * - The receiver must resolve to the realm's `%Function%` intrinsic
 *   (`resolvesToGlobalFunctionAlias`, oracle-based): a user `function Function(){}`
 *   or any local shadow DECLINES.
 * - `.apply`'s argument list must be a literal array (or absent). A dynamic
 *   array-like cannot be spread into the constructor's variadic body/params
 *   contract at compile time, so it DECLINES rather than guessing.
 * - The reshape is spelling-only: it produces a `Function(…)` call node with the
 *   original text range, and every downstream decision (const-body compile-away,
 *   provider boundary, SyntaxError for a malformed body) is made by the existing
 *   `Function(…)` path.
 */
import { ts } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import { resolvesToGlobalFunctionAlias } from "./expressions/eval-inline.js";

function stripParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * Reshape `Function.call/apply(thisArg, …)` into the equivalent `Function(…)`
 * call, or return undefined to leave the expression untouched.
 */
export function reshapeFunctionCtorReflectiveCall(
  oracle: TypeOracle,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ts.CallExpression | undefined {
  const method = propAccess.name.text;
  if (method !== "call" && method !== "apply") return undefined;

  const receiver = stripParens(propAccess.expression);
  if (!ts.isIdentifier(receiver)) return undefined;
  if (!resolvesToGlobalFunctionAlias(receiver, oracle)) return undefined;

  let ctorArgs: readonly ts.Expression[];
  if (method === "call") {
    ctorArgs = expr.arguments.slice(1);
  } else {
    if (expr.arguments.length <= 1) {
      ctorArgs = [];
    } else if (expr.arguments.length === 2) {
      const argList = stripParens(expr.arguments[1]!);
      if (ts.isArrayLiteralExpression(argList)) {
        // A spread inside the literal is not statically flattenable — decline.
        if (argList.elements.some((el) => ts.isSpreadElement(el))) return undefined;
        ctorArgs = argList.elements;
      } else if (argList.kind === ts.SyntaxKind.NullKeyword) {
        // §20.2.3.1 step 3: a null/undefined argArray means "no arguments".
        ctorArgs = [];
      } else if (ts.isIdentifier(argList) && argList.text === "undefined") {
        ctorArgs = [];
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  // Reuse the ORIGINAL receiver identifier as the callee: it is a real node
  // with a real symbol, so every downstream `Function`-resolution check
  // (`isGlobalFunctionIdentifier`, the oracle) sees what the source wrote
  // rather than a synthetic identifier with no binding.
  const reshaped = ts.factory.createCallExpression(receiver, undefined, ctorArgs);
  ts.setTextRange(reshaped, expr);
  (reshaped as { parent?: ts.Node }).parent = expr.parent;
  return reshaped;
}
