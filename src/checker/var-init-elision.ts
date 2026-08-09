// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Source-level must-analysis for eliding a hoisted `var`'s entry `undefined`.
 *
 * A Wasm `externref` local starts as null, while JavaScript's hoisted `var`
 * starts as undefined. Codegen normally repairs that mismatch with
 * `emitUndefined` + `local.set`. The repair is dead when every source-level
 * read is reached only after a write to the same checker symbol. This pass
 * proves exactly that fact; every missing symbol or unsupported control-flow
 * shape declines the optimization.
 *
 * The flow state is the set of candidate symbols definitely written on every
 * reaching path. Joins intersect states. Expression results retain separate
 * truthy and falsy states so short-circuit flow such as
 * `a && (x = value) && use(x)` does not invent a path from `a` directly to the
 * final read. Loops are checked using their first iteration (the least-written
 * state) and expose only writes guaranteed on a zero-iteration exit.
 */
import { ts } from "../ts-api.js";

type FunctionWithBlock = ts.FunctionLikeDeclaration & { body: ts.Block };
type FlowState = ReadonlySet<ts.Symbol>;

interface ExpressionFlow {
  truthy: FlowState | null;
  falsy: FlowState | null;
}

interface CandidateFacts {
  symbols: Set<ts.Symbol>;
  names: Set<string>;
}

function mergeStates(left: FlowState | null, right: FlowState | null): FlowState | null {
  if (left === null) return right;
  if (right === null) return left;
  const intersection = new Set<ts.Symbol>();
  for (const symbol of left) if (right.has(symbol)) intersection.add(symbol);
  return intersection;
}

function normalState(flow: ExpressionFlow): FlowState | null {
  return mergeStates(flow.truthy, flow.falsy);
}

function unknownFlow(state: FlowState): ExpressionFlow {
  return { truthy: state, falsy: state };
}

function addWritten(state: FlowState, symbol: ts.Symbol | undefined): FlowState {
  if (symbol === undefined || state.has(symbol)) return state;
  const next = new Set(state);
  next.add(symbol);
  return next;
}

function addWrittenToFlow(flow: ExpressionFlow, symbol: ts.Symbol | undefined): ExpressionFlow {
  return {
    truthy: flow.truthy === null ? null : addWritten(flow.truthy, symbol),
    falsy: flow.falsy === null ? null : addWritten(flow.falsy, symbol),
  };
}

function isFunctionWithBlock(node: ts.Node): node is FunctionWithBlock {
  if (!ts.isFunctionLike(node)) return false;
  const body = (node as ts.Node & { body?: ts.Node }).body;
  return body !== undefined && ts.isBlock(body);
}

function enclosingFunction(node: ts.Node): FunctionWithBlock | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionWithBlock(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function isAsyncFunction(fn: FunctionWithBlock): boolean {
  const modifiers = (fn as FunctionWithBlock & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function unwrapTransparent(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Collect simple local bindings and reject scopes whose identity is ambiguous. */
function collectCandidates(checker: ts.TypeChecker, fn: FunctionWithBlock): CandidateFacts | undefined {
  if (fn.asteriskToken !== undefined || isAsyncFunction(fn)) return undefined;

  const bindings = new Map<string, { declarations: number; symbols: Set<ts.Symbol> }>();
  const candidates = new Set<ts.Symbol>();
  const candidateNames = new Set<string>();
  let failed = false;

  const recordBinding = (name: ts.BindingName, candidate: boolean): void => {
    if (!ts.isIdentifier(name)) {
      failed = true; // destructuring is deliberately outside this proof
      return;
    }
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol === undefined) {
      failed = true;
      return;
    }
    const entry = bindings.get(name.text) ?? { declarations: 0, symbols: new Set<ts.Symbol>() };
    entry.declarations++;
    entry.symbols.add(symbol);
    bindings.set(name.text, entry);
    if (candidate) {
      candidates.add(symbol);
      candidateNames.add(name.text);
    }
  };

  for (const parameter of fn.parameters) {
    if (parameter.initializer !== undefined) return undefined;
    recordBinding(parameter.name, false);
  }

  const visit = (node: ts.Node): void => {
    if (failed) return;
    if (node !== fn.body && ts.isFunctionLike(node)) {
      failed = true; // nested functions may capture a candidate
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      failed = true;
      return;
    }
    if (
      ts.isTryStatement(node) ||
      ts.isWithStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isLabeledStatement(node) ||
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node)
    ) {
      failed = true;
      return;
    }
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      failed = true;
      return;
    }
    if (ts.isVariableDeclarationList(node)) {
      if ((node.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) {
        failed = true;
        return;
      }
      const isVar = (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      for (const declaration of node.declarations) recordBinding(declaration.name, isVar);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapTransparent(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        failed = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);

  // Multiple declarations or same-text/different-symbol bindings make both
  // hoist ownership and shadow resolution too easy to mis-model. Decline.
  for (const binding of bindings.values()) {
    if (binding.declarations !== 1 || binding.symbols.size !== 1) failed = true;
  }
  if (failed) return undefined;
  return { symbols: candidates, names: candidateNames };
}

class MustWriteFlow {
  readonly unsafe = new Set<ts.Symbol>();
  failed = false;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly candidates: ReadonlySet<ts.Symbol>,
    private readonly candidateNames: ReadonlySet<string>,
  ) {}

  private candidateAt(identifier: ts.Identifier): ts.Symbol | undefined {
    if (!this.candidateNames.has(identifier.text)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) {
      this.failed = true;
      return undefined;
    }
    if (this.candidates.has(symbol)) return symbol;
    // A same-text shadow should have been rejected by collection. Treat a
    // checker disagreement as unknown rather than silently ignoring the use.
    this.failed = true;
    return undefined;
  }

  private identifier(identifier: ts.Identifier, state: FlowState): ExpressionFlow {
    const symbol = this.candidateAt(identifier);
    if (symbol !== undefined && !state.has(symbol)) this.unsafe.add(symbol);
    return unknownFlow(state);
  }

  private expressionSequence(expressions: readonly ts.Expression[], state: FlowState): FlowState | null {
    let current: FlowState | null = state;
    for (const expression of expressions) {
      if (current === null) break;
      current = normalState(this.expression(expression, current));
    }
    return current;
  }

  private assignmentTarget(
    target: ts.Expression,
    state: FlowState,
    readValue: boolean,
  ): { state: FlowState | null; symbol?: ts.Symbol } {
    const current = unwrapTransparent(target);
    if (ts.isIdentifier(current)) {
      const symbol = this.candidateAt(current);
      return {
        state: readValue ? normalState(this.identifier(current, state)) : state,
        ...(symbol === undefined ? {} : { symbol }),
      };
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      return { state: normalState(this.expression(current, state)) };
    }
    this.failed = true; // destructuring and every other assignment target
    return { state: null };
  }

  private binary(expression: ts.BinaryExpression, state: FlowState): ExpressionFlow {
    const op = expression.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = this.expression(expression.left, state);
      const right = left.truthy === null ? null : this.expression(expression.right, left.truthy);
      return {
        truthy: right?.truthy ?? null,
        falsy: mergeStates(left.falsy, right?.falsy ?? null),
      };
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const left = this.expression(expression.left, state);
      const right = left.falsy === null ? null : this.expression(expression.right, left.falsy);
      return {
        truthy: mergeStates(left.truthy, right?.truthy ?? null),
        falsy: right?.falsy ?? null,
      };
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      this.failed = true; // requires a third nullish/non-nullish flow dimension
      return unknownFlow(state);
    }
    if (op === ts.SyntaxKind.CommaToken) {
      const next = normalState(this.expression(expression.left, state));
      return next === null ? { truthy: null, falsy: null } : this.expression(expression.right, next);
    }
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
      if (
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken
      ) {
        this.failed = true;
        return unknownFlow(state);
      }
      const plain = op === ts.SyntaxKind.EqualsToken;
      const target = this.assignmentTarget(expression.left, state, !plain);
      if (target.state === null) return { truthy: null, falsy: null };
      const value = this.expression(expression.right, target.state);
      return addWrittenToFlow(plain ? value : unknownFlow(normalState(value) ?? target.state), target.symbol);
    }

    const left = normalState(this.expression(expression.left, state));
    if (left === null) return { truthy: null, falsy: null };
    const right = normalState(this.expression(expression.right, left));
    return right === null ? { truthy: null, falsy: null } : unknownFlow(right);
  }

  expression(expression: ts.Expression, state: FlowState): ExpressionFlow {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return this.expression(expression.expression, state);
    }
    if (ts.isIdentifier(expression)) return this.identifier(expression, state);
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return { truthy: state, falsy: null };
    if (expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) {
      return { truthy: null, falsy: state };
    }
    if (ts.isNumericLiteral(expression)) {
      return Number(expression.text) === 0 ? { truthy: null, falsy: state } : { truthy: state, falsy: null };
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text.length === 0 ? { truthy: null, falsy: state } : { truthy: state, falsy: null };
    }
    if (ts.isBinaryExpression(expression)) return this.binary(expression, state);
    if (ts.isConditionalExpression(expression)) {
      const condition = this.expression(expression.condition, state);
      const whenTrue = condition.truthy === null ? null : this.expression(expression.whenTrue, condition.truthy);
      const whenFalse = condition.falsy === null ? null : this.expression(expression.whenFalse, condition.falsy);
      return {
        truthy: mergeStates(whenTrue?.truthy ?? null, whenFalse?.truthy ?? null),
        falsy: mergeStates(whenTrue?.falsy ?? null, whenFalse?.falsy ?? null),
      };
    }
    if (ts.isPrefixUnaryExpression(expression)) {
      if (expression.operator === ts.SyntaxKind.ExclamationToken) {
        const operand = this.expression(expression.operand, state);
        return { truthy: operand.falsy, falsy: operand.truthy };
      }
      if (
        expression.operator === ts.SyntaxKind.PlusPlusToken ||
        expression.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        const target = this.assignmentTarget(expression.operand, state, true);
        const next = target.state === null ? state : addWritten(target.state, target.symbol);
        return unknownFlow(next);
      }
      const next = normalState(this.expression(expression.operand, state));
      return next === null ? { truthy: null, falsy: null } : unknownFlow(next);
    }
    if (ts.isPostfixUnaryExpression(expression)) {
      const target = this.assignmentTarget(expression.operand, state, true);
      const next = target.state === null ? state : addWritten(target.state, target.symbol);
      return unknownFlow(next);
    }
    if (ts.isVoidExpression(expression)) {
      const next = normalState(this.expression(expression.expression, state));
      return { truthy: null, falsy: next };
    }
    if (ts.isTypeOfExpression(expression)) {
      const next = normalState(this.expression(expression.expression, state));
      return next === null ? { truthy: null, falsy: null } : { truthy: next, falsy: null };
    }
    if (ts.isDeleteExpression(expression)) {
      this.failed = true;
      return unknownFlow(state);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (expression.questionDotToken !== undefined) this.failed = true;
      const next = normalState(this.expression(expression.expression, state));
      return next === null ? { truthy: null, falsy: null } : unknownFlow(next);
    }
    if (ts.isElementAccessExpression(expression)) {
      if (expression.questionDotToken !== undefined) this.failed = true;
      const receiver = normalState(this.expression(expression.expression, state));
      const next = receiver === null ? null : normalState(this.expression(expression.argumentExpression, receiver));
      return next === null ? { truthy: null, falsy: null } : unknownFlow(next);
    }
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      if (
        (ts.isCallExpression(expression) && expression.questionDotToken !== undefined) ||
        expression.arguments?.some(ts.isSpreadElement)
      ) {
        this.failed = true;
        return unknownFlow(state);
      }
      const callee = normalState(this.expression(expression.expression, state));
      const next = callee === null ? null : this.expressionSequence(expression.arguments ?? [], callee);
      return next === null ? { truthy: null, falsy: null } : unknownFlow(next);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const elements = expression.elements.filter(
        (element): element is ts.Expression => !ts.isOmittedExpression(element),
      );
      if (elements.some(ts.isSpreadElement)) this.failed = true;
      const next = this.expressionSequence(elements, state);
      return { truthy: next, falsy: null };
    }
    if (ts.isObjectLiteralExpression(expression)) {
      let next: FlowState | null = state;
      for (const property of expression.properties) {
        if (next === null) break;
        if (ts.isSpreadAssignment(property) || ts.isMethodDeclaration(property) || ts.isAccessor(property)) {
          this.failed = true;
          break;
        }
        if (ts.isComputedPropertyName(property.name)) {
          next = normalState(this.expression(property.name.expression, next));
          if (next === null) break;
        }
        if (ts.isPropertyAssignment(property)) next = normalState(this.expression(property.initializer, next));
        else if (ts.isShorthandPropertyAssignment(property)) {
          // `{ x = fallback }` evaluates fallback only when x is undefined;
          // modeling that needs nullish flow, so decline the whole proof.
          if (property.objectAssignmentInitializer !== undefined) this.failed = true;
          next = normalState(this.identifier(property.name, next));
        } else this.failed = true;
      }
      return { truthy: next, falsy: null };
    }
    if (ts.isTemplateExpression(expression)) {
      const next = this.expressionSequence(
        expression.templateSpans.map((span) => span.expression),
        state,
      );
      return next === null ? { truthy: null, falsy: null } : unknownFlow(next);
    }
    if (ts.isTaggedTemplateExpression(expression)) {
      const tag = normalState(this.expression(expression.tag, state));
      if (tag === null) return { truthy: null, falsy: null };
      const template = ts.isTemplateExpression(expression.template)
        ? normalState(this.expression(expression.template, tag))
        : tag;
      return template === null ? { truthy: null, falsy: null } : unknownFlow(template);
    }
    if (ts.isRegularExpressionLiteral(expression)) return { truthy: state, falsy: null };
    if (expression.kind === ts.SyntaxKind.ThisKeyword) return unknownFlow(state);

    // Functions/classes, optional chains, `await`/`yield`, JSX, meta
    // properties, and future syntax all decline until modeled explicitly.
    this.failed = true;
    return unknownFlow(state);
  }

  private variableList(list: ts.VariableDeclarationList, state: FlowState): FlowState | null {
    let next: FlowState | null = state;
    for (const declaration of list.declarations) {
      if (next === null || !ts.isIdentifier(declaration.name)) {
        this.failed = true;
        return null;
      }
      const symbol = this.candidateAt(declaration.name);
      if (declaration.initializer !== undefined) {
        next = normalState(this.expression(declaration.initializer, next));
        if (next !== null) next = addWritten(next, symbol);
      }
    }
    return next;
  }

  private statementFrom(statement: ts.Statement, state: FlowState | null): FlowState | null {
    return state === null ? null : this.statement(statement, state);
  }

  statement(statement: ts.Statement, state: FlowState): FlowState | null {
    if (ts.isBlock(statement)) {
      let next: FlowState | null = state;
      for (const child of statement.statements) next = this.statementFrom(child, next);
      return next;
    }
    if (ts.isVariableStatement(statement)) return this.variableList(statement.declarationList, state);
    if (ts.isExpressionStatement(statement)) return normalState(this.expression(statement.expression, state));
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      if (statement.expression !== undefined) this.expression(statement.expression, state);
      return null;
    }
    if (ts.isIfStatement(statement)) {
      const condition = this.expression(statement.expression, state);
      const whenTrue = this.statementFrom(statement.thenStatement, condition.truthy);
      const whenFalse = statement.elseStatement
        ? this.statementFrom(statement.elseStatement, condition.falsy)
        : condition.falsy;
      return mergeStates(whenTrue, whenFalse);
    }
    if (ts.isWhileStatement(statement)) {
      const condition = this.expression(statement.expression, state);
      this.statementFrom(statement.statement, condition.truthy);
      return condition.falsy; // body writes are not guaranteed on a zero-iteration exit
    }
    if (ts.isDoStatement(statement)) {
      const body = this.statement(statement.statement, state);
      if (body === null) return null;
      return this.expression(statement.expression, body).falsy;
    }
    if (ts.isForStatement(statement)) {
      let next: FlowState | null = state;
      if (statement.initializer !== undefined) {
        next = ts.isVariableDeclarationList(statement.initializer)
          ? this.variableList(statement.initializer, state)
          : normalState(this.expression(statement.initializer, state));
      }
      if (next === null) return null;
      const condition = statement.condition
        ? this.expression(statement.condition, next)
        : { truthy: next, falsy: null };
      const body = this.statementFrom(statement.statement, condition.truthy);
      if (body !== null && statement.incrementor !== undefined) this.expression(statement.incrementor, body);
      return condition.falsy;
    }
    if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
      const iterable = normalState(this.expression(statement.expression, state));
      if (iterable === null) return null;
      let iteration = iterable;
      if (ts.isVariableDeclarationList(statement.initializer)) {
        if (
          statement.initializer.declarations.length !== 1 ||
          !ts.isIdentifier(statement.initializer.declarations[0]!.name) ||
          statement.initializer.declarations[0]!.initializer !== undefined
        ) {
          this.failed = true;
          return iterable;
        }
        iteration = addWritten(iteration, this.candidateAt(statement.initializer.declarations[0]!.name));
      } else {
        const target = this.assignmentTarget(statement.initializer, iteration, false);
        if (target.state !== null) iteration = addWritten(target.state, target.symbol);
      }
      this.statement(statement.statement, iteration);
      return iterable; // the iterable may be empty, so the target need not be written
    }
    if (ts.isEmptyStatement(statement)) return state;

    this.failed = true;
    return state;
  }
}

function analyzeFunction(checker: ts.TypeChecker, fn: FunctionWithBlock): ReadonlySet<ts.Symbol> {
  const facts = collectCandidates(checker, fn);
  if (facts === undefined || facts.symbols.size === 0) return new Set();
  const flow = new MustWriteFlow(checker, facts.symbols, facts.names);
  flow.statement(fn.body, new Set());
  if (flow.failed) return new Set();
  return new Set([...facts.symbols].filter((symbol) => !flow.unsafe.has(symbol)));
}

/** Checker-owned, memoized query consumed by the var hoister. */
export class VarInitElisionAnalysis {
  private readonly functionCache = new WeakMap<FunctionWithBlock, ReadonlySet<ts.Symbol>>();

  constructor(private readonly checker: ts.TypeChecker) {}

  canElideUndefinedInit(declaration: ts.VariableDeclaration): boolean {
    try {
      if (!ts.isIdentifier(declaration.name)) return false;
      const list = declaration.parent;
      if (!ts.isVariableDeclarationList(list)) return false;
      if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) {
        return false;
      }
      const fn = enclosingFunction(declaration);
      if (fn === undefined) return false;
      let safe = this.functionCache.get(fn);
      if (safe === undefined) {
        safe = analyzeFunction(this.checker, fn);
        this.functionCache.set(fn, safe);
      }
      const symbol = this.checker.getSymbolAtLocation(declaration.name);
      return symbol !== undefined && safe.has(symbol);
    } catch {
      return false;
    }
  }
}
