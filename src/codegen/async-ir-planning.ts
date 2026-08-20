// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isSingleAwaitReturnAsyncCandidate } from "../ir/async-prepare.js";
import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef } from "../ir/callable-bindings.js";
import {
  IR_ASYNC_CLOCK_SNAPSHOT_FN,
  IR_ASYNC_CONSOLE_LOG_STRING_FN,
  IR_ASYNC_NUMBER_TO_STRING_FN,
  IR_ASYNC_PROMISE_ALL_NATIVE_FN,
  IR_ASYNC_STRING_CONCAT_5_FN,
} from "../ir/async-semantic-runtime.js";
import type { IrFromAstResolver } from "../ir/from-ast.js";
import { irVal, irVec } from "../ir/nodes.js";
import type { IrPromiseDelayResolver } from "../ir/promise-delay.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrSelectionOptions } from "../ir/select.js";
import { asyncEngineWouldActivate } from "./async-activation.js";
import { analyzeAsyncBody, splitBodyAtAwait } from "./async-cps.js";
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
    };

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
  if (!split || !ts.isCallExpression(split.awaitedExpr)) return null;
  if (isSingleAwaitReturnAsyncCandidate(fn)) {
    return { kind: "identity", awaitedCall: split.awaitedExpr };
  }
  if (
    split.isReturnAwait ||
    !split.resumeBinding ||
    split.suffix.length === 0 ||
    !isAmbientPromiseAll(ctx, split.awaitedExpr) ||
    !continuationHasNoPreAwaitCapture(ctx, fn, split.prefix, split.suffix)
  ) {
    return null;
  }
  return { kind: "promise-all-continuation", awaitedCall: split.awaitedExpr };
}

export function preparedIrAsyncSourceCanSuspend(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  const shape = preparedIrAsyncSourceShape(ctx, fn);
  return (
    shape !== null &&
    (shape.kind === "promise-all-continuation" ||
      shape.kind === "sequential-counted-loop" ||
      shape.kind === "final-main" ||
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
  return (
    preparedIrAsyncSourceCanSuspend(ctx, fn) && (!ctx.standalone || isExactStandaloneNativeAsyncFamilyOwner(ctx, fn))
  );
}

/** Exact awaited Promise.all node owned by the certified continuation shape. */
export function isPreparedIrPromiseAllCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const owner = enclosingFunctionDeclaration(call);
  if (!owner) return false;
  const shape = preparedIrAsyncSourceShape(ctx, owner);
  return shape?.kind === "promise-all-continuation" && shape.awaitedCall === call;
}

/** Exact direct async call whose Promise result is owned by a prepared state. */
export function isPreparedIrThenableCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const owner = enclosingFunctionDeclaration(call);
  if (!owner) return false;
  const shape = preparedIrAsyncSourceShape(ctx, owner);
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
  const shape = preparedIrAsyncSourceShape(ctx, fn);
  const supportedFulfillment =
    (fulfillmentResults.length === 1 && fulfillmentResults[0]?.kind === "f64") ||
    (shape?.kind === "final-main" && fulfillmentResults.length === 0);
  const usesPromiseAbi =
    ctx.programAbiSession !== undefined &&
    !ctx.wasi &&
    (!ctx.standalone || ctx.nativeStrings) &&
    !fn.typeParameters?.length &&
    ts.isSourceFile(fn.parent) &&
    shape !== null &&
    preparedIrAsyncSourceCanSuspendOnTarget(ctx, fn) &&
    params.every((param) => preparedAsyncParamAbiIsStable(ctx, param)) &&
    supportedFulfillment;
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
      return { target: irImportFuncRef("env", "Promise_all"), resultType: irVec(irVal({ kind: "f64" }), true) };
    },
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
  const owners = new Set<IrUnitId>();
  if (ctx.wasi || (ctx.standalone && !ctx.nativeStrings)) return owners;
  for (const claim of identityPlan.functionClaims) {
    if (selectedFunctions.has(claim.legacyName) && preparedIrAsyncSourceCanSuspendOnTarget(ctx, claim.declaration)) {
      owners.add(claim.unitId);
    }
  }
  return owners;
}
