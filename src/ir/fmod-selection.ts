// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { TsCheckerOracle, type TypeOracle } from "../checker/oracle.js";
import { staticIntegerRange } from "./analysis/static-numeric-range.js";
import { FMOD_EARLY_MAGNITUDE_FN, FMOD_FN } from "../codegen/fmod.js";
import { ts } from "../ts-api.js";
import { peelExpr } from "./analysis/i32-slots.js";
import { irIntrinsicFuncRef } from "./callable-bindings.js";

export { FMOD_FN };

// Small/indexing divisors (`% 3`, `% 4`, `% 10000`) normally fail an early
// magnitude check, so retain #4150's integral-first helper for them. Large
// static divisors are the rolling-accumulator regime where |a| < |b| is common.
const EARLY_MAGNITUDE_MIN_ABS_DIVISOR = 2 ** 16;

function numericLiteralValue(expression: ts.Expression): number | undefined {
  const inner = peelExpr(expression);
  if (ts.isNumericLiteral(inner)) return Number(inner.text.replace(/_/g, ""));
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  ) {
    return -Number(inner.operand.text.replace(/_/g, ""));
  }
  return undefined;
}

/** Select the exact remainder helper without matching source or benchmark identities. */
export function fmodRefFor(rhs: ts.Expression, checker?: ts.TypeChecker, oracle?: TypeOracle) {
  if (process.env.JS2WASM_FMOD_EARLY_MAGNITUDE === "0") return irIntrinsicFuncRef(FMOD_FN);

  const literal = numericLiteralValue(rhs);
  let divisor = literal !== undefined && Number.isSafeInteger(literal) ? literal : undefined;
  // (#4218) Prefer the compile's backend-selected oracle; the ad-hoc
  // TsCheckerOracle wrap remains only as the no-oracle fallback.
  const rangeOracle = oracle ?? (checker ? new TsCheckerOracle(checker) : undefined);
  if (divisor === undefined && rangeOracle) {
    const range = staticIntegerRange({ oracle: rangeOracle }, rhs);
    if (range && range.min === range.max) divisor = range.min;
  }
  const symbol =
    divisor !== undefined && Math.abs(divisor) >= EARLY_MAGNITUDE_MIN_ABS_DIVISOR ? FMOD_EARLY_MAGNITUDE_FN : FMOD_FN;
  return irIntrinsicFuncRef(symbol);
}
