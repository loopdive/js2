// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) The satellite's bitwise/shift PRODUCER rule.
//
// Every JavaScript bitwise and shift operator is a *numeric* producer: the
// abstract operation applies ToInt32/ToUint32 to both operands and yields a
// 32-bit integer. The shared lattice core already knows this — see the `#1126
// Stage 2` arms in `propagate.ts` — but it only says so when
// `JS2WASM_IR_I32_DOMAIN=1`, because on the MAIN map an `i32` fact is an
// instruction-selection promise the emitter has not yet shipped (Stage 3).
//
// The satellite has no such obligation. Its single consumer
// (`src/codegen/fnctor-ctor-param-types.ts`) treats `i32`/`u32` exactly like
// `f64` — they are numeric subdomains and lower to the same f64 slot — so here
// the fact is only ever read as "this is a number". That asymmetry is the whole
// reason this module exists rather than the satellite flipping the core's env
// flag: flipping it would change the always-on `IrUnitTypeMap` and break #1712
// byte-parity, while an `InferExtension` is invisible to every caller that does
// not pass one.
//
// The rule here is also STRICTER-typed and WIDER than the core's, deliberately:
// the core demands `f64Compatible` on BOTH operands, which is a stronger
// precondition than the semantics need (`"abc" | 0`, `undefined | 0` and
// `({}) | 0` are all perfectly good Int32s). See `provablyNotBigInt` for the
// one thing that genuinely has to be excluded.
import { ts } from "../ts-api.js";
import type { InferExtension, LatticeType } from "./propagate.js";

const I32: LatticeType = { kind: "i32" };
const U32: LatticeType = { kind: "u32" };

/**
 * BigInt is the ONLY reason a bitwise operator can produce a non-number, and it
 * is why this rule is not unconditional.
 *
 * `ApplyStringOrNumericBinaryOperator` computes `ToNumeric` on both operands and
 * throws a TypeError when the two results are of different types. So:
 *
 *  - if **either** operand is provably a Number, the expression either throws
 *    (no value flows anywhere, so no fact is needed) or both operands were
 *    Numbers and the result is an Int32/Uint32. That is the guard below.
 *  - if both operands are `dynamic`/`unknown`, both could be BigInts and the
 *    result is a BigInt — which this lattice has no atom for and which would be
 *    stored into an f64 field slot. DYNAMIC is the honest answer.
 *
 * `string` and `bool` count as proof: `ToNumeric` of either is always a Number.
 * `object` does NOT — `ToPrimitive` runs user code (`Symbol.toPrimitive`,
 * `valueOf`) and may hand back a BigInt, and the satellite's `object` atoms
 * include instance shapes of constructors in the module under analysis, which
 * can define exactly those methods. `unknown` is lattice BOTTOM (no contribution
 * observed yet), never evidence.
 */
export function provablyNotBigInt(t: LatticeType): boolean {
  return t.kind === "f64" || t.kind === "i32" || t.kind === "u32" || t.kind === "bool" || t.kind === "string";
}

/** `& | ^ << >>` and their compound-assignment twins → Int32. */
function isInt32Producer(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
  );
}

/**
 * `>>>` and `>>>=` → Uint32, with NO operand precondition.
 *
 * Unsigned right shift is the one bitwise operator BigInt does not implement at
 * all: `BigInt::unsignedRightShift` unconditionally throws a TypeError. So
 * either the expression throws — and no value reaches a slot — or both operands
 * coerced to Numbers and the result is a Uint32. There is no third case, which
 * is why this arm skips the `provablyNotBigInt` guard the others need.
 */
function isUint32Producer(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

/**
 * Build the satellite's `InferExtension`.
 *
 * `evaluate` must recurse through the SAME extension — the caller closes over
 * the extension it is constructing so `(a | b) & c` and an operand three levels
 * down both get the rule. A recursion that drops the extension answers the
 * pre-extension type for that subtree and nothing fails loudly, so the nesting
 * fixtures in `tests/issue-743-i32-producers.test.ts` are load-bearing.
 *
 * Deliberately NOT in this slice:
 *  - integer classification of numeric LITERALS (the core's other `#1126
 *    Stage 2` producer). It would retype every `this.x = 0` seed from `f64` to
 *    `i32` across the whole satellite for no consumer-visible gain — the
 *    consumer collapses both to one f64 slot — while perturbing every joined
 *    fact in the corpus. The literal rule buys precision only once an emitter
 *    consumes `i32`, which is Stage 3's problem, not the satellite's.
 *  - `Math.imul` / `Math.clz32`, for the same reason plus zero sites on the
 *    dogfood corpus.
 */
export function createI32ProducerExtension(
  evaluate: (expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>) => LatticeType,
): InferExtension {
  return {
    tryInfer(expr, scope) {
      if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.TildeToken) {
        // `~1n` is `-2n`, a BigInt — so unary bitwise NOT needs the same proof
        // its binary siblings do, from its single operand.
        return provablyNotBigInt(evaluate(expr.operand, scope)) ? I32 : undefined;
      }
      if (!ts.isBinaryExpression(expr)) return undefined;
      const op = expr.operatorToken.kind;
      if (isUint32Producer(op)) return U32;
      if (!isInt32Producer(op)) return undefined;
      if (provablyNotBigInt(evaluate(expr.left, scope))) return I32;
      return provablyNotBigInt(evaluate(expr.right, scope)) ? I32 : undefined;
    },
  };
}
