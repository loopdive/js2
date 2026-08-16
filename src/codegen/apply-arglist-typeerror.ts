// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4483 family A) `f.apply(thisArg, <primitive>)` → TypeError.
 *
 * §20.2.3.1 `Function.prototype.apply` step 4 calls `CreateListFromArrayLike`,
 * whose step 2 is: *"If Type(obj) is not Object, throw a TypeError exception."*
 * So `f.apply(null, true)`, `f.apply(null, NaN)`, `f.apply(null, '1,2,3')` and
 * `f.apply(null, Symbol())` all throw — **including the string**, which is
 * array-like but not an Object.
 *
 * `null` / `undefined` are the documented exception (step 3: "If argArray is
 * undefined or null, perform ... with an empty List"), so they must NOT throw.
 *
 * ## Base behaviour
 *
 * Measured on this branch's base with `runTest262File(…, "standalone")`:
 * `built-ins/Function/prototype/apply/argarray-not-object.js` failed with
 * "Expected a TypeError to be thrown but no exception was thrown at all" — the
 * generic apply lowering treated the primitive as a one-element argument list
 * (or ignored it) and called the function.
 *
 * ## Narrowing (absent-not-wrong)
 *
 * The oracle must PROVE the argument is a primitive other than null/undefined.
 * `any`, unions, objects, arrays, `arguments` and everything unresolvable
 * DECLINE — a wrong throw here would break working programs, and the existing
 * lowerings stay in charge of every shape this file does not claim. A boxed
 * `new Number(1)` is an object type and never matches.
 *
 * Evaluation order follows the spec: the receiver and both arguments are
 * evaluated (for their side effects) before the throw.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { TypeFact } from "../checker/oracle.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./js-errors.js";
import { compileExpression } from "./shared.js";

/** Primitive kinds for which §20.2.3.1 step 4 throws (null/undefined excluded). */
function isThrowingArgArrayFact(fact: TypeFact): boolean {
  switch (fact.kind) {
    case "number":
    case "boolean":
    case "string":
    case "symbol":
    case "bigint":
      return true;
    default:
      return false;
  }
}

/**
 * Emit the §20.2.3.1 step-4 TypeError for `f.apply(thisArg, <primitive>)`, or
 * return undefined to leave the call to the existing lowerings.
 */
export function tryEmitApplyArgArrayTypeError(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  if (propAccess.name.text !== "apply") return undefined;
  if (expr.arguments.length !== 2) return undefined;
  const argArray = expr.arguments[1]!;
  if (!isThrowingArgArrayFact(ctx.oracle.typeFactOf(argArray))) return undefined;

  // Spec order: receiver, thisArg, argArray — all evaluated, then the throw.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType) fctx.body.push({ op: "drop" });
  const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
  if (thisType) fctx.body.push({ op: "drop" });
  const argType = compileExpression(ctx, fctx, argArray);
  if (argType) fctx.body.push({ op: "drop" });

  emitThrowTypeError(ctx, fctx, "CreateListFromArrayLike called on non-object");
  return { kind: "externref" };
}
