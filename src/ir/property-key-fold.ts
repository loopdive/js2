// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4513) The single syntactic fold for object-literal COMPUTED property keys
 * (`{ [expr]: v }`), shared by the selector (`select.ts`) and the lowerer
 * (`from-ast.ts`).
 *
 * It lives in its own leaf module for one reason: **selector claim ⇔ lowering
 * parity**. `select.ts` and `from-ast.ts` cannot import each other (circular),
 * and their two `phase1PropertyName` copies are already duplicated for exactly
 * that reason. Duplicating a *widening* fold as well would make the claim rule
 * and the lowering rule two texts that can drift — and a drift in this
 * direction is not a missed optimisation, it is a function the selector claimed
 * and the lowerer then cannot deliver (a post-claim `invariant`, a hard error
 * under the IR-only policy). One exported function makes drift impossible.
 *
 * ## Why the fold is syntactic and not `resolveConstantExpression`
 *
 * The IR object shape is STATIC: `IrObjectShape.fields` is a fixed list of
 * `{ name, type }`. A key known only at run time cannot produce one, so the
 * adoptable set is exactly the keys that resolve to a string during selection.
 *
 * Legacy resolves more of them — `resolveComputedKeyExpression` →
 * `resolveConstantExpression` (`src/codegen/literals.ts`) reads `const`
 * initialisers, enum tables and well-known `Symbol.*` names off a live
 * `CodegenContext`. The selector has none of that: `planIrCompilation` takes a
 * bare `SourceFile`, and its `scope` is a `ReadonlySet<string>` of NAMES, not a
 * value environment. So this fold sees literals only, and every richer key
 * keeps rejecting at the existing `objectlit-computed-key` arm.
 *
 * ## Numeric keys — why `expr.text` is already the spec key
 *
 * JS canonicalises a numeric property key through `ToString(ToNumber(…))`, so
 * `{ [0x10]: v }` is the key `"16"` and `{ [0.50]: v }` is `"0.5"`. That looks
 * like it needs a canonicalisation step here, and an earlier draft of this
 * module carried one (`String(Number(text)) === text` or reject).
 *
 * Measured 2026-08-16 (`.tmp/4513/`): **TypeScript's scanner already stores the
 * canonical decimal form in `NumericLiteral.text`**, so the guard was dead code
 * that implied a hazard the compiler does not have. All 16 spellings probed —
 * `0x10`→`16`, `0b101`→`5`, `0o17`→`15`, `0.50`→`0.5`, `.5`→`0.5`, `5.`→`5`,
 * `1e3`→`1000`, `1_000`→`1000`, `1e21`→`1e+21`, `1e-7`→`1e-7`,
 * `0.0000001`→`1e-7`, `9007199254740993`→`9007199254740992`, `1e100`→`1e+100`,
 * `123456789012345678901234567890`→`1.2345678901234568e+29` — satisfy
 * `text === String(Number(text))`.
 *
 * So the numeric arm just returns `expr.text`, which makes a computed numeric
 * key **byte-identical** to the already-shipped plain numeric key
 * (`phase1PropertyName` returns `name.text` too). That identity is the parity
 * property worth having, and `tests/issue-4513.test.ts` asserts it at runtime
 * for `{ [0x10]: v }` / `{ 0x10: v }` / `{ 16: v }` rather than restating the
 * scanner's behaviour as a comment.
 *
 * ## Evaluation order
 *
 * Every key this module folds is a LITERAL, so it has no side effects and
 * cannot participate in an evaluation-order hazard of its own. The order that
 * is observable is between property VALUES, and `lowerObjectLiteral` preserves
 * it structurally: initialisers are lowered in the `expr.properties` loop
 * (source order) and the field list is sorted by name only afterwards, so the
 * sort permutes the `object.new` operand list, never the emission order of the
 * value computations. A computed key is the case that makes that distinction
 * visible, because a folded key's field name need not sort in source position
 * (`{ ["b"]: p(1), a: p(2) }`); tests/issue-4513.test.ts pins it.
 */

import { ts } from "../ts-api.js";

/**
 * Fold an object-literal computed property name to its static field-name
 * string, or `null` when it does not fold (the caller then keeps its existing
 * `objectlit-computed-key` reject — no new reason code is minted, because a
 * non-folding key is the same condition that arm already names).
 *
 * Accepts, after stripping parentheses (which are not an operation):
 *   - `StringLiteral`                 → its text
 *   - `NoSubstitutionTemplateLiteral` → its text (nothing to evaluate)
 *   - `NumericLiteral`                → its text, which the scanner has already
 *                                       canonicalised (see the module doc)
 */
export function foldComputedPropertyKey(name: ts.ComputedPropertyName): string | null {
  let expr: ts.Expression = name.expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return expr.text;
  return null;
}

/**
 * `phase1PropertyName` extended with the computed-key fold, for the OBJECT
 * LITERAL DATA-PROPERTY site only.
 *
 * Deliberately a separate entry point rather than a change to
 * `phase1PropertyName` itself: that function is also consulted for class-member
 * naming, OrdinaryToPrimitive method resolution and prepared-scope method keys
 * (7 call sites across the two files), where a computed name means something
 * different — `phase1MemberName` documents that a widening there could make
 * Phase B patch the wrong `funcMap` slot. Widening only the data-property site
 * keeps this slice's blast radius equal to its measurement.
 */
export function objectLiteralDataPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text; // matches the plain-key path
  if (ts.isComputedPropertyName(name)) return foldComputedPropertyKey(name);
  return null;
}
