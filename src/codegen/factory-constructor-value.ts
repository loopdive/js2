import { forEachChild, ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** A const binding initialized by an unchanged, single-return ordinary factory. */
export function isConstFactoryConstructor(ctx: CodegenContext, callee: ts.Identifier): boolean {
  if (ctx.dynamicCodeDirty) return false;
  const init = ctx.oracle.constInitializerOf(callee);
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false;
  const factory = ctx.oracle.valueDeclarationOf(init.expression);
  if (
    !factory ||
    !ts.isFunctionDeclaration(factory) ||
    !factory.name ||
    factory.asteriskToken ||
    !factory.body ||
    factory.body.statements.length !== 1 ||
    factory.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return false;
  const statement = factory.body.statements[0]!;
  if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isFunctionExpression(statement.expression))
    return false;
  const returned = statement.expression;
  if (returned.asteriskToken || returned.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const name = factory.name.text;
  const containsName = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === name) || forEachChild(node, containsName) === true;
  let written = false;
  const scan = (node: ts.Node): void => {
    if (written) return;
    if (
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        containsName(node.left)) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        containsName(node.operand)) ||
      ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && containsName(node.initializer)) ||
      (ts.isVariableDeclaration(node) && !!node.initializer && containsName(node.name)) ||
      (ts.isFunctionDeclaration(node) && node !== factory && node.name?.text === name)
    ) {
      written = true;
      return;
    }
    forEachChild(node, scan);
  };
  scan(factory.getSourceFile());
  return !written;
}
