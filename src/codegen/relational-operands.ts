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
import {
  compileToPrimitiveCascadeOperand,
  type RawToPrimitiveOperand,
  tryCompileClassToPrimitiveOperand,
} from "./classes/class-symbol-to-primitive-operand.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };

/** One cascade operand: its externref temp, plus a raw class operand still owed ToPrimitive (#6982). */
export interface CascadeOperand {
  tmp: number;
  raw?: RawToPrimitiveOperand;
}

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

type NaturalOperand = { raw: RawToPrimitiveOperand } | { local: number; type: ValType };

/** Compile one operand at its natural type into a temp (a #6982 class operand stays raw). */
function compileNatural(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): NaturalOperand | null {
  const raw = tryCompileClassToPrimitiveOperand(ctx, fctx, expr);
  if (raw) return { raw };
  const type = compileExpression(ctx, fctx, expr);
  if (!type) return null;
  const local = allocTempLocal(fctx, type);
  fctx.body.push({ op: "local.set", index: local });
  return { local, type };
}

function releaseNatural(fctx: FunctionContext, o: NaturalOperand): void {
  releaseTempLocal(fctx, "raw" in o ? o.raw.local : o.local);
}

/** Box a natural operand into an externref cascade temp. */
function toCascade(ctx: CodegenContext, fctx: FunctionContext, o: NaturalOperand): CascadeOperand {
  if ("raw" in o) return { tmp: allocTempLocal(fctx, EXTERNREF), raw: o.raw };
  fctx.body.push({ op: "local.get", index: o.local });
  if (o.type.kind !== "externref") coerceType(ctx, fctx, o.type, EXTERNREF);
  releaseTempLocal(fctx, o.local);
  const tmp = allocTempLocal(fctx, EXTERNREF);
  fctx.body.push({ op: "local.set", index: tmp });
  return { tmp };
}

/**
 * Compile both operands for the cascade and return them, or return `null` when
 * the comparison is already complete on the stack (an i32 — the numeric
 * shortcut, or a failed operand compile).
 */
export function compileRelationalOperands(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  numericShortcut: boolean,
): { l: CascadeOperand; r: CascadeOperand } | null {
  if (!numericShortcut) {
    const l = compileToPrimitiveCascadeOperand(ctx, fctx, expr.left);
    if (!l) return null;
    const r = compileToPrimitiveCascadeOperand(ctx, fctx, expr.right);
    if (!r) {
      releaseTempLocal(fctx, l.tmp);
      return null;
    }
    return { l, r };
  }

  const l = compileNatural(ctx, fctx, expr.left);
  if (!l) return null;
  const r = compileNatural(ctx, fctx, expr.right);
  if (!r) {
    releaseNatural(fctx, l);
    return null;
  }
  if ("type" in l && "type" in r && isWasmNumber(l.type) && isWasmNumber(r.type)) {
    for (const o of [l, r]) {
      fctx.body.push({ op: "local.get", index: o.local });
      if (o.type.kind !== "f64") coerceType(ctx, fctx, o.type, { kind: "f64" });
      releaseTempLocal(fctx, o.local);
    }
    fctx.body.push({ op: f64RelOp(op) });
    return null;
  }
  return { l: toCascade(ctx, fctx, l), r: toCascade(ctx, fctx, r) };
}
