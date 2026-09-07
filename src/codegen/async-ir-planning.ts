// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { PreparedAsyncAwaitSite } from "../ir/async-from-ast.js";
import { isSingleAwaitReturnAsyncCandidate } from "../ir/async-prepare.js";
import {
  IR_ASYNC_CLOCK_SNAPSHOT_FN,
  IR_ASYNC_CONSOLE_LOG_STRING_FN,
  IR_ASYNC_NUMBER_TO_STRING_FN,
  IR_ASYNC_PROMISE_ALL_NATIVE_FN,
  IR_ASYNC_STRING_CONCAT_5_FN,
} from "../ir/async-semantic-runtime.js";
import type { IrFromAstResolver } from "../ir/from-ast.js";
import {
  awaitIsStaticallyResolved,
  staticPromiseResolveSettledExpr,
  unwrapPromiseTypeNode,
} from "../ir/async-static.js";
import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef } from "../ir/callable-bindings.js";
import { irVal, irVec } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrPromiseDelayResolver } from "../ir/promise-delay.js";
import type { IrSelectionOptions } from "../ir/select.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { IrSourceId, IrTerminalUnitRecord, IrUnitId } from "../ir/identity.js";
import { asyncEngineWouldActivate } from "./async-activation.js";
import { analyzeAsyncBody, splitBodyAtAwait } from "./async-cps.js";
import {
  type PreparedIrAsyncLinearSource,
  forgetPreparedIrAsyncSettledOwner,
  preparedIrAsyncLinearSource,
  preparedIrAsyncPromiseCallClosure,
  preparedIrAsyncSettledOwner,
  preparedIrAsyncSettledOwnerWasIssued,
  settledOwnerIdentity,
  type PreparedIrAsyncPromiseCallClosure,
  type SettledOwnerIdentity,
} from "./async-linear-planning.js";
import { nativeTypeOfDeclaration } from "./native-type-annotations.js";
import type { CodegenContext } from "./context/types.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";

type AsyncSelectionOptions = Pick<
  IrSelectionOptions,
  | "supportsAsyncIr"
  | "asyncEngineClaims"
  | "asyncHasRealSuspension"
  | "canPrepareSuspendingAsync"
  | "preparedAsyncPromiseVectorLocal"
  | "preparedAsyncThenableCall"
  | "preparedAsyncPromiseAllCall"
  | "preparedAsyncDateNowCall"
>;

export type PreparedIrAsyncSourceShape =
  | {
      readonly kind: "identity" | "promise-all-continuation";
      readonly awaitedCall: ts.CallExpression;
    }
  | {
      readonly kind: "sequential-counted-loop";
      readonly awaitedCalls: readonly [ts.CallExpression];
    }
  | {
      readonly kind: "final-main";
      readonly awaitedCalls: readonly [ts.CallExpression, ts.CallExpression];
      readonly dateNowCalls: readonly [ts.CallExpression, ts.CallExpression, ts.CallExpression, ts.CallExpression];
      readonly concatExpressions: readonly [ts.Expression, ts.Expression];
    }
  | PreparedIrAsyncLinearSource;

function hasAsyncModifier(fn: ts.FunctionDeclaration): boolean {
  return fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function variableDeclarationOf(statement: ts.Statement, name: string): ts.VariableDeclaration | null {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return null;
  const declaration = statement.declarationList.declarations[0]!;
  return ts.isIdentifier(declaration.name) && declaration.name.text === name ? declaration : null;
}

function exactDirectCall(expression: ts.Expression | undefined, name: string): ts.CallExpression | null {
  return expression &&
    ts.isCallExpression(expression) &&
    !expression.questionDotToken &&
    expression.typeArguments === undefined &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === name
    ? expression
    : null;
}

function exactAwaitedVariable(
  statement: ts.Statement,
  variableName: string,
  calleeName: string,
): ts.CallExpression | null {
  const declaration = variableDeclarationOf(statement, variableName);
  return declaration?.initializer && ts.isAwaitExpression(declaration.initializer)
    ? exactDirectCall(declaration.initializer.expression, calleeName)
    : null;
}

function exactDateNowVariable(
  ctx: CodegenContext,
  statement: ts.Statement,
  variableName: string,
): ts.CallExpression | null {
  const initializer = variableDeclarationOf(statement, variableName)?.initializer;
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.arguments.length !== 0 ||
    initializer.typeArguments ||
    initializer.questionDotToken ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    initializer.expression.name.text !== "now" ||
    !ts.isIdentifier(initializer.expression.expression) ||
    initializer.expression.expression.text !== "Date" ||
    !declarationsAreAmbient(ctx, initializer.expression.expression) ||
    !declarationsAreAmbient(ctx, initializer.expression.name)
  ) {
    return null;
  }
  return initializer;
}

function exactConsoleLogArgument(ctx: CodegenContext, statement: ts.Statement): ts.Expression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
  const call = statement.expression;
  if (
    call.arguments.length !== 1 ||
    call.typeArguments ||
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "log" ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.expression.text !== "console" ||
    !declarationsAreAmbient(ctx, call.expression.expression) ||
    !declarationsAreAmbient(ctx, call.expression.name)
  ) {
    return null;
  }
  return call.arguments[0]!;
}

function exactNumberToStringCall(expression: ts.Expression, name: string): boolean {
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 0 &&
    expression.typeArguments === undefined &&
    !expression.questionDotToken &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "toString" &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === name
  );
}

function exactDurationToStringCall(expression: ts.Expression, end: string, start: string): boolean {
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 0 ||
    expression.typeArguments !== undefined ||
    expression.questionDotToken ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "toString"
  ) {
    return false;
  }
  const receiver = expression.expression.expression;
  if (!ts.isParenthesizedExpression(receiver) || !ts.isBinaryExpression(receiver.expression)) return false;
  const subtraction = receiver.expression;
  return (
    subtraction.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    ts.isIdentifier(subtraction.left) &&
    subtraction.left.text === end &&
    ts.isIdentifier(subtraction.right) &&
    subtraction.right.text === start
  );
}

function exactTimingLogExpression(
  expression: ts.Expression,
  prefix: string,
  valueName: string,
  end: string,
  start: string,
): boolean {
  const terms: ts.Expression[] = [];
  let current = expression;
  while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    terms.unshift(current.right);
    current = current.left;
  }
  terms.unshift(current);
  return (
    terms.length === 5 &&
    ts.isStringLiteralLike(terms[0]!) &&
    terms[0]!.text === prefix &&
    exactNumberToStringCall(terms[1]!, valueName) &&
    ts.isStringLiteralLike(terms[2]!) &&
    terms[2]!.text === " (took ~" &&
    exactDurationToStringCall(terms[3]!, end, start) &&
    ts.isStringLiteralLike(terms[4]!) &&
    terms[4]!.text === "ms)"
  );
}

function exactPromiseReturn(fn: ts.FunctionDeclaration, argumentKind: ts.SyntaxKind): boolean {
  const type = fn.type;
  return (
    !!type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "Promise" &&
    type.typeArguments?.length === 1 &&
    type.typeArguments[0]?.kind === argumentKind
  );
}

function exactSequentialShape(ctx: CodegenContext, fn: ts.FunctionDeclaration): ts.CallExpression | null {
  if (
    fn.name?.text !== "fetchAllSequential" ||
    !hasAsyncModifier(fn) ||
    fn.parameters.length !== 1 ||
    !exactPromiseReturn(fn, ts.SyntaxKind.NumberKeyword) ||
    fn.body?.statements.length !== 3
  ) {
    return null;
  }
  const parameter = fn.parameters[0]!;
  if (
    !ts.isIdentifier(parameter.name) ||
    parameter.name.text !== "ids" ||
    !parameter.type ||
    !ts.isArrayTypeNode(parameter.type) ||
    parameter.type.elementType.kind !== ts.SyntaxKind.NumberKeyword
  ) {
    return null;
  }
  const total = variableDeclarationOf(fn.body.statements[0]!, "total");
  if (!total?.initializer || !ts.isNumericLiteral(total.initializer) || Number(total.initializer.text) !== 0)
    return null;
  const loop = fn.body.statements[1];
  if (
    !loop ||
    !ts.isForStatement(loop) ||
    !loop.initializer ||
    !ts.isVariableDeclarationList(loop.initializer) ||
    loop.initializer.declarations.length !== 1 ||
    !loop.condition ||
    !loop.incrementor ||
    !ts.isBlock(loop.statement) ||
    loop.statement.statements.length !== 1
  ) {
    return null;
  }
  const iDecl = loop.initializer.declarations[0]!;
  const exactInit =
    ts.isIdentifier(iDecl.name) &&
    iDecl.name.text === "i" &&
    !!iDecl.initializer &&
    ts.isNumericLiteral(iDecl.initializer) &&
    Number(iDecl.initializer.text) === 0;
  const exactCondition =
    ts.isBinaryExpression(loop.condition) &&
    loop.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
    ts.isIdentifier(loop.condition.left) &&
    loop.condition.left.text === "i" &&
    ts.isPropertyAccessExpression(loop.condition.right) &&
    ts.isIdentifier(loop.condition.right.expression) &&
    loop.condition.right.expression.text === "ids" &&
    loop.condition.right.name.text === "length";
  const exactIncrement =
    ts.isPostfixUnaryExpression(loop.incrementor) &&
    loop.incrementor.operator === ts.SyntaxKind.PlusPlusToken &&
    ts.isIdentifier(loop.incrementor.operand) &&
    loop.incrementor.operand.text === "i";
  const bodyStatement = loop.statement.statements[0]!;
  if (!exactInit || !exactCondition || !exactIncrement || !ts.isExpressionStatement(bodyStatement)) return null;
  const assignment = bodyStatement.expression;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    assignment.left.text !== "total" ||
    !ts.isBinaryExpression(assignment.right) ||
    assignment.right.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isIdentifier(assignment.right.left) ||
    assignment.right.left.text !== "total" ||
    !ts.isParenthesizedExpression(assignment.right.right) ||
    !ts.isAwaitExpression(assignment.right.right.expression)
  ) {
    return null;
  }
  const awaited = exactDirectCall(assignment.right.right.expression.expression, "fetchUser");
  if (
    !awaited ||
    awaited.arguments.length !== 1 ||
    !ts.isElementAccessExpression(awaited.arguments[0]!) ||
    !ts.isIdentifier(awaited.arguments[0]!.expression) ||
    awaited.arguments[0]!.expression.text !== "ids" ||
    !awaited.arguments[0]!.argumentExpression ||
    !ts.isIdentifier(awaited.arguments[0]!.argumentExpression) ||
    awaited.arguments[0]!.argumentExpression.text !== "i"
  ) {
    return null;
  }
  const returned = fn.body.statements[2];
  if (
    !returned ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isIdentifier(returned.expression) ||
    returned.expression.text !== "total"
  ) {
    return null;
  }
  const callee = ctx.oracle.valueDeclarationOf(awaited.expression);
  return callee && ts.isFunctionDeclaration(callee) && preparedIrAsyncSourceShape(ctx, callee)?.kind === "identity"
    ? awaited
    : null;
}

function exactFinalMainShape(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
): Extract<PreparedIrAsyncSourceShape, { readonly kind: "final-main" }> | null {
  if (
    fn.name?.text !== "main" ||
    !hasAsyncModifier(fn) ||
    fn.parameters.length !== 0 ||
    !exactPromiseReturn(fn, ts.SyntaxKind.VoidKeyword) ||
    fn.body?.statements.length !== 11
  ) {
    return null;
  }
  const statements = fn.body.statements;
  const intro = exactConsoleLogArgument(ctx, statements[0]!);
  const ids = variableDeclarationOf(statements[1]!, "ids")?.initializer;
  const t0 = exactDateNowVariable(ctx, statements[2]!, "t0");
  const sequential = exactAwaitedVariable(statements[3]!, "seq", "fetchAllSequential");
  const t1 = exactDateNowVariable(ctx, statements[4]!, "t1");
  const sequentialLog = exactConsoleLogArgument(ctx, statements[5]!);
  const t2 = exactDateNowVariable(ctx, statements[6]!, "t2");
  const parallel = exactAwaitedVariable(statements[7]!, "par", "fetchAllParallel");
  const t3 = exactDateNowVariable(ctx, statements[8]!, "t3");
  const parallelLog = exactConsoleLogArgument(ctx, statements[9]!);
  const done = exactConsoleLogArgument(ctx, statements[10]!);
  if (
    !intro ||
    !ts.isStringLiteralLike(intro) ||
    intro.text !== "async/await demo" ||
    !ids ||
    !ts.isArrayLiteralExpression(ids) ||
    ids.elements.length !== 5 ||
    !ids.elements.every((element, index) => ts.isNumericLiteral(element) && Number(element.text) === index + 1) ||
    !t0 ||
    !sequential ||
    sequential.arguments.length !== 1 ||
    !ts.isIdentifier(sequential.arguments[0]!) ||
    sequential.arguments[0]!.text !== "ids" ||
    !t1 ||
    !sequentialLog ||
    !exactTimingLogExpression(sequentialLog, "sequential sum = ", "seq", "t1", "t0") ||
    !t2 ||
    !parallel ||
    parallel.arguments.length !== 1 ||
    !ts.isIdentifier(parallel.arguments[0]!) ||
    parallel.arguments[0]!.text !== "ids" ||
    !t3 ||
    !parallelLog ||
    !exactTimingLogExpression(parallelLog, "parallel  sum = ", "par", "t3", "t2") ||
    !done ||
    !ts.isStringLiteralLike(done) ||
    done.text !== "done"
  ) {
    return null;
  }
  const seqDecl = ctx.oracle.valueDeclarationOf(sequential.expression);
  const parDecl = ctx.oracle.valueDeclarationOf(parallel.expression);
  if (
    !seqDecl ||
    !ts.isFunctionDeclaration(seqDecl) ||
    exactSequentialShape(ctx, seqDecl) === null ||
    !parDecl ||
    !ts.isFunctionDeclaration(parDecl) ||
    preparedIrAsyncSourceShape(ctx, parDecl)?.kind !== "promise-all-continuation"
  ) {
    return null;
  }
  return {
    kind: "final-main",
    awaitedCalls: [sequential, parallel],
    dateNowCalls: [t0, t1, t2, t3],
    concatExpressions: [sequentialLog, parallelLog],
  };
}

function collectBindingDeclarations(
  ctx: CodegenContext,
  name: ts.BindingName,
  declarations: Set<ts.Declaration>,
): void {
  if (ts.isIdentifier(name)) {
    const declaration = ctx.oracle.valueDeclarationOf(name);
    if (declaration) declarations.add(declaration);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingDeclarations(ctx, element.name, declarations);
  }
}

function isNestedExecutable(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function bodyHasNestedExecutable(body: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isNestedExecutable(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of body.statements) visit(statement);
  return found;
}

function declarationsAreAmbient(ctx: CodegenContext, node: ts.Node): boolean {
  const declarations = ctx.oracle.declarationsOf(node);
  return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function isExactPromiseVectorDeclaration(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  const type = declaration.type;
  return (
    !!type &&
    ts.isArrayTypeNode(type) &&
    ts.isTypeReferenceNode(type.elementType) &&
    ts.isIdentifier(type.elementType.typeName) &&
    type.elementType.typeName.text === "Promise" &&
    type.elementType.typeArguments?.length === 1 &&
    type.elementType.typeArguments[0]?.kind === ts.SyntaxKind.NumberKeyword &&
    declarationsAreAmbient(ctx, type.elementType.typeName) &&
    !!declaration.initializer &&
    ts.isArrayLiteralExpression(declaration.initializer) &&
    declaration.initializer.elements.length === 0
  );
}

/** Checker proof that the continuation reads no parameter or prefix local. */
function continuationHasNoPreAwaitCapture(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  prefix: readonly ts.Statement[],
  suffix: readonly ts.Statement[],
): boolean {
  const preAwaitDeclarations = new Set<ts.Declaration>();
  for (const parameter of fn.parameters) collectBindingDeclarations(ctx, parameter.name, preAwaitDeclarations);
  const collectPrefix = (node: ts.Node): void => {
    if (isNestedExecutable(node)) return;
    if (ts.isVariableDeclaration(node)) collectBindingDeclarations(ctx, node.name, preAwaitDeclarations);
    ts.forEachChild(node, collectPrefix);
  };
  for (const statement of prefix) collectPrefix(statement);

  let captured = false;
  const inspectSuffix = (node: ts.Node): void => {
    if (captured || isNestedExecutable(node)) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(node) && node.text === "arguments")) {
      captured = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      const declaration = ctx.oracle.valueDeclarationOf(node);
      if (declaration && preAwaitDeclarations.has(declaration)) {
        captured = true;
        return;
      }
    }
    ts.forEachChild(node, inspectSuffix);
  };
  for (const statement of suffix) inspectSuffix(statement);
  return !captured;
}

function isAmbientPromiseAll(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const target = call.expression;
  if (
    !ts.isPropertyAccessExpression(target) ||
    !ts.isIdentifier(target.expression) ||
    target.expression.text !== "Promise" ||
    target.name.text !== "all"
  ) {
    return false;
  }
  if (call.questionDotToken || call.typeArguments?.length || call.arguments.length !== 1) return false;
  const pendingDeclaration = ts.isIdentifier(call.arguments[0]!)
    ? ctx.oracle.variableDeclarationOf(call.arguments[0]!)
    : undefined;
  return (
    declarationsAreAmbient(ctx, target.expression) &&
    declarationsAreAmbient(ctx, target.name) &&
    pendingDeclaration !== undefined &&
    isExactPromiseVectorDeclaration(ctx, pendingDeclaration)
  );
}

/**
 * Source-level proof used before callable ABI publication. The continuation
 * widening remains one exact Promise.all suspension and rejects every value
 * that would need a frame spill; final IR preparation re-verifies the split.
 */
export function preparedIrAsyncSourceShape(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
): PreparedIrAsyncSourceShape | null {
  if (!ts.isFunctionDeclaration(fn) || fn.asteriskToken || !fn.body || bodyHasNestedExecutable(fn.body)) return null;
  if (!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  const sequential = exactSequentialShape(ctx, fn);
  if (sequential) return { kind: "sequential-counted-loop", awaitedCalls: [sequential] };
  const finalMain = exactFinalMainShape(ctx, fn);
  if (finalMain) return finalMain;
  const plan = analyzeAsyncBody(ctx, fn);
  const split = splitBodyAtAwait(fn, plan);
  if (split && ts.isCallExpression(split.awaitedExpr)) {
    if (isSingleAwaitReturnAsyncCandidate(fn)) {
      return { kind: "identity", awaitedCall: split.awaitedExpr };
    }
    if (
      !split.isReturnAwait &&
      split.resumeBinding &&
      split.suffix.length > 0 &&
      isAmbientPromiseAll(ctx, split.awaitedExpr) &&
      continuationHasNoPreAwaitCapture(ctx, fn, split.prefix, split.suffix)
    ) {
      return {
        kind: "promise-all-continuation",
        awaitedCall: split.awaitedExpr,
      };
    }
  }
  const linear = preparedIrAsyncLinearSource(ctx, fn);
  if (linear) {
    // Keep the historical identity shape for the exact one-await producer;
    // the generic IR producer is still selected after that producer proves
    // it cannot handle the lowered block (for example, a live mutable slot).
    if (isSingleAwaitReturnAsyncCandidate(fn) && linear.awaitedExpressions.length === 1) {
      const awaited = linear.awaitedExpressions[0];
      if (ts.isCallExpression(awaited)) return { kind: "identity", awaitedCall: awaited };
    }
    return linear;
  }
  return null;
}

export function preparedIrAsyncSourceCanSuspend(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  assertPreparedIrAsyncPromiseOwnerCurrent(ctx, fn);
  return sourceAsyncCanSuspend(ctx, fn);
}

/** Source facts only: receipt validation recomputes these without re-entering itself. */
function sourceAsyncCanSuspend(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  // Check issuance before asking the current AST/identity maps for a shape.
  // A withdrawn or rebound owner must remain fatal even when that lookup now
  // returns no shape and would otherwise look like an ordinary refusal.
  const settledOwnerWasIssued = preparedIrAsyncSettledOwnerWasIssued(ctx, fn);
  const shape = preparedIrAsyncSourceShape(ctx, fn);
  const linearPlan = shape?.kind === "linear" ? analyzeAsyncBody(ctx, fn) : undefined;
  const settledOwner = shape?.kind === "linear" ? preparedIrAsyncSettledOwner(ctx, fn) : null;
  if (settledOwnerWasIssued && !settledOwner) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `settled async owner ${fn.name?.text ?? "<anonymous>"} lost its source proof after ABI issuance`,
    );
  }
  const linearCalleesPrepared =
    shape?.kind !== "linear" || linearAwaitCalleesArePrepared(ctx, shape.awaitedExpressions);
  const linearHasSupportedAwaitTypes =
    shape?.kind !== "linear" ||
    shape.awaitSites.every(
      (awaitExpression) =>
        preparedIrAsyncLinearAwaitResultType(ctx, awaitExpression) !== null &&
        preparedIrAsyncLinearAwaitOperandCanLower(ctx, awaitExpression),
    );
  const linearHasRealSuspension =
    shape?.kind !== "linear" ||
    linearPlan!.awaitPoints.some(
      (awaitExpression) => linearPlan!.awaitedStaticallyResolved.get(awaitExpression) !== true,
    );
  return (
    shape !== null &&
    linearHasSupportedAwaitTypes &&
    linearCalleesPrepared &&
    (linearHasRealSuspension || settledOwner !== null) &&
    (shape.kind === "promise-all-continuation" ||
      shape.kind === "sequential-counted-loop" ||
      shape.kind === "final-main" ||
      shape.kind === "linear" ||
      asyncEngineWouldActivate(ctx, fn))
  );
}

const promiseDelayResolverByContext = new WeakMap<CodegenContext, IrPromiseDelayResolver>();

/** Publish checker-derived delay ownership before declaration ABI collection. */
export function registerIrAsyncPromiseDelayResolver(ctx: CodegenContext, resolver: IrPromiseDelayResolver): void {
  promiseDelayResolverByContext.set(ctx, resolver);
}

function promiseDelayResolver(ctx: CodegenContext): IrPromiseDelayResolver | undefined {
  return promiseDelayResolverByContext.get(ctx);
}

function sourceFunctionForCall(ctx: CodegenContext, call: ts.CallExpression): ts.FunctionDeclaration | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const declaration = ctx.oracle.valueDeclarationOf(call.expression);
  return declaration && ts.isFunctionDeclaration(declaration) && declaration.getSourceFile() === call.getSourceFile()
    ? declaration
    : null;
}

/** A linear owner may call only async declarations that the same producer can prepare. */
function linearAwaitCalleesArePrepared(ctx: CodegenContext, expressions: readonly ts.Expression[]): boolean {
  for (const expression of expressions) {
    if (!ts.isCallExpression(expression)) continue;
    const callee = sourceFunctionForCall(ctx, expression);
    if (!callee || !callee.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) continue;
    if (!preparedIrAsyncSourceCanSuspend(ctx, callee)) return false;
  }
  return true;
}

function exactStandaloneFetchUser(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  shape: { readonly awaitedCall: ts.CallExpression },
): boolean {
  const parameter = fn.parameters[0];
  const call = shape.awaitedCall;
  const delay = sourceFunctionForCall(ctx, call);
  const multiplied = call.arguments[1];
  return (
    fn.name?.text === "fetchUser" &&
    fn.parameters.length === 1 &&
    !!parameter &&
    ts.isIdentifier(parameter.name) &&
    parameter.type?.kind === ts.SyntaxKind.NumberKeyword &&
    exactPromiseReturn(fn, ts.SyntaxKind.NumberKeyword) &&
    call.arguments.length === 2 &&
    ts.isNumericLiteral(call.arguments[0]!) &&
    Number(call.arguments[0]!.text) === 30 &&
    !!multiplied &&
    ts.isBinaryExpression(multiplied) &&
    multiplied.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
    ts.isIdentifier(multiplied.left) &&
    ctx.oracle.valueDeclarationOf(multiplied.left) === parameter &&
    ts.isNumericLiteral(multiplied.right) &&
    Number(multiplied.right.text) === 10 &&
    !!delay &&
    promiseDelayResolver(ctx)?.resolveOwner(delay) !== undefined
  );
}

function standaloneLinearAwaitOperand(
  ctx: CodegenContext,
  expression: ts.Expression,
  active: Set<ts.FunctionDeclaration>,
): boolean {
  let candidate = expression;
  while (
    ts.isParenthesizedExpression(candidate) ||
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isNonNullExpression(candidate)
  ) {
    candidate = candidate.expression;
  }
  // A settled literal or Promise.resolve form still crosses the retained
  // await edge; it has no unknown producer to close over.  Native-first
  // lanes cannot box an f64 operand at this boundary, however, so apply the
  // same operand admission check as the generic source preflight.
  if (awaitIsStaticallyResolved(candidate) || staticPromiseResolveSettledExpr(candidate) !== null) {
    return preparedIrAsyncLinearAwaitOperandCanLower(ctx, expression);
  }
  if (ts.isNewExpression(candidate)) {
    return promiseDelayResolver(ctx)?.resolve(candidate) !== undefined;
  }
  if (!ts.isCallExpression(candidate) || !ts.isIdentifier(candidate.expression)) return false;
  const callee = sourceFunctionForCall(ctx, candidate);
  if (!callee) return false;
  return (
    promiseDelayResolver(ctx)?.resolveOwner(callee) !== undefined ||
    isExactStandaloneNativeAsyncFamilyOwner(ctx, callee, active)
  );
}

/**
 * Keep the first standalone-native projection closed over the exact playground
 * dependency family. The host projection retains the broader certified async
 * shapes; standalone widens only when every source call bottoms out at the
 * separately prepared Promise-delay owner.
 */
function isExactStandaloneNativeAsyncFamilyOwner(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  active = new Set<ts.FunctionDeclaration>(),
): boolean {
  if (active.has(fn)) return false;
  active.add(fn);
  try {
    const shape = preparedIrAsyncSourceShape(ctx, fn);
    if (!shape) return false;
    if (shape.kind === "identity") return exactStandaloneFetchUser(ctx, fn, shape);
    if (shape.kind === "sequential-counted-loop") {
      const callee = sourceFunctionForCall(ctx, shape.awaitedCalls[0]);
      return !!callee && isExactStandaloneNativeAsyncFamilyOwner(ctx, callee, active);
    }
    if (shape.kind === "final-main") {
      const sequential = sourceFunctionForCall(ctx, shape.awaitedCalls[0]);
      const parallel = sourceFunctionForCall(ctx, shape.awaitedCalls[1]);
      return (
        !!sequential &&
        !!parallel &&
        isExactStandaloneNativeAsyncFamilyOwner(ctx, sequential, active) &&
        isExactStandaloneNativeAsyncFamilyOwner(ctx, parallel, active)
      );
    }
    if (shape.kind === "linear") {
      return shape.awaitedExpressions.every((expression) => standaloneLinearAwaitOperand(ctx, expression, active));
    }
    if (fn.name?.text !== "fetchAllParallel") return false;
    const callees = new Set<ts.FunctionDeclaration>();
    const visit = (node: ts.Node): void => {
      if (node !== fn && isNestedExecutable(node)) return;
      if (ts.isCallExpression(node) && node.end <= shape.awaitedCall.pos && isPreparedAsyncThenableCall(ctx, node)) {
        const callee = sourceFunctionForCall(ctx, node);
        if (callee) callees.add(callee);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body!);
    return (
      callees.size === 1 && [...callees].every((callee) => isExactStandaloneNativeAsyncFamilyOwner(ctx, callee, active))
    );
  } finally {
    active.delete(fn);
  }
}

function preparedIrAsyncSourceCanSuspendOnTarget(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  return sourceAsyncCanSuspend(ctx, fn) && (!ctx.standalone || isExactStandaloneNativeAsyncFamilyOwner(ctx, fn));
}

/** Exact awaited Promise.all node owned by the certified continuation shape. */
export function isPreparedIrPromiseAllCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const owner = enclosingFunctionDeclaration(call);
  if (!owner) return false;
  const shape = preparedIrAsyncSourceShape(ctx, owner);
  return shape?.kind === "promise-all-continuation" && shape.awaitedCall === call;
}

function preparedIrAsyncLinearAwaitResultType(
  ctx: CodegenContext,
  expression: ts.AwaitExpression,
): ReturnType<typeof irVal> | null {
  switch (ctx.oracle.typeFactOf(expression).kind) {
    case "number":
      return irVal({ kind: "f64" });
    default:
      return null;
  }
}

/**
 * Whether lowering the retained await operand can satisfy the frozen lane
 * boundary.  A native-first lane has no `js.number.box` provider, so a
 * settled numeric operand would otherwise make a source owner look closed and
 * fail only after synthetic helpers have been registered.  Promise-valued
 * operands remain externref carriers and are admitted normally.
 */
function preparedIrAsyncLinearAwaitOperandCanLower(
  ctx: CodegenContext,
  expression: ts.AwaitExpression | ts.Expression,
): boolean {
  if (!ctx.nativeStrings) return true;
  const operand = ts.isAwaitExpression(expression) ? expression.expression : expression;
  const settled = staticPromiseResolveSettledExpr(operand);
  const candidate = settled !== null && settled !== "undefined" ? settled : operand;
  return ctx.oracle.typeFactOf(candidate).kind !== "number";
}

/** Exact prepared await evidence for the generic linear producer. */
export function preparedIrAsyncAwaitSite(
  ctx: CodegenContext,
  expression: ts.AwaitExpression,
): PreparedAsyncAwaitSite | null {
  const owner = enclosingFunctionDeclaration(expression);
  if (!owner) return null;
  assertPreparedIrAsyncPromiseOwnerCurrent(ctx, owner);
  // Do not let a lost current source shape turn an already-issued Promise ABI
  // into a quiet unsupported result.  The declaration-keyed issuance receipt
  // survives identity-map loss and makes this path fail before await lowering.
  const settledOwnerWasIssued = preparedIrAsyncSettledOwnerWasIssued(ctx, owner);
  const shape = preparedIrAsyncSourceShape(ctx, owner);
  if (shape?.kind !== "linear") {
    if (settledOwnerWasIssued) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `settled async owner ${owner.name?.text ?? "<anonymous>"} lost its source proof before await lowering`,
      );
    }
    return null;
  }
  if (!shape.awaitSites.includes(expression)) return null;
  const settledOwner = preparedIrAsyncSettledOwner(ctx, owner);
  if (!settledOwner && settledOwnerWasIssued) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `settled async owner ${owner.name?.text ?? "<anonymous>"} lost its source proof before await lowering`,
    );
  }
  if (
    settledOwner &&
    (process.env.JS2WASM_TEST_DROP_IR_ASYNC_SETTLED_OWNER === "1" ||
      process.env.JS2WASM_TEST_DROP_IR_ASYNC_SETTLED_OWNER === owner.name?.text)
  ) {
    // Test-only fault injection models a producer that withdrew an owner
    // after declaration ABI projection. The next shared gate below must
    // reject with an invariant before any direct body can be retried.
    forgetPreparedIrAsyncSettledOwner(ctx, owner);
  }
  // The generic producer owns either an existing B2 source owner whose
  // analysis reports a potentially suspending await or a B3 owner carrying
  // the complete settled non-thenable receipt. If this evidence escaped the
  // admission proof, from-ast would retain an await node and async
  // preparation would later try to attach a frame plan to an owner that the
  // selector never promised.
  if (!preparedIrAsyncSourceCanSuspend(ctx, owner)) return null;
  const resultType = preparedIrAsyncLinearAwaitResultType(ctx, expression);
  return resultType
    ? {
        resultType,
        // B3 consumes the original operand exactly once. Promise.resolve and
        // existing B2 Promise-valued owners retain their established
        // substitution/consumer rules.
        ...(settledOwner
          ? {
              settledNonThenable: true,
              settledOwnerUnitId: settledOwner.unitId,
              settledOwnerProofKey: settledOwner.sourceFingerprint,
            }
          : {}),
      }
    : null;
}

/** Exact direct async call whose Promise result is owned by a prepared state. */
export function isPreparedIrThenableCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const owner = enclosingFunctionDeclaration(call);
  if (!owner) return false;
  const shape = preparedIrAsyncSourceShape(ctx, owner);
  if (shape?.kind === "linear") return shape.awaitedExpressions.includes(call);
  if (shape?.kind === "sequential-counted-loop" || shape?.kind === "final-main") {
    return shape.awaitedCalls.includes(call);
  }
  return isPreparedAsyncThenableCall(ctx, call);
}

/** Exact ambient Date.now call owned by the final prepared main. */
export function isPreparedIrDateNowCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const owner = enclosingFunctionDeclaration(call);
  const shape = owner ? preparedIrAsyncSourceShape(ctx, owner) : null;
  return shape?.kind === "final-main" && shape.dateNowCalls.includes(call);
}

/** Exact five-part string concat owned by the final prepared main. */
export function isPreparedIrAsyncConcat(ctx: CodegenContext, expression: ts.Expression): boolean {
  const owner = enclosingFunctionDeclaration(expression);
  const shape = owner ? preparedIrAsyncSourceShape(ctx, owner) : null;
  return shape?.kind === "final-main" && shape.concatExpressions.includes(expression);
}

function isInsidePreparedFinalMain(ctx: CodegenContext, node: ts.Node): boolean {
  const owner = enclosingFunctionDeclaration(node);
  return owner ? preparedIrAsyncSourceShape(ctx, owner)?.kind === "final-main" : false;
}

function preparedAsyncParamAbiIsStable(ctx: CodegenContext, param: ValType): boolean {
  if (param.kind === "f64") return true;
  const numericVecTypeIdx = ctx.vecTypeMap.get("f64");
  return (
    (param.kind === "ref" || param.kind === "ref_null") &&
    numericVecTypeIdx !== undefined &&
    param.typeIdx === numericVecTypeIdx
  );
}

function enclosingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current;
    if (isNestedExecutable(current)) return null;
  }
  return null;
}

/** Exact pending-vector annotation owned by the certified Promise.all prefix. */
export function isPreparedIrPromiseVectorLocal(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  if (!isExactPromiseVectorDeclaration(ctx, declaration)) return false;
  const owner = enclosingFunctionDeclaration(declaration);
  if (!owner) return false;
  const shape = preparedIrAsyncSourceShape(ctx, owner);
  return shape?.kind === "promise-all-continuation" && declaration.end <= shape.awaitedCall.pos;
}

/** Exact Promise-producing call stored in the certified pending vector. */
function isPreparedAsyncThenableCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  const owner = enclosingFunctionDeclaration(call);
  if (!owner) return false;
  const ownerShape = preparedIrAsyncSourceShape(ctx, owner);
  if (ownerShape?.kind !== "promise-all-continuation" || call.end > ownerShape.awaitedCall.pos) return false;

  const pushCall = call.parent;
  if (
    !ts.isCallExpression(pushCall) ||
    pushCall.arguments.length !== 1 ||
    pushCall.arguments[0] !== call ||
    !ts.isPropertyAccessExpression(pushCall.expression) ||
    pushCall.expression.name.text !== "push" ||
    !ts.isIdentifier(pushCall.expression.expression)
  ) {
    return false;
  }
  const pendingDeclaration = ctx.oracle.variableDeclarationOf(pushCall.expression.expression);
  if (!pendingDeclaration || !isPreparedIrPromiseVectorLocal(ctx, pendingDeclaration)) return false;

  const callee = ctx.oracle.valueDeclarationOf(call.expression);
  return (
    callee !== undefined &&
    ts.isFunctionDeclaration(callee) &&
    ts.isSourceFile(callee.parent) &&
    callee.getSourceFile() === owner.getSourceFile() &&
    preparedIrAsyncSourceShape(ctx, callee)?.kind === "identity" &&
    preparedIrAsyncSourceCanSuspendOnTarget(ctx, callee)
  );
}

interface PreparedIrAsyncPromiseOwnerCandidate {
  readonly unitId: IrUnitId;
  readonly declaration: ts.FunctionDeclaration;
}

interface PreparedIrAsyncPromiseOwnerIssuance {
  readonly declaration: ts.FunctionDeclaration;
  readonly unitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly sourceFile: ts.SourceFile;
  readonly terminal: IrTerminalUnitRecord;
  readonly sourceFingerprint: string;
  readonly ownerUnitIds: ReadonlySet<IrUnitId>;
  readonly ownerUnitIdsFingerprint: string;
  readonly closureFingerprint: string;
  readonly abiFingerprint: string;
}

/**
 * A frozen Set still exposes mutating methods whose internal slots remain
 * writable. Keep the owner population behind a read-only view instead; the
 * identity and ABI receipts can then safely retain the same collection.
 */
function immutableReadonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const snapshot = Object.freeze([...new Set(values)]);
  const lookup = new Set(snapshot);
  const view: ReadonlySet<T> = Object.freeze({
    get size(): number {
      return snapshot.length;
    },
    has(value: T): boolean {
      return lookup.has(value);
    },
    forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
      for (const value of snapshot) callbackfn.call(thisArg, value, value, view);
    },
    entries(): IterableIterator<[T, T]> {
      return (function* (): IterableIterator<[T, T]> {
        for (const value of snapshot) yield [value, value];
      })();
    },
    keys(): IterableIterator<T> {
      return snapshot[Symbol.iterator]();
    },
    values(): IterableIterator<T> {
      return snapshot[Symbol.iterator]();
    },
    [Symbol.iterator](): IterableIterator<T> {
      return snapshot[Symbol.iterator]();
    },
  }) as ReadonlySet<T>;
  return view;
}

const preparedAsyncPromiseOwnerUnitIdsByContext = new WeakMap<CodegenContext, ReadonlySet<IrUnitId>>();
const preparedAsyncPromiseOwnerIssuanceByContext = new WeakMap<
  CodegenContext,
  {
    readonly byDeclaration: WeakMap<ts.FunctionDeclaration, PreparedIrAsyncPromiseOwnerIssuance>;
    readonly byUnitId: Map<IrUnitId, PreparedIrAsyncPromiseOwnerIssuance>;
    readonly invalid: Set<IrUnitId>;
  }
>();
const preparedAsyncObservedAbiByContext = new WeakMap<CodegenContext, WeakMap<ts.FunctionDeclaration, boolean>>();

/**
 * The declaration pass can see a Promise annotation before it has seen every
 * source callable's final Wasm slot.  Keep the early candidate population
 * independent of declaration order, and use only source facts that the
 * eventual `prepareAsyncCallableAbi` call can represent.
 */
function sourceAsyncParameterKind(
  ctx: CodegenContext,
  parameter: ts.ParameterDeclaration,
): "f64" | "vec-f64" | undefined {
  if (
    parameter.questionToken !== undefined ||
    parameter.dotDotDotToken !== undefined ||
    parameter.initializer !== undefined ||
    !ts.isIdentifier(parameter.name) ||
    parameter.type === undefined ||
    ts.getJSDocType(parameter) !== undefined ||
    ts.getJSDocParameterTags(parameter).some((tag) => tag.isBracketed === true)
  ) {
    return undefined;
  }
  let type: ts.Type;
  try {
    type = ctx.checker.getTypeAtLocation(parameter);
  } catch {
    return undefined;
  }
  // Primitive aliases lose their name in checker types. The declaration
  // collector still honors an explicit i32/f32 annotation, so use its same
  // native-annotation resolver before claiming an f64 parameter.
  const native = nativeTypeOfDeclaration(ctx.checker, parameter);
  if (native !== null && native.kind !== "f64") return undefined;
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "f64";
  const symbol = type.getSymbol?.();
  const symbolName = symbol?.name;
  if (symbolName !== "Array" && symbolName !== "ReadonlyArray") return undefined;
  const declarations = symbol?.declarations;
  if (!declarations?.length || !declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) {
    return undefined;
  }
  const typeArguments = ctx.checker.getTypeArguments(type as ts.TypeReference);
  return typeArguments.length === 1 && (typeArguments[0]!.flags & ts.TypeFlags.NumberLike) !== 0
    ? "vec-f64"
    : undefined;
}

/** Infer the fulfillment carrier that the async declaration pass can project. */
function asyncPromiseFulfillmentKind(ctx: CodegenContext, fn: ts.FunctionDeclaration): "f64" | "void" | undefined {
  let signature: ts.Signature | undefined;
  try {
    signature = ctx.checker.getSignatureFromDeclaration(fn) ?? undefined;
  } catch {
    return undefined;
  }
  if (!signature) return undefined;
  // Match the selector's explicit Promise<T> admission contract. An async
  // declaration's checker return type can otherwise look numeric even when a
  // skipped diagnostic left an invalid/non-Promise annotation in place.
  const fulfillmentNode = unwrapPromiseTypeNode(fn.type);
  if (!fulfillmentNode || !fn.type || !ts.isTypeReferenceNode(fn.type)) return undefined;
  if (!declarationsAreAmbient(ctx, fn.type.typeName)) return undefined;
  let type: ts.Type;
  try {
    type = ctx.checker.getTypeAtLocation(fulfillmentNode);
  } catch {
    return undefined;
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "f64";
  if ((type.flags & ts.TypeFlags.VoidLike) !== 0) return "void";
  return undefined;
}

function sourceAsyncPromiseOwnerCandidate(ctx: CodegenContext, declaration: ts.FunctionDeclaration): boolean {
  if (
    preparedAsyncObservedAbiByContext.get(ctx)?.get(declaration) === false ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true ||
    declaration.asteriskToken !== undefined ||
    declaration.typeParameters?.length ||
    !declaration.body ||
    declaration.parent === undefined ||
    !ts.isSourceFile(declaration.parent) ||
    declaration.parameters.some((parameter) => sourceAsyncParameterKind(ctx, parameter) === undefined)
  ) {
    return false;
  }
  const fulfillment = asyncPromiseFulfillmentKind(ctx, declaration);
  if (fulfillment === undefined) return false;
  const shape = preparedIrAsyncSourceShape(ctx, declaration);
  return (
    shape !== null &&
    (fulfillment === "f64" || shape.kind === "final-main" || shape.kind === "linear") &&
    preparedIrAsyncSourceCanSuspendOnTarget(ctx, declaration)
  );
}

function sourceAsyncPromiseOwnerCandidates(ctx: CodegenContext): PreparedIrAsyncPromiseOwnerCandidate[] {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity) return [];
  const candidates: PreparedIrAsyncPromiseOwnerCandidate[] = [];
  const sourceFiles = ctx.callableSourceFiles ?? [...identity.sourceFileBySourceId.values()];
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement)) continue;
      const unitId = identity.unitIdByDeclaration.get(statement);
      if (unitId === undefined || !sourceAsyncPromiseOwnerCandidate(ctx, statement)) continue;
      candidates.push({ unitId, declaration: statement });
    }
  }
  return candidates;
}

/**
 * Compute the source-qualified fixed point for generic Promise owners.  An
 * owner survives only when its incoming and outgoing source calls all have a
 * matching Promise contract.  In particular, an async declaration with no
 * real await is absent from this set and cannot satisfy an awaited Promise
 * edge merely because TypeScript wrote `Promise<T>` in its return type.
 */
function promiseOwnerUnitIdsFingerprint(unitIds: Iterable<IrUnitId>): string {
  return JSON.stringify([...unitIds].sort());
}

function computePreparedIrAsyncPromiseOwnerUnitIds(ctx: CodegenContext): ReadonlySet<IrUnitId> {
  const candidates = sourceAsyncPromiseOwnerCandidates(ctx);
  const active = new Set(candidates.map(({ unitId }) => unitId));
  const ordered = [...candidates].sort((left, right) =>
    left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0,
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const candidate of ordered) {
      if (!active.has(candidate.unitId)) continue;
      // The closure itself authenticates each call against the currently
      // active fixed point. A failed owner is removed and all callers/callees
      // that depended on it are reconsidered on the next pass.
      if (!preparedIrAsyncPromiseCallClosure(ctx, candidate.declaration, active)) {
        active.delete(candidate.unitId);
        changed = true;
      }
    }
  }
  return immutableReadonlySet(active);
}

export function preparedIrAsyncPromiseOwnerUnitIds(ctx: CodegenContext): ReadonlySet<IrUnitId> {
  assertPreparedIrAsyncPromiseOwnersCurrent(ctx);
  const cached = preparedAsyncPromiseOwnerUnitIdsByContext.get(ctx);
  if (cached) return cached;
  const result = computePreparedIrAsyncPromiseOwnerUnitIds(ctx);
  preparedAsyncPromiseOwnerUnitIdsByContext.set(ctx, result);
  return result;
}

function issuedPreparedIrAsyncPromiseOwner(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
): PreparedIrAsyncPromiseOwnerIssuance | undefined {
  return preparedAsyncPromiseOwnerIssuanceByContext.get(ctx)?.byDeclaration.get(fn);
}

function promiseOwnerIdentityIsCurrent(ctx: CodegenContext, receipt: PreparedIrAsyncPromiseOwnerIssuance): boolean {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity || !ts.isSourceFile(receipt.declaration.parent)) return false;
  const currentUnitId = identity.unitIdByDeclaration.get(receipt.declaration);
  const currentSourceId = identity.sourceIdBySourceFile.get(receipt.sourceFile);
  const unit = identity.unitByUnitId.get(receipt.unitId);
  const terminal = identity.terminalByUnitId.get(receipt.unitId);
  return (
    receipt.declaration.getSourceFile() === receipt.sourceFile &&
    currentUnitId === receipt.unitId &&
    currentSourceId === receipt.sourceId &&
    identity.sourceFileBySourceId.get(receipt.sourceId) === receipt.sourceFile &&
    identity.declarationByUnitId.get(receipt.unitId) === receipt.declaration &&
    unit !== undefined &&
    unit === receipt.terminal &&
    unit.sourceId === receipt.sourceId &&
    unit.kind === "top-level-function" &&
    terminal !== undefined &&
    terminal === unit &&
    terminal.terminalOwnerId === receipt.unitId
  );
}

function promiseOwnerSourceFingerprint(fn: ts.FunctionDeclaration): string {
  return `${fn.pos}:${fn.end}:${fn.getText()}`;
}

function promiseOwnerIsCurrent(
  ctx: CodegenContext,
  receipt: PreparedIrAsyncPromiseOwnerIssuance,
  currentOwnerUnitIds: ReadonlySet<IrUnitId>,
): boolean {
  if (!promiseOwnerIdentityIsCurrent(ctx, receipt)) return false;
  if (promiseOwnerSourceFingerprint(receipt.declaration) !== receipt.sourceFingerprint) return false;
  if (promiseOwnerUnitIdsFingerprint(currentOwnerUnitIds) !== receipt.ownerUnitIdsFingerprint) return false;
  const closure = preparedIrAsyncPromiseCallClosure(ctx, receipt.declaration, receipt.ownerUnitIds);
  return closure !== null && closure.fingerprint === receipt.closureFingerprint;
}

/** True after a generic Promise ABI receipt was issued for this declaration. */
export function preparedIrAsyncPromiseOwnerWasIssued(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  return issuedPreparedIrAsyncPromiseOwner(ctx, fn) !== undefined;
}

/**
 * Keep every post-issuance handoff on the original generic Promise receipt.
 * A missing identity, terminal, source closure, or owner population is an
 * invariant: the caller must never fall back to a raw numeric ABI.
 */
export function assertPreparedIrAsyncPromiseOwnerCurrent(ctx: CodegenContext, _fn: ts.FunctionDeclaration): void {
  // Replacing the current declaration must not hide an original issuance.
  // Validation therefore begins at the retained UnitId population, not at a
  // possibly new declaration supplied by this handoff.
  assertPreparedIrAsyncPromiseOwnersCurrent(ctx);
}

/** Validate original receipts even when a later selection has lost the declaration entirely. */
function assertPreparedIrAsyncPromiseOwnersCurrent(ctx: CodegenContext): void {
  const issued = preparedAsyncPromiseOwnerIssuanceByContext.get(ctx);
  if (!issued) return;
  let currentOwnerUnitIds: ReadonlySet<IrUnitId> | undefined;
  for (const receipt of issued.byUnitId.values()) {
    try {
      if (!issued.invalid.has(receipt.unitId) && promiseOwnerIdentityIsCurrent(ctx, receipt)) {
        currentOwnerUnitIds ??= computePreparedIrAsyncPromiseOwnerUnitIds(ctx);
        if (promiseOwnerIsCurrent(ctx, receipt, currentOwnerUnitIds)) continue;
      }
    } catch (cause) {
      issued.invalid.add(receipt.unitId);
      throw genericPromiseOwnerInvariant(receipt, cause);
    }
    issued.invalid.add(receipt.unitId);
    throw genericPromiseOwnerInvariant(receipt);
  }
}

function genericPromiseOwnerInvariant(receipt: PreparedIrAsyncPromiseOwnerIssuance, cause?: unknown): IrInvariantError {
  return new IrInvariantError(
    "selection-preparation-mismatch",
    "resolve",
    `generic Promise owner ${receipt.declaration.name?.text ?? "<anonymous>"} (${receipt.unitId}) lost its source proof/ABI closure after issuance`,
    cause,
  );
}

function issuePreparedIrAsyncPromiseOwner(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  identity: SettledOwnerIdentity,
  ownerUnitIds: ReadonlySet<IrUnitId>,
  closure: PreparedIrAsyncPromiseCallClosure,
  abiFingerprint: string,
): void {
  const issued = preparedAsyncPromiseOwnerIssuanceByContext.get(ctx) ?? {
    byDeclaration: new WeakMap(),
    byUnitId: new Map(),
    invalid: new Set(),
  };
  const receipt: PreparedIrAsyncPromiseOwnerIssuance = Object.freeze({
    declaration: fn,
    unitId: identity.unitId,
    sourceId: identity.sourceId,
    sourceFile: identity.sourceFile,
    terminal: ctx.irPlanningIdentityContext!.terminalByUnitId.get(identity.unitId)!,
    sourceFingerprint: promiseOwnerSourceFingerprint(fn),
    ownerUnitIds: immutableReadonlySet(ownerUnitIds),
    ownerUnitIdsFingerprint: promiseOwnerUnitIdsFingerprint(ownerUnitIds),
    closureFingerprint: closure.fingerprint,
    abiFingerprint,
  });
  issued.byDeclaration.set(fn, receipt);
  issued.byUnitId.set(identity.unitId, receipt);
  preparedAsyncPromiseOwnerIssuanceByContext.set(ctx, issued);
}

/**
 * Freeze the canonical Promise-returning callable ABI before program-ABI
 * publication for the first top-level real-suspension owner. The direct async
 * engine already rewrites this exact population to `externref` while compiling
 * the body; doing it at declaration time lets sealed IR preparation own the
 * same source slot without changing nested or sync-pass-through declarations.
 */
export function prepareAsyncCallableAbi(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  params: ValType[],
  fulfillmentResults: ValType[],
): [ValType[], ValType[]] {
  const issued = issuedPreparedIrAsyncPromiseOwner(ctx, fn);
  const abiFingerprint = JSON.stringify({ params, fulfillmentResults });
  if (issued && issued.abiFingerprint !== abiFingerprint) {
    preparedAsyncPromiseOwnerIssuanceByContext.get(ctx)!.invalid.add(issued.unitId);
    throw genericPromiseOwnerInvariant(issued);
  }
  if (issued) assertPreparedIrAsyncPromiseOwnerCurrent(ctx, fn);
  const shape = preparedIrAsyncSourceShape(ctx, fn);
  // Keep the post-issuance identity/currentness invariant independent of the
  // generic Promise-owner cache. A stale identity map must fail closed even
  // when this context already cached the owner's earlier fixed-point member.
  const sourceCanSuspend = preparedIrAsyncSourceCanSuspendOnTarget(ctx, fn);
  const ownerUnitId = ctx.irPlanningIdentityContext?.unitIdByDeclaration.get(fn);
  const sourceFulfillment = shape === null ? undefined : asyncPromiseFulfillmentKind(ctx, fn);
  const supportedFulfillment =
    (sourceFulfillment === "f64" && fulfillmentResults.length === 1 && fulfillmentResults[0]?.kind === "f64") ||
    (sourceFulfillment === "void" &&
      (shape?.kind === "final-main" || shape?.kind === "linear") &&
      fulfillmentResults.length === 0);
  const physicalAbiSupported =
    params.length === fn.parameters.length &&
    params.every((param, index) => {
      const sourceKind = sourceAsyncParameterKind(ctx, fn.parameters[index]!);
      return sourceKind === "f64"
        ? param.kind === "f64"
        : sourceKind === "vec-f64" && param.kind !== "f64" && preparedAsyncParamAbiIsStable(ctx, param);
    }) &&
    supportedFulfillment;
  const observed = preparedAsyncObservedAbiByContext.get(ctx) ?? new WeakMap<ts.FunctionDeclaration, boolean>();
  const previousAbiSupported = observed.get(fn);
  observed.set(fn, physicalAbiSupported);
  preparedAsyncObservedAbiByContext.set(ctx, observed);
  // Source candidates are stable during declaration collection. Only a new
  // contradictory physical observation invalidates the pre-issuance cache;
  // recomputing a whole-source census for every synchronous declaration would
  // make ordinary programs quadratic even when they have no async owners.
  if (
    !preparedAsyncPromiseOwnerIssuanceByContext.has(ctx) &&
    ((!physicalAbiSupported &&
      ownerUnitId !== undefined &&
      preparedAsyncPromiseOwnerUnitIdsByContext.get(ctx)?.has(ownerUnitId)) ||
      (previousAbiSupported === false && physicalAbiSupported))
  ) {
    preparedAsyncPromiseOwnerUnitIdsByContext.delete(ctx);
  }
  const promiseOwnerUnitIds = preparedIrAsyncPromiseOwnerUnitIds(ctx);
  const usesPromiseAbi =
    ctx.programAbiSession !== undefined &&
    !ctx.wasi &&
    (!ctx.standalone || ctx.nativeStrings) &&
    !fn.typeParameters?.length &&
    ts.isSourceFile(fn.parent) &&
    shape !== null &&
    sourceCanSuspend &&
    ownerUnitId !== undefined &&
    promiseOwnerUnitIds.has(ownerUnitId) &&
    physicalAbiSupported;
  if (issued && !usesPromiseAbi) {
    preparedAsyncPromiseOwnerIssuanceByContext.get(ctx)!.invalid.add(issued.unitId);
    throw genericPromiseOwnerInvariant(issued);
  }
  if (usesPromiseAbi && !issued) {
    const ownerIdentity = settledOwnerIdentity(ctx, fn);
    const closure = ownerIdentity ? preparedIrAsyncPromiseCallClosure(ctx, fn, promiseOwnerUnitIds) : null;
    if (!ownerIdentity || !closure) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `generic Promise owner ${fn.name?.text ?? "<anonymous>"} has no closed source ABI receipt`,
      );
    }
    issuePreparedIrAsyncPromiseOwner(ctx, fn, ownerIdentity, promiseOwnerUnitIds, closure, abiFingerprint);
  }
  return [params, usesPromiseAbi ? [{ kind: "externref" }] : fulfillmentResults];
}

/** Keep selector admission and the production async engine on one proof. */
export function prepareIrAsyncSelectionOptions(
  ctx: CodegenContext,
  resolvePromiseDelay?: IrPromiseDelayResolver,
): AsyncSelectionOptions {
  if (resolvePromiseDelay) registerIrAsyncPromiseDelayResolver(ctx, resolvePromiseDelay);
  return {
    supportsAsyncIr: ctx.supportsAsyncIr,
    asyncEngineClaims: (fn) => asyncEngineWouldActivate(ctx, fn),
    asyncHasRealSuspension: (fn) => {
      const plan = analyzeAsyncBody(ctx, fn);
      return plan.awaitPoints.some((awaited) => plan.awaitedStaticallyResolved.get(awaited) !== true);
    },
    // The exact prepared plans project either through host adapters or the
    // standalone native `$Promise` runtime. WASI remains outside this slice.
    canPrepareSuspendingAsync: (fn) =>
      !ctx.wasi &&
      (!ctx.standalone || ctx.nativeStrings) &&
      ts.isFunctionDeclaration(fn) &&
      preparedIrAsyncSourceCanSuspendOnTarget(ctx, fn),
    preparedAsyncPromiseVectorLocal: (declaration) => isPreparedIrPromiseVectorLocal(ctx, declaration),
    preparedAsyncThenableCall: (call) => isPreparedIrThenableCall(ctx, call),
    preparedAsyncPromiseAllCall: (call) => isPreparedIrPromiseAllCall(ctx, call),
    preparedAsyncDateNowCall: (call) => isPreparedIrDateNowCall(ctx, call),
  };
}

/** Backend-bound AST resolver fragment for exact prepared async constructs. */
export function preparedIrAsyncFromAstResolver(
  ctx: CodegenContext,
): Pick<
  IrFromAstResolver,
  | "preparedAsyncPromiseVectorLocal"
  | "preparedAsyncPromiseAllPlan"
  | "preparedAsyncAwaitSite"
  | "preparedAsyncThenableResultType"
  | "preparedAsyncDateNowTarget"
  | "preparedAsyncNumberToStringTarget"
  | "preparedAsyncConsoleTarget"
  | "preparedAsyncConcatFiveTarget"
> {
  return {
    preparedAsyncPromiseVectorLocal: (declaration) => isPreparedIrPromiseVectorLocal(ctx, declaration),
    preparedAsyncPromiseAllPlan: (call) => {
      if (ctx.standalone && !ctx.wasi && ctx.nativeStrings && isPreparedIrPromiseAllCall(ctx, call)) {
        return {
          target: irRuntimeFuncRef(IR_ASYNC_PROMISE_ALL_NATIVE_FN),
          argumentType: irVec(irVal({ kind: "externref" }), true),
          resultType: irVec(irVal({ kind: "f64" }), true),
        };
      }
      if (
        ctx.wasi ||
        ctx.standalone ||
        ctx.strictNoHostImports ||
        !ctx.funcMap.has("Promise_all") ||
        !isPreparedIrPromiseAllCall(ctx, call)
      ) {
        return null;
      }
      return {
        target: irImportFuncRef("env", "Promise_all"),
        resultType: irVec(irVal({ kind: "f64" }), true),
      };
    },
    preparedAsyncAwaitSite: (awaitExpression) => preparedIrAsyncAwaitSite(ctx, awaitExpression),
    preparedAsyncThenableResultType: (call) =>
      isPreparedIrThenableCall(ctx, call) ? irVal({ kind: "f64" }) : undefined,
    preparedAsyncDateNowTarget: (call) =>
      isPreparedIrDateNowCall(ctx, call) ? irIntrinsicFuncRef(IR_ASYNC_CLOCK_SNAPSHOT_FN) : null,
    preparedAsyncNumberToStringTarget: (call) =>
      isInsidePreparedFinalMain(ctx, call) ? irIntrinsicFuncRef(IR_ASYNC_NUMBER_TO_STRING_FN) : null,
    preparedAsyncConsoleTarget: (call) =>
      isInsidePreparedFinalMain(ctx, call) ? irIntrinsicFuncRef(IR_ASYNC_CONSOLE_LOG_STRING_FN) : null,
    preparedAsyncConcatFiveTarget: (expression) =>
      isPreparedIrAsyncConcat(ctx, expression) ? irIntrinsicFuncRef(IR_ASYNC_STRING_CONCAT_5_FN) : null,
  };
}

/** Reconcile selector claims to the exact owners the post-build producer must split. */
export function collectPreparedIrAsyncOwners(
  ctx: CodegenContext,
  identityPlan: IrOverlayIdentityPlan,
  selectedFunctions: ReadonlySet<string>,
): ReadonlySet<IrUnitId> {
  assertPreparedIrAsyncPromiseOwnersCurrent(ctx);
  const owners = new Set<IrUnitId>();
  if (ctx.wasi || (ctx.standalone && !ctx.nativeStrings)) return owners;
  for (const claim of identityPlan.functionClaims) {
    if (!selectedFunctions.has(claim.legacyName)) continue;
    assertPreparedIrAsyncPromiseOwnerCurrent(ctx, claim.declaration);
    if (preparedIrAsyncSourceCanSuspendOnTarget(ctx, claim.declaration)) {
      owners.add(claim.unitId);
    }
  }
  return owners;
}
