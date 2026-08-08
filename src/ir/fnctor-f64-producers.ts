// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) The satellite's arithmetic F64-producer rule — `- * / % **`.
//
// The shared core's arithmetic arm demands `f64Compatible` on BOTH operands
// (`propagate.ts`, the `#1126 Stage 2` block), which is a stronger precondition
// than the semantics need: `"7" - 1`, `true * 2` and `x - 1` for ANY non-BigInt
// `x` are all Numbers. `ApplyStringOrNumericBinaryOperator` for these operators
// computes `ToNumeric` on both operands and throws when the two results are of
// different numeric types — so if EITHER operand is provably not a BigInt, the
// expression either throws (no value flows, any fact is vacuously sound) or
// both operands coerced to Numbers and the result is a Number. This is the
// same either-operand proof `fnctor-i32-producers.ts` uses, minus the Int32
// wrap (these operators do not truncate).
//
// `+` is deliberately ABSENT: it is the one operator that is string-or-number,
// and its handling lives in `plusJoin` / the core's plus arm.
//
// Satellite-only for the same reason as its siblings: the main map's facts are
// instruction-selection promises, while the satellite's single consumer reads
// `f64` as "this is a number". Where the core already answers F64 (both
// operands f64-compatible) this rule agrees; where the core answers DYNAMIC it
// refines — it can only lower a fact, never raise one.
//
// Measured motivation (#743 Parser.pos pin census, 2026-08-08): acorn's
// `this.pos += octalStr.length - 1` — `octalStr.length` is DYNAMIC (no string
// substrate), but the literal `1` alone proves the subtraction numeric.
import { ts } from "../ts-api.js";
import { provablyNotBigInt } from "./fnctor-i32-producers.js";
import type { InferExtension, LatticeType } from "./propagate.js";

const F64: LatticeType = { kind: "f64" };

/** `- * / % **` and their compound-assignment twins → Number. */
function isF64Producer(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.PercentEqualsToken ||
    op === ts.SyntaxKind.AsteriskAsteriskEqualsToken
  );
}

/**
 * Build the rule. `evaluate` must recurse through the composed extension —
 * see the nesting caveat on `createI32ProducerExtension`.
 */
export function createF64ProducerExtension(
  evaluate: (expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>) => LatticeType,
): InferExtension {
  return {
    tryInfer(expr, scope) {
      if (!ts.isBinaryExpression(expr)) return undefined;
      if (!isF64Producer(expr.operatorToken.kind)) return undefined;
      if (provablyNotBigInt(evaluate(expr.left, scope))) return F64;
      return provablyNotBigInt(evaluate(expr.right, scope)) ? F64 : undefined;
    },
  };
}
