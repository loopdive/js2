// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * An equality (`==` / `!=` / `===` / `!==`) one of whose operands is statically
 * `void` / `undefined` / `never`.
 *
 * ## The defect
 *
 * Such an operand compiles to NO value, so `compileBinaryExpression` fell out
 * at its `if (!leftType || !rightType) return null` bail-out — after it had
 * already emitted the operand code. The caller reads `null` as "not handled",
 * **rolls that code back**, and substitutes the statically-correct constant. The
 * answer is right and the operands are gone:
 *
 * ```js
 * var calls = 0;
 * var u = function () { calls++; };
 * u() == 1;            // calls === 0 — the call was never emitted
 * ```
 *
 * §13.11.1 evaluates BOTH operands before comparing, so this is silent
 * wrong-code, not just a missed optimisation. It bites hardest where the void
 * type is inferred rather than written: TypeScript gives
 * `function () { throw "x"; }` the type `() => never`, which is exactly the
 * shape of the ES5 evaluation-order tests —
 * `language/expressions/{equals,does-not-equals,strict-equals,
 * strict-does-not-equals}/S11.9.*_A2.4_T2.js`. Those report
 * `Actual: [object Object]`, which is a red herring: nothing throws at all, so
 * what gets caught is the Test262Error the *next* line raises.
 *
 * `+`, `<`, `in` and `instanceof` were never affected — they coerce, so their
 * operands always produce a value.
 *
 * ## The fold
 *
 * `undefined` is equal (loosely and strictly) only to `undefined`, and loosely
 * also to `null`. So with the counter-operand proven non-nullish the result is
 * decidable, and the only thing missing was the evaluation. This mirrors the
 * BigInt-vs-Number strict-equality fold in the same file: compile both sides,
 * drop whatever they produced, then push the constant.
 *
 * A counter-operand that is `any` / `unknown` / nullable is NOT folded — it
 * keeps the previous `return null`, so nothing that worked before moves.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { FunctionContext } from "./context/types.js";

const VOID_LIKE = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never;
const NOT_DECIDABLE = VOID_LIKE | ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown;

const IS_EQ = new Set<ts.SyntaxKind>([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken]);
const IS_NEQ = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * The whole answer for the `!leftType || !rightType` bail-out in
 * `compileBinaryExpression`: emit the folded equality when this is one, or
 * `null` to keep the caller's historical "not handled" return.
 *
 * `leftType` / `rightType` are the operands' compiled result types — `null`
 * meaning "produced no value". Whichever side DID produce one still has it on
 * the stack, so it is dropped here before the constant goes on.
 */
export function foldVoidOperandEquality(
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  leftType: ValType | null,
  rightType: ValType | null,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
): ValType | null {
  const isEq = IS_EQ.has(op);
  if (!isEq && !IS_NEQ.has(op)) return null;
  const leftVoid = leftType === null && (leftTsType.flags & VOID_LIKE) !== 0;
  const rightVoid = rightType === null && (rightTsType.flags & VOID_LIKE) !== 0;
  if (!leftVoid && !rightVoid) return null;
  const bothVoid = leftVoid && rightVoid;
  // The surviving side has to be provably non-nullish: `undefined == null` is
  // true, and an `any` operand is not decidable at all.
  if (!bothVoid && ((leftVoid ? rightTsType : leftTsType).flags & NOT_DECIDABLE) !== 0) return null;
  if (leftType) fctx.body.push({ op: "drop" });
  if (rightType) fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: bothVoid === isEq ? 1 : 0 });
  return { kind: "i32" };
}
