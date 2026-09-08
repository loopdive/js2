// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

type Kind = "number" | "string" | "boolean" | "bigint" | "symbol" | "undefined" | "null" | "object" | "unknown";

function scalarKind(type: ts.Type): Kind | undefined {
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & ts.TypeFlags.ESSymbolLike) return "symbol";
  return undefined;
}

/** Assertions are erased by JavaScript, so only their operand supplies evidence. */
function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  )
    expr = expr.expression;
  return expr;
}

function declarationOf(checker: ts.TypeChecker, node: ts.Node): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function lexicalOwner(node: ts.Node): ts.Node {
  while (node.parent && !ts.isFunctionLike(node) && !ts.isSourceFile(node)) node = node.parent;
  return node;
}

function activeGuardKind(checker: ts.TypeChecker, use: ts.Identifier): Kind | undefined {
  const binding = checker.getSymbolAtLocation(use);
  let child: ts.Node = use;
  for (let parent = use.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) break;
    if (!ts.isIfStatement(parent) || child !== parent.thenStatement) continue;
    const condition = unwrap(parent.expression);
    if (
      !ts.isBinaryExpression(condition) ||
      ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(condition.operatorToken.kind)
    )
      continue;
    const left = unwrap(condition.left),
      right = unwrap(condition.right);
    const probe = ts.isTypeOfExpression(left) ? left : ts.isTypeOfExpression(right) ? right : undefined;
    const tag = ts.isStringLiteral(left) ? left.text : ts.isStringLiteral(right) ? right.text : undefined;
    if (!probe || !tag || !["number", "string", "boolean", "bigint", "symbol"].includes(tag)) continue;
    const operand = unwrap(probe.expression);
    if (!ts.isIdentifier(operand) || checker.getSymbolAtLocation(operand) !== binding) continue;
    let invalidated = false;
    const inspect = (node: ts.Node): void => {
      if (node.pos >= use.pos || ts.isFunctionLike(node)) return;
      if (node.end <= use.pos && (ts.isCallExpression(node) || ts.isNewExpression(node))) invalidated = true;
      if (
        ts.isBinaryExpression(node) &&
        node.end <= use.pos &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === binding &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        invalidated = true;
      ts.forEachChild(node, inspect);
    };
    inspect(parent.thenStatement);
    if (!invalidated) return tag as Kind;
  }
  return undefined;
}

/** Source-order origins for a binding; never count a future or uncalled write. */
function variableKindsAtUse(
  checker: ts.TypeChecker,
  use: ts.Identifier,
  declaration: ts.VariableDeclaration,
  seen: Set<ts.Node>,
): Set<Kind> {
  let values = runtimeKinds(checker, declaration.initializer!, seen);
  const owner = lexicalOwner(use);
  const declaredOwner = lexicalOwner(declaration);
  const binding = checker.getSymbolAtLocation(declaration.name);
  if (owner !== declaredOwner) {
    return (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? values : new Set(["unknown"]);
  }
  const unconditional = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent && parent !== owner; parent = parent.parent) {
      if (
        ts.isIfStatement(parent) ||
        ts.isConditionalExpression(parent) ||
        ts.isIterationStatement(parent, false) ||
        ts.isSwitchStatement(parent) ||
        ts.isCaseClause(parent) ||
        ts.isCatchClause(parent) ||
        (ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(parent.operatorToken.kind))
      )
        return false;
    }
    return true;
  };
  const mergeWrite = (rhs: ts.Expression, replace: boolean): void => {
    const kinds = runtimeKinds(checker, rhs, seen);
    if (replace) values = kinds;
    else for (const kind of kinds) values.add(kind);
  };
  const inspectCalledBody = (body: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === binding
      )
        mergeWrite(node.right, false);
      ts.forEachChild(node, visit);
    };
    visit(body);
  };
  const visit = (node: ts.Node): void => {
    if (node !== owner && ts.isFunctionLike(node)) return;
    if (node.pos >= use.pos) return;
    ts.forEachChild(node, visit);
    if (node.end > use.pos || node.end <= declaration.end) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      checker.getSymbolAtLocation(node.left) === binding
    )
      mergeWrite(node.right, unconditional(node));
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = declarationOf(checker, node.expression);
      if (callee && ts.isFunctionDeclaration(callee) && callee.body) inspectCalledBody(callee.body);
      if (callee && ts.isVariableDeclaration(callee) && callee.initializer) {
        const initializer = unwrap(callee.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          inspectCalledBody(initializer.body);
      }
    }
  };
  visit(owner);
  return values;
}

/** A direct, unmodified generic parameter returns the argument's runtime value. */
function returnedGenericArgument(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  implementation: ts.FunctionDeclaration,
  call: ts.CallExpression,
): ts.Expression | undefined {
  const value = unwrap(expression);
  if (!ts.isIdentifier(value) || (checker.getTypeAtLocation(value).flags & ts.TypeFlags.TypeParameter) === 0)
    return undefined;
  const declaration = declarationOf(checker, value);
  if (!declaration || !ts.isParameter(declaration) || declaration.parent !== implementation) return undefined;
  const parameterSymbol = checker.getSymbolAtLocation(value);
  let modified = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      checker.getSymbolAtLocation(node.left) === parameterSymbol
    )
      modified = true;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      ts.isIdentifier(node.operand) &&
      checker.getSymbolAtLocation(node.operand) === parameterSymbol
    )
      modified = true;
    ts.forEachChild(node, visit);
  };
  visit(implementation.body!);
  if (modified) return undefined;
  return call.arguments[implementation.parameters.indexOf(declaration)] ?? declaration.initializer;
}

/** Actual visible value origins, never the target type of an assertion. */
function runtimeKinds(checker: ts.TypeChecker, expression: ts.Expression, seen = new Set<ts.Node>()): Set<Kind> {
  const expr = unwrap(expression);
  if (seen.has(expr)) return new Set(["unknown"]);
  seen = new Set(seen).add(expr);
  if (ts.isStringLiteralLike(expr) || ts.isTemplateExpression(expr)) return new Set(["string"]);
  if (ts.isNumericLiteral(expr)) return new Set(["number"]);
  if (ts.isBigIntLiteral(expr)) return new Set(["bigint"]);
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return new Set(["boolean"]);
  if (expr.kind === ts.SyntaxKind.NullKeyword) return new Set(["null"]);
  if (ts.isVoidExpression(expr)) return new Set(["undefined"]);
  if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr) || ts.isNewExpression(expr))
    return new Set(["object"]);
  if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.ExclamationToken) return new Set(["boolean"]);
    if (expr.operator === ts.SyntaxKind.PlusToken) return new Set(["number"]);
  }
  if (ts.isConditionalExpression(expr))
    return new Set([...runtimeKinds(checker, expr.whenTrue, seen), ...runtimeKinds(checker, expr.whenFalse, seen)]);
  if (ts.isIdentifier(expr)) {
    const declaration = declarationOf(checker, expr);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const guarded = activeGuardKind(checker, expr);
      if (guarded) return new Set([guarded]);
      return variableKindsAtUse(checker, expr, declaration, seen);
    }
    if (expr.text === "undefined" && (!declaration || declaration.getSourceFile().isDeclarationFile))
      return new Set(["undefined"]);
  }
  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression)) {
      const declaration = declarationOf(checker, expr.expression);
      if (!declaration || declaration.getSourceFile().isDeclarationFile) {
        const conversion = (
          { Number: "number", String: "string", Boolean: "boolean", BigInt: "bigint", Symbol: "symbol" } as const
        )[expr.expression.text];
        if (conversion) return new Set([conversion]);
      }
      if (declaration && ts.isFunctionDeclaration(declaration)) {
        const symbol = checker.getSymbolAtLocation(declaration.name!);
        const implementation = symbol?.declarations?.find(
          (d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && !!d.body,
        );
        if (implementation?.body && !seen.has(implementation)) {
          const values = new Set<Kind>();
          const nested = new Set(seen).add(implementation);
          const visit = (node: ts.Node): void => {
            if (ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node)) {
              for (const kind of node.expression
                ? runtimeKinds(
                    checker,
                    returnedGenericArgument(checker, node.expression, implementation, expr) ?? node.expression,
                    nested,
                  )
                : ["undefined" as const])
                values.add(kind);
            }
            ts.forEachChild(node, visit);
          };
          visit(implementation.body);
          if (values.size) return values;
        }
      }
    }
  }
  const type = checker.getTypeAtLocation(expr);
  if (type.flags & ts.TypeFlags.Undefined) return new Set(["undefined"]);
  if (type.flags & ts.TypeFlags.Null) return new Set(["null"]);
  // Non-erased computed operations and genuinely typed parameters retain their
  // normal contracts; their call sites are checked separately below.
  return new Set([scalarKind(type) ?? "unknown"]);
}

export function collectUnsafePrimitiveFlows(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): UnsafeTypeAssumption[] {
  const findings: UnsafeTypeAssumption[] = [];
  const seen = new Set<ts.Node>();
  const check = (node: ts.Node, value: ts.Expression, target: ts.Type, id: string): void => {
    const expected = scalarKind(target);
    if (!expected || seen.has(node)) return;
    const actual = runtimeKinds(checker, value);
    if (actual.size === 1 && actual.has(expected)) return;
    seen.add(node);
    findings.push({
      node,
      id,
      message: `Cannot preserve JavaScript: this ${expected}-typed operation receives ${[...actual].join(" or ")}. Keep the value dynamic or explicitly convert it before this operation.`,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      check(node, node.expression, checker.getTypeFromTypeNode(node.type), "JS2WASM_UNSOUND_ASSERTION");
    } else if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
      check(
        node.initializer,
        node.initializer,
        checker.getTypeFromTypeNode(node.type),
        "JS2WASM_UNSOUND_PRIMITIVE_FLOW",
      );
    } else if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      if (signature) {
        for (let i = 0; i < Math.min(signature.parameters.length, node.arguments.length); i++) {
          const parameter = signature.parameters[i].valueDeclaration;
          if (
            parameter &&
            ts.isParameter(parameter) &&
            parameter.type &&
            !parameter.dotDotDotToken &&
            !parameter.getSourceFile().isDeclarationFile
          ) {
            check(
              node.arguments[i],
              node.arguments[i],
              checker.getTypeFromTypeNode(parameter.type),
              "JS2WASM_UNSOUND_PRIMITIVE_FLOW",
            );
          }
        }
        const declaration = signature.declaration;
        if (
          declaration &&
          ts.isFunctionDeclaration(declaration) &&
          !declaration.body &&
          !declaration.getSourceFile().isDeclarationFile
        ) {
          check(node, node, checker.getReturnTypeOfSignature(signature), "JS2WASM_UNSOUND_OVERLOAD");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
