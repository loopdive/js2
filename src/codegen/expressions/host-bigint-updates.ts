// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * JS-host BigInt update expressions. Host BigInts use externref so the host
 * can retain arbitrary precision; this helper keeps identifier `++`/`--`
 * values out of the legacy f64/i64 update paths.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { emitIdentifierWriteFromLocal } from "./assignment.js";
import { coerceType, compileExpression } from "../shared.js";

/** Host BigInts must remain externref-backed in the JS-host lanes. */
export function isHostBigIntUpdate(ctx: CodegenContext, operand: ts.Expression): boolean {
  return !ctx.standalone && !ctx.wasi && ctx.oracle.staticJsTypeOf(operand) === "bigint";
}

/** Compile an identifier update through the host BigInt binary operation. */
export function compileHostBigIntIdentifierUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Identifier,
  isIncrement: boolean,
  isPostfix: boolean,
): ValType | null {
  const externref: ValType = { kind: "externref" };
  let oldLocal: number | undefined;

  // Evaluate the old value exactly once. Keep it in an externref local because
  // host BigInts are arbitrary-width JS values; no f64/i64 conversion may occur
  // on this path. Prefix updates also need the value for the binary operation.
  const oldType = compileExpression(ctx, fctx, target, externref);
  if (!oldType) return null;
  if (oldType.kind !== "externref") coerceType(ctx, fctx, oldType, externref);
  const oldValue = allocLocal(fctx, `__bigint_update_value_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: oldValue });
  if (isPostfix) {
    oldLocal = allocLocal(fctx, `__bigint_update_old_${fctx.locals.length}`, externref);
    fctx.body.push({ op: "local.get", index: oldValue }, { op: "local.set", index: oldLocal });
  }

  // Compile 1n directly with an externref expectation. Building a synthetic
  // `target + 1n` AST makes the checker see the synthetic literal as `number`,
  // which routes the real BigInt target through __unbox_number/i64 and truncates
  // wide values. Dispatch the already-evaluated operands through the same host
  // BigInt binary import used by ordinary pure-BigInt expressions instead.
  const one = ts.factory.createBigIntLiteral("1");
  const oneType = compileExpression(ctx, fctx, one, externref);
  if (!oneType) return null;
  if (oneType.kind !== "externref") coerceType(ctx, fctx, oneType, externref);
  const oneLocal = allocLocal(fctx, `__bigint_update_one_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: oneLocal });

  const imported = ensureLateImport(ctx, "__host_bigint_binop", [{ kind: "i32" }, externref, externref], [externref]);
  flushLateImportShifts(ctx, fctx);
  const finalIdx = ctx.funcMap.get("__host_bigint_binop") ?? imported;
  if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __host_bigint_binop");
  fctx.body.push(
    { op: "i32.const", value: isIncrement ? 0 : 1 },
    { op: "local.get", index: oldValue },
    { op: "local.get", index: oneLocal },
    { op: "call", funcIdx: finalIdx },
  );
  const newValue = allocLocal(fctx, `__bigint_update_new_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: newValue });

  // Write through the canonical identifier storage helper so local, boxed
  // capture, captured-global, and module-global bindings retain their existing
  // synchronization semantics. The helper consumes no stack value.
  emitIdentifierWriteFromLocal(ctx, fctx, target, newValue);

  if (isPostfix) {
    // The assignment result is the new value; discard it and restore the old
    // value required by postfix semantics.
    fctx.body.push({ op: "local.get", index: oldLocal! });
  } else {
    fctx.body.push({ op: "local.get", index: newValue });
  }
  return externref;
}
