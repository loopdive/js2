// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Front-end proof for the first AST-free multi-await producer.
 *
 * The ordinary source shape returns only exact await sites and their source
 * expressions.  The B3 settled-owner receipt adds checker-derived facts while
 * `IrAsyncPlan` is still built later from lowered IR and never carries a
 * checker object or codegen callback.
 */

import type { CodegenContext } from "./context/types.js";
import { analyzeAsyncBody, planLinearAwaits } from "./async-cps.js";
import type { TypeFact } from "../checker/oracle.js";
import {
  makeIrIdentityImportedFunctionResolver,
  type IrIdentityImportedFunctionResolver,
} from "../ir/imported-functions.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import { ts } from "../ts-api.js";

export interface PreparedIrAsyncLinearSource {
  readonly kind: "linear";
  readonly awaitSites: readonly ts.AwaitExpression[];
  readonly awaitedExpressions: readonly ts.Expression[];
}

/**
 * Complete source receipt for the B3 settled-owner cutover.
 *
 * The ordinary linear source shape is deliberately kept separate from this
 * receipt: a linear body may still await a Promise and therefore belong to
 * B2.  B3 needs every operand to be proved numeric/non-thenable before the
 * declaration ABI is changed.  Keeping the exact declaration, source file,
 * operand facts and delivery facts together gives each later handoff one
 * source-owned record to re-check instead of asking the static-await helper
 * to stand in for semantic evidence.
 */
export interface PreparedIrAsyncSettledOwner {
  readonly kind: "settled-nonthenable";
  /** Structural owner from the one authoritative planning inventory. */
  readonly unitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly awaitSites: readonly ts.AwaitExpression[];
  readonly awaitedExpressions: readonly ts.Expression[];
  readonly declaration: ts.FunctionDeclaration;
  readonly sourceFile: ts.SourceFile;
  readonly sourceIdentity: string;
  /** Source syntax receipt used to reject stale ASTs after issuance. */
  readonly sourceFingerprint: string;
  readonly declarationName: string;
  readonly awaitOperandFacts: readonly TypeFact[];
  readonly awaitDeliveryFacts: readonly TypeFact[];
  readonly fulfillmentType: ts.TypeNode | undefined;
  /** Incoming source callers joined by their exact structural UnitId. */
  readonly incomingCallerUnitIds: readonly IrUnitId[];
  readonly incomingCallContracts: readonly PreparedIrAsyncCallContract[];
  /** Outgoing source-unit calls retained by this owner proof. */
  readonly outgoingCalleeUnitIds: readonly IrUnitId[];
  readonly callerClosureFingerprint: string;
}

export interface PreparedIrAsyncCallContract {
  readonly callerUnitId: IrUnitId;
  readonly targetUnitId: IrUnitId;
  readonly callPosition: number;
  readonly kind: "awaited-fulfillment" | "promise-carrier";
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

/**
 * Keep this proof deliberately structural.  A flat IR block is required by
 * the producer, so accepting a source branch or loop here would make source
 * ownership disagree with the post-lowering producer.
 */
function containsUnsupportedControl(body: ts.Block): boolean {
  let unsupported = false;
  const visit = (node: ts.Node): void => {
    if (unsupported) return;
    // A nested executable owns a separate activation and can hide an await or
    // capture a value that the flat producer cannot represent.  Refuse the
    // outer owner as soon as one is encountered instead of skipping its body
    // and accidentally certifying only the visible top-level statements.
    if (isNestedExecutable(node)) {
      unsupported = true;
      return;
    }
    if (
      ts.isIfStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isWithStatement(node) ||
      ts.isLabeledStatement(node) ||
      ts.isThrowStatement(node)
    ) {
      unsupported = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of body.statements) visit(statement);
  return unsupported;
}

function hasNonFinalReturn(body: ts.Block): boolean {
  for (let index = 0; index < body.statements.length; index++) {
    const statement = body.statements[index]!;
    if (!ts.isReturnStatement(statement)) continue;
    if (index !== body.statements.length - 1) return true;
  }
  return false;
}

/**
 * Prove one top-level straight-line async declaration for B2.
 *
 * `planLinearAwaits` remains the shared source-shape preflight, while this
 * wrapper removes its broader try/finally and control-flow population.  The
 * exact sites are retained in source order so AST lowering can preserve every
 * suspension, including statically settled operands.
 */
export function preparedIrAsyncLinearSource(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
): PreparedIrAsyncLinearSource | null {
  if (
    !ts.isFunctionDeclaration(fn) ||
    fn.asteriskToken ||
    !fn.body ||
    !ts.isBlock(fn.body) ||
    fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true
  ) {
    return null;
  }
  if (containsUnsupportedControl(fn.body) || hasNonFinalReturn(fn.body)) return null;

  const cps = analyzeAsyncBody(ctx, fn);
  if (cps.awaitPoints.length === 0) return null;
  const linear = planLinearAwaits(fn, cps, { checker: ctx.checker });
  if (!linear || linear.finalizer !== null || linear.tailInTry.some(Boolean)) return null;
  if (linear.segments.some((segment) => segment.awaitInTry || segment.leadInTry.some(Boolean))) return null;
  if (linear.segments.length !== cps.awaitPoints.length) return null;

  // The shared analyzer reports awaits pre-order.  The flat source proof has
  // no nested executable/control region, so segment order must be identical;
  // retain that identity as an invariant rather than silently reordering it.
  const awaitSites = cps.awaitPoints.slice();
  const awaitedExpressions = linear.segments.map((segment) => segment.awaitedExpr);
  if (awaitedExpressions.length !== awaitSites.length) return null;
  return { kind: "linear", awaitSites, awaitedExpressions };
}

function isTypeAssertionExpression(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion | ts.SatisfiesExpression {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node);
}

/** Strip only wrappers whose runtime value is unchanged. */
function unwrapSettledOperand(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Require a checker/oracle fact that cannot carry a `then` property.
 *
 * The oracle's exact `number` fact is the ABI proof used by the existing
 * lowerer.  The checker supplement rejects an intersection/union that still
 * exposes `then`, `any`/`unknown`, or another unresolved constituent.  The
 * latter matters because TypeScript's union `getProperty` only reports
 * properties common to every member.
 */
function hasExactNumericNonThenableType(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (ctx.oracle.typeFactOf(expression).kind !== "number") return false;
  let type: ts.Type;
  try {
    type = ctx.checker.getTypeAtLocation(expression);
  } catch {
    return false;
  }
  const parts = type.isUnion?.() ? type.types : [type];
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return part.getProperty?.("then") === undefined;
  });
}

/**
 * Keep the static Promise.resolve recognizer out of the B3 proof.  Its
 * spelling is intentionally not a binding/mutation proof, and a shadowed or
 * rewritten `Promise.resolve` must not accidentally become a new settled-owner
 * admission merely because its declared result is numeric.
 */
function containsPromiseResolveCall(expression: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== expression && isNestedExecutable(node)) return;
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (
        (ts.isPropertyAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === "Promise" &&
          target.name.text === "resolve") ||
        (ts.isElementAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === "Promise" &&
          !!target.argumentExpression &&
          ts.isStringLiteral(target.argumentExpression) &&
          target.argumentExpression.text === "resolve")
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

/**
 * Type assertions are runtime-transparent, but they are not proof.  Walk all
 * assertion nodes in a numeric expression and recursively validate the value
 * beneath each one.  Thus `seed as number` is accepted when `seed` is already
 * numeric, while `promise as unknown as number` and `unknownValue as number`
 * remain refusals.  A cast hidden inside a binary/call expression is treated
 * the same way, so a cast cannot smuggle a thenable into a settled receipt.
 */
function numericAssertionsAreGrounded(
  ctx: CodegenContext,
  expression: ts.Expression,
  owner: ts.FunctionDeclaration,
  resolving: ReadonlySet<ts.VariableDeclaration>,
  assumed: ReadonlySet<ts.VariableDeclaration>,
): boolean {
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (node !== expression && isNestedExecutable(node)) return;
    if (isTypeAssertionExpression(node)) {
      if (!isSettledNumericExpression(ctx, node.expression, owner, resolving, assumed)) valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return valid;
}

function writesNumericValue(
  ctx: CodegenContext,
  owner: ts.FunctionDeclaration,
  declaration: ts.VariableDeclaration,
  resolving: ReadonlySet<ts.VariableDeclaration>,
): boolean {
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (node !== owner.body && isNestedExecutable(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = unwrapSettledOperand(node.left);
      if (ts.isIdentifier(left) && ctx.oracle.valueDeclarationOf(left) === declaration) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const assumed = new Set<ts.VariableDeclaration>([declaration]);
          if (!isSettledNumericExpression(ctx, node.right, owner, resolving, assumed)) valid = false;
        } else if (
          !hasExactNumericNonThenableType(ctx, node) ||
          !numericAssertionsAreGrounded(ctx, node, owner, resolving, new Set([declaration]))
        ) {
          valid = false;
        }
        return;
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(node.operand) &&
        ctx.oracle.valueDeclarationOf(node.operand) === declaration &&
        (!hasExactNumericNonThenableType(ctx, node) ||
          !numericAssertionsAreGrounded(ctx, node, owner, resolving, new Set([declaration])))
      ) {
        valid = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (owner.body) visit(owner.body);
  return valid;
}

function isSettledNumericExpression(
  ctx: CodegenContext,
  expression: ts.Expression,
  owner: ts.FunctionDeclaration,
  resolving: ReadonlySet<ts.VariableDeclaration> = new Set(),
  assumed: ReadonlySet<ts.VariableDeclaration> = new Set(),
): boolean {
  const candidate = unwrapSettledOperand(expression);
  if (isTypeAssertionExpression(candidate)) {
    return isSettledNumericExpression(ctx, candidate.expression, owner, resolving, assumed);
  }
  if (containsPromiseResolveCall(candidate)) return false;
  if (!hasExactNumericNonThenableType(ctx, candidate)) return false;
  if (!numericAssertionsAreGrounded(ctx, candidate, owner, resolving, assumed)) return false;

  // A numeric local may be initialized from an earlier await.  Its delivery
  // type alone is insufficient evidence: the earlier operand must carry the
  // same non-thenable proof, otherwise a Promise-valued await could be hidden
  // behind the local before this site's receipt is issued.
  if (ts.isAwaitExpression(candidate)) {
    return isSettledNumericExpression(ctx, candidate.expression, owner, resolving, assumed);
  }

  if (!ts.isIdentifier(candidate)) return true;
  const declaration = ctx.oracle.variableDeclarationOf(candidate);
  if (!declaration) return true; // parameter/import/global: exact numeric ABI fact is sufficient.
  if (assumed.has(declaration)) return true;
  if (resolving.has(declaration) || !declaration.initializer) return false;
  const nextResolving = new Set(resolving);
  nextResolving.add(declaration);
  return (
    isSettledNumericExpression(ctx, declaration.initializer, owner, nextResolving, assumed) &&
    writesNumericValue(ctx, owner, declaration, nextResolving)
  );
}

interface SettledOwnerIdentity {
  readonly unitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly sourceFile: ts.SourceFile;
}

interface SettledOwnerCallClosure {
  readonly incomingCallerUnitIds: readonly IrUnitId[];
  readonly incomingCallContracts: readonly PreparedIrAsyncCallContract[];
  readonly outgoingCalleeUnitIds: readonly IrUnitId[];
  readonly fingerprint: string;
}

const settledOwnerCache = new WeakMap<CodegenContext, Map<IrUnitId, PreparedIrAsyncSettledOwner | null>>();
const settledOwnerIssued = new WeakMap<CodegenContext, Set<IrUnitId>>();
const importedResolverCache = new WeakMap<IrPlanningIdentityContext, IrIdentityImportedFunctionResolver>();

function importedResolver(ctx: CodegenContext): IrIdentityImportedFunctionResolver | null {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity) return null;
  const cached = importedResolverCache.get(identity);
  if (cached) return cached;
  const sourceFiles = ctx.callableSourceFiles ?? [...identity.sourceFileBySourceId.values()];
  const resolver = makeIrIdentityImportedFunctionResolver(ctx.checker, sourceFiles, identity);
  importedResolverCache.set(identity, resolver);
  return resolver;
}

function sourceFunctionTarget(ctx: CodegenContext, identifier: ts.Identifier): ts.FunctionDeclaration | undefined {
  const resolver = importedResolver(ctx);
  if (!resolver) return undefined;
  return (
    resolver.resolveTopLevelFunctionValueTarget(identifier)?.declaration ??
    resolver.resolveImportedFunctionTarget(identifier)?.declaration
  );
}

function settledOwnerIdentity(ctx: CodegenContext, fn: ts.FunctionDeclaration): SettledOwnerIdentity | null {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity || !ts.isSourceFile(fn.parent) || fn.getSourceFile() !== fn.parent) return null;
  const unitId = identity.unitIdByDeclaration.get(fn);
  const sourceId = identity.sourceIdBySourceFile.get(fn.getSourceFile());
  const unit = unitId === undefined ? undefined : identity.unitByUnitId.get(unitId);
  const terminal = unitId === undefined ? undefined : identity.terminalByUnitId.get(unitId);
  if (
    unitId === undefined ||
    sourceId === undefined ||
    !unit ||
    unit.sourceId !== sourceId ||
    unit.kind !== "top-level-function" ||
    !terminal ||
    terminal !== unit ||
    terminal.terminalOwnerId !== unitId ||
    identity.declarationByUnitId.get(unitId) !== fn
  ) {
    return null;
  }
  return { unitId, sourceId, sourceFile: fn.getSourceFile() };
}

function sourceFingerprint(ctx: CodegenContext, fn: ts.FunctionDeclaration): string {
  const source = preparedIrAsyncLinearSource(ctx, fn);
  const awaitFingerprint = source
    ? source.awaitSites.map((site, index) => {
        const operand = source.awaitedExpressions[index];
        let typeText = "<unresolvable>";
        try {
          typeText = ctx.checker.typeToString(
            ctx.checker.getTypeAtLocation(operand),
            undefined,
            ts.TypeFormatFlags.NoTruncation,
          );
        } catch {
          // Keep the explicit sentinel. A currentness mismatch is safer than
          // treating an unavailable checker answer as the issued proof.
        }
        return `${site.pos}:${site.end}:${site.getText()}:${typeText}`;
      })
    : [];
  return `${fn.pos}:${fn.end}:${fn.getText()}:${JSON.stringify(awaitFingerprint)}`;
}

function isAsyncDeclaration(fn: ts.FunctionLikeDeclaration): boolean {
  return fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function isImportOrExportBindingPosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent)
  );
}

function callContractKind(call: ts.CallExpression): PreparedIrAsyncCallContract["kind"] | null {
  let current: ts.Node = call;
  let hasAssertion = false;
  for (;;) {
    const parent = current.parent;
    if (!parent) return null;
    if ((ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (isTypeAssertionExpression(parent) && parent.expression === current) {
      hasAssertion = true;
      current = parent;
      continue;
    }
    if (ts.isAwaitExpression(parent) && parent.expression === current) return "awaited-fulfillment";
    if (ts.isReturnStatement(parent) && parent.expression === current && !hasAssertion) return "promise-carrier";
    return null;
  }
}

function callBoundary(
  ctx: CodegenContext,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { readonly unitId: IrUnitId; readonly declaration?: ts.FunctionLikeDeclaration } | null {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity) return null;
  for (let current: ts.Node | undefined = call.parent; current && current !== sourceFile; current = current.parent) {
    if (!isNestedExecutable(current)) continue;
    const unitId = identity.unitIdByDeclaration.get(current);
    if (unitId === undefined) return null;
    return { unitId, declaration: current as ts.FunctionLikeDeclaration };
  }
  const unitId = identity.moduleInitUnitIdBySourceFile.get(sourceFile);
  return unitId === undefined ? null : { unitId };
}

function promiseReturnContractIsClosed(
  ctx: CodegenContext,
  caller: ts.FunctionLikeDeclaration,
  call: ts.CallExpression,
): boolean {
  // An async caller with no own await still has its legacy f64 declaration
  // ABI in this increment, so returning a newly externref-valued owner from
  // it would strand the call on a stale slot. A synchronous Promise carrier
  // is only accepted when the checker can prove that the call expression and
  // caller signature both carry Promise.
  if (isAsyncDeclaration(caller)) return false;
  const callFact = ctx.oracle.typeFactOf(call);
  const callerSignature = ctx.oracle.signatureOf(caller)?.returns;
  return (
    callFact.kind === "builtin" &&
    callFact.name === "Promise" &&
    callerSignature?.kind === "builtin" &&
    callerSignature.name === "Promise"
  );
}

function hasUnresolvedDirectCall(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): boolean {
  let unresolved = false;
  const visit = (node: ts.Node): void => {
    if (unresolved) return;
    if (node !== fn && isNestedExecutable(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = ctx.oracle.valueDeclarationOf(node.expression);
      if (declaration === undefined && sourceFunctionTarget(ctx, node.expression) === undefined) {
        unresolved = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return unresolved;
}

/**
 * Close every source-visible caller before a settled owner changes its
 * callable result from numeric fulfillment to the physical Promise carrier.
 * This intentionally uses checker declaration identity and inventory UnitIds;
 * a matching spelling, an unknown caller, or an unowned module-init call does
 * not establish a compatible edge.
 */
function settledOwnerCallClosure(
  ctx: CodegenContext,
  owner: ts.FunctionDeclaration,
  ownerIdentity: SettledOwnerIdentity,
): SettledOwnerCallClosure | null {
  const identity = ctx.irPlanningIdentityContext;
  if (!identity) return null;
  const incoming = new Map<string, PreparedIrAsyncCallContract>();
  const outgoing = new Set<IrUnitId>();
  const sourceFiles = ctx.callableSourceFiles ?? [ownerIdentity.sourceFile];
  const inventoryOrder = new Map(identity.inventory.allUnits.map((unit, index) => [unit.id, index] as const));
  let valid = true;
  const visitSource = (sourceFile: ts.SourceFile): void => {
    if (!valid) return;
    if (identity.sourceIdBySourceFile.get(sourceFile) === undefined) {
      valid = false;
      return;
    }
    const visit = (node: ts.Node): void => {
      if (!valid) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const declaration = ctx.oracle.valueDeclarationOf(node.expression);
        const targetDeclaration = sourceFunctionTarget(ctx, node.expression);
        const boundary = callBoundary(ctx, node, sourceFile);
        if (
          boundary?.unitId !== undefined &&
          boundary.unitId === ownerIdentity.unitId &&
          ctx.oracle.isUnresolvableIdentifier(node.expression)
        ) {
          // An unresolved call in the owner body has no source/provider ABI
          // contract. Do not let an accidental numeric checker answer turn it
          // into a settled-owner proof.
          valid = false;
          return;
        }
        if (targetDeclaration === undefined && declaration === undefined && node.expression.text === owner.name?.text) {
          // Same-spelling unresolved calls are not foreign identity evidence;
          // keep the owner out until a checker-authenticated target exists.
          valid = false;
          return;
        }
        if (targetDeclaration === owner) {
          const kind = callContractKind(node);
          const caller = boundary?.declaration;
          if (
            !kind ||
            !boundary ||
            !caller ||
            (boundary.unitId === ownerIdentity.unitId && kind !== "awaited-fulfillment") ||
            (kind === "awaited-fulfillment" &&
              (!isAsyncDeclaration(caller) ||
                preparedIrAsyncLinearSource(ctx, caller) === null ||
                hasUnresolvedDirectCall(ctx, caller))) ||
            (kind === "promise-carrier" && !promiseReturnContractIsClosed(ctx, caller, node))
          ) {
            valid = false;
            return;
          }
          const contract: PreparedIrAsyncCallContract = Object.freeze({
            callerUnitId: boundary.unitId,
            targetUnitId: ownerIdentity.unitId,
            callPosition: node.pos,
            kind,
          });
          incoming.set(`${boundary.unitId}:${node.pos}:${kind}`, contract);
        } else if (
          boundary?.unitId === ownerIdentity.unitId &&
          targetDeclaration !== undefined &&
          targetDeclaration !== owner
        ) {
          const targetUnitId = identity.unitIdByDeclaration.get(targetDeclaration);
          const targetUnit = targetUnitId === undefined ? undefined : identity.unitByUnitId.get(targetUnitId);
          if (
            targetUnitId !== undefined &&
            targetUnit?.kind === "top-level-function" &&
            isAsyncDeclaration(targetDeclaration)
          ) {
            // An async source call that is not the admitted numeric await
            // operand would need the Promise carrier closure of a later R2
            // increment. Keep this B3 receipt closed over settled/non-async
            // outgoing calls only.
            valid = false;
            return;
          }
          if (targetUnitId !== undefined && targetUnit?.kind === "top-level-function") outgoing.add(targetUnitId);
        }
      }
      if (
        ts.isIdentifier(node) &&
        ctx.oracle.valueDeclarationOf(node) === owner &&
        node !== owner.name &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        !isImportOrExportBindingPosition(node)
      ) {
        valid = false;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  };
  for (const sourceFile of sourceFiles) visitSource(sourceFile);
  if (!valid) return null;

  const incomingCallContracts = [...incoming.values()].sort(
    (left, right) =>
      (inventoryOrder.get(left.callerUnitId) ?? Number.MAX_SAFE_INTEGER) -
        (inventoryOrder.get(right.callerUnitId) ?? Number.MAX_SAFE_INTEGER) ||
      left.callPosition - right.callPosition ||
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
  );
  const incomingCallerUnitIds = [...new Set(incomingCallContracts.map((contract) => contract.callerUnitId))];
  const outgoingCalleeUnitIds = [...outgoing].sort(
    (left, right) =>
      (inventoryOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (inventoryOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
      (left < right ? -1 : left > right ? 1 : 0),
  );
  const fingerprint = JSON.stringify({
    incoming: incomingCallContracts,
    outgoing: outgoingCalleeUnitIds,
  });
  return { incomingCallerUnitIds, incomingCallContracts, outgoingCalleeUnitIds, fingerprint };
}

function settledOwnerIsCurrent(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  receipt: PreparedIrAsyncSettledOwner,
): boolean {
  const identity = settledOwnerIdentity(ctx, fn);
  if (
    !identity ||
    identity.unitId !== receipt.unitId ||
    identity.sourceId !== receipt.sourceId ||
    identity.sourceFile !== receipt.sourceFile ||
    sourceFingerprint(ctx, fn) !== receipt.sourceFingerprint
  ) {
    return false;
  }
  const source = preparedIrAsyncLinearSource(ctx, fn);
  if (
    !source ||
    source.awaitSites.length !== receipt.awaitSites.length ||
    source.awaitedExpressions.length !== receipt.awaitedExpressions.length ||
    source.awaitSites.some((site, index) => site !== receipt.awaitSites[index]) ||
    source.awaitedExpressions.some((expression, index) => expression !== receipt.awaitedExpressions[index])
  ) {
    return false;
  }
  const closure = settledOwnerCallClosure(ctx, fn, identity);
  return closure !== null && closure.fingerprint === receipt.callerClosureFingerprint;
}

function freezeSettledOwner(
  receipt: Omit<
    PreparedIrAsyncSettledOwner,
    | "awaitSites"
    | "awaitedExpressions"
    | "awaitOperandFacts"
    | "awaitDeliveryFacts"
    | "incomingCallerUnitIds"
    | "incomingCallContracts"
    | "outgoingCalleeUnitIds"
  > & {
    readonly awaitSites: readonly ts.AwaitExpression[];
    readonly awaitedExpressions: readonly ts.Expression[];
    readonly awaitOperandFacts: readonly TypeFact[];
    readonly awaitDeliveryFacts: readonly TypeFact[];
    readonly incomingCallerUnitIds: readonly IrUnitId[];
    readonly incomingCallContracts: readonly PreparedIrAsyncCallContract[];
    readonly outgoingCalleeUnitIds: readonly IrUnitId[];
  },
): PreparedIrAsyncSettledOwner {
  return Object.freeze({
    ...receipt,
    awaitSites: Object.freeze([...receipt.awaitSites]),
    awaitedExpressions: Object.freeze([...receipt.awaitedExpressions]),
    awaitOperandFacts: Object.freeze([...receipt.awaitOperandFacts]),
    awaitDeliveryFacts: Object.freeze([...receipt.awaitDeliveryFacts]),
    incomingCallerUnitIds: Object.freeze([...receipt.incomingCallerUnitIds]),
    incomingCallContracts: Object.freeze(
      receipt.incomingCallContracts.map((contract) => Object.freeze({ ...contract })),
    ),
    outgoingCalleeUnitIds: Object.freeze([...receipt.outgoingCalleeUnitIds]),
  });
}

function buildPreparedIrAsyncSettledOwner(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
): PreparedIrAsyncSettledOwner | null {
  const ownerIdentity = settledOwnerIdentity(ctx, fn);
  if (!ownerIdentity) return null;
  const source = preparedIrAsyncLinearSource(ctx, fn);
  if (!source) return null;
  const awaitOperandFacts = source.awaitedExpressions.map((expression) => ctx.oracle.typeFactOf(expression));
  if (!source.awaitedExpressions.every((expression) => isSettledNumericExpression(ctx, expression, fn))) return null;
  const closure = settledOwnerCallClosure(ctx, fn, ownerIdentity);
  if (!closure) return null;
  return freezeSettledOwner({
    kind: "settled-nonthenable",
    unitId: ownerIdentity.unitId,
    sourceId: ownerIdentity.sourceId,
    declaration: fn,
    sourceFile: ownerIdentity.sourceFile,
    sourceIdentity: `${ownerIdentity.sourceId}:${ownerIdentity.unitId}`,
    sourceFingerprint: sourceFingerprint(ctx, fn),
    declarationName: fn.name?.text ?? "",
    awaitSites: source.awaitSites,
    awaitedExpressions: source.awaitedExpressions,
    awaitOperandFacts,
    awaitDeliveryFacts: source.awaitSites.map((expression) => ctx.oracle.typeFactOf(expression)),
    fulfillmentType: fn.type,
    incomingCallerUnitIds: closure.incomingCallerUnitIds,
    incomingCallContracts: closure.incomingCallContracts,
    outgoingCalleeUnitIds: closure.outgoingCalleeUnitIds,
    callerClosureFingerprint: closure.fingerprint,
  });
}

/**
 * Build the B3 source receipt for an ordinary top-level linear owner.  This
 * deliberately does not consult `awaitIsStaticallyResolved`: a typed local or
 * parameter is semantic non-thenable evidence even when its spelling is not a
 * literal, while Promise.resolve and cast/unknown forms remain outside this
 * receipt.
 */
export function preparedIrAsyncSettledOwner(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
): PreparedIrAsyncSettledOwner | null {
  const identity = settledOwnerIdentity(ctx, fn);
  if (!identity) return null;
  let cache = settledOwnerCache.get(ctx);
  if (!cache) {
    cache = new Map();
    settledOwnerCache.set(ctx, cache);
  }
  if (cache.has(identity.unitId)) {
    const receipt = cache.get(identity.unitId)!;
    if (receipt === null) return null;
    if (settledOwnerIsCurrent(ctx, fn, receipt)) return receipt;
    cache.set(identity.unitId, null);
    return null;
  }
  const receipt = buildPreparedIrAsyncSettledOwner(ctx, fn);
  cache.set(identity.unitId, receipt);
  if (receipt) {
    const issued = settledOwnerIssued.get(ctx) ?? new Set<IrUnitId>();
    issued.add(identity.unitId);
    settledOwnerIssued.set(ctx, issued);
  }
  return receipt;
}

/** True after a settled proof was issued, even if a later handoff withdrew it. */
export function preparedIrAsyncSettledOwnerWasIssued(ctx: CodegenContext, fn: ts.FunctionDeclaration): boolean {
  const unitId = settledOwnerIdentity(ctx, fn)?.unitId;
  return unitId !== undefined && settledOwnerIssued.get(ctx)?.has(unitId) === true;
}

/** Test/integration seam for modelling proof loss after ABI projection. */
export function forgetPreparedIrAsyncSettledOwner(ctx: CodegenContext, fn: ts.FunctionDeclaration): void {
  const unitId = settledOwnerIdentity(ctx, fn)?.unitId;
  if (unitId === undefined) return;
  const cache = settledOwnerCache.get(ctx) ?? new Map<IrUnitId, PreparedIrAsyncSettledOwner | null>();
  cache.set(unitId, null);
  settledOwnerCache.set(ctx, cache);
}
