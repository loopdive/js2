// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T6) `new <alias-of-a-builtin-static>(…)` → TypeError.
 *
 * §10.3 built-in function objects only have a `[[Construct]]` internal method
 * when the definition says so, and no `<Namespace>.<staticMethod>` says so. So
 * `var f = String.fromCharCode; new f(65, 66)` must throw a TypeError
 * (test262 `built-ins/String/fromCharCode/S15.5.3.2_A4`).
 *
 * The reified builtin value is a closure struct with no constructor brand, and
 * the standalone `new` lowering's unknown-constructor path answered a null
 * externref instead — measured on the pre-fix base, both `new f(65,66)` (an
 * alias of `String.fromCharCode`) and `new m(1,2)` (an alias of `Math.max`)
 * evaluated to `object:null` with no throw.
 *
 * Scope: the two ALIAS spellings that reach a reified builtin static value —
 * the destructuring form (`const { max } = Math`, `resolveBuiltinStaticBindingAlias`)
 * and the plain form (`var f = String.fromCharCode`,
 * `resolveVariadicBuiltinStaticPlainAlias`). The DIRECT spelling
 * `new String.fromCharCode(…)` is equally non-constructable but goes through a
 * different callee shape; it is deliberately left to its existing path here so
 * this arm stays measurable in isolation.
 */

import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { compileExpression } from "../shared.js";
import { emitThrowTypeError } from "./helpers.js";
import { resolveBuiltinStaticBindingAlias } from "../builtin-static-globals.js";
import { resolveVariadicBuiltinStaticPlainAlias } from "../builtin-static-plain-alias.js";

/**
 * Returns an `externref` result when it handled (and threw for) the
 * construction; `undefined` when the callee is not an alias of a builtin static
 * and the caller must continue its own dispatch.
 *
 * Evaluation order follows §13.3.5.1: the constructor expression first, then the
 * argument list, then the throw.
 */
export function tryNewBuiltinStaticAlias(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isNonNullExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  const alias = resolveBuiltinStaticBindingAlias(ctx, callee) ?? resolveVariadicBuiltinStaticPlainAlias(ctx, callee);
  if (alias === undefined) return undefined;

  const calleeType = compileExpression(ctx, fctx, callee);
  if (calleeType) fctx.body.push({ op: "drop" });
  for (const arg of expr.arguments ?? []) {
    const argType = compileExpression(ctx, fctx, ts.isSpreadElement(arg) ? arg.expression : arg);
    if (argType) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, `${alias.builtinName}.${alias.propName} is not a constructor`);
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
