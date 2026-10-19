// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7014) Bindings whose `.name` the legacy path answers by a STATIC fold.
 *
 * §13.15.2: `a &&= function () {}` (and `||=` / `??=`) NamedEvaluation names an
 * anonymous function after the LHS identifier. The legacy codegen answers a
 * later `a.name` from `resolveLogicalAssignmentName` (#2201) at compile time;
 * no lane stamps that name onto the runtime closure, so the IR's runtime
 * `dyn.member_get` reads `undefined`. `from-ast` uses this predicate to demote
 * such a read rather than claim it. It became reachable when #5289
 * (163eb5bc5c) admitted `any` module bindings to claimed bodies.
 */
import { forEachChild, ts } from "../ts-api.js";

const targetsBySourceFile = new WeakMap<ts.SourceFile, ReadonlySet<ts.Symbol>>();

function isLogicalAssignmentToken(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function collectTargets(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ReadonlySet<ts.Symbol> {
  const found = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isLogicalAssignmentToken(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      let rhs: ts.Expression = node.right;
      while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
      if (ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs) || ts.isClassExpression(rhs)) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) found.add(symbol);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  return found;
}

/** Is `receiver` an identifier some `&&=`/`||=`/`??=` assigns a function or class to? */
export function isLogicalAssignmentFunctionTarget(
  receiver: ts.Expression,
  checker: ts.TypeChecker | undefined,
): boolean {
  if (!checker || !ts.isIdentifier(receiver)) return false;
  const sourceFile = receiver.getSourceFile();
  let targets = targetsBySourceFile.get(sourceFile);
  if (!targets) {
    targets = collectTargets(sourceFile, checker);
    targetsBySourceFile.set(sourceFile, targets);
  }
  const symbol = checker.getSymbolAtLocation(receiver);
  return symbol !== undefined && targets.has(symbol);
}
