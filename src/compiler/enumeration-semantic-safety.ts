// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function executionScope(node: ts.Node): ts.Node {
  while (node.parent && !ts.isFunctionLike(node) && !ts.isSourceFile(node)) node = node.parent;
  return node;
}

function statementContainer(node: ts.Node): ts.Node | undefined {
  while (node.parent && !ts.isBlock(node.parent) && !ts.isSourceFile(node.parent)) node = node.parent;
  return node.parent;
}

/** Measured limitations of fixed carriers; this is not an enumeration whitelist. */
export function collectUnsafeEnumeration(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  { standalone }: { standalone: boolean },
): UnsafeTypeAssumption[] {
  const findings: UnsafeTypeAssumption[] = [];
  const rebound = new Set<ts.Symbol>();
  let localObject = false;
  let localConsole = false;
  const mark = (node: ts.Node): void => {
    // Duplicate script-global declarations may still resolve to the lib symbol.
    // Conservatively decline the builtin claim if this file binds Object.
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "Object"
    )
      localObject = true;
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "console"
    )
      localConsole = true;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) rebound.add(symbol);
    }
    ts.forEachChild(node, mark);
  };
  mark(sourceFile);
  const origin = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression | undefined => {
    const node = unwrap(expression);
    if (!ts.isIdentifier(node)) return node;
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (
      !symbol ||
      seen.has(symbol) ||
      rebound.has(symbol) ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    )
      return undefined;
    seen.add(symbol);
    return origin(declaration.initializer, seen);
  };
  const objectCall = (node: ts.Expression | undefined, method: string): node is ts.CallExpression => {
    if (localObject) return false;
    if (
      !node ||
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== method ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== "Object"
    )
      return false;
    const symbol = checker.getSymbolAtLocation(node.expression.expression);
    return !symbol?.declarations?.some((declaration) => !declaration.getSourceFile().isDeclarationFile);
  };
  const report = (node: ts.Node, message: string): void => {
    findings.push({ node, id: "JS2WASM_UNSOUND_ENUMERATION", message: `${message} (#5401).` });
  };
  const numeric = (node: ts.Expression): boolean =>
    (checker.getTypeAtLocation(node).flags & ts.TypeFlags.NumberLike) !== 0;
  const propertyName = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : undefined;
  const observesDeletion = (
    receiver: ts.Expression,
    key: string,
    deletion: ts.DeleteExpression,
    array: boolean,
  ): boolean => {
    const scope = executionScope(deletion);
    const restores: ts.BinaryExpression[] = [];
    const collectRestores = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isExpressionStatement(node.parent) &&
        node.parent.parent === statementContainer(deletion)
      ) {
        const target = unwrap(node.left);
        if (
          (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
          origin(target.expression) === receiver &&
          (ts.isPropertyAccessExpression(target) ? target.name.text : propertyName(target.argumentExpression)) === key
        )
          restores.push(node);
      }
      ts.forEachChild(node, collectRestores);
    };
    collectRestores(scope);
    const restoredBefore = (observation: ts.Node): boolean =>
      statementContainer(observation) === statementContainer(deletion) &&
      restores.some((restore) => restore.getStart() > deletion.getEnd() && restore.getEnd() < observation.getStart());
    const rawRead = (expression: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
      const value = unwrap(expression);
      if (ts.isIdentifier(value)) {
        const symbol = checker.getSymbolAtLocation(value);
        const declaration = symbol?.valueDeclaration;
        if (
          !symbol ||
          seen.has(symbol) ||
          rebound.has(symbol) ||
          !declaration ||
          !ts.isVariableDeclaration(declaration) ||
          !declaration.initializer ||
          executionScope(declaration) !== scope ||
          declaration.getStart() <= deletion.getEnd()
        )
          return false;
        seen.add(symbol);
        return rawRead(declaration.initializer, seen);
      }
      if (ts.isTypeOfExpression(value)) return rawRead(value.expression, seen);
      return (
        (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
        origin(value.expression) === receiver &&
        (ts.isPropertyAccessExpression(value) ? value.name.text : propertyName(value.argumentExpression)) === key &&
        !restoredBefore(value)
      );
    };
    let observed = false;
    const inspect = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (node.getStart() > deletion.getEnd()) {
        if (
          ts.isCallExpression(node) &&
          objectCall(node, "keys") &&
          node.arguments[0] &&
          origin(node.arguments[0]) === receiver
        )
          observed = true;
        if (
          array &&
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
          propertyName(unwrap(node.left)) === key &&
          origin(node.right) === receiver &&
          !restoredBefore(node)
        )
          observed = true;
        if (
          !localConsole &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "console" &&
          ["log", "warn", "error", "info", "debug"].includes(node.expression.name.text) &&
          node.arguments.some((argument) => rawRead(argument))
        )
          observed = true;
      }
      if (!observed) ts.forEachChild(node, inspect);
    };
    inspect(scope);
    return observed;
  };
  const sortedArrays = new Map<ts.Expression, number>();
  const findSorts = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "sort"
    ) {
      const array = origin(node.expression.expression);
      if (array) sortedArrays.set(array, node.getStart());
    }
    ts.forEachChild(node, findSorts);
  };
  findSorts(sourceFile);

  const visit = (node: ts.Node): void => {
    if (!standalone && ts.isDeleteExpression(node)) {
      const target = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        // An any-typed receiver uses the generic property carrier and its
        // deletion tombstones, even when its initializer is a numeric literal.
        const receiverType = checker.getTypeAtLocation(target.expression);
        const receiver = receiverType.flags & ts.TypeFlags.Any ? undefined : origin(target.expression);
        const key = ts.isPropertyAccessExpression(target) ? target.name.text : propertyName(target.argumentExpression);
        if (
          receiver &&
          ts.isArrayLiteralExpression(receiver) &&
          key !== undefined &&
          /^(0|[1-9]\d*)$/.test(key) &&
          receiver.elements.length > Number(key) &&
          receiver.elements.every((item) => !ts.isSpreadElement(item) && numeric(item)) &&
          observesDeletion(receiver, key, node, true)
        ) {
          report(node, "Host numeric-array deletion cannot preserve the resulting hole and property presence");
        } else if (
          receiver &&
          ts.isObjectLiteralExpression(receiver) &&
          key !== undefined &&
          receiver.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) && propertyName(property.name) === key && numeric(property.initializer),
          ) &&
          observesDeletion(receiver, key, node, false)
        ) {
          report(node, "Host deletion of a fixed numeric object field cannot preserve key removal and undefined reads");
        }
      }
    }
    if (!standalone && ts.isForInStatement(node)) {
      const receiver = origin(node.expression);
      const prototype =
        objectCall(receiver, "create") && receiver.arguments[0] ? origin(receiver.arguments[0]) : undefined;
      if (prototype && ts.isObjectLiteralExpression(prototype) && prototype.properties.length > 0)
        report(node, "Host for-in enumeration of Object.create receivers cannot preserve own and inherited keys");
    }
    if (standalone && ts.isCallExpression(node) && objectCall(node, "keys") && node.arguments[0]) {
      const receiver = origin(node.arguments[0]);
      if (
        receiver &&
        ts.isObjectLiteralExpression(receiver) &&
        receiver.properties.some((property) => {
          if (!ts.isSpreadAssignment(property)) return false;
          const spread = origin(property.expression);
          return spread && ts.isObjectLiteralExpression(spread) && spread.properties.length > 1;
        })
      )
        report(node, "Standalone Object.keys after object spread cannot preserve source insertion order");
    }
    if (standalone && ts.isForInStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const binding = node.initializer.declarations[0]?.name;
      const key = binding && ts.isIdentifier(binding) ? checker.getSymbolAtLocation(binding) : undefined;
      const inspect = (child: ts.Node): void => {
        if (
          key &&
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === "push" &&
          child.arguments.some((arg) => {
            const value = unwrap(arg);
            return ts.isIdentifier(value) && checker.getSymbolAtLocation(value) === key;
          })
        ) {
          const array = origin(child.expression.expression);
          if (
            array &&
            ts.isArrayLiteralExpression(array) &&
            array.elements.length === 0 &&
            (sortedArrays.get(array) ?? -1) > child.getEnd()
          ) {
            report(
              child,
              "Standalone sorting of for-in keys collected into an empty array has an unsupported string carrier",
            );
          }
        }
        ts.forEachChild(child, inspect);
      };
      inspect(node.statement);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
