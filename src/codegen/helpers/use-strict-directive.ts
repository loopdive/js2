// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4515 wave-5) The ONE predicate for "is this Directive Prologue entry a Use
 * Strict Directive" (ECMA-262 §11.2.2 / §14.1.1).
 *
 * ## Why the COOKED string is the wrong thing to compare
 *
 * The spec is explicit that the token is matched **as written**:
 *
 * > A Use Strict Directive is an ExpressionStatement in a Directive Prologue
 * > whose StringLiteral is either the exact code unit sequence `"use strict"`
 * > or `'use strict'`. **A Use Strict Directive may not contain an
 * > EscapeSequence or LineContinuation.**
 *
 * Every call site in this backend compared `stringLiteral.text`, which is the
 * COOKED value — escapes already decoded, line continuations already removed.
 * So both of these were (wrongly) treated as strict-mode switches, measured on
 * `--target standalone` before this landed:
 *
 * ```js
 * function foo() { 'use str\
 * ict'; return this !== undefined; }   // LC → answered false, spec true
 * function bar() { 'use strict'; return this !== undefined; }
 *                                      // escape → answered false, spec true
 * ```
 *
 * Both functions are SLOPPY, so `foo.call(undefined)` substitutes the global
 * object for `this` and the comparison is `true`. Treating them as strict
 * leaves `this` genuinely `undefined` and flips the answer — `false`, which is
 * what `language/directive-prologue/14.1-{4,5}-s.js` reported.
 *
 * This is not a conformance nicety. Strictness here drives `this` substitution,
 * the mapped-vs-unmapped `arguments` split (`isSimpleParameterList`'s
 * companion), assignment-to-unresolvable-reference behaviour and the eval
 * early-error set — so a mis-detected directive changes ordinary program
 * semantics, silently, in the direction of MORE restriction.
 *
 * ## Absent-not-wrong
 *
 * A node with no readable source token (a synthesized node — the prelude
 * builders and the `Function(...)` body assembler produce these) cannot be
 * checked against raw text at all. There the cooked comparison is the only
 * evidence available and is kept, so nothing that worked before moves. The
 * fallback direction matters: a synthesized `"use strict"` is one this
 * compiler itself emitted and genuinely means strict.
 *
 * ## Template literals
 *
 * `ts.isStringLiteralLike` also matches a NoSubstitutionTemplateLiteral, which
 * is NOT a StringLiteral and therefore never a Directive. Its raw text is
 * backtick-quoted, so the raw comparison rejects it for free — no separate
 * branch, and the pre-existing cooked-text behaviour for a genuinely
 * synthesized template is unchanged.
 */
import { ts } from "../../ts-api.js";

/** The raw source token for `node`, or `undefined` when it has none. */
function rawTokenText(node: ts.Node): string | undefined {
  if (node.pos < 0 || node.end < 0) return undefined;
  try {
    const sf = node.getSourceFile();
    if (!sf || typeof sf.text !== "string") return undefined;
    return sf.text.slice(node.getStart(sf), node.end);
  } catch {
    // A synthesized node throws rather than answering; see "absent-not-wrong".
    return undefined;
  }
}

/**
 * True when `expr` is the string literal of a Use Strict Directive — i.e. it
 * cooks to `use strict` AND its source token is exactly `"use strict"` or
 * `'use strict'`, with no EscapeSequence and no LineContinuation.
 */
export function isUseStrictDirectiveExpression(expr: ts.Expression): boolean {
  if (!ts.isStringLiteralLike(expr)) return false;
  if (expr.text !== "use strict") return false;
  const raw = rawTokenText(expr);
  if (raw === undefined) return true; // synthesized: cooked text is all there is
  return raw === '"use strict"' || raw === "'use strict'";
}
