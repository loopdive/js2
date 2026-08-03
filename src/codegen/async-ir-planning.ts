// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isSingleAwaitReturnAsyncCandidate } from "../ir/async-prepare.js";
import { irImportFuncRef } from "../ir/callable-bindings.js";
import type { IrFromAstResolver } from "../ir/from-ast.js";
import { irVal, irVec } from "../ir/nodes.js";
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
>;

export interface PreparedIrAsyncSourceShape {
  readonly kind: "identity" | "promise-all-continuation";
  readonly awaitedCall: ts.CallExpression;
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
  return shape !== null && (shape.kind === "promise-all-continuation" || asyncEngineWouldActivate(ctx, fn));
}

/** Exact awaited Promise.all node owned by the certified continuation shape. */
export function isPreparedIrPromiseAllCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const owner = enclosingFunctionDeclaration(call);
  if (!owner) return false;
  const shape = preparedIrAsyncSourceShape(ctx, owner);
  return shape?.kind === "promise-all-continuation" && shape.awaitedCall === call;
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
    preparedIrAsyncSourceCanSuspend(ctx, callee)
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
  const usesPromiseAbi =
    ctx.programAbiSession !== undefined &&
    !ctx.wasi &&
    !ctx.standalone &&
    !fn.typeParameters?.length &&
    ts.isSourceFile(fn.parent) &&
    preparedIrAsyncSourceCanSuspend(ctx, fn) &&
    params.every((param) => preparedAsyncParamAbiIsStable(ctx, param)) &&
    fulfillmentResults.length === 1 &&
    fulfillmentResults[0]?.kind === "f64";
  return [params, usesPromiseAbi ? [{ kind: "externref" }] : fulfillmentResults];
}

/** Keep selector admission and the production async engine on one proof. */
export function prepareIrAsyncSelectionOptions(ctx: CodegenContext): AsyncSelectionOptions {
  return {
    supportsAsyncIr: ctx.supportsAsyncIr,
    asyncEngineClaims: (fn) => asyncEngineWouldActivate(ctx, fn),
    asyncHasRealSuspension: (fn) => {
      const plan = analyzeAsyncBody(ctx, fn);
      return plan.awaitPoints.some((awaited) => plan.awaitedStaticallyResolved.get(awaited) !== true);
    },
    // #4106: first genuinely-suspending IR producer. Host/WasmGC only — the
    // prepared runtime-provider catalogue has no standalone/WASI projection.
    canPrepareSuspendingAsync: (fn) =>
      !ctx.wasi && !ctx.standalone && ts.isFunctionDeclaration(fn) && preparedIrAsyncSourceCanSuspend(ctx, fn),
    preparedAsyncPromiseVectorLocal: (declaration) => isPreparedIrPromiseVectorLocal(ctx, declaration),
    preparedAsyncThenableCall: (call) => isPreparedAsyncThenableCall(ctx, call),
    preparedAsyncPromiseAllCall: (call) => isPreparedIrPromiseAllCall(ctx, call),
  };
}

/** Backend-bound AST resolver fragment for exact prepared async constructs. */
export function preparedIrAsyncFromAstResolver(
  ctx: CodegenContext,
): Pick<IrFromAstResolver, "preparedAsyncPromiseVectorLocal" | "preparedAsyncPromiseAllPlan"> {
  return {
    preparedAsyncPromiseVectorLocal: (declaration) => isPreparedIrPromiseVectorLocal(ctx, declaration),
    preparedAsyncPromiseAllPlan: (call) => {
      if (
        ctx.standalone ||
        ctx.wasi ||
        ctx.strictNoHostImports ||
        !ctx.funcMap.has("Promise_all") ||
        !isPreparedIrPromiseAllCall(ctx, call)
      ) {
        return null;
      }
      return { target: irImportFuncRef("env", "Promise_all"), resultType: irVec(irVal({ kind: "f64" }), true) };
    },
  };
}

/** Reconcile selector claims to the exact owners the post-build producer must split. */
export function collectPreparedIrAsyncOwners(
  ctx: CodegenContext,
  identityPlan: IrOverlayIdentityPlan,
  selectedFunctions: ReadonlySet<string>,
): ReadonlySet<IrUnitId> {
  const owners = new Set<IrUnitId>();
  if (ctx.wasi || ctx.standalone) return owners;
  for (const claim of identityPlan.functionClaims) {
    if (selectedFunctions.has(claim.legacyName) && preparedIrAsyncSourceCanSuspend(ctx, claim.declaration)) {
      owners.add(claim.unitId);
    }
  }
  return owners;
}
