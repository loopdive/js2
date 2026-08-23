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
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

const VOID_LIKE = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never;
const NOT_DECIDABLE = VOID_LIKE | ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown;

const IS_EQ = new Set<ts.SyntaxKind>([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken]);
const IS_NEQ = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Is the SURVIVING operand's static type provably never nullish, so the fold
 * below can decide the comparison without emitting one?
 *
 * (#4656) The flag test alone was wrong for a UNION: `number | undefined`
 * carries `TypeFlags.Union`, and `Union & NOT_DECIDABLE` is 0, so a
 * `void`-vs-`number|undefined` equality folded to the constant `false` even
 * when the value at hand actually WAS `undefined`. Look through the
 * constituents so any nullish member refuses the fold.
 */
function provablyNonNullish(t: ts.Type): boolean {
  if ((t.flags & NOT_DECIDABLE) !== 0) return false;
  if ((t.flags & ts.TypeFlags.Union) !== 0) {
    const members = (t as ts.UnionType).types;
    if (!Array.isArray(members)) return false;
    return members.every((m) => (m.flags & NOT_DECIDABLE) === 0);
  }
  return true;
}

/** Operand types to CONTINUE the ordinary typed dispatch with (#4656). */
export interface MaterializedVoidOperands {
  left: ValType;
  right: ValType;
}

/**
 * The whole answer for the `!leftType || !rightType` bail-out in
 * `compileBinaryExpression`. Three outcomes:
 *
 * - a `ValType` — the equality was decidable and the constant is emitted;
 * - a `MaterializedVoidOperands` — not decidable, but `undefined` has been
 *   materialised for the void side, so the caller CONTINUES with these types;
 * - `null` — keep the caller's historical "not handled" return.
 *
 * `leftType` / `rightType` are the operands' compiled result types — `null`
 * meaning "produced no value". Whichever side DID produce one still has it on
 * the stack, so it is dropped here before a constant goes on.
 */
export function foldVoidOperandEquality(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  leftType: ValType | null,
  rightType: ValType | null,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
): ValType | MaterializedVoidOperands | null {
  const isEq = IS_EQ.has(op);
  if (!isEq && !IS_NEQ.has(op)) return null;
  const leftVoid = leftType === null && (leftTsType.flags & VOID_LIKE) !== 0;
  const rightVoid = rightType === null && (rightTsType.flags & VOID_LIKE) !== 0;
  if (!leftVoid && !rightVoid) return null;
  const bothVoid = leftVoid && rightVoid;
  // The surviving side has to be provably non-nullish: `undefined == null` is
  // true, and an `any` operand is not decidable at all.
  if (!bothVoid && !provablyNonNullish(leftVoid ? rightTsType : leftTsType)) {
    return materializeVoidOperandEquality(ctx, fctx, leftType, rightType, leftVoid, rightVoid);
  }
  if (leftType) fctx.body.push({ op: "drop" });
  if (rightType) fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: bothVoid === isEq ? 1 : 0 });
  return { kind: "i32" };
}

/**
 * (#4656) The case the fold above deliberately DECLINES: a `void`/`undefined`
 * operand whose counter-operand is itself nullish-capable (`any`, `undefined`,
 * `null`, `unknown`, or a union containing one of those). Nothing is decidable
 * statically there — but the caller's `return null` is not "leave it alone", it
 * is a **rollback plus a default constant**, and for a boolean-typed comparison
 * that default is `i32.const 0`. So `f() === undefinedValued` and
 * `f() !== undefinedValued` BOTH answered `false`, and `f`'s call was discarded
 * with them.
 *
 * Measured on the campaign base (`language/types/undefined/S8.1_A2_T2.js`):
 *
 * | expression (`function v0(){}`, `var u;`) | base    | spec   |
 * | ---------------------------------------- | ------- | ------ |
 * | `v0() === void 0`                        | `false` | `true` |
 * | `v0() !== void 0`                        | `false` | `false`|
 * | `v0() === u`                             | `false` | `true` |
 * | `v0() === undefined`                     | `true`  | `true` |
 *
 * The last row is the localisation control: the bare `undefined` IDENTIFIER
 * produces no value either, so it takes the `bothVoid` arm above and was right
 * by luck; every value-producing spelling of the same value was wrong.
 *
 * The repair is to stop folding and start COMPARING: the void side produced no
 * value, so materialise the canonical `undefined` externref for it and hand
 * both operands back to the ordinary typed dispatch. Evaluation order is
 * already correct — both operand subtrees have run by the time this is called —
 * so the materialised constant is appended (or, when the LEFT is the void side,
 * threaded under the right operand through a temp) with no side effect of its
 * own.
 *
 * Returns the operand types to continue with, or `null` to keep the caller's
 * historical `return null` (which the callers of a genuinely unusable operand
 * still need).
 */
function materializeVoidOperandEquality(
  ctx: CodegenContext,
  fctx: FunctionContext,
  leftType: ValType | null,
  rightType: ValType | null,
  leftVoid: boolean,
  rightVoid: boolean,
): MaterializedVoidOperands | null {
  // A missing operand that is NOT statically void is a real compile miss —
  // there is no defensible value to invent for it, so keep the rollback.
  if (leftType === null && !leftVoid) return null;
  if (rightType === null && !rightVoid) return null;

  const externref: ValType = { kind: "externref" };
  const pushUndefined = (): void => {
    for (const instr of canonicalUndefinedExternInstrs(ctx)) fctx.body.push(instr);
  };

  if (leftVoid && rightType !== null) {
    // Stack holds only the right operand's value; the left slot has to go
    // UNDER it. A temp round-trip is the only order-preserving way to do that
    // without splicing already-emitted instructions.
    const tmp = allocTempLocal(fctx, rightType);
    fctx.body.push({ op: "local.set", index: tmp });
    pushUndefined();
    fctx.body.push({ op: "local.get", index: tmp });
    releaseTempLocal(fctx, tmp);
    return { left: externref, right: rightType };
  }
  if (leftVoid) pushUndefined();
  if (rightVoid) pushUndefined();
  return { left: leftVoid ? externref : leftType!, right: rightVoid ? externref : rightType! };
}
