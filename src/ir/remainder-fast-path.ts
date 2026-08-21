// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { RemainderFastPathPlan } from "./analysis/remainder-fast-path.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrFuncRef, type IrValueId } from "./nodes.js";

const I64_MIN = -(2 ** 63);
const I64_MAX_EXCLUSIVE = 2 ** 63;

/** Emit the IR form of an AOT-proven or guarded signed-i64 remainder. */
export function emitNumberRemainder(
  builder: IrFunctionBuilder,
  lhs: IrValueId,
  rhs: IrValueId,
  plan: RemainderFastPathPlan,
  exactFallbackTarget: IrFuncRef,
): IrValueId {
  const f64 = irVal({ kind: "f64" });
  const i64 = irVal({ kind: "i64" });
  const i32 = irVal({ kind: "i32" });

  const exactFallback = (): IrValueId => {
    const result = builder.emitCall(exactFallbackTarget, [lhs, rhs], f64);
    if (result === null) throw new Error("ir/remainder-fast-path: exact fallback produced no value");
    return result;
  };

  const fastI64 = (): IrValueId => {
    const leftI64 = builder.emitUnary("i64.trunc_f64_s", lhs, i64);
    const rightI64 = builder.emitUnary("i64.trunc_f64_s", rhs, i64);
    const remainder = builder.emitBinary("i64.rem_s", leftI64, rightI64, i64);
    const numeric = builder.emitUnary("f64.convert_i64_s", remainder, f64);
    return builder.emitBinary("f64.copysign", numeric, lhs, f64);
  };

  if (plan.kind === "none") return exactFallback();
  if (plan.kind === "direct-i64") return fastI64();

  let condition: IrValueId | undefined;
  const andCondition = (clause: IrValueId): void => {
    condition = condition === undefined ? clause : builder.emitBinary("i32.and", condition, clause, i32);
  };
  const addIntegerRangeGuard = (value: IrValueId): void => {
    const integral = builder.emitBinary("f64.eq", builder.emitUnary("f64.trunc", value, f64), value, i32);
    const lower = builder.emitBinary("f64.ge", value, builder.emitConst({ kind: "f64", value: I64_MIN }, f64), i32);
    const upper = builder.emitBinary(
      "f64.lt",
      value,
      builder.emitConst({ kind: "f64", value: I64_MAX_EXCLUSIVE }, f64),
      i32,
    );
    andCondition(builder.emitBinary("i32.and", integral, lower, i32));
    andCondition(upper);
  };

  if (plan.checkLeftIntegerRange) addIntegerRangeGuard(lhs);
  if (plan.checkRightIntegerRange) addIntegerRangeGuard(rhs);
  if (plan.checkDivisorNonZero) {
    andCondition(builder.emitBinary("f64.ne", rhs, builder.emitConst({ kind: "f64", value: 0 }, f64), i32));
  }
  if (plan.checkSignedOverflow) {
    const minDividend = builder.emitBinary("f64.eq", lhs, builder.emitConst({ kind: "f64", value: I64_MIN }, f64), i32);
    const negativeOneDivisor = builder.emitBinary(
      "f64.eq",
      rhs,
      builder.emitConst({ kind: "f64", value: -1 }, f64),
      i32,
    );
    const overflow = builder.emitBinary("i32.and", minDividend, negativeOneDivisor, i32);
    andCondition(builder.emitUnary("i32.eqz", overflow, i32));
  }
  if (condition === undefined) return fastI64();

  let thenValue!: IrValueId;
  const thenBody = builder.collectBodyInstrs(() => {
    thenValue = fastI64();
  });
  let elseValue!: IrValueId;
  const elseBody = builder.collectBodyInstrs(() => {
    elseValue = exactFallback();
  });
  return builder.emitIfElse({ cond: condition, then: thenBody, thenValue, else: elseBody, elseValue, resultType: f64 });
}
