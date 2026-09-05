// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3518 Transaction A / #1004) Shared proof for counted string appends.
 *
 * The syntax reader is shared by the compatibility selector gate and both
 * lowering routes. Bare selector callers keep the old checker-free deferral;
 * production selection may consume the exact checker proof below and carry
 * that same immutable plan into Prepared IR.
 */
import type { TypeOracle } from "../../checker/oracle.js";
import { forEachChild, ts } from "../../ts-api.js";

export type IrCountedStringComparison = "lt" | "lte";
export type IrCountedStringIncrement = "postfix" | "prefix" | "plus-equals";

export interface IrCountedStringAppendPlan {
  readonly sourceFile: ts.SourceFile;
  readonly loop: ts.ForStatement;
  readonly appendStatement: ts.ExpressionStatement;
  readonly appendExpression: ts.BinaryExpression;
  readonly accumulatorDeclaration: ts.VariableDeclaration;
  readonly accumulatorSymbol: ts.Symbol;
  readonly accumulatorWrite: ts.Identifier;
  readonly accumulatorRead: ts.Identifier;
  readonly accumulatorType: "string";
  readonly counterDeclaration: ts.VariableDeclaration;
  readonly counterSymbol: ts.Symbol;
  readonly counterConditionRead: ts.Identifier;
  readonly counterIncrementWrite: ts.Identifier;
  readonly startExpression: ts.Expression;
  readonly startConstDeclarations: readonly ts.VariableDeclaration[];
  readonly start: number;
  readonly boundExpression: ts.Expression;
  readonly boundConstDeclarations: readonly ts.VariableDeclaration[];
  readonly bound: number;
  readonly comparison: IrCountedStringComparison;
  readonly increment: IrCountedStringIncrement;
  readonly fragmentExpression: ts.Expression;
  readonly fragmentDeclaration?: ts.VariableDeclaration;
  readonly fragmentSymbol?: ts.Symbol;
  readonly fragmentConstDeclarations: readonly ts.VariableDeclaration[];
  readonly fragmentType: "string";
  readonly fragmentValue: string;
  readonly tripCount: number;
}

interface CountedStringAppendSyntax {
  readonly loop: ts.ForStatement;
  readonly counterDeclarationList: ts.VariableDeclarationList;
  readonly counterDeclaration: ts.VariableDeclaration;
  readonly counterName: ts.Identifier;
  readonly startExpression: ts.Expression;
  readonly condition: ts.BinaryExpression;
  readonly counterConditionRead: ts.Identifier;
  readonly boundExpression: ts.Expression;
  readonly comparison: IrCountedStringComparison;
  readonly incrementExpression: ts.Expression;
  readonly counterIncrementWrite: ts.Identifier;
  readonly increment: IrCountedStringIncrement;
  readonly appendStatement: ts.ExpressionStatement;
  readonly appendExpression: ts.BinaryExpression;
  readonly accumulatorWrite: ts.Identifier;
  readonly accumulatorRead: ts.Identifier;
  readonly fragmentExpression: ts.Expression;
}

interface ProofContext {
  readonly checker: ts.TypeChecker;
  readonly oracle: TypeOracle;
}

interface ResolvedInt {
  readonly value: number;
  readonly declarations: readonly ts.VariableDeclaration[];
}

interface ResolvedStringFragment {
  readonly expression: ts.Expression;
  readonly declaration?: ts.VariableDeclaration;
  readonly symbol?: ts.Symbol;
  readonly declarations: readonly ts.VariableDeclaration[];
  readonly value: string;
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function identifierExpression(expression: ts.Expression): ts.Identifier | null {
  const current = unwrapExpression(expression);
  return ts.isIdentifier(current) ? current : null;
}

function oneBodyStatement(statement: ts.Statement): ts.Statement | null {
  if (!ts.isBlock(statement)) return statement;
  return statement.statements.length === 1 ? statement.statements[0]! : null;
}

/** One syntax reader for both the checker-free routing gate and full proof. */
function readCountedStringAppendSyntax(loop: ts.ForStatement): CountedStringAppendSyntax | null {
  const initializer = loop.initializer;
  const condition = loop.condition;
  const incrementor = loop.incrementor;
  if (
    !initializer ||
    !ts.isVariableDeclarationList(initializer) ||
    initializer.declarations.length !== 1 ||
    !condition ||
    !ts.isBinaryExpression(condition) ||
    !incrementor
  ) {
    return null;
  }

  const counterDeclaration = initializer.declarations[0]!;
  if (!ts.isIdentifier(counterDeclaration.name) || !counterDeclaration.initializer) return null;
  const counterName = counterDeclaration.name;

  const conditionRead = identifierExpression(condition.left);
  const comparison =
    condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
      ? "lt"
      : condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken
        ? "lte"
        : null;
  if (!conditionRead || conditionRead.text !== counterName.text || comparison === null) return null;

  const incrementExpression = unwrapExpression(incrementor);
  let counterIncrementWrite: ts.Identifier | null = null;
  let increment: IrCountedStringIncrement | null = null;
  if (ts.isPostfixUnaryExpression(incrementExpression)) {
    const operand = identifierExpression(incrementExpression.operand);
    if (incrementExpression.operator === ts.SyntaxKind.PlusPlusToken && operand?.text === counterName.text) {
      counterIncrementWrite = operand;
      increment = "postfix";
    }
  } else if (ts.isPrefixUnaryExpression(incrementExpression)) {
    const operand = identifierExpression(incrementExpression.operand);
    if (incrementExpression.operator === ts.SyntaxKind.PlusPlusToken && operand?.text === counterName.text) {
      counterIncrementWrite = operand;
      increment = "prefix";
    }
  } else if (
    ts.isBinaryExpression(incrementExpression) &&
    incrementExpression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
  ) {
    const target = identifierExpression(incrementExpression.left);
    const step = unwrapExpression(incrementExpression.right);
    if (target?.text === counterName.text && ts.isNumericLiteral(step) && Number(step.text) === 1) {
      counterIncrementWrite = target;
      increment = "plus-equals";
    }
  }
  if (!counterIncrementWrite || increment === null) return null;

  const onlyStatement = oneBodyStatement(loop.statement);
  if (!onlyStatement || !ts.isExpressionStatement(onlyStatement) || !ts.isBinaryExpression(onlyStatement.expression)) {
    return null;
  }
  const appendExpression = onlyStatement.expression;
  let accumulatorWrite: ts.Identifier | null = null;
  let accumulatorRead: ts.Identifier | null = null;
  let fragmentExpression: ts.Expression | null = null;
  if (appendExpression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    const target = identifierExpression(appendExpression.left);
    if (target) {
      accumulatorWrite = target;
      accumulatorRead = target;
      fragmentExpression = appendExpression.right;
    }
  } else if (appendExpression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = identifierExpression(appendExpression.left);
    const right = unwrapExpression(appendExpression.right);
    if (target && ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const read = identifierExpression(right.left);
      if (read?.text === target.text) {
        accumulatorWrite = target;
        accumulatorRead = read;
        fragmentExpression = right.right;
      }
    }
  }
  if (!accumulatorWrite || !accumulatorRead || !fragmentExpression) return null;

  return {
    loop,
    counterDeclarationList: initializer,
    counterDeclaration,
    counterName,
    startExpression: counterDeclaration.initializer,
    condition,
    counterConditionRead: conditionRead,
    boundExpression: condition.right,
    comparison,
    incrementExpression,
    counterIncrementWrite,
    increment,
    appendStatement: onlyStatement,
    appendExpression,
    accumulatorWrite,
    accumulatorRead,
    fragmentExpression,
  };
}

function sourceFileOf(node: ts.Node): ts.SourceFile {
  return node.getSourceFile();
}

function runtimeOwner(node: ts.Node): ts.SignatureDeclaration | ts.SourceFile | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    if (ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return null;
}

function statementContainer(node: ts.Node): ts.Block | ts.SourceFile | ts.ModuleBlock | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) return current;
    current = current.parent;
  }
  return null;
}

function directStatementChild(
  container: ts.Block | ts.SourceFile | ts.ModuleBlock,
  node: ts.Node,
): ts.Statement | null {
  let current: ts.Node = node;
  while (current.parent && current.parent !== container) current = current.parent;
  return current.parent === container && ts.isStatement(current) ? current : null;
}

/** The declaration's initialized value must exist before `use` executes. */
function declarationDominatesUse(declaration: ts.VariableDeclaration, use: ts.Node): boolean {
  const declarationContainer = statementContainer(declaration);
  if (!declarationContainer) return false;
  const declarationStatement = directStatementChild(declarationContainer, declaration);
  const useStatement = directStatementChild(declarationContainer, use);
  if (!declarationStatement || !useStatement) return false;
  const declarationIndex = declarationContainer.statements.indexOf(declarationStatement);
  const useIndex = declarationContainer.statements.indexOf(useStatement);
  return declarationIndex >= 0 && useIndex >= 0 && declarationIndex < useIndex;
}

function exactVariableDeclaration(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  kind: ts.NodeFlags.Let | ts.NodeFlags.Const,
): { declaration: ts.VariableDeclaration; symbol: ts.Symbol } | null {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (
    !symbol ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    declaration.parent.declarations.length !== 1 ||
    (declaration.parent.flags & kind) === 0 ||
    symbol.declarations?.length !== 1 ||
    checker.getSymbolAtLocation(declaration.name) !== symbol
  ) {
    return null;
  }
  return { declaration, symbol };
}

function resolveSafeInteger(
  context: ProofContext,
  expression: ts.Expression,
  loop: ts.ForStatement,
  use: ts.Node,
  active: ReadonlySet<ts.Symbol> = new Set(),
): ResolvedInt | null {
  const current = unwrapExpression(expression);
  if (ts.isNumericLiteral(current)) {
    const value = Number(current.text.replace(/_/g, ""));
    return Number.isSafeInteger(value) ? { value, declarations: [] } : null;
  }
  if (
    ts.isPrefixUnaryExpression(current) &&
    (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)
  ) {
    const inner = resolveSafeInteger(context, current.operand, loop, use, active);
    if (!inner) return null;
    const value = current.operator === ts.SyntaxKind.MinusToken ? -inner.value : inner.value;
    return Number.isSafeInteger(value) ? { value, declarations: inner.declarations } : null;
  }
  if (!ts.isIdentifier(current)) return null;

  const exact = exactVariableDeclaration(context.checker, current, ts.NodeFlags.Const);
  if (!exact || !exact.declaration.initializer || active.has(exact.symbol)) return null;
  if (
    sourceFileOf(exact.declaration) !== sourceFileOf(loop) ||
    runtimeOwner(exact.declaration) !== runtimeOwner(loop)
  ) {
    return null;
  }
  if (!declarationDominatesUse(exact.declaration, use)) return null;

  const nextActive = new Set(active);
  nextActive.add(exact.symbol);
  const resolved = resolveSafeInteger(
    context,
    exact.declaration.initializer,
    loop,
    exact.declaration.initializer,
    nextActive,
  );
  if (!resolved) return null;
  return { value: resolved.value, declarations: [exact.declaration, ...resolved.declarations] };
}

function resolveStringFragment(
  context: ProofContext,
  expression: ts.Expression,
  loop: ts.ForStatement,
  counterSymbol: ts.Symbol,
  accumulatorSymbol: ts.Symbol,
  use: ts.Node,
  active: ReadonlySet<ts.Symbol> = new Set(),
): ResolvedStringFragment | null {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return { expression, declarations: [], value: current.text };
  }
  if (!ts.isIdentifier(current) || context.oracle.staticJsTypeOf(current) !== "string") return null;
  const exact = exactVariableDeclaration(context.checker, current, ts.NodeFlags.Const);
  if (
    !exact ||
    exact.symbol === counterSymbol ||
    exact.symbol === accumulatorSymbol ||
    !exact.declaration.initializer ||
    active.has(exact.symbol) ||
    sourceFileOf(exact.declaration) !== sourceFileOf(loop) ||
    runtimeOwner(exact.declaration) !== runtimeOwner(loop) ||
    !declarationDominatesUse(exact.declaration, use)
  ) {
    return null;
  }
  const nextActive = new Set(active);
  nextActive.add(exact.symbol);
  const initializer = resolveStringFragment(
    context,
    exact.declaration.initializer,
    loop,
    counterSymbol,
    accumulatorSymbol,
    exact.declaration.initializer,
    nextActive,
  );
  if (!initializer) return null;
  return {
    expression,
    declaration: exact.declaration,
    symbol: exact.symbol,
    declarations: [exact.declaration, ...initializer.declarations],
    value: initializer.value,
  };
}

function isWriteOccurrence(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return true;
  if (ts.isPostfixUnaryExpression(parent)) return true;
  if (
    ts.isPrefixUnaryExpression(parent) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (ts.isDeleteExpression(parent)) return true;
  return (
    ts.isBinaryExpression(parent) && parent.left === identifier && ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)
  );
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function symbolUsesAreSafe(
  checker: ts.TypeChecker,
  owner: ts.SignatureDeclaration | ts.SourceFile,
  loop: ts.ForStatement,
  symbol: ts.Symbol,
  declarationName: ts.Identifier,
  allowedLoopUses: ReadonlySet<ts.Identifier>,
  allowedWrites: ReadonlySet<ts.Identifier>,
): boolean {
  const root: ts.Node = ts.isSourceFile(owner) ? owner : "body" in owner && owner.body ? owner.body : owner;
  let safe = true;
  const visit = (node: ts.Node, nestedFunction: boolean): void => {
    if (!safe) return;
    const entersNestedFunction = node !== owner && ts.isFunctionLike(node);
    const nested = nestedFunction || entersNestedFunction;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      if (node === declarationName) return;
      if (nested) {
        safe = false;
        return;
      }
      const inLoop = isDescendantOf(node, loop);
      if (inLoop && !allowedLoopUses.has(node)) {
        safe = false;
        return;
      }
      if (isWriteOccurrence(node) && !allowedWrites.has(node)) {
        safe = false;
        return;
      }
    }
    forEachChild(node, (child) => visit(child, nested));
  };
  visit(root, false);
  return safe;
}

function constDeclarationsStayReadOnly(
  checker: ts.TypeChecker,
  owner: ts.SignatureDeclaration | ts.SourceFile,
  declarations: readonly ts.VariableDeclaration[],
): boolean {
  const root: ts.Node = ts.isSourceFile(owner) ? owner : "body" in owner && owner.body ? owner.body : owner;
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name)) return false;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) return false;
    let readOnly = true;
    const visit = (node: ts.Node): void => {
      if (!readOnly) return;
      if (
        ts.isIdentifier(node) &&
        node !== declaration.name &&
        checker.getSymbolAtLocation(node) === symbol &&
        isWriteOccurrence(node)
      ) {
        readOnly = false;
        return;
      }
      forEachChild(node, visit);
    };
    visit(root);
    if (!readOnly) return false;
  }
  return true;
}

function checkedTripCount(start: number, bound: number, comparison: IrCountedStringComparison): number | null {
  const raw = BigInt(bound) - BigInt(start) + (comparison === "lte" ? 1n : 0n);
  if (raw <= 0n) return 0;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(raw);
}

export function planCountedStringAppend(
  context: ProofContext,
  loop: ts.ForStatement,
): IrCountedStringAppendPlan | null {
  const syntax = readCountedStringAppendSyntax(loop);
  if (!syntax || (syntax.counterDeclarationList.flags & ts.NodeFlags.Let) === 0) return null;

  const counter = exactVariableDeclaration(context.checker, syntax.counterName, ts.NodeFlags.Let);
  if (!counter || counter.declaration !== syntax.counterDeclaration) return null;
  if (
    context.checker.getSymbolAtLocation(syntax.counterConditionRead) !== counter.symbol ||
    context.checker.getSymbolAtLocation(syntax.counterIncrementWrite) !== counter.symbol
  ) {
    return null;
  }

  const accumulator = exactVariableDeclaration(context.checker, syntax.accumulatorRead, ts.NodeFlags.Let);
  const owner = runtimeOwner(loop);
  if (
    !owner ||
    !accumulator ||
    !accumulator.declaration.initializer ||
    context.checker.getSymbolAtLocation(syntax.accumulatorWrite) !== accumulator.symbol ||
    accumulator.symbol === counter.symbol ||
    sourceFileOf(accumulator.declaration) !== sourceFileOf(loop) ||
    runtimeOwner(accumulator.declaration) !== owner ||
    !declarationDominatesUse(accumulator.declaration, loop) ||
    context.oracle.staticJsTypeOf(syntax.accumulatorRead) !== "string"
  ) {
    return null;
  }

  const start = resolveSafeInteger(context, syntax.startExpression, loop, syntax.startExpression);
  const bound = resolveSafeInteger(context, syntax.boundExpression, loop, loop);
  if (!start || !bound) return null;
  if (
    !constDeclarationsStayReadOnly(context.checker, owner, start.declarations) ||
    !constDeclarationsStayReadOnly(context.checker, owner, bound.declarations)
  ) {
    return null;
  }
  const tripCount = checkedTripCount(start.value, bound.value, syntax.comparison);
  if (tripCount === null) return null;

  const fragment = resolveStringFragment(
    context,
    syntax.fragmentExpression,
    loop,
    counter.symbol,
    accumulator.symbol,
    loop,
  );
  if (!fragment) return null;

  const counterUses = new Set<ts.Identifier>([syntax.counterConditionRead, syntax.counterIncrementWrite]);
  if (
    !symbolUsesAreSafe(
      context.checker,
      owner,
      loop,
      counter.symbol,
      syntax.counterName,
      counterUses,
      new Set([syntax.counterIncrementWrite]),
    )
  ) {
    return null;
  }

  const fragmentIdentifier = identifierExpression(syntax.fragmentExpression);
  for (const declaration of fragment.declarations) {
    if (!ts.isIdentifier(declaration.name)) return null;
    const symbol = context.checker.getSymbolAtLocation(declaration.name);
    if (!symbol) return null;
    const loopUses =
      symbol === fragment.symbol && fragmentIdentifier
        ? new Set<ts.Identifier>([fragmentIdentifier])
        : new Set<ts.Identifier>();
    if (
      !symbolUsesAreSafe(context.checker, owner, loop, symbol, declaration.name, loopUses, new Set<ts.Identifier>())
    ) {
      return null;
    }
  }
  const accumulatorUses = new Set<ts.Identifier>([syntax.accumulatorWrite, syntax.accumulatorRead]);
  if (
    !symbolUsesAreSafe(
      context.checker,
      owner,
      loop,
      accumulator.symbol,
      accumulator.declaration.name as ts.Identifier,
      accumulatorUses,
      new Set([syntax.accumulatorWrite]),
    )
  ) {
    return null;
  }

  return Object.freeze({
    sourceFile: sourceFileOf(loop),
    loop,
    appendStatement: syntax.appendStatement,
    appendExpression: syntax.appendExpression,
    accumulatorDeclaration: accumulator.declaration,
    accumulatorSymbol: accumulator.symbol,
    accumulatorWrite: syntax.accumulatorWrite,
    accumulatorRead: syntax.accumulatorRead,
    accumulatorType: "string",
    counterDeclaration: counter.declaration,
    counterSymbol: counter.symbol,
    counterConditionRead: syntax.counterConditionRead,
    counterIncrementWrite: syntax.counterIncrementWrite,
    startExpression: syntax.startExpression,
    startConstDeclarations: Object.freeze([...start.declarations]),
    start: start.value,
    boundExpression: syntax.boundExpression,
    boundConstDeclarations: Object.freeze([...bound.declarations]),
    bound: bound.value,
    comparison: syntax.comparison,
    increment: syntax.increment,
    fragmentExpression: fragment.expression,
    fragmentDeclaration: fragment.declaration,
    fragmentSymbol: fragment.symbol,
    fragmentConstDeclarations: Object.freeze([...fragment.declarations]),
    fragmentType: "string",
    fragmentValue: fragment.value,
    tripCount,
  });
}

/** Re-run and compare every identity-bearing field immediately before use. */
export function countedStringAppendPlanIsCurrent(context: ProofContext, plan: IrCountedStringAppendPlan): boolean {
  const current = planCountedStringAppend(context, plan.loop);
  const sameDeclarations = (
    left: readonly ts.VariableDeclaration[],
    right: readonly ts.VariableDeclaration[],
  ): boolean => left.length === right.length && left.every((declaration, index) => declaration === right[index]);
  return (
    current !== null &&
    current.sourceFile === plan.sourceFile &&
    current.loop === plan.loop &&
    current.appendStatement === plan.appendStatement &&
    current.appendExpression === plan.appendExpression &&
    current.accumulatorDeclaration === plan.accumulatorDeclaration &&
    current.accumulatorSymbol === plan.accumulatorSymbol &&
    current.accumulatorWrite === plan.accumulatorWrite &&
    current.accumulatorRead === plan.accumulatorRead &&
    current.accumulatorType === plan.accumulatorType &&
    current.counterDeclaration === plan.counterDeclaration &&
    current.counterSymbol === plan.counterSymbol &&
    current.counterConditionRead === plan.counterConditionRead &&
    current.counterIncrementWrite === plan.counterIncrementWrite &&
    current.startExpression === plan.startExpression &&
    sameDeclarations(current.startConstDeclarations, plan.startConstDeclarations) &&
    current.start === plan.start &&
    current.boundExpression === plan.boundExpression &&
    sameDeclarations(current.boundConstDeclarations, plan.boundConstDeclarations) &&
    current.bound === plan.bound &&
    current.comparison === plan.comparison &&
    current.increment === plan.increment &&
    current.fragmentExpression === plan.fragmentExpression &&
    current.fragmentDeclaration === plan.fragmentDeclaration &&
    current.fragmentSymbol === plan.fragmentSymbol &&
    sameDeclarations(current.fragmentConstDeclarations, plan.fragmentConstDeclarations) &&
    current.fragmentType === plan.fragmentType &&
    current.fragmentValue === plan.fragmentValue &&
    current.tripCount === plan.tripCount
  );
}

/**
 * Preserve the pre-#3518 unconditional selector deferral byte-for-shape. This
 * intentionally asks only for the old adjacent literal seed/loop syntax; it
 * does not claim that the direct transform's checker proof succeeds.
 */
export function containsCountedStringAppendCandidate(root: ts.Node): boolean {
  return countedStringAppendCandidateLoops(root).length > 0;
}

/** Exact loop nodes covered by the pre-#3518 checker-free routing shape. */
export function countedStringAppendCandidateLoops(root: ts.Node): readonly ts.ForStatement[] {
  const loops: ts.ForStatement[] = [];
  const matches = (seedStatement: ts.Statement, loopStatement: ts.Statement): boolean => {
    if (!ts.isVariableStatement(seedStatement) || seedStatement.declarationList.declarations.length !== 1) {
      return false;
    }
    const seed = seedStatement.declarationList.declarations[0]!;
    if (
      !ts.isIdentifier(seed.name) ||
      !seed.initializer ||
      !(ts.isStringLiteral(seed.initializer) || ts.isNoSubstitutionTemplateLiteral(seed.initializer)) ||
      !ts.isForStatement(loopStatement)
    ) {
      return false;
    }
    const syntax = readCountedStringAppendSyntax(loopStatement);
    if (!syntax) return false;
    const directIncrement = loopStatement.incrementor!;
    const oldIncrementShape =
      ((ts.isPrefixUnaryExpression(directIncrement) || ts.isPostfixUnaryExpression(directIncrement)) &&
        ts.isIdentifier(directIncrement.operand)) ||
      (ts.isBinaryExpression(directIncrement) &&
        ts.isIdentifier(directIncrement.left) &&
        ts.isNumericLiteral(directIncrement.right));
    let oldAppendShape = false;
    if (
      syntax.appendExpression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isIdentifier(syntax.appendExpression.left)
    ) {
      oldAppendShape = true;
    } else if (
      syntax.appendExpression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(syntax.appendExpression.left)
    ) {
      let right = syntax.appendExpression.right;
      while (ts.isParenthesizedExpression(right)) right = right.expression;
      oldAppendShape =
        ts.isBinaryExpression(right) &&
        right.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isIdentifier(right.left) &&
        right.left.text === syntax.appendExpression.left.text;
    }
    return (
      ts.isNumericLiteral(syntax.startExpression) &&
      ts.isIdentifier(syntax.condition.left) &&
      ts.isNumericLiteral(syntax.boundExpression) &&
      oldIncrementShape &&
      oldAppendShape &&
      syntax.accumulatorWrite.text === seed.name.text &&
      syntax.accumulatorWrite.text !== syntax.counterName.text &&
      (ts.isStringLiteral(syntax.fragmentExpression) || ts.isNoSubstitutionTemplateLiteral(syntax.fragmentExpression))
    );
  };

  const walk = (node: ts.Node): void => {
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (let index = 0; index + 1 < node.statements.length; index++) {
        if (matches(node.statements[index]!, node.statements[index + 1]!)) {
          loops.push(node.statements[index + 1]! as ts.ForStatement);
        }
      }
    }
    forEachChild(node, (child) => {
      if (ts.isFunctionLike(child)) return;
      walk(child);
    });
  };
  walk(root);
  return Object.freeze(loops);
}
