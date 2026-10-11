// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S1) A Proxy trap's `T | undefined` result keeps its `undefined`,
 * `--target standalone`.
 *
 * ## The wrong answer this removes
 *
 * ```js
 * var p = new Proxy([], {
 *   get: function (t, key) { if (key === "length") return Number.MAX_SAFE_INTEGER; },
 * });
 * [].concat(1, p);   // spec: TypeError (1 + 2^53 - 1 > 2^53 - 1)
 * ```
 *
 * TypeScript infers the trap's return type as `number | undefined`, the closure
 * signature strips the nullish member and lowers the result to `f64`, and a
 * fall-off-the-end completion materializes that type's ZERO. So the `get` trap
 * answered `0` — not `undefined` — for `@@isConcatSpreadable`, §7.2.x
 * IsConcatSpreadable took `ToBoolean(0) = false`, the proxy was appended as ONE
 * element and the length check never ran
 * (`Array/prototype/concat/arg-length-exceeding-integer-limit.js`).
 *
 * `mixed-return-widening.ts` (#4641) fixed exactly this for function
 * DECLARATIONS and deliberately left closures on their existing carrier (the
 * general union-collapse reversal is #3580 S3). A trap is the one closure
 * position where the scalar carrier can never pay for itself: its result is
 * consumed only by the proxy machinery, through the generic closure call and an
 * externref box, so the TypeScript-typed call-site fast path does not exist for
 * it. Widening its result to externref costs nothing a caller can observe
 * except the correct `undefined`.
 *
 * Scope: a function expression / arrow that is a property VALUE of the object
 * literal passed as the handler (argument 1) of `new Proxy(…)` or
 * `Proxy.revocable(…)`. Every other closure keeps its bytes.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { widenMixedUndefinedReturn } from "../mixed-return-widening.js";

/** Is `lit` the handler argument of `new Proxy(t, lit)` / `Proxy.revocable(t, lit)`? */
function isProxyHandlerLiteral(lit: ts.ObjectLiteralExpression): boolean {
  let arg: ts.Node = lit;
  while (ts.isParenthesizedExpression(arg.parent)) arg = arg.parent;
  const call = arg.parent;
  if (!ts.isNewExpression(call) && !ts.isCallExpression(call)) return false;
  if (call.arguments?.[1] !== arg) return false;
  const callee = call.expression;
  if (ts.isNewExpression(call)) return ts.isIdentifier(callee) && callee.text === "Proxy";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "revocable" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Proxy"
  );
}

/** Widen a Proxy trap's scalar `T | undefined` result to externref; else `lowered`. */
export function widenProxyTrapMixedReturn(
  ctx: CodegenContext,
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  retType: ts.Type,
  lowered: ValType,
): ValType {
  if (!ctx.standalone || ts.isFunctionDeclaration(fn)) return lowered;
  const prop = fn.parent;
  if (!ts.isPropertyAssignment(prop) || prop.initializer !== fn) return lowered;
  if (!ts.isObjectLiteralExpression(prop.parent) || !isProxyHandlerLiteral(prop.parent)) return lowered;
  return widenMixedUndefinedReturn(retType, lowered);
}
