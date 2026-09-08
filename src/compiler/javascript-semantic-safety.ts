// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

/** Concrete source origins only; an unknown origin is not proof of safety. */
export function collectUnsafeJavaScriptOperations(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
  { standalone }: { standalone: boolean },
): UnsafeTypeAssumption[] {
  const errors: UnsafeTypeAssumption[] = [];
  const sourceNames = new Set<string>();
  const reassigned = new Set<ts.Symbol>();
  const recordWrite = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) reassigned.add(symbol);
    } else if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node))
      ts.forEachChild(node, recordWrite);
  };
  const findWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      recordWrite(node.left);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      recordWrite(node.operand);
    ts.forEachChild(node, findWrites);
  };
  findWrites(file);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) sourceNames.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) sourceNames.add(declaration.name.text);
  }
  const origin = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression => {
    if (ts.isParenthesizedExpression(expression)) return origin(expression.expression, seen);
    if (!ts.isIdentifier(expression)) return expression;
    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration;
    if (
      !symbol ||
      reassigned.has(symbol) ||
      seen.has(symbol) ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    )
      return expression;
    seen.add(symbol);
    return origin(declaration.initializer, seen);
  };
  const builtin = (expression: ts.Expression, name: string): boolean =>
    ts.isIdentifier(expression) &&
    expression.text === name &&
    !sourceNames.has(name) &&
    (checker.getSymbolAtLocation(expression)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile) ?? true);
  const array = (expression: ts.Expression): ts.ArrayLiteralExpression | undefined => {
    const value = origin(expression);
    return ts.isArrayLiteralExpression(value) ? value : undefined;
  };
  const add = (node: ts.Node, id: string, message: string): void => {
    errors.push({
      node,
      id: `JS2WASM_UNSUPPORTED_${id}`,
      message: `${message} Rewrite this operation before compiling to this target (#5399).`,
    });
  };
  const contains = (node: ts.Node, predicate: (n: ts.Node) => boolean): boolean => {
    if (predicate(node)) return true;
    return ts.forEachChild(node, (child) => contains(child, predicate) || undefined) ?? false;
  };
  const sameReceiver = (a: ts.Expression, b: ts.Expression): boolean =>
    (ts.isIdentifier(a) && ts.isIdentifier(b) && checker.getSymbolAtLocation(a) === checker.getSymbolAtLocation(b)) ||
    origin(a) === origin(b);
  const coercibleSingleton = (expression: ts.Expression): boolean => {
    const literal = array(expression);
    if (!literal) return false;
    if (!literal.elements.length) return true;
    if (literal.elements.length !== 1) return false;
    const value = literal.elements[0]!;
    return ts.isNumericLiteral(value) || (ts.isStringLiteral(value) && !Number.isNaN(Number(value.text)));
  };
  const filledHole = (node: ts.BinaryExpression): boolean => {
    if (!standalone || !ts.isIdentifier(node.right) || !ts.isNumericLiteral(node.left)) return false;
    for (let parent: ts.Node | undefined = node.parent; parent && parent !== file; parent = parent.parent)
      if (ts.isFunctionLike(parent)) return false;
    return file.statements.some((statement) => {
      if (
        statement.end >= node.pos ||
        !ts.isExpressionStatement(statement) ||
        !ts.isBinaryExpression(statement.expression)
      )
        return false;
      const write = statement.expression;
      return (
        write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(write.left) &&
        ts.isIdentifier(write.left.expression) &&
        checker.getSymbolAtLocation(write.left.expression) === checker.getSymbolAtLocation(node.right) &&
        ts.isNumericLiteral(write.left.argumentExpression) &&
        Number(write.left.argumentExpression.text) === Number((node.left as ts.NumericLiteral).text) &&
        ts.isNumericLiteral(write.right)
      );
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      standalone &&
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      const lookup = builtin(node.right, "undefined")
        ? node.left
        : builtin(node.left, "undefined")
          ? node.right
          : undefined;
      if (
        lookup &&
        ts.isCallExpression(lookup) &&
        ts.isPropertyAccessExpression(lookup.expression) &&
        lookup.expression.name.text === "get" &&
        lookup.arguments[0] &&
        ts.isObjectLiteralExpression(lookup.arguments[0])
      ) {
        const map = origin(lookup.expression.expression);
        if (ts.isNewExpression(map) && builtin(map.expression, "Map"))
          add(
            lookup,
            "MAP_ABSENT_OBJECT_KEY",
            "A fresh object key is absent, but standalone Map.get does not preserve undefined identity here.",
          );
      }
    }
    if (ts.isBinaryExpression(node)) {
      if (
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isNumericLiteral(node.left) &&
        array(node.right)?.elements[Number(node.left.text)]?.kind === ts.SyntaxKind.OmittedExpression &&
        !filledHole(node)
      )
        add(node, "ARRAY_HOLE_PRESENCE", "Sparse-array membership currently treats holes as present elements.");
      if (!standalone && node.operatorToken.kind === ts.SyntaxKind.PlusToken && (array(node.left) || array(node.right)))
        add(
          node,
          "ARRAY_TO_PRIMITIVE",
          "The host array carrier cannot preserve JavaScript ToPrimitive for this addition.",
        );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (!standalone && builtin(callee, "Number") && node.arguments[0] && coercibleSingleton(node.arguments[0]))
        add(node, "ARRAY_TO_NUMBER", "The host array carrier cannot preserve Number(array) coercion.");
      if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression;
        if (standalone && callee.name.text === "stringify" && builtin(receiver, "JSON") && node.arguments[0]) {
          const value = origin(node.arguments[0]);
          const declaration = ts.isNewExpression(value)
            ? checker.getSymbolAtLocation(value.expression)?.valueDeclaration
            : undefined;
          if (
            declaration &&
            ts.isClassDeclaration(declaration) &&
            declaration.members.some((m) => ts.isPropertyDeclaration(m) && ts.isPrivateIdentifier(m.name)) &&
            !declaration.members.some((m) => ts.isPropertyDeclaration(m) && !ts.isPrivateIdentifier(m.name)) &&
            !contains(
              declaration,
              (n) =>
                ts.isBinaryExpression(n) &&
                n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(n.left) &&
                n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
                !ts.isPrivateIdentifier(n.left.name),
            )
          )
            add(
              node,
              "PRIVATE_INSTANCE_JSON",
              "Standalone JSON.stringify does not preserve the empty public shape of this private-field instance.",
            );
        }

        if (
          callee.name.text === "setPrototypeOf" &&
          builtin(receiver, "Object") &&
          node.arguments[0] &&
          array(node.arguments[0]) &&
          !(
            node.arguments[1] &&
            ts.isPropertyAccessExpression(node.arguments[1]) &&
            node.arguments[1].name.text === "prototype" &&
            builtin(node.arguments[1].expression, "Array")
          )
        )
          add(
            node,
            "ARRAY_PROTOTYPE",
            "Array prototype replacement is not reflected in compiled indexed reads or membership.",
          );
        if (callee.name.text === "call" && ts.isPropertyAccessExpression(receiver)) {
          const declaration = checker.getSymbolAtLocation(receiver.name)?.valueDeclaration;
          if (
            declaration &&
            ts.isMethodDeclaration(declaration) &&
            ts.isObjectLiteralExpression(declaration.parent) &&
            node.arguments[0] &&
            !sameReceiver(node.arguments[0], receiver.expression) &&
            contains(declaration, (n) => n.kind === ts.SyntaxKind.ThisKeyword)
          )
            add(
              node,
              "METHOD_CALL_RECEIVER",
              "Calling this object method with a different receiver loses its JavaScript this binding.",
            );
          if (
            standalone &&
            ts.isPropertyAccessExpression(receiver.expression) &&
            receiver.expression.name.text === "prototype" &&
            checker.getSymbolAtLocation(receiver.expression.expression)?.declarations?.some(ts.isClassDeclaration)
          )
            add(node, "PROTOTYPE_METHOD_CALL", "Standalone prototype method.call does not preserve the method result.");
        }
        if (
          !standalone &&
          callee.name.text === "then" &&
          ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          receiver.expression.name.text === "all" &&
          builtin(receiver.expression.expression, "Promise") &&
          node.arguments[0] &&
          (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
        ) {
          const callback = node.arguments[0];
          const parameter = callback.parameters[0];
          const symbol = parameter && checker.getSymbolAtLocation(parameter.name);
          if (
            symbol &&
            contains(
              callback.body,
              (n) =>
                ts.isCallExpression(n) &&
                ts.isPropertyAccessExpression(n.expression) &&
                n.expression.name.text === "join" &&
                checker.getSymbolAtLocation(n.expression.expression) === symbol,
            )
          )
            add(
              node,
              "PROMISE_ALL_ARRAY",
              "The host Promise.all result cannot be materialized as a compiled array for join().",
            );
        }
      }
    }
    if (
      ts.isConstructorDeclaration(node) &&
      node.body &&
      node.parent.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword) &&
      !contains(node.body, (n) => ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword)
    ) {
      for (const statement of node.body.statements)
        if (
          ts.isReturnStatement(statement) &&
          statement.expression &&
          ts.isObjectLiteralExpression(statement.expression)
        )
          add(
            statement,
            "DERIVED_RETURN_OBJECT",
            "A derived constructor returning an object before super currently raises an incorrect ReferenceError.",
          );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}
