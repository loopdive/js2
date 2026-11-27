// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The dense-array shapes from-ast lowers without a growing array: an empty literal filled by the counted loop after it
 * (`denseFillPlanForLiteral`), and such a fill consumed once by an i32 sum reduction (`denseArrayReductionPlan`).
 * Pure AST questions; the lowering stays in from-ast.
 */
import { forEachChild, ts } from "../ts-api.js";
import { i32LiteralValue, peelExpr } from "./analysis/i32-slots.js";
import { isIrBitwiseOperatorToken } from "./i32-pure-bitwise.js";

function isPureDenseFillRhs(expr: ts.Expression, arrayName: string): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPureDenseFillRhs(expr.expression, arrayName);
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr)) return expr.text !== arrayName;
  if (ts.isPrefixUnaryExpression(expr)) {
    return (
      (expr.operator === ts.SyntaxKind.PlusToken ||
        expr.operator === ts.SyntaxKind.MinusToken ||
        expr.operator === ts.SyntaxKind.TildeToken ||
        expr.operator === ts.SyntaxKind.ExclamationToken) &&
      isPureDenseFillRhs(expr.operand, arrayName)
    );
  }
  if (!ts.isBinaryExpression(expr)) return false;
  const operator = expr.operatorToken.kind;
  if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
  if (operator === ts.SyntaxKind.CommaToken) return false;
  return isPureDenseFillRhs(expr.left, arrayName) && isPureDenseFillRhs(expr.right, arrayName);
}

export interface DenseFillPlan {
  readonly arrayName: string;
  readonly indexName: string;
  readonly bound: ts.Expression;
  readonly loop: ts.ForStatement;
}

export function denseFillPlanForLiteral(expr: ts.ArrayLiteralExpression): DenseFillPlan | null {
  // The direct-store optimization relies on the empty-literal allocation arm
  // reserving the loop bound as backing capacity and publishing that bound as
  // the final length. A non-empty literal keeps its fixed initial capacity and
  // length, so its indexed writes must retain the grow-and-length helper.
  if (expr.elements.length !== 0) return null;
  const declaration = expr.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  const declarationList = declaration.parent;
  const declarationStatement = declarationList.parent;
  const block = declarationStatement.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    !ts.isVariableStatement(declarationStatement) ||
    (!ts.isBlock(block) && !ts.isSourceFile(block))
  ) {
    return null;
  }
  const statements = block.statements;
  const statementIndex = statements.indexOf(declarationStatement);
  const loop = statements[statementIndex + 1];
  if (statementIndex < 0 || !loop || !ts.isForStatement(loop)) return null;

  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return null;
  const indexDeclaration = initializer.declarations[0];
  if (
    !ts.isIdentifier(indexDeclaration.name) ||
    !indexDeclaration.initializer ||
    !ts.isNumericLiteral(indexDeclaration.initializer) ||
    Number(indexDeclaration.initializer.text) !== 0
  ) {
    return null;
  }
  const indexName = indexDeclaration.name.text;
  const condition = loop.condition;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(condition.left) ||
    condition.left.text !== indexName ||
    (!ts.isIdentifier(condition.right) && !ts.isNumericLiteral(condition.right))
  ) {
    return null;
  }
  const incrementor = loop.incrementor;
  if (
    !incrementor ||
    (!ts.isPrefixUnaryExpression(incrementor) && !ts.isPostfixUnaryExpression(incrementor)) ||
    incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(incrementor.operand) ||
    incrementor.operand.text !== indexName
  ) {
    return null;
  }
  const loopStatements = ts.isBlock(loop.statement) ? loop.statement.statements : [loop.statement];
  if (loopStatements.length !== 1 || !ts.isExpressionStatement(loopStatements[0])) return null;
  const assignment = loopStatements[0].expression;
  const arrayName = declaration.name.text;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isElementAccessExpression(assignment.left) ||
    !ts.isIdentifier(assignment.left.expression) ||
    assignment.left.expression.text !== arrayName ||
    !ts.isIdentifier(assignment.left.argumentExpression) ||
    assignment.left.argumentExpression.text !== indexName ||
    !isPureDenseFillRhs(assignment.right, arrayName)
  ) {
    return null;
  }
  return { arrayName, indexName, bound: condition.right, loop };
}

export function denseFillPlanForLoop(loop: ts.ForStatement): DenseFillPlan | null {
  const parent = loop.parent;
  if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return null;
  const loopIndex = parent.statements.indexOf(loop);
  const previous = parent.statements[loopIndex - 1];
  if (
    loopIndex < 1 ||
    !previous ||
    !ts.isVariableStatement(previous) ||
    previous.declarationList.declarations.length !== 1
  ) {
    return null;
  }
  const initializer = previous.declarationList.declarations[0].initializer;
  return initializer && ts.isArrayLiteralExpression(initializer) ? denseFillPlanForLiteral(initializer) : null;
}

/**
 * A nested bitwise result is already the exact 32-bit pattern the enclosing
 * bitwise operator's ToInt32 conversion consumes. This deliberately includes
 * `>>>`: its JavaScript NUMBER result may be above INT32_MAX, so it is not a
 * generally signed-i32-valued expression, but converting that uint32 result
 * back through ToInt32 preserves the same 32 bits.
 */
export function isNestedBitwiseResult(e: ts.Expression): boolean {
  const inner = peelExpr(e);
  return ts.isBinaryExpression(inner) && isIrBitwiseOperatorToken(inner.operatorToken.kind);
}

export interface DenseArrayReductionPlan {
  readonly accumulatorDeclaration: ts.VariableStatement;
  readonly fillLoop: ts.ForStatement;
  readonly fillValue: ts.Expression;
  readonly accumulatorName: string;
  readonly returnStatement: ts.ReturnStatement;
}

function referencesIdentifier(expr: ts.Expression, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Eliminate a local dense array that is filled and then consumed exactly once
 * by an i32 sum reduction. The array never escapes and both loops are pure, so
 * accumulating the generated value in the fill loop preserves iteration order
 * while avoiding a large, immediately-dead WasmGC allocation.
 */
export function denseArrayReductionPlan(stmts: readonly ts.Statement[]): DenseArrayReductionPlan | null {
  if (stmts.length !== 5) return null;
  const [arrayStatement, fillStatement, accumulatorStatement, reductionStatement, returnStatement] = stmts;
  if (
    !arrayStatement ||
    !fillStatement ||
    !accumulatorStatement ||
    !reductionStatement ||
    !returnStatement ||
    !ts.isVariableStatement(arrayStatement) ||
    !ts.isForStatement(fillStatement) ||
    !ts.isVariableStatement(accumulatorStatement) ||
    !ts.isForStatement(reductionStatement) ||
    !ts.isReturnStatement(returnStatement)
  ) {
    return null;
  }

  const arrayDeclaration = arrayStatement.declarationList.declarations[0];
  if (
    arrayStatement.declarationList.declarations.length !== 1 ||
    !arrayDeclaration ||
    !arrayDeclaration.initializer ||
    !ts.isArrayLiteralExpression(arrayDeclaration.initializer)
  ) {
    return null;
  }
  const fillPlan = denseFillPlanForLiteral(arrayDeclaration.initializer);
  if (!fillPlan || fillPlan.loop !== fillStatement) return null;
  const fillBody = ts.isBlock(fillStatement.statement)
    ? fillStatement.statement.statements[0]
    : fillStatement.statement;
  if (!fillBody || !ts.isExpressionStatement(fillBody) || !ts.isBinaryExpression(fillBody.expression)) return null;
  const fillValue = fillBody.expression.right;
  if (!isNestedBitwiseResult(fillValue)) return null;

  const accumulatorDeclaration = accumulatorStatement.declarationList.declarations[0];
  if (
    accumulatorStatement.declarationList.declarations.length !== 1 ||
    !accumulatorDeclaration ||
    !ts.isIdentifier(accumulatorDeclaration.name) ||
    !accumulatorDeclaration.initializer ||
    !ts.isNumericLiteral(accumulatorDeclaration.initializer) ||
    Number(accumulatorDeclaration.initializer.text) !== 0
  ) {
    return null;
  }
  const accumulatorName = accumulatorDeclaration.name.text;
  if (referencesIdentifier(fillValue, accumulatorName)) return null;

  const reductionInit = reductionStatement.initializer;
  if (
    !reductionInit ||
    !ts.isVariableDeclarationList(reductionInit) ||
    reductionInit.declarations.length !== 1 ||
    !reductionInit.declarations[0]?.initializer ||
    !ts.isIdentifier(reductionInit.declarations[0].name) ||
    !ts.isNumericLiteral(reductionInit.declarations[0].initializer) ||
    Number(reductionInit.declarations[0].initializer.text) !== 0
  ) {
    return null;
  }
  const reductionIndex = reductionInit.declarations[0].name.text;
  const reductionCondition = reductionStatement.condition;
  const reductionIncrement = reductionStatement.incrementor;
  if (
    !reductionCondition ||
    !ts.isBinaryExpression(reductionCondition) ||
    reductionCondition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(reductionCondition.left) ||
    reductionCondition.left.text !== reductionIndex ||
    !ts.isPropertyAccessExpression(reductionCondition.right) ||
    !ts.isIdentifier(reductionCondition.right.expression) ||
    reductionCondition.right.expression.text !== fillPlan.arrayName ||
    reductionCondition.right.name.text !== "length" ||
    !reductionIncrement ||
    (!ts.isPrefixUnaryExpression(reductionIncrement) && !ts.isPostfixUnaryExpression(reductionIncrement)) ||
    reductionIncrement.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(reductionIncrement.operand) ||
    reductionIncrement.operand.text !== reductionIndex
  ) {
    return null;
  }

  const reductionBody = ts.isBlock(reductionStatement.statement)
    ? reductionStatement.statement.statements[0]
    : reductionStatement.statement;
  if (!reductionBody || !ts.isExpressionStatement(reductionBody) || !ts.isBinaryExpression(reductionBody.expression)) {
    return null;
  }
  const assignment = reductionBody.expression;
  const reduced = peelExpr(assignment.right);
  if (
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    assignment.left.text !== accumulatorName ||
    !ts.isBinaryExpression(reduced) ||
    reduced.operatorToken.kind !== ts.SyntaxKind.BarToken ||
    i32LiteralValue(reduced.right) !== 0
  ) {
    return null;
  }
  const addition = peelExpr(reduced.left);
  if (
    !ts.isBinaryExpression(addition) ||
    addition.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isIdentifier(addition.left) ||
    addition.left.text !== accumulatorName ||
    !ts.isElementAccessExpression(addition.right) ||
    !ts.isIdentifier(addition.right.expression) ||
    addition.right.expression.text !== fillPlan.arrayName ||
    !ts.isIdentifier(addition.right.argumentExpression) ||
    addition.right.argumentExpression.text !== reductionIndex
  ) {
    return null;
  }

  const returned = returnStatement.expression ? peelExpr(returnStatement.expression) : null;
  const returnIsAccumulator =
    returned !== null &&
    (ts.isIdentifier(returned)
      ? returned.text === accumulatorName
      : ts.isBinaryExpression(returned) &&
        returned.operatorToken.kind === ts.SyntaxKind.BarToken &&
        ts.isIdentifier(returned.left) &&
        returned.left.text === accumulatorName &&
        i32LiteralValue(returned.right) === 0);
  if (!returnIsAccumulator) return null;

  return {
    accumulatorDeclaration: accumulatorStatement,
    fillLoop: fillStatement,
    fillValue,
    accumulatorName,
    returnStatement,
  };
}
