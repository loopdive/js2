// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

type FnctorResolver = (checker: ts.TypeChecker, expression: ts.Expression) => ts.Symbol | undefined;

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

/** Closed-world positive proof for #4387's Array-valued fnctor prototype. */
export function analyzeStableArrayPrototypeNames(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  resolveFnctor: FnctorResolver,
): ReadonlySet<string> {
  interface Verdict {
    readonly symbol: ts.Symbol;
    readonly name: string;
    count: number;
    array: boolean;
    poisoned: boolean;
  }
  const verdicts = new Map<ts.Symbol, Verdict>();

  const isAmbientArrayCtor = (node: ts.Expression): boolean => {
    const value = unwrapExpression(node);
    if (ts.isArrayLiteralExpression(value)) return true;
    if (!ts.isNewExpression(value) && !ts.isCallExpression(value)) return false;
    const callee = unwrapExpression(value.expression);
    if (!ts.isIdentifier(callee) || callee.text !== "Array") return false;
    const declarations = checker.getSymbolAtLocation(callee)?.getDeclarations();
    return (
      declarations !== undefined &&
      declarations.length > 0 &&
      declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
    );
  };

  const collectWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      !ts.isPrivateIdentifier(node.left.name) &&
      node.left.name.text === "prototype"
    ) {
      const owner = resolveFnctor(checker, node.left.expression);
      if (owner) {
        const topLevel = ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent);
        const verdict = verdicts.get(owner) ?? {
          symbol: owner,
          name: owner.name,
          count: 0,
          array: true,
          poisoned: false,
        };
        verdict.count++;
        verdict.array &&= topLevel && isAmbientArrayCtor(node.right);
        verdicts.set(owner, verdict);
      }
    }
    forEachChild(node, collectWrites);
  };
  for (const sourceFile of sourceFiles) collectWrites(sourceFile);

  // Most programs, including the Test262 harness, do not assign an Array to a
  // constructor prototype. Avoid the symbol-heavy reference pass entirely in
  // that common case; an empty candidate set cannot produce a positive proof.
  if (verdicts.size === 0) return new Set();

  // The consumer is still name-keyed, so same-named symbols decline. Any
  // constructor reference outside its declaration, the direct assignment, or
  // zero-argument construction also declines: aliases and computed writes can
  // otherwise mutate `prototype` behind this deliberately narrow scan.
  const symbolsByName = new Map<string, number>();
  for (const verdict of verdicts.values()) {
    symbolsByName.set(verdict.name, (symbolsByName.get(verdict.name) ?? 0) + 1);
  }
  const inspectReference = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const verdict = symbol ? verdicts.get(symbol) : undefined;
      if (verdict) {
        const declarationName = verdict.symbol.getDeclarations()?.some((declaration) => {
          if (ts.isFunctionDeclaration(declaration)) return declaration.name === node;
          if (ts.isVariableDeclaration(declaration)) return declaration.name === node;
          return false;
        });
        const prototypeAssignment =
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.name.text === "prototype" &&
          ts.isBinaryExpression(node.parent.parent) &&
          node.parent.parent.left === node.parent &&
          node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const zeroArgumentConstruction =
          ts.isNewExpression(node.parent) &&
          node.parent.expression === node &&
          (node.parent.arguments?.length ?? 0) === 0;
        if (!declarationName && !prototypeAssignment && !zeroArgumentConstruction) verdict.poisoned = true;
      }
    }
    forEachChild(node, inspectReference);
  };
  for (const sourceFile of sourceFiles) inspectReference(sourceFile);

  return new Set(
    [...verdicts.values()]
      .filter(
        (verdict) => verdict.count === 1 && verdict.array && !verdict.poisoned && symbolsByName.get(verdict.name) === 1,
      )
      .map((verdict) => verdict.name),
  );
}
