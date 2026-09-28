// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

type Literal = ts.ArrayLiteralExpression | ts.ObjectLiteralExpression;
type Context = {
  checker: ts.TypeChecker;
  identifiers: Map<ts.Symbol, ts.Identifier[]>;
};

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function wrapped(node: ts.Node): ts.Node {
  while (
    node.parent &&
    (ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isTypeAssertionExpression(node.parent) ||
      ts.isNonNullExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent))
  ) {
    node = node.parent;
  }
  return node;
}

function constantDeclaration(symbol: ts.Symbol | undefined): ts.VariableDeclaration | undefined {
  const declaration = symbol?.valueDeclaration;
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ? declaration
    : undefined;
}

function literalOf(ctx: Context, expression: ts.Expression, seen = new Set<ts.Symbol>()): Literal | undefined {
  const value = unwrap(expression);
  if (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  const symbol = ctx.checker.getSymbolAtLocation(value);
  const declaration = constantDeclaration(symbol);
  if (!symbol || !declaration || seen.has(symbol)) return undefined;
  seen.add(symbol);
  return literalOf(ctx, declaration.initializer!, seen);
}

function isWrite(node: ts.Node): boolean {
  const parent = wrapped(node).parent;
  return (
    !!parent &&
    ((ts.isBinaryExpression(parent) &&
      parent.left === wrapped(node) &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ts.isDeleteExpression(parent) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)))
  );
}

/** No inferred literal bounds survive a write, a method call, or an escape. */
function closedBinding(ctx: Context, symbol: ts.Symbol, seen = new Set<ts.Symbol>()): boolean {
  if (seen.has(symbol)) return true;
  seen.add(symbol);
  const declaration = constantDeclaration(symbol);
  if (!declaration) return false;
  const statement = declaration.parent.parent;
  if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    return false;
  for (const identifier of ctx.identifiers.get(symbol) ?? []) {
    if (identifier === declaration.name) continue;
    const use = wrapped(identifier);
    const parent = use.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === use && ts.isIdentifier(parent.name)) {
      const alias = ctx.checker.getSymbolAtLocation(parent.name);
      if (!alias || !closedBinding(ctx, alias, seen)) return false;
    } else if (
      (ts.isElementAccessExpression(parent) || ts.isPropertyAccessExpression(parent)) &&
      parent.expression === use
    ) {
      if (isWrite(parent)) return false;
      const outer = wrapped(parent).parent;
      if (ts.isCallExpression(outer) && outer.expression === wrapped(parent)) return false;
    } else return false;
  }
  return true;
}

function numeric(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.NumberLike) !== 0 || (type.isUnion() && type.types.every(numeric));
}

/** Undefined already becomes NaN at these consumers, matching the scalar read. */
function numericUsesOnly(ctx: Context, node: ts.Node, seen = new Set<ts.Symbol>()): boolean {
  const use = wrapped(node);
  const parent = use.parent;
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent))
    return parent.operator === ts.SyntaxKind.PlusToken || parent.operator === ts.SyntaxKind.MinusToken;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (
      [
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
      ].includes(operator)
    )
      return true;
    if (operator === ts.SyntaxKind.PlusToken) {
      const other = parent.left === use ? parent.right : parent.left;
      return numeric(ctx.checker.getTypeAtLocation(other));
    }
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === use &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "Number"
  ) {
    return (
      ctx.checker
        .getSymbolAtLocation(parent.expression)
        ?.declarations?.every((d) => d.getSourceFile().isDeclarationFile) === true
    );
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === use && ts.isIdentifier(parent.name)) {
    const symbol = ctx.checker.getSymbolAtLocation(parent.name);
    if (!symbol || !constantDeclaration(symbol) || seen.has(symbol)) return false;
    seen.add(symbol);
    return (ctx.identifiers.get(symbol) ?? []).every((id) => id === parent.name || numericUsesOnly(ctx, id, seen));
  }
  return false;
}

function literalKey(expression: ts.Expression): string | undefined {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return value.text;
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.operand)
  )
    return String(-Number(value.operand.text));
  return undefined;
}

// These names can resolve on Object.prototype even when absent from the literal.
const INHERITED_KEYS = new Set([
  "__proto__",
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function missingLookup(ctx: Context, access: ts.ElementAccessExpression, standalone: boolean): boolean {
  const key = literalKey(access.argumentExpression);
  const literal = literalOf(ctx, access.expression);
  if (key === undefined || !literal) return false;
  if (ts.isArrayLiteralExpression(literal)) {
    const index = Number(key);
    return (
      Number.isInteger(index) &&
      String(index) === key &&
      (index < 0 || index >= literal.elements.length) &&
      literal.elements.every(
        (element) => !ts.isSpreadElement(element) && numeric(ctx.checker.getTypeAtLocation(element)),
      ) &&
      numeric(ctx.checker.getTypeAtLocation(access))
    );
  }
  if (!standalone || INHERITED_KEYS.has(key)) return false;
  const index = ctx.checker.getIndexTypeOfType(ctx.checker.getTypeAtLocation(access.expression), ts.IndexKind.String);
  if (!index || (index.flags & ts.TypeFlags.StringLike) === 0) return false;
  const keys: string[] = [];
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return false;
    const name = property.name.text;
    if (name === "__proto__") return false;
    keys.push(name);
  }
  return !keys.includes(key);
}

function contextFor(checker: ts.TypeChecker, sourceFile: ts.SourceFile): Context | undefined {
  const identifiers = new Map<ts.Symbol, ts.Identifier[]>();
  let opaque = false;
  const visit = (node: ts.Node): void => {
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === "eval")) opaque = true;
    if (ts.isNewExpression(node)) opaque = true;
    // Prototype changes can invalidate an otherwise closed literal's missing key.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isWrite(node)) opaque = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["defineProperty", "defineProperties", "setPrototypeOf", "assign"].includes(node.expression.name.text)
    )
      opaque = true;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const knownConsole =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "console" &&
        checker
          .getSymbolAtLocation(callee.expression)
          ?.declarations?.every((d) => d.getSourceFile().isDeclarationFile) === true &&
        ["log", "info", "warn", "error", "debug"].includes(callee.name.text);
      const knownNumber =
        ts.isIdentifier(callee) &&
        callee.text === "Number" &&
        checker.getSymbolAtLocation(callee)?.declarations?.every((d) => d.getSourceFile().isDeclarationFile) === true;
      const missingMethod =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "toFixed" &&
        ts.isElementAccessExpression(unwrap(callee.expression));
      if (!knownConsole && !knownNumber && !missingMethod) opaque = true;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const list = identifiers.get(symbol) ?? [];
        list.push(node);
        identifiers.set(symbol, list);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return opaque ? undefined : { checker, identifiers };
}

/** #5389: reject only established missing-read representations, not unchecked indexing generally. */
export function collectUnsafeLookups(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  options: { standalone: boolean },
): UnsafeTypeAssumption[] {
  const ctx = contextFor(checker, sourceFile);
  if (!ctx) return [];
  const findings: UnsafeTypeAssumption[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && !isWrite(node) && missingLookup(ctx, node, options.standalone)) {
      const literal = literalOf(ctx, node.expression)!;
      const parent = wrapped(literal).parent;
      const symbol =
        ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
          ? checker.getSymbolAtLocation(parent.name)
          : undefined;
      if (
        (symbol ? closedBinding(ctx, symbol) : unwrap(node.expression) === literal) &&
        !(ts.isArrayLiteralExpression(literal) && numericUsesOnly(ctx, node))
      ) {
        findings.push({
          node,
          id: "JS2WASM_UNSOUND_LOOKUP",
          message:
            "This missing property read produces undefined in JavaScript, but its specialized representation cannot preserve that value here.",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
