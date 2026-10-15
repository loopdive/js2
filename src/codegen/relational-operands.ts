// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Operand compilation for `emitAnyRelational` (the §7.2.13 runtime-dispatched
 * relational), plus the #6999 numeric shortcut.
 *
 * The cascade needs both operands as externref temps (a runtime string must stay
 * boxed so `__typeof_string` can see it). Compiling straight to externref is
 * what the cascade has always done, and it is what every caller still gets by
 * default — byte-for-byte.
 *
 * #6999 opened the cascade to every `any`/`unknown` relational on host-free
 * targets. Statically that is all we know, but codegen often knows more: an
 * untyped `this.pos < this.input.length` in a typed-`this` twin compiles both
 * sides to `f64` (#3765). Boxing those to externref only to run ToPrimitive and
 * `__typeof_string` on two numbers would put three calls into the hottest loop
 * of a tokenizer. With `numericShortcut` the operands are compiled at their
 * natural type first; when BOTH come out as Wasm numbers the comparison is a
 * plain `f64.<op>` (§7.2.13 on two Numbers), and only otherwise are they boxed
 * for the cascade.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };

function f64RelOp(op: ts.SyntaxKind): "f64.lt" | "f64.le" | "f64.gt" | "f64.ge" {
  if (op === ts.SyntaxKind.LessThanToken) return "f64.lt";
  if (op === ts.SyntaxKind.LessThanEqualsToken) return "f64.le";
  if (op === ts.SyntaxKind.GreaterThanToken) return "f64.gt";
  return "f64.ge";
}

/** A Wasm number whose ToNumber is the value itself (symbols must still throw). */
function isWasmNumber(t: ValType): boolean {
  return t.kind === "f64" || (t.kind === "i32" && t.symbol !== true);
}

/**
 * Leave both operands in externref temps and return them, or return `null` when
 * the comparison is already complete on the stack (an i32 — the numeric
 * shortcut, or a failed operand compile).
 */
export function compileRelationalOperandsToExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  numericShortcut: boolean,
): { lTmp: number; rTmp: number } | null {
  if (!numericShortcut) {
    const lType = compileExpression(ctx, fctx, expr.left, EXTERNREF);
    if (!lType) return null;
    if (lType.kind !== "externref") coerceType(ctx, fctx, lType, EXTERNREF);
    const lTmp = allocTempLocal(fctx, EXTERNREF);
    fctx.body.push({ op: "local.set", index: lTmp });
    const rType = compileExpression(ctx, fctx, expr.right, EXTERNREF);
    if (!rType) {
      releaseTempLocal(fctx, lTmp);
      return null;
    }
    if (rType.kind !== "externref") coerceType(ctx, fctx, rType, EXTERNREF);
    const rTmp = allocTempLocal(fctx, EXTERNREF);
    fctx.body.push({ op: "local.set", index: rTmp });
    return { lTmp, rTmp };
  }

  const lType = compileExpression(ctx, fctx, expr.left);
  if (!lType) return null;
  const lRaw = allocTempLocal(fctx, lType);
  fctx.body.push({ op: "local.set", index: lRaw });
  const rType = compileExpression(ctx, fctx, expr.right);
  if (!rType) {
    releaseTempLocal(fctx, lRaw);
    return null;
  }
  const rRaw = allocTempLocal(fctx, rType);
  fctx.body.push({ op: "local.set", index: rRaw });
  const numeric = isWasmNumber(lType) && isWasmNumber(rType);
  const target: ValType = numeric ? { kind: "f64" } : EXTERNREF;
  const temps: number[] = [];
  for (const [raw, type] of [
    [lRaw, lType],
    [rRaw, rType],
  ] as const) {
    fctx.body.push({ op: "local.get", index: raw });
    if (type.kind !== target.kind) coerceType(ctx, fctx, type, target);
    if (numeric) continue;
    const tmp = allocTempLocal(fctx, EXTERNREF);
    fctx.body.push({ op: "local.set", index: tmp });
    temps.push(tmp);
  }
  releaseTempLocal(fctx, rRaw);
  releaseTempLocal(fctx, lRaw);
  if (numeric) {
    fctx.body.push({ op: f64RelOp(op) });
    return null;
  }
  return { lTmp: temps[0]!, rTmp: temps[1]! };
}
