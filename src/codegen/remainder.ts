// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  remainderFastPathPlan,
  UNKNOWN_REMAINDER_FAST_PATH,
  type RemainderFastPathPlan,
} from "../ir/analysis/remainder-fast-path.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureFmod } from "./fmod.js";

const I64_MIN = -(2 ** 63);
const I64_MAX_EXCLUSIVE = 2 ** 63;

/** Compile a numeric `%` after its two f64 operands have been pushed. */
export function compileModulo(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  emitModulo(ctx, fctx, remainderFastPathPlan(ctx, expr.left, expr.right));
  return { kind: "f64" };
}

/**
 * Emit exact JS Number remainder with an AOT-proven or guarded signed-i64 path.
 * Stack: [left_f64, right_f64] -> [result_f64].
 */
export function emitModulo(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plan: RemainderFastPathPlan = UNKNOWN_REMAINDER_FAST_PATH,
): void {
  if (plan.kind === "none") {
    fctx.body.push({ op: "call", funcIdx: ensureFmod(ctx) });
    return;
  }

  const right = allocTempLocal(fctx, { kind: "f64" });
  const left = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: right }, { op: "local.set", index: left });
  const fast = fastRemainder(left, right);

  if (plan.kind === "direct-i64") {
    fctx.body.push(...fast);
  } else {
    emitGuardedRemainder(ctx, fctx, left, right, fast, plan);
  }

  releaseTempLocal(fctx, left);
  releaseTempLocal(fctx, right);
}

function fastRemainder(left: number, right: number): Instr[] {
  return [
    { op: "local.get", index: left },
    { op: "i64.trunc_f64_s" },
    { op: "local.get", index: right },
    { op: "i64.trunc_f64_s" },
    { op: "i64.rem_s" },
    { op: "f64.convert_i64_s" },
    { op: "local.get", index: left },
    { op: "f64.copysign" },
  ];
}

function emitGuardedRemainder(
  ctx: CodegenContext,
  fctx: FunctionContext,
  left: number,
  right: number,
  fast: Instr[],
  plan: Extract<RemainderFastPathPlan, { kind: "guarded-i64" }>,
): void {
  let hasCondition = false;
  const appendClause = (clause: Instr[]): void => {
    fctx.body.push(...clause);
    if (hasCondition) fctx.body.push({ op: "i32.and" });
    hasCondition = true;
  };

  if (plan.checkLeftIntegerRange) appendClause(integerRangeGuard(left));
  if (plan.checkRightIntegerRange) appendClause(integerRangeGuard(right));
  if (plan.checkDivisorNonZero) {
    appendClause([{ op: "local.get", index: right }, { op: "f64.const", value: 0 }, { op: "f64.ne" }]);
  }
  if (plan.checkSignedOverflow) appendClause(signedOverflowGuard(left, right));

  if (!hasCondition) {
    fctx.body.push(...fast);
    return;
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: fast,
    else: [
      { op: "local.get", index: left },
      { op: "local.get", index: right },
      { op: "call", funcIdx: ensureFmod(ctx) },
    ],
  });
}

function integerRangeGuard(local: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "f64.trunc" },
    { op: "local.get", index: local },
    { op: "f64.eq" },
    { op: "local.get", index: local },
    { op: "f64.const", value: I64_MIN },
    { op: "f64.ge" },
    { op: "i32.and" },
    { op: "local.get", index: local },
    { op: "f64.const", value: I64_MAX_EXCLUSIVE },
    { op: "f64.lt" },
    { op: "i32.and" },
  ];
}

function signedOverflowGuard(left: number, right: number): Instr[] {
  return [
    { op: "local.get", index: left },
    { op: "f64.const", value: I64_MIN },
    { op: "f64.eq" },
    { op: "local.get", index: right },
    { op: "f64.const", value: -1 },
    { op: "f64.eq" },
    { op: "i32.and" },
    { op: "i32.eqz" },
  ];
}
