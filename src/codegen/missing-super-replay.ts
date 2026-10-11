// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5350) A derived constructor with no lexical `super()` still runs its body:
 * §10.2.2 [[Construct]] evaluates the body and only then, at the fallthrough,
 * GetThisBinding throws the ReferenceError. Test262's
 * `super/prop-{dot,expr}-cls-this-uninit.js` observe exactly that by catching
 * the `super.x` ReferenceError inside the body.
 *
 * Standalone replays the body before the caller's fallthrough throw, but only
 * for statically bounded shapes. Return, lexical `this`, `eval`, nested
 * callables/classes, `super` in a parameter initializer and super writes keep
 * the established entry throw until their completion semantics share this path.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { hoistLetConstWithTdz, hoistVarDeclarations } from "./index.js";
import { compileStatement } from "./shared.js";

function isSuperWriteTarget(node: ts.Node): boolean {
  let child = node.parent;
  for (let parent = child?.parent; parent; child = parent, parent = parent.parent) {
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === child &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === child)
    )
      return true;
    if (ts.isStatement(parent)) break;
  }
  return false;
}

// Scan parameter initializers too: a default `this` read must prevent body effects.
function canReplayMissingSuperBody(ctor: ts.ConstructorDeclaration): boolean {
  let safe = true;
  let inParameters = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (
      ts.isReturnStatement(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword ||
      (node.kind === ts.SyntaxKind.SuperKeyword && (inParameters || isSuperWriteTarget(node))) ||
      (ts.isIdentifier(node) && node.text === "eval") ||
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      safe = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const parameter of ctor.parameters) visit(parameter);
  inParameters = false;
  if (ctor.body) visit(ctor.body);
  return safe;
}

/** Compile a bounded missing-`super()` constructor body (standalone only). */
export function replayMissingSuperBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ctor: ts.ConstructorDeclaration | undefined,
): void {
  if (!ctx.standalone || !ctor?.body || !canReplayMissingSuperBody(ctor)) return;
  hoistVarDeclarations(ctx, fctx, ctor.body.statements);
  hoistLetConstWithTdz(ctx, fctx, ctor.body.statements);
  for (const stmt of ctor.body.statements) compileStatement(ctx, fctx, stmt);
}
