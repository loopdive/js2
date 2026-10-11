// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A11, group 2) A yield's RESUMPTION value picks the generator carrier
 * too, not only its operand.
 *
 * `generatorElemValType` sizes a native generator's frame from what it YIELDS
 * and RETURNS: all-numeric (a bare `yield` counts, it yields `undefined`)
 * gives the f64 carrier, and the frame's `sent` field — the value `next(v)`
 * hands back to the suspended `yield` — is then f64 as well. So in
 * `function* g() { actual = yield; }` a `g().next({})` stored NaN in `actual`
 * (`language/expressions/yield/iter-value-specified.js`): the object never
 * survived the f64 field.
 *
 * `next(v)` accepts ANY value, so a yield whose result is CONSUMED needs the
 * boxed-any carrier unless its static type says the value is a number (a
 * `Generator<_, _, number>` keeps f64). Standalone/WASI only, like A6's G3a:
 * the JS-host lane keeps its bytes and its eager fallback.
 *
 * Two shapes are deliberately left where they were:
 *  - a yield whose value is DISCARDED (statement position, `void`, a comma's
 *    left operand, a `for` initializer/incrementor) — nothing observes `v`;
 *  - a declaration initializer (`let x = yield`). That is a RESUME BINDING,
 *    which the boxed-any plan still refuses (#2864 F1, `buildNativeGeneratorPlan`'s
 *    spill typing), so moving it would turn a numeric-sent pass into a
 *    compile error.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** True when `node`'s resumption value is observed and may be any JS value. */
export function yieldResumptionNeedsAnyCarrier(ctx: CodegenContext, node: ts.YieldExpression): boolean {
  if (node.asteriskToken) return false;
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent || ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    parent.left === child
  ) {
    return false;
  }
  if (ts.isForStatement(parent) && (parent.initializer === child || parent.incrementor === child)) return false;
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) return false;
  return ctx.oracle.typeFactOf(node).kind !== "number";
}
