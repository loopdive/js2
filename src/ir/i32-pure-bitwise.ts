// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3758) Predicate for "this expression can be computed entirely via
 * genuine native i32 arithmetic/bitwise ops, with no ToInt32 dance
 * anywhere in the subtree" — the AST-level half of the IR i32-pure fast
 * path. `ir/from-ast.ts` holds the paired emitter (`emitI32PureExpr`),
 * which needs `LowerCtx`/`lowerExpr`/the IR builder and can't live here
 * without a circular import.
 *
 * === History: why this is careful about wrap vs. saturate ===
 *
 * A prior version of this fast path (#3745) computed an i32-pure operand by
 * lowering it via the EXISTING f64 arithmetic (unchanged) and then applying
 * `i32.trunc_sat_f64_s` to the f64 RESULT — treating "both operands are
 * already bounded" as license to treat their SUM/PRODUCT as bounded too.
 * That is false: two int32-range operands can sum to a value outside
 * int32 range (e.g. an accumulator like `fib`'s `(a + b) | 0` — both `a`
 * and `b` individually stay in range, but `a + b` routinely does not).
 * ECMA-262 ToInt32 WRAPS such a value modulo 2^32; `i32.trunc_sat_f64_s`
 * SATURATES to INT32_MIN/MAX instead. The four-lane sanitizer probe caught
 * the divergence on the `fib` benchmark and the commit was reverted — see
 * `plan/issues/3745-*.md` and the revert commit for the measured repro.
 *
 * The fix (this module + `emitI32PureExpr`) never uses trunc_sat as a
 * substitute for arithmetic. Leaves (a proven-bounded identifier, an
 * in-range literal, or the result of a nested bitwise/shift/comparison —
 * ALWAYS int32-range by ECMA-262 spec regardless of ITS OWN operands) are
 * safe to obtain via `i32.trunc_sat_f64_s`, because a leaf's value is
 * independently proven bounded, not inferred from its parts. But `+`/`-`/
 * guarded-`*` COMPOSITIONS of pure operands are computed via genuine
 * NATIVE `i32.add`/`i32.sub`/`i32.mul` (added in `ir/nodes.ts`), which wrap
 * modulo 2^32 exactly like ToInt32 does — never via trunc_sat.
 *
 * `+`/`-` need no extra guard: f64 add/sub of two int32-range operands is
 * exact (|a±b| < 2^32 < 2^53), so wrapping the exact sum via native i32.add
 * is bit-identical to ToInt32(a+b) — mirrors legacy's own reasoning in
 * `src/codegen/binary-ops.ts`'s `isI32PureExpr`. `*` additionally requires
 * `isI32MulSafe` (at least one operand a "small" literal, |n| < 2^21) —
 * not for wrap correctness (native i32.mul always wraps exactly) but
 * because JS `*` itself computes in f64 first: for large operands the true
 * product can exceed 2^53 and round, so an exact native i32.mul could
 * diverge from what JS's (lossy) float64 multiply followed by ToInt32
 * would actually produce. The guard keeps native i32.mul aligned with what
 * JS itself computes. Same rationale, same bound, as legacy's own
 * `isI32MulSafe`.
 *
 * Deliberately excludes `>>>` results as a "safe unconditional leaf": its
 * value range is [0, 2^32), which does NOT fit signed `i32.trunc_sat_f64_s`
 * semantics for values >= 2^31 (mirrors legacy's own established special
 * -casing of `>>>` as a result op, e.g. `binary-ops.ts`'s `bitwiseI32`
 * excludes `>>>` as the outer result op for the same reason).
 *
 * Call expressions are excluded as leaves — with ONE proven exception
 * (#3931): a `recv.charCodeAt(i)` read inside a recognised canonical
 * char-read loop. That gap was left open here deliberately, because closing
 * it needs the "provably in-bounds" proof of legacy's #2682
 * (`matchHoistedCharRead` / `detectCanonicalCharReadLoop`) rather than a
 * guess, and porting it hastily into #3758 is exactly the kind of shortcut
 * that caused the #3745 revert. `ir/char-read-loop.ts` now carries that
 * proof: inside such a loop `0 <= i < recv.length` holds at every read, so
 * the §22.1.3.3 NaN result is unreachable and the read is a u16 — ALWAYS
 * int32-range, hence a genuine bounded leaf in exactly the sense the header
 * above requires. Every OTHER call expression still returns false.
 */
import { forEachChild, ts } from "../ts-api.js";
import { collectI32CoercedLocals } from "../codegen/function-body.js";
import { detectI32LoopVar } from "./analysis/loop-shape.js";
import { matchProvenCharRead, type ProvenCharReads } from "./char-read-loop.js";

/** Names (function-wide) proven to always hold a clean int32 value when read. */
export type I32PureNames = ReadonlySet<string>;

const FUNCTION_SCOPE_KINDS = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isAccessor(node) ||
  ts.isConstructorDeclaration(node);

/**
 * Union of `collectI32CoercedLocals` (mutated/const locals whose every
 * write is bitwise-coerced or an in-range literal) and every canonical
 * `for (let i = INT; i < …; i++)` counter name `detectI32LoopVar` accepts —
 * the same two proofs legacy's own #1120/#1236 i32-local promotion uses.
 * Computed once per top-level function declaration; nested functions get
 * their own independent set (never merged with an outer scope's).
 */
export function computeI32PureNames(fn: ts.FunctionLikeDeclaration): I32PureNames {
  const names = new Set<string>(collectI32CoercedLocals(fn));
  if (fn.body && ts.isBlock(fn.body)) {
    const visit = (node: ts.Node): void => {
      if (node !== fn && FUNCTION_SCOPE_KINDS(node)) return; // nested scope — independent
      if (ts.isForStatement(node)) {
        const info = detectI32LoopVar(node);
        if (info) names.add(info.name);
      }
      forEachChild(node, visit);
    };
    forEachChild(fn.body, visit);
  }
  return names;
}

function peel(e: ts.Expression): ts.Expression {
  let inner: ts.Expression = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** Mirrors legacy binary-ops.ts's `isI32MulSafe`: at least one operand must be a small (|n| < 2^21) integer literal, so the true product stays exactly representable in f64 and native i32.mul agrees with JS's own float64 `*`. */
export function isI32MulSafe(l: ts.Expression, r: ts.Expression): boolean {
  return isSmallIntLiteral(l) || isSmallIntLiteral(r);
}

function isSmallIntLiteral(e: ts.Expression): boolean {
  const inner = peel(e);
  if (!ts.isNumericLiteral(inner)) return false;
  const n = Number(inner.text.replace(/_/g, ""));
  return Number.isInteger(n) && Math.abs(n) < 1 << 21;
}

function isBitwiseOpKind(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
  );
}

/** Bitwise/shift ops whose result is safe to treat as an unconditional int32-range LEAF — excludes `>>>` (unsigned [0, 2^32) range doesn't fit signed trunc_sat). */
function isSignedBoundedBitwiseOpKind(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken
  );
}

/**
 * True iff `e`, when evaluated, is provably computable via genuine native
 * i32 arithmetic with NO ToInt32 dance anywhere in the subtree — safe to
 * hand to `emitI32PureExpr` (in `ir/from-ast.ts`). See this module's header
 * comment for the wrap-vs-saturate soundness argument.
 */
export function isI32PureExprIR(e: ts.Expression, names: I32PureNames, charReads?: ProvenCharReads): boolean {
  const inner = peel(e);
  if (ts.isIdentifier(inner)) return names.has(inner.text);
  if (ts.isNumericLiteral(inner)) {
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  }
  // (#3931) The ONE admitted call leaf: a proven-in-bounds `recv.charCodeAt(i)`
  // inside a canonical char-read loop. Its value is a u16 code unit — bounded
  // independently of anything else in the expression — and the proof makes the
  // NaN arm unreachable, so it is a leaf in the strict sense this module means.
  if (ts.isCallExpression(inner)) return matchProvenCharRead(inner, charReads) !== null;
  if (!ts.isBinaryExpression(inner)) return false;
  const k = inner.operatorToken.kind;
  // A nested bitwise/shift (non-`>>>`) sub-expression's OWN result is
  // ALWAYS int32-range by ECMA-262 spec, independent of its own operands —
  // its correct computation is independently handled (unchanged) by the
  // existing bitwise lowering, so no recursion into ITS operands is needed
  // here to establish that ITS result is a safe leaf.
  if (isSignedBoundedBitwiseOpKind(k)) return true;
  if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
    return isI32PureExprIR(inner.left, names, charReads) && isI32PureExprIR(inner.right, names, charReads);
  }
  if (k === ts.SyntaxKind.AsteriskToken) {
    return (
      isI32PureExprIR(inner.left, names, charReads) &&
      isI32PureExprIR(inner.right, names, charReads) &&
      isI32MulSafe(inner.left, inner.right)
    );
  }
  return false;
}

/** The six bitwise/shift operator token kinds the outer fast-path gate applies to (including `>>>` — the OUTER op's own result-type handling is unchanged/unaffected by this module). */
export function isIrBitwiseOperatorToken(k: ts.SyntaxKind): boolean {
  return isBitwiseOpKind(k);
}
