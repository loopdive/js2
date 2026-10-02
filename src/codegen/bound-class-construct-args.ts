// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 C5) `new g(…)` where `g = C.bind(thisArg, a1, …, ak)` and `C` is a
 * compiled class: the bound arguments come FIRST (§10.4.1.2 step 5,
 * `args = boundArgs ++ argumentsList`).
 *
 * ## The gap (both lanes)
 *
 * TypeScript types `C.bind(…)` through `NewableFunction.bind`, so `new g(8)` is
 * typed `C` and `compileNewExpression` resolves the class from that TYPE and
 * calls `C_new` directly with the site's own arguments — a static fold of
 * [[Construct]] through the bound function that silently dropped every bound
 * argument (`class/subclass/binding.js`: `new (Subclass.bind(obj, 1))(8)`
 * built `x = 8, y = undefined` instead of `x = 1, y = 8`).
 *
 * ## The fix, and its boundary
 *
 * The fold is kept — the target, `C`, and the ignored `thisArg` are exactly
 * what §10.4.1.2 prescribes — and made complete by prepending the bound
 * arguments. That is only sound when re-evaluating them at the `new` site
 * yields the values `bind` captured, so the prefix is supplied only when
 *
 *  - the callee is an identifier whose single, never-written binding is
 *    initialised by `<id>.bind(…)` directly, `<id>` being this very class's
 *    single, never-written declaration; and
 *  - every bound argument is a literal (number, string, boolean, `null`,
 *    `undefined`, a negated number) — side-effect free and identical on every
 *    evaluation.
 *
 * Anything else keeps the previous emission (bound arguments still dropped —
 * the residual is recorded in #6651 C5).
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { bindingIsUniqueAndNeverWritten } from "./class-heritage-check.js";

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** A literal whose re-evaluation is observably identical to the captured value. */
function isStableLiteral(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  switch (e.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      break;
  }
  if (ts.isIdentifier(e)) return e.text === "undefined";
  return (
    ts.isPrefixUnaryExpression(e) &&
    (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(unwrap(e.operand))
  );
}

/**
 * The argument list `new <expr>` must pass to `<className>_new` — the bound
 * arguments followed by the site's own — when the callee is a provably
 * unaliased `ClassName.bind(thisArg, …literals)`; `undefined` otherwise (use
 * `expr.arguments` unchanged).
 */
export function boundClassConstructArgs(
  ctx: CodegenContext,
  expr: ts.NewExpression,
  className: string,
): ts.NodeArray<ts.Expression> | undefined {
  const callee = unwrap(expr.expression);
  if (!ts.isIdentifier(callee)) return undefined;
  const calleeDecl = ctx.oracle.valueDeclarationOf(callee);
  if (calleeDecl === undefined || !ts.isVariableDeclaration(calleeDecl) || calleeDecl.initializer === undefined) {
    return undefined;
  }
  const init = unwrap(calleeDecl.initializer);
  if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) return undefined;
  if (init.expression.name.text !== "bind" || init.arguments.length < 2) return undefined;
  const target = unwrap(init.expression.expression);
  if (!ts.isIdentifier(target)) return undefined;
  const targetDecl = ctx.oracle.valueDeclarationOf(target);
  if (targetDecl === undefined || !ts.isClassDeclaration(targetDecl)) return undefined;
  if ((ctx.anonClassExprNames.get(targetDecl) ?? targetDecl.name?.text) !== className) return undefined;
  const bound = init.arguments.slice(1);
  if (bound.some((arg) => ts.isSpreadElement(arg) || !isStableLiteral(arg))) return undefined;
  if (!bindingIsUniqueAndNeverWritten(callee, calleeDecl) || !bindingIsUniqueAndNeverWritten(target, targetDecl)) {
    return undefined;
  }
  return ts.factory.createNodeArray([...bound, ...(expr.arguments ?? [])]);
}
