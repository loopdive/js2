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
import { coerceType } from "../shared.js";

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
