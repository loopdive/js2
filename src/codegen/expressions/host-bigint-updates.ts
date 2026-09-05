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
import { usesHostBigIntCarrier } from "../host-bigint-carrier.js";

/** Host BigInts must remain externref-backed in the JS-host lanes. */
export function isHostBigIntUpdate(ctx: CodegenContext, operand: ts.Expression): boolean {
  return usesHostBigIntCarrier(ctx) && ctx.oracle.staticJsTypeOf(operand) === "bigint";
}

/**
 * Apply one host BigInt binary operation to a value already on the stack.
 *
 * Struct fields and vector elements use this after their storage-specific
 * read. Keeping the operation here is important: the old member/element
 * paths converted every non-f64 value to f64 before doing `+ 1`, which is
 * lossy for arbitrary-width host BigInts. The callback stores the new
 * externref in the caller's storage and the return value is either the old
 * value (postfix) or the new value (prefix/compound assignment).
 */
export function emitHostBigIntBinaryOpFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  leftType: ValType,
  right: ts.Expression,
  opcode: number,
  returnOld: boolean,
  storeNew: (newValue: number) => void,
): ValType | null {
  const externref: ValType = { kind: "externref" };
  if (leftType.kind !== "externref") coerceType(ctx, fctx, leftType, externref);
  const leftValue = allocLocal(fctx, `__bigint_update_left_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: leftValue });

  const rightType = compileExpression(ctx, fctx, right, externref);
  if (!rightType) return null;
  if (rightType.kind !== "externref") coerceType(ctx, fctx, rightType, externref);
  const rightValue = allocLocal(fctx, `__bigint_update_right_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: rightValue });

  const imported = ensureLateImport(ctx, "__host_bigint_binop", [{ kind: "i32" }, externref, externref], [externref]);
  flushLateImportShifts(ctx, fctx);
  const finalIdx = ctx.funcMap.get("__host_bigint_binop") ?? imported;
  if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __host_bigint_binop");
  fctx.body.push(
    { op: "i32.const", value: opcode },
    { op: "local.get", index: leftValue },
    { op: "local.get", index: rightValue },
    { op: "call", funcIdx: finalIdx },
  );
  const newValue = allocLocal(fctx, `__bigint_update_result_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: newValue });
  storeNew(newValue);
  fctx.body.push({ op: "local.get", index: returnOld ? leftValue : newValue });
  return externref;
}

export function emitHostBigIntStructMemberIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  objTmp: number,
  structTypeIdx: number,
  fieldIdx: number,
  arithOp: "add" | "sub",
  mode: "prefix" | "postfix",
): ValType | null {
  const one = ts.factory.createBigIntLiteral("1");
  return emitHostBigIntBinaryOpFromStack(
    ctx,
    fctx,
    fieldType,
    one,
    arithOp === "add" ? 0 : 1,
    mode === "postfix",
    (newValue) => {
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newValue });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    },
  );
}

export function emitStructMemberIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  fieldType: ValType,
  objTmp: number,
  structTypeIdx: number,
  fieldIdx: number,
  arithOp: "add" | "sub",
  mode: "prefix" | "postfix",
): ValType | null {
  const f64Op = arithOp === "add" ? "f64.add" : "f64.sub";
  const i32Op = arithOp === "add" ? "i32.add" : "i32.sub";

  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  if (isHostBigIntUpdate(ctx, operand)) {
    return emitHostBigIntStructMemberIncDec(ctx, fctx, fieldType, objTmp, structTypeIdx, fieldIdx, arithOp, mode);
  }

  if (ctx.fast && fieldType.kind === "i32") {
    if (mode === "postfix") {
      // Save old value, compute new, store new, return old
      const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.tee", index: oldTmp });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: i32Op });
      const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: newTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newTmp });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldTmp });
      return { kind: "i32" };
    }
    // Compute new, store, return new
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: i32Op });
    const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: newTmp });
    fctx.body.push({ op: "local.get", index: objTmp });
    fctx.body.push({ op: "local.get", index: newTmp });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.get", index: newTmp });
    return { kind: "i32" };
  }

  // Default: f64 arithmetic
  if (fieldType.kind !== "f64") coerceType(ctx, fctx, fieldType, { kind: "f64" });

  if (mode === "postfix") {
    // Save old value, compute new, store, return old
    const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.tee", index: oldTmp });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: f64Op });
    if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
    const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.set", index: newTmp });
    fctx.body.push({ op: "local.get", index: objTmp });
    fctx.body.push({ op: "local.get", index: newTmp });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.get", index: oldTmp });
    return { kind: "f64" };
  }

  // Compute new, store, return new
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: f64Op });
  const newF64Tmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: newF64Tmp });
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "local.get", index: newF64Tmp });
  if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
  fctx.body.push({ op: "local.get", index: newF64Tmp });
  return { kind: "f64" };
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
