// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651) A top-level assignment whose TARGET is a property/element access
 * rooted in an EXPRESSION rather than a binding — `f(o).p = v`, `f()[k] = v`,
 * `g().a.b = v`, `new F().p = v`, `` tag`x`.p = v ``, `0..p = v`,
 * `({}).p = v`, `(a || b).p = v` — under every assignment operator (`=`, the
 * compound `+=`/`**=`/…, and the logical `??=`/`||=`/`&&=`).
 *
 * ## The defect
 *
 * `collectDeclarations` keeps a top-level assignment statement only when its
 * ROOT resolves to something it recognises: a module global, a top-level
 * function, `globalThis`, a class accessor, an implicit global.
 * `getAssignmentRootIdentifier` walks the property/element chain and stops at
 * the first node that is not an access; for these targets that node is not an
 * identifier, so there is no root name and the statement fell off the
 * allow-list. The #3623 classifier calls every assignment operator "keep" and
 * the #4433 user-code default only runs for `unhandled` statements, so neither
 * backstop saw it: the statement compiled to NOTHING — the call never ran, the
 * write never happened, and a setter on the receiver never fired. The
 * identical statement inside a function body has always worked; this is a
 * collection gap, the #2992 / #3592 / #3615 / #4176 family, not a lowering gap.
 * (Two LOWERING gaps are visible once the statement runs and are out of scope
 * here, because a function body shows them too: a write through a nullish base
 * does not throw, and a primitive base does not reach a Proxy `set` trap on
 * its wrapper prototype.)
 *
 * Measured on `main` @ 3eb7ae5da3 (2026-09-28), host AND standalone with the
 * same answer: 15 of 18 probed call-rooted shapes wrong (only `++f(o).n`,
 * `f(o).n++` and `o[f(k)] = v` were right — other arms own those), including
 * `(new F()).p = 7` (the constructor never ran) and
 * `Object.getPrototypeOf(o).zz = 7`; the object-literal, comma and conditional
 * roots were wrong too.
 *
 * ## Scope
 *
 * The chain's root (after stripping parens / casts / `!`) must be something
 * other than an identifier, `this`, `super` or a meta-property: those roots
 * keep their existing root-name-driven decision, so a module with no
 * expression-rooted target compiles byte-identically. A tagged template that
 * is really the synchronous top-level-await parse recovery stays out, exactly
 * as it does in the bare-statement arm.
 */
import { ts } from "../../ts-api.js";
import { isSynchronousTopLevelAwaitRecovery } from "../module-init-collection.js";

function unwrap(expr: ts.Expression): ts.Expression {
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

/** True when `target` is a property/element access whose receiver chain is rooted in a non-binding expression. */
export function isExpressionRootedAssignmentTarget(target: ts.Expression): boolean {
  let current = unwrap(target);
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  if (ts.isTaggedTemplateExpression(current)) return !isSynchronousTopLevelAwaitRecovery(current);
  return !(
    ts.isIdentifier(current) ||
    ts.isMetaProperty(current) ||
    current.kind === ts.SyntaxKind.ThisKeyword ||
    current.kind === ts.SyntaxKind.SuperKeyword
  );
}
