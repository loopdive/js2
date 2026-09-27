// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6604 (#5383 S16) — `void 0` is the `undefined` LITERAL for the purposes of
 * the §7.2.14 / §7.2.16 null-and-undefined comparison shortcut.
 *
 * ## The defect
 *
 * `compileBinaryExpression`'s nullish-comparison arm recognised the undefined
 * literal as the IDENTIFIER `undefined` only (`ts.isIdentifier(e) && e.text ===
 * "undefined"`). A `void 0` operand fell straight past it into the generic
 * reference equality, which compares an `externref` undefined sentinel against
 * whatever carrier the other side has — and answers "not equal" for a value
 * that IS undefined. Measured standalone, base tree:
 *
 * | source | answered | correct |
 * | --- | --- | --- |
 * | `let a = undefined; void 0 !== a` | `true` | `false` |
 * | `let a = null; void 0 !== a` | `true` | `true` * |
 * | `undefined !== a` (identifier) | `false` | `false` |
 * | `const a = m[1]; void 0 === a` | `false` | `true` |
 *
 * (* the `null` row is right by accident — `void 0 !== null` IS true — but it
 * is produced by the same comparison that gets the `undefined` row wrong.)
 *
 * Every minifier emits `void 0`, never `undefined`, so this is not an exotic
 * form: it is the ONLY form a bundled dependency uses.
 * `@js-temporal/polyfill`'s `ToTemporalDuration` guards each fractional
 * capture group with `if (void 0 !== c) { … (c + "000000000").slice(0, 9) … }`,
 * so the guard admitted a NULL group and the concatenation then dereferenced
 * it — 8 Duration + 3 ZonedDateTime rows in the #5383 three-family sample.
 *
 * ## Why the operand must be a literal
 *
 * The nullish shortcut never COMPILES the literal side; it recognises it and
 * emits a null/undefined test against the other operand. `void <expr>` is only
 * interchangeable with `undefined` when evaluating `<expr>` is unobservable, so
 * this predicate admits `void` over a literal and nothing else. `void f()`,
 * `void x++` and `void x` keep their existing (fully evaluated) lowering.
 */
import { ts } from "../ts-api.js";

/** Wrappers that change neither the value nor the observable effects. */
function unwrapTransparent(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * A literal whose evaluation is unobservable — so `void <it>` can be folded to
 * the undefined literal without dropping an effect. Deliberately syntactic: an
 * identifier is excluded even when it is provably constant, because a TDZ read
 * of a `let` THROWS, which is an effect.
 */
function isInertLiteral(expr: ts.Expression): boolean {
  const inner = unwrapTransparent(expr);
  return (
    ts.isNumericLiteral(inner) ||
    ts.isBigIntLiteral(inner) ||
    ts.isStringLiteral(inner) ||
    ts.isNoSubstitutionTemplateLiteral(inner) ||
    ts.isRegularExpressionLiteral(inner) ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * True when `expr` denotes the `undefined` value with no observable evaluation:
 * the identifier `undefined`, the `undefined` keyword type position, or
 * `void <inert literal>` (`void 0`, the minified form).
 *
 * Callers may use this ONLY where the operand is recognised rather than
 * compiled — that is the whole reason the `void` arm is restricted to a
 * literal.
 */
export function isInertUndefinedLiteral(expr: ts.Expression): boolean {
  const inner = unwrapTransparent(expr);
  if (inner.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isIdentifier(inner) && inner.text === "undefined") return true;
  return ts.isVoidExpression(inner) && isInertLiteral(inner.expression);
}
