// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrType } from "./core/types.js";
import type { IrUnitId } from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";

type Vector = Extract<IrType, { kind: "vec" }>;
type VectorNode = ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression;
type Proof = "defined" | "possibly-absent" | "unknown";
interface Context {
  readonly checker?: ts.TypeChecker;
  readonly logicalVectorTypes: ReadonlyMap<VectorNode, Vector>;
  readonly identity?: IrPlanningIdentityContext;
  readonly ownerUnitId: IrUnitId;
  readonly numericParameter: (parameter: ts.ParameterDeclaration) => boolean;
  readonly inBounds: (read: ts.ElementAccessExpression) => boolean;
}
function owner(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return current;
  return undefined;
}
function transparent(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  )
    expr = expr.expression;
  return expr;
}
/** Source-only conservative all-write proof. No representation or checker number type proves absence impossible. */
export function nativeNumericUndefinedProof(expression: ts.Expression, context: Context): Proof {
  const checker = context.checker,
    root = owner(expression);
  if (!checker || !root) return "unknown";
  const writes = new Map<ts.Symbol, ts.Expression[]>(),
    unfinished = new Set<ts.Symbol>();
  let nodes = 0,
    exhausted = false;
  const record = (name: ts.Identifier, value: ts.Expression): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) {
      exhausted = true;
      return;
    }
    const values = writes.get(symbol) ?? [];
    values.push(value);
    writes.set(symbol, values);
  };
  const markUnknownTarget = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) unfinished.add(symbol);
      else exhausted = true;
    } else ts.forEachChild(node, markUnknownTarget);
  };
  const scan = (node: ts.Node): void => {
    if (++nodes > 20000) {
      exhausted = true;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      record(node.name, node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      record(node.left, node.right);
    // Compound assignments remain conservatively unknown; no mutable
    // overwrite clears an earlier possibly absent source value.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) unfinished.add(symbol);
      else exhausted = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      !ts.isIdentifier(node.left)
    )
      markUnknownTarget(node.left);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
      markUnknownTarget(node.initializer);
    ts.forEachChild(node, scan);
  };
  scan(root);
  if (exhausted) return "unknown";
  const publicInput = (): boolean => {
    const identity = context.identity;
    if (!identity || !ts.isFunctionDeclaration(root) || !root.name) return false;
    const source = root.getSourceFile(),
      sourceId = identity.sourceIdBySourceFile.get(source);
    if (
      !sourceId ||
      identity.sourceFileBySourceId.get(sourceId) !== source ||
      identity.unitIdByDeclaration.get(root) !== context.ownerUnitId ||
      identity.declarationByUnitId.get(context.ownerUnitId) !== root ||
      identity.unitByUnitId.get(context.ownerUnitId)?.sourceId !== sourceId
    )
      return false;
    let unknown = false,
      used = false,
      count = 0;
    const canonical = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
      const seen = new Set<ts.Symbol>();
      while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        if (seen.has(symbol)) {
          unknown = true;
          return undefined;
        }
        seen.add(symbol);
        symbol = checker.getAliasedSymbol(symbol);
      }
      return symbol;
    };
    const symbol = canonical(checker.getSymbolAtLocation(root.name));
    const module = checker.getSymbolAtLocation(source);
    if (!symbol || !module || !checker.getExportsOfModule(module).some((value) => canonical(value) === symbol))
      return false;
    const visit = (node: ts.Node): void => {
      if (++count > 20000) {
        unknown = true;
        return;
      }
      if (ts.isIdentifier(node) && node !== root.name) {
        const reference = canonical(checker.getSymbolAtLocation(node));
        if (reference === symbol) used = true;
        else if (
          !reference &&
          !(node.text === "undefined" && (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined) !== 0)
        )
          unknown = true;
      }
      ts.forEachChild(node, visit);
    };
    for (const file of identity.sourceFileBySourceId.values()) visit(file);
    return !unknown && !used;
  };
  const parameterBoundary = publicInput();
  const active = new Set<ts.Symbol>();
  const numeric = (expr: ts.Expression): boolean =>
    (checker.getTypeAtLocation(expr).flags & ts.TypeFlags.NumberLike) !== 0;
  const vector = (expr: ts.Expression): boolean => {
    expr = transparent(expr);
    let type = context.logicalVectorTypes.get(expr);
    if (!type && ts.isIdentifier(expr)) {
      const declarations = checker.getSymbolAtLocation(expr)?.declarations;
      if (declarations?.length === 1) {
        const declaration = declarations[0]!;
        if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
          type = context.logicalVectorTypes.get(declaration);
      }
    }
    return type?.elementType.kind === "val" && type.elementType.val.kind === "f64";
  };
  const join = (proofs: readonly Proof[]): Proof =>
    proofs.includes("possibly-absent")
      ? "possibly-absent"
      : !proofs.length || proofs.includes("unknown")
        ? "unknown"
        : "defined";
  const prove = (value: ts.Expression, depth: number): Proof => {
    if (depth > 128) return "unknown";
    value = transparent(value);
    if (ts.isNumericLiteral(value)) return "defined";
    if (ts.isElementAccessExpression(value))
      return vector(value.expression)
        ? value === transparent(expression) && context.inBounds(value)
          ? "defined"
          : "possibly-absent"
        : "unknown";
    if (ts.isIdentifier(value)) {
      const symbol = checker.getSymbolAtLocation(value);
      if (!symbol || active.has(symbol) || unfinished.has(symbol)) return "unknown";
      const declarations = symbol.declarations;
      if (declarations?.length !== 1 || owner(declarations[0]!) !== root) return "unknown";
      const declaration = declarations[0]!;
      if (ts.isParameter(declaration)) {
        if (
          !parameterBoundary ||
          !context.numericParameter(declaration) ||
          declaration.questionToken ||
          declaration.dotDotDotToken ||
          !numeric(value)
        )
          return "unknown";
        const assigned = writes.get(symbol) ?? [];
        active.add(symbol);
        const proof = join([
          "defined",
          ...(declaration.initializer ? [prove(declaration.initializer, depth + 1)] : []),
          ...assigned.map((expr) => prove(expr, depth + 1)),
        ]);
        active.delete(symbol);
        return proof;
      }
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return "unknown";
      active.add(symbol);
      const proof = join((writes.get(symbol) ?? []).map((expr) => prove(expr, depth + 1)));
      active.delete(symbol);
      return proof;
    }
    if (ts.isConditionalExpression(value))
      return join([prove(value.whenTrue, depth + 1), prove(value.whenFalse, depth + 1)]);
    if (
      ts.isPrefixUnaryExpression(value) &&
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(value.operator)
    )
      return "defined";
    if (ts.isBinaryExpression(value)) {
      const op = value.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken) return prove(value.right, depth + 1);
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(op)
      )
        return join([prove(value.left, depth + 1), prove(value.right, depth + 1)]);
      if (
        [
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.PercentToken,
          ts.SyntaxKind.AsteriskAsteriskToken,
          ts.SyntaxKind.AmpersandToken,
          ts.SyntaxKind.BarToken,
          ts.SyntaxKind.CaretToken,
          ts.SyntaxKind.LessThanLessThanToken,
          ts.SyntaxKind.GreaterThanGreaterThanToken,
          ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ].includes(op)
      )
        return "defined";
      if (op === ts.SyntaxKind.PlusToken && numeric(value.left) && numeric(value.right)) return "defined";
    }
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "Number") {
      const symbol = checker.getSymbolAtLocation(value.expression),
        ambient = checker.resolveName("Number", undefined, ts.SymbolFlags.Value, false);
      if (
        symbol &&
        symbol === ambient &&
        !writes.has(symbol) &&
        !unfinished.has(symbol) &&
        symbol.declarations?.length &&
        symbol.declarations.every((node) => node.getSourceFile().isDeclarationFile)
      )
        return "defined";
    }
    if (ts.isPropertyAccessExpression(value) && value.name.text === "length" && vector(value.expression))
      return "defined";
    // Calls, fields, cross-function/captured bindings and unrecognized forms
    // have no source value proof. An unboxed numeric result does not fix that.
    return "unknown";
  };
  return prove(expression, 0);
}
