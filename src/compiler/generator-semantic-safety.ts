// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

type Generator = ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration;

function scope(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function bodyNodes(generator: Generator): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  if (generator.body) ts.forEachChild(generator.body, visit);
  return nodes;
}

function assignedIdentifier(node: ts.Node): ts.Identifier | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return ts.isIdentifier(node.left) ? node.left : undefined;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return ts.isIdentifier(node.operand) ? node.operand : undefined;
  }
  return undefined;
}

/** Source evidence for measured generator/iterator limitations, not a general safety proof. */
export function collectUnsafeGeneratorSemantics(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
  options: { standalone: boolean },
): UnsafeTypeAssumption[] {
  const diagnostics: UnsafeTypeAssumption[] = [];
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const report = (node: ts.Node, id: string, message: string): void => {
    diagnostics.push({ node, id, message: `${message} (#5398).` });
  };

  inspectGenerators(checker, nodes, options, report);
  inspectArrayIterators(checker, nodes, options, report);
  return diagnostics;
}

type Report = (node: ts.Node, id: string, message: string) => void;

function inspectGenerators(
  checker: ts.TypeChecker,
  nodes: ts.Node[],
  options: { standalone: boolean },
  report: Report,
): void {
  for (const node of nodes) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
      node.asteriskToken
    ) {
      const body = bodyNodes(node);
      const yields = body.filter(ts.isYieldExpression);
      for (const yielded of yields) {
        let use: ts.Node = yielded;
        while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
        if (
          yielded.asteriskToken &&
          !ts.isExpressionStatement(use.parent) &&
          (!options.standalone || ts.isReturnStatement(use.parent))
        ) {
          report(
            yielded,
            "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT",
            "The selected generator backend cannot preserve this consumed yield* completion value; avoid consuming delegation results",
          );
        }
      }
      if (!options.standalone) {
        const consumesSentValue = yields.some(
          (yielded) => !yielded.asteriskToken && !ts.isExpressionStatement(yielded.parent),
        );
        const yieldTypes = yields
          .filter((yielded) => !yielded.asteriskToken && yielded.expression)
          .map((yielded) => checker.getTypeAtLocation(yielded.expression!));
        const hasString = yieldTypes.some((type) => !!(type.flags & ts.TypeFlags.StringLike));
        const hasNumber = yieldTypes.some((type) => !!(type.flags & ts.TypeFlags.NumberLike));
        const untypedSentBinding = yields.some((yielded) => {
          if (yielded.asteriskToken || !ts.isVariableDeclaration(yielded.parent)) return false;
          const type = checker.getTypeAtLocation(yielded.parent.name);
          return !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
        });
        if (consumesSentValue && ((hasString && hasNumber) || untypedSentBinding)) {
          const consumed = yields.find(
            (yielded) => !yielded.asteriskToken && !ts.isExpressionStatement(yielded.parent),
          )!;
          report(
            consumed,
            "JS2WASM_UNSUPPORTED_GENERATOR_SENT_VALUE",
            "The host generator fallback cannot resume this mixed or untyped yield sequence with next(value); use a supported uniform typed generator",
          );
        }
        if (ts.isFunctionExpression(node)) {
          const capturedWrite = body.map(assignedIdentifier).find((identifier) => {
            if (!identifier) return false;
            const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
            return (
              declaration &&
              !ts.isSourceFile(scope(declaration)) &&
              (declaration.pos < node.pos || declaration.end > node.end)
            );
          });
          if (capturedWrite && yields.length > 0) {
            report(
              capturedWrite,
              "JS2WASM_UNSUPPORTED_GENERATOR_CAPTURE_MUTATION",
              "The host generator-expression fallback eagerly mutates this captured binding; use a supported generator declaration or standalone target",
            );
          }
        }
      }
    }
  }
}

function inspectArrayIterators(
  checker: ts.TypeChecker,
  nodes: ts.Node[],
  options: { standalone: boolean },
  report: Report,
): void {
  for (const node of nodes) {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) continue;
    const call = unwrap(node.initializer);
    if (!ts.isCallExpression(call) || !ts.isElementAccessExpression(call.expression)) continue;
    const access = call.expression;
    const key = access.argumentExpression;
    if (
      !ts.isPropertyAccessExpression(key) ||
      key.name.text !== "iterator" ||
      !ts.isIdentifier(key.expression) ||
      key.expression.text !== "Symbol"
    )
      continue;
    const symbolDeclaration = checker.getSymbolAtLocation(key.expression)?.valueDeclaration;
    if (!symbolDeclaration?.getSourceFile().isDeclarationFile) continue;
    const receiver = unwrap(access.expression);
    if (
      !checker.isArrayType(checker.getTypeAtLocation(receiver)) &&
      !checker.isTupleType(checker.getTypeAtLocation(receiver))
    )
      continue;
    if (options.standalone) {
      report(
        call,
        "JS2WASM_UNSUPPORTED_EXPLICIT_ARRAY_ITERATOR",
        "Standalone cannot yet preserve an explicit Array Symbol.iterator cursor; use direct array traversal",
      );
      continue;
    }
    if (!ts.isIdentifier(receiver)) continue;
    const arraySymbol = checker.getSymbolAtLocation(receiver);
    const iteratorSymbol = checker.getSymbolAtLocation(node.name);
    const owner = scope(node);
    const laterReads = nodes.filter(
      (candidate) =>
        ts.isCallExpression(candidate) &&
        candidate.pos > node.end &&
        scope(candidate) === owner &&
        ts.isPropertyAccessExpression(candidate.expression) &&
        candidate.expression.name.text === "next" &&
        checker.getSymbolAtLocation(candidate.expression.expression) === iteratorSymbol,
    );
    const mutation = nodes.find((candidate) => {
      if (
        candidate.pos <= node.end ||
        scope(candidate) !== owner ||
        !laterReads.some((read) => read.pos > candidate.end)
      )
        return false;
      if (!ts.isCallExpression(candidate) || !ts.isPropertyAccessExpression(candidate.expression)) return false;
      return (
        ["push", "pop", "shift", "unshift", "splice"].includes(candidate.expression.name.text) &&
        checker.getSymbolAtLocation(candidate.expression.expression) === arraySymbol
      );
    });
    if (mutation)
      report(
        mutation,
        "JS2WASM_UNSUPPORTED_LIVE_ARRAY_ITERATOR",
        "The host array iterator snapshots its source and cannot observe this later array mutation; finish iteration before mutating the array",
      );
  }
}
