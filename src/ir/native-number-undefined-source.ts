// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import type { NativeFamilyVectorNode, NativeFamilyVectorType } from "./program-logical-types.js";
import { IrUnsupportedError } from "../shared/contracts/ir-preparation-errors.js";

export interface NativeNumberUndefinedSource {
  readonly reads: ReadonlySet<ts.ElementAccessExpression>;
  readonly values: ReadonlySet<ts.Expression>;
  readonly declarations: ReadonlySet<ts.VariableDeclaration>;
}
const issued = new WeakMap<
  NativeNumberUndefinedSource,
  {
    checker: ts.TypeChecker;
    fn: ts.FunctionDeclaration;
    vectors: ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType>;
    identity: IrPlanningIdentityContext;
    text: string;
  }
>();

/** Authenticate original local source identities; this is never serialized as physical authority. */
export function nativeNumberUndefinedSource(
  checker: ts.TypeChecker,
  fn: ts.FunctionDeclaration,
  vectors: ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType> | undefined,
  identity?: IrPlanningIdentityContext,
): NativeNumberUndefinedSource | undefined {
  if (!vectors?.size || !fn.body) return undefined;
  const reads = new Set<ts.ElementAccessExpression>(),
    values = new Set<ts.Expression>(),
    declarations = new Set<ts.VariableDeclaration>();
  const bindings = new Map<ts.Symbol, ts.VariableDeclaration>(),
    nodes: ts.Node[] = [];
  const comparisons: ts.BinaryExpression[] = [];
  const writes = new Map<ts.Symbol, ts.Expression[]>();
  let interested = false;
  const refuse = (reason: string): never => {
    throw new IrUnsupportedError("nullish-value-unsupported", "build", `native Number/Undefined source: ${reason}`);
  };
  const scan = (node: ts.Node) => {
    if (nodes.length >= 20000) refuse("source population limit");
    nodes.push(node);
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) bindings.set(symbol, node);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      comparisons.push(node);
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body);
  const collectWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) {
        const values = writes.get(symbol) ?? [];
        values.push(node.right);
        writes.set(symbol, values);
      }
    }
    ts.forEachChild(node, collectWrites);
  };
  collectWrites(fn.body);
  const observedRead = (expr: ts.Expression, active: Set<ts.Symbol>): boolean => {
    if (ts.isElementAccessExpression(expr)) return true;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      return observedRead(expr.expression, active);
    if (ts.isConditionalExpression(expr))
      return observedRead(expr.whenTrue, active) || observedRead(expr.whenFalse, active);
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr),
        declaration = symbol && bindings.get(symbol);
      if (!symbol || active.has(symbol)) return false;
      active.add(symbol);
      const possible = [...(declaration?.initializer ? [declaration.initializer] : []), ...(writes.get(symbol) ?? [])];
      const result = possible.some((value) => observedRead(value, active));
      active.delete(symbol);
      return result;
    }
    return false;
  };
  interested = comparisons.some((expr) => observedRead(expr.left, new Set()) || observedRead(expr.right, new Set()));
  if (!interested) return undefined;
  if (fn.asteriskToken || fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    refuse("non-synchronous source function");
  if (
    !identity ||
    !fn.name ||
    identity.declarationByUnitId.get(identity.unitIdByDeclaration.get(fn)!) !== fn ||
    identity.sourceFileBySourceId.get(identity.sourceIdBySourceFile.get(fn.getSourceFile())!) !== fn.getSourceFile()
  )
    refuse("missing canonical unit/source custody");
  const canonical = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    const seen = new Set<ts.Symbol>();
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      if (seen.has(symbol)) refuse("cyclic checker alias");
      seen.add(symbol);
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const functionSymbol = canonical(checker.getSymbolAtLocation(fn.name!));
  if (!functionSymbol) refuse("missing function symbol");
  if (fn.parameters.some((parameter) => parameter.initializer || parameter.questionToken || parameter.dotDotDotToken))
    refuse("unclosed optional/default/rest numeric boundary");
  let population = 0;
  const incoming = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) refuse("unclosed runtime import/realm effects");
    if (ts.isCallExpression(node) || ts.isNewExpression(node))
      refuse("unclosed complete-source call or constructor effects");
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      refuse("unclosed complete-source assignment/prototype effects");
    if (
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
    )
      refuse("unclosed complete-source update effects");
    if (++population > 20000) refuse("incoming source population limit");
    if (ts.isIdentifier(node) && node !== fn.name && canonical(checker.getSymbolAtLocation(node)) === functionSymbol)
      refuse("called, captured or aliased source function");
    ts.forEachChild(node, incoming);
  };
  for (const file of identity!.sourceFileBySourceId.values()) incoming(file);
  const active = new Set<ts.Symbol>();
  const initializedNumber = (expr: ts.Expression): boolean => {
    if (ts.isNumericLiteral(expr)) return true;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      return initializedNumber(expr.expression);
    if (ts.isPrefixUnaryExpression(expr) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(expr.operator))
      return initializedNumber(expr.operand);
    if (
      ts.isBinaryExpression(expr) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
      ].includes(expr.operatorToken.kind)
    )
      return initializedNumber(expr.left) && initializedNumber(expr.right);
    if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr);
      if (!symbol || active.has(symbol)) return false;
      const declaration = symbol.valueDeclaration;
      if (declaration && ts.isParameter(declaration) && declaration.parent === fn)
        return (checker.getTypeAtLocation(expr).flags & ts.TypeFlags.NumberLike) !== 0;
      const local = bindings.get(symbol);
      if (!local?.initializer || !(local.parent.flags & ts.NodeFlags.Const)) return false;
      active.add(symbol);
      const result = initializedNumber(local.initializer);
      active.delete(symbol);
      return result;
    }
    return false;
  };
  const vectorSymbols = new Set<ts.Symbol>();
  for (const [node, type] of vectors) {
    if (!ts.isVariableDeclaration(node)) continue;
    if (
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isArrayLiteralExpression(node.initializer) ||
      !(node.parent.flags & ts.NodeFlags.Const) ||
      type.elementType.kind !== "val" ||
      type.elementType.val.kind !== "f64"
    )
      refuse("nonlocal dense constructor");
    if (
      (node.initializer as ts.ArrayLiteralExpression).elements.some(
        (e) => ts.isOmittedExpression(e) || ts.isSpreadElement(e),
      )
    )
      refuse("hole or spread");
    for (const element of (node.initializer as ts.ArrayLiteralExpression).elements) {
      let value = element as ts.Expression;
      while (
        ts.isParenthesizedExpression(value) ||
        ts.isAsExpression(value) ||
        ts.isTypeAssertionExpression(value) ||
        ts.isNonNullExpression(value)
      )
        value = value.expression;
      if (!initializedNumber(value)) refuse("constructor cell lacks initialized numeric source proof");
    }
    const symbol = checker.getSymbolAtLocation(node.name);
    if (!symbol || bindings.get(symbol) !== node) refuse("constructor identity");
    vectorSymbols.add(symbol!);
  }
  const carries = (expr: ts.Expression): boolean => {
    if (values.has(expr)) return true;
    let result = false;
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    )
      result = carries(expr.expression);
    else if (ts.isElementAccessExpression(expr)) {
      const receiver = ts.isIdentifier(expr.expression) ? checker.getSymbolAtLocation(expr.expression) : undefined;
      if (!receiver || !vectorSymbols.has(receiver) || expr.questionDotToken)
        refuse("receiver lacks immutable local dense constructor");
      const indexEffects = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) ||
          ts.isPostfixUnaryExpression(node) ||
          (ts.isPrefixUnaryExpression(node) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
        )
          refuse("effectful or unclosed numeric index");
        ts.forEachChild(node, indexEffects);
      };
      indexEffects(expr.argumentExpression);
      const indexType = checker.getTypeAtLocation(expr.argumentExpression);
      if ((indexType.flags & ts.TypeFlags.NumberLike) === 0) refuse("index lacks actual numeric source type");
      reads.add(expr);
      result = true;
    } else if (ts.isIdentifier(expr)) {
      const symbol = checker.getSymbolAtLocation(expr),
        declaration = symbol && bindings.get(symbol);
      if (declaration) {
        if (active.has(symbol!)) refuse("cyclic aliases");
        if (!declaration.initializer || !(declaration.parent.flags & ts.NodeFlags.Const)) refuse("mutable alias");
        active.add(symbol!);
        result = carries(declaration.initializer!);
        active.delete(symbol!);
        if (result) declarations.add(declaration);
      }
    } else if (ts.isConditionalExpression(expr)) {
      const a = carries(expr.whenTrue),
        b = carries(expr.whenFalse);
      if ((a || b) && ((!a && !initializedNumber(expr.whenTrue)) || (!b && !initializedNumber(expr.whenFalse))))
        refuse("conditional join has unproved partition");
      result = a || b;
    }
    if (result) values.add(expr);
    return result;
  };
  for (const node of nodes) if (ts.isElementAccessExpression(node)) carries(node);
  for (const node of nodes)
    if (ts.isVariableDeclaration(node) && node.initializer && carries(node.initializer)) declarations.add(node);
  for (const node of nodes) {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node),
        declaration = symbol && bindings.get(symbol);
      if (declaration && declarations.has(declaration)) carries(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      refuse("assignment population");
    if (
      ts.isCallExpression(node) &&
      node.arguments.some(
        (arg) => values.has(arg) || (ts.isIdentifier(arg) && vectorSymbols.has(checker.getSymbolAtLocation(arg)!)),
      )
    )
      refuse("cross-call carrier");
    if (ts.isReturnStatement(node) && node.expression && values.has(node.expression)) refuse("public dynamic result");
    if (ts.isFunctionLike(node) && node !== fn) {
      const captured = (child: ts.Node) => {
        if (ts.isIdentifier(child)) {
          const symbol = checker.getSymbolAtLocation(child),
            declaration = symbol && bindings.get(symbol);
          if ((symbol && vectorSymbols.has(symbol)) || (declaration && declarations.has(declaration)))
            refuse("captured carrier");
        }
        ts.forEachChild(child, captured);
      };
      captured(node);
    }
  }
  if (!reads.size) return undefined;
  const facts = { reads, values, declarations };
  issued.set(facts, {
    checker,
    fn,
    vectors,
    identity: identity!,
    text: fn.getSourceFile().text,
  });
  return facts;
}

/** Reject fabricated, crossed-owner and mutated source sidecars before any emission. */
export function assertNativeNumberUndefinedSource(
  facts: NativeNumberUndefinedSource,
  checker: ts.TypeChecker,
  fn: ts.FunctionDeclaration,
  vectors: ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType>,
): void {
  const custody = issued.get(facts);
  const refuse = () => {
    throw new IrUnsupportedError(
      "nullish-value-unsupported",
      "build",
      "native Number/Undefined source: unissued or stale source custody",
    );
  };
  if (
    !custody ||
    custody.checker !== checker ||
    custody.fn !== fn ||
    custody.vectors !== vectors ||
    custody.text !== fn.getSourceFile().text
  )
    refuse();
  const current = nativeNumberUndefinedSource(checker, fn, vectors, custody!.identity);
  if (!current) refuse();
  for (const key of ["reads", "values", "declarations"] as const) {
    const before = facts[key] as ReadonlySet<ts.Node>,
      after = current![key] as ReadonlySet<ts.Node>;
    if (before.size !== after.size || [...before].some((node) => !after.has(node))) refuse();
  }
}
