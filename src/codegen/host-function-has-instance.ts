// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4771) JS-host lane `%Function.prototype%[@@hasInstance]`.
 *
 * ES2015 §20.2.3.6 gives every function ONE inherited `@@hasInstance` method
 * whose body is `OrdinaryHasInstance(this, V)`. A compiled closure is a WasmGC
 * struct with no JS prototype chain, so `f[Symbol.hasInstance]` resolves to
 * nothing and the method CALL lowers to a null callee — which traps as
 * "dereferencing a null pointer" rather than answering the predicate.
 *
 * #4676 / #4739 fixed the STANDALONE twin by minting a native method closure on
 * the host-free Function prototype glue; that whole path is gated on
 * `ctx.standalone`, so the host lane never sees it. On the host lane the
 * semantics already exist in the `__instanceof_check` predicate — the very same
 * §13.10.2 + §7.3.20 tri-state (0 false / 1 true / 2 TypeError) that the
 * `instanceof` OPERATOR is lowered onto. This module points the method call
 * straight at it with the operands swapped, so each lane keeps exactly ONE
 * OrdinaryHasInstance implementation.
 *
 * Why this cannot recurse: `_instanceofResult` step 2 decides "default vs
 * custom handler" by reading `target[Symbol.hasInstance]` as an ordinary host
 * property and comparing it against `Function.prototype[Symbol.hasInstance]`.
 * This arm materialises no per-function value and installs no property, so a
 * compiled closure still reads `undefined` there and takes the default branch —
 * the failure mode that killed the runtime-only attempt (a bridge value that
 * step 2 classified as CUSTOM and then called back into itself) cannot arise.
 *
 * Identity (`f[Symbol.hasInstance] === g[Symbol.hasInstance]`, §20.2.3.6) holds
 * for the same reason: the call form is a direct lowering, not a value, so no
 * two functions can disagree about a method object that is never minted.
 */

import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, resolveComputedKeyExpression, skipTransparentExpressions } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitInstanceofThrowGuard } from "./expressions/identifiers.js";
import { FUNCTION_PROTO_HAS_INSTANCE_MEMBER } from "./function-proto-has-instance.js";
import { noJsHost } from "./js-errors.js";

/**
 * Does this element access spell the inherited `@@hasInstance` method of a
 * receiver the checker certifies as a function (or of `Function.prototype`
 * itself)? A shadowed `Symbol` / `Function` binding, or any receiver whose
 * callability is not statically known, declines — those keep the dynamic path.
 */
function isInheritedFunctionHasInstanceAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemAccess: ts.ElementAccessExpression,
): boolean {
  if (noJsHost(ctx) || fctx.localMap.has("Symbol")) return false;
  if (resolveComputedKeyExpression(ctx, elemAccess.argumentExpression) !== FUNCTION_PROTO_HAS_INSTANCE_MEMBER) {
    return false;
  }
  const receiver = skipTransparentExpressions(elemAccess.expression);
  const fact = ctx.oracle.typeFactOf(receiver);
  if (fact.kind === "function") return true;
  if (fact.kind === "builtin" && fact.name === "Function") return true;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "prototype" &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === "Function" &&
    !fctx.localMap.has("Function") &&
    !(fctx.boxedCaptures?.has("Function") ?? false)
  );
}

/**
 * Lower `f[Symbol.hasInstance](v)` on the JS-host lane to the host
 * OrdinaryHasInstance predicate. Returns `undefined` to decline, leaving the
 * generic callable-element path (and every other lane) untouched.
 *
 * Evaluation order is source order — receiver, then every argument left to
 * right — even though only the first argument reaches the one-parameter
 * `@@hasInstance` operation; the rest are evaluated for their side effects and
 * discarded, as a call to a 1-ary function does.
 */
export function tryEmitHostFunctionHasInstanceCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | undefined {
  if (!isInheritedFunctionHasInstanceAccess(ctx, fctx, elemAccess)) return undefined;

  // Reserve the import BEFORE any operand is compiled: `ensureLateImport`
  // shifts every already-emitted funcidx, and `flushLateImportShifts` can only
  // repair bodies that exist when it runs.
  const checkIdx = ensureLateImport(
    ctx,
    "__instanceof_check",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  if (checkIdx === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);

  const receiverType = compileExpression(ctx, fctx, elemAccess.expression, { kind: "externref" });
  if (receiverType === null) return undefined;
  if (receiverType.kind !== "externref") coerceType(ctx, fctx, receiverType, { kind: "externref" });
  const targetLocal = allocLocal(fctx, `__has_instance_target_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: targetLocal });

  const valueLocal = allocLocal(fctx, `__has_instance_value_${fctx.locals.length}`, { kind: "externref" });
  if (expr.arguments.length > 0) {
    const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
  } else {
    // No argument: V is `undefined`, which OrdinaryHasInstance step 3 answers
    // `false` for without ever reading `this.prototype`.
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: valueLocal });
  for (let i = 1; i < expr.arguments.length; i++) {
    const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }

  // `__instanceof_check(V, C)` — the operator's operand order, which is the
  // reverse of the method's (`C` is the receiver, `V` the argument).
  fctx.body.push({ op: "local.get", index: valueLocal });
  fctx.body.push({ op: "local.get", index: targetLocal });
  fctx.body.push({ op: "call", funcIdx: checkIdx });
  // Turns the `2` sentinel into a wasm-originated TypeError; a host-thrown one
  // would lose its identity crossing the wasm catch boundary.
  emitInstanceofThrowGuard(ctx, fctx);
  return { kind: "i32", boolean: true };
}
