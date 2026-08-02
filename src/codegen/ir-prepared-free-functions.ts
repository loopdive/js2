// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import type { IrClassId, IrUnitId } from "../ir/identity.js";
import { compileIrPathFunctions, type IrIntegrationReport, type IrTypeOverrideMap } from "../ir/integration.js";
import { asVal, type IrClassShape, type IrType } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import {
  buildIrLegacyUnitProjection,
  type IrLegacyUnitProjection,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";
import type { IrPromiseDelayLoweringPlan, IrPromiseDelayLoweringPlans } from "../ir/promise-delay-lowering.js";
import type { IrSelection } from "../ir/select.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { getOrRegisterVecType } from "./registry/types.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import {
  buildIrRequestedFunctionSkipProjection,
  computeIrFirstSkipUnitIds,
  mergeIrIntegrationReports,
  preparedIrBodyRouting,
  type IrExactBodyClaim,
  type IrExactFunctionClaim,
} from "./ir-overlay-safety.js";

/** Preserve the inherited compile-once allowlist for owners not prepared early. */
export function computePreparedInheritedIrFirstSkipUnitIds(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityContext: IrPlanningIdentityContext;
  readonly safeFunctionUnitIds: ReadonlySet<IrUnitId>;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overridesByUnitId: ReadonlyMap<
    IrUnitId,
    { readonly params: readonly IrType[]; readonly returnType: IrType | null }
  >;
  readonly potentiallyBlockedOwnerUnitIds: ReadonlySet<IrUnitId>;
  readonly generatorsSkippable: boolean;
  readonly fast: boolean;
}): Set<IrUnitId> {
  const requestedSkipUnitIds = new Set(
    computeIrFirstSkipUnitIds({
      sourceFile: input.sourceFile,
      identityContext: input.identityContext,
      safeFunctionUnitIds: input.safeFunctionUnitIds,
      claimsByUnitId: input.claimsByUnitId,
      overridesByUnitId: input.overridesByUnitId,
      potentiallyBlockedOwnerUnitIds: input.potentiallyBlockedOwnerUnitIds,
      generatorsSkippable: input.generatorsSkippable,
    }),
  );
  // Fast mode can ground source `number` positions to i32 during direct body
  // discovery even though the early IR override still says f64. Keep only the
  // annotation-proven boolean subset on the inherited compile-once route until
  // exact callable-contract comparison moves into preparation.
  if (!input.fast) return requestedSkipUnitIds;

  const fastBlockedUnitIds = new Set<IrUnitId>();
  for (const unitId of requestedSkipUnitIds) {
    const declaration = input.claimsByUnitId.get(unitId)?.declaration;
    const stableFastSignature =
      declaration !== undefined &&
      declaration.parameters.every(
        (parameter) =>
          !parameter.questionToken &&
          !parameter.dotDotDotToken &&
          !parameter.initializer &&
          parameter.type?.kind === ts.SyntaxKind.BooleanKeyword,
      ) &&
      (declaration.type?.kind === ts.SyntaxKind.BooleanKeyword || declaration.type?.kind === ts.SyntaxKind.VoidKeyword);
    if (!stableFastSignature) {
      requestedSkipUnitIds.delete(unitId);
      fastBlockedUnitIds.add(unitId);
    }
  }
  const callEdges = collectLocalCallEdgesByIdentity(input.sourceFile, input.identityContext);
  for (let changed = true; changed; ) {
    changed = false;
    for (const unitId of requestedSkipUnitIds) {
      if (![...(callEdges.callees.get(unitId) ?? [])].some((calleeUnitId) => fastBlockedUnitIds.has(calleeUnitId))) {
        continue;
      }
      requestedSkipUnitIds.delete(unitId);
      fastBlockedUnitIds.add(unitId);
      changed = true;
    }
  }
  return requestedSkipUnitIds;
}

export interface PreparedIrFreeFunctionBodies {
  readonly report: IrIntegrationReport;
  readonly requestedSkipProjection: IrLegacyUnitProjection;
  /** Owners settled by the preparation attempt and excluded from the late overlay. */
  readonly completedBodies: ReadonlySet<string>;
  readonly skipBodies: ReadonlySet<string>;
  readonly preserveBodies: ReadonlySet<string>;
}

export interface PreparedIrClassMethodBodies {
  readonly report: IrIntegrationReport;
  readonly requestedSkipProjection: IrLegacyUnitProjection;
  readonly completedBodies: ReadonlySet<string>;
  readonly skipBodies: ReadonlySet<string>;
  readonly preserveBodies: ReadonlySet<string>;
}

/** Project selected ordinary methods through exact structural class ownership. */
export function selectPreparedClassMethodNames(
  ctx: CodegenContext,
  selection: Pick<IrSelection, "classMembers">,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): ReadonlySet<string> {
  const selectedNames = new Set(selection.classMembers ?? []);
  const methodNames = new Set<string>();
  for (const claim of identityPlan.identitySelection.classMembers?.values() ?? []) {
    const terminal = identityPlan.identityContext.terminalByUnitId.get(claim.unitId);
    const declaration = identityPlan.identityContext.declarationByUnitId.get(claim.unitId);
    const owner = declaration?.parent;
    const instanceClassId =
      owner !== undefined && ts.isClassDeclaration(owner)
        ? identityPlan.identityContext.classIdByDeclaration.get(owner)
        : undefined;
    // Derived layouts receive a late leaf-finality decision and constructors /
    // inherited support still cross the direct boundary. Keep this first
    // instance-method owner on exact top-level classes without `extends`.
    const instanceOwnerIsFlat =
      owner !== undefined &&
      ts.isClassDeclaration(owner) &&
      ts.isSourceFile(owner.parent) &&
      !(owner.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? false) &&
      instanceClassId !== undefined &&
      ctx.programAbiTypes?.canPrepareScalarClassLayout(instanceClassId) === true;
    if (
      selectedNames.has(claim.legacyMatchName) &&
      (terminal?.kind === "class-static-method" ||
        (terminal?.kind === "class-instance-method" && instanceOwnerIsFlat)) &&
      declaration !== undefined &&
      ts.isMethodDeclaration(declaration) &&
      !containsNestedExecutableSyntax(declaration)
    ) {
      methodNames.add(claim.legacyMatchName);
    }
  }
  return methodNames;
}

function deferUnsealedPreparedComponents(
  report: IrIntegrationReport,
  deferredUnitIds: ReadonlySet<IrUnitId>,
  claimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>,
): IrIntegrationReport {
  if (deferredUnitIds.size === 0) return report;
  if (!report.terminalEvidence || !report.compiledArtifactEvidence) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      "unsealed prepared components have no exact integration artifact evidence",
    );
  }
  const deferredLegacyNames = new Set<string>();
  for (const unitId of deferredUnitIds) {
    const claim = claimsByUnitId.get(unitId);
    const evidence = report.terminalEvidence.find((candidate) => candidate.unitId === unitId);
    if (!claim || evidence?.kind !== "patched" || evidence.preparedComponentId !== undefined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `deferred prepared component ${unitId} has no exact unsealed patched owner`,
      );
    }
    deferredLegacyNames.add(claim.legacyName);
  }
  const compiledArtifactEvidence = report.compiledArtifactEvidence.filter(
    (artifact) => !deferredUnitIds.has(artifact.terminalOwnerUnitId),
  );
  const deferredDerivedArtifact = report.compiledArtifactEvidence.find(
    (artifact) =>
      deferredUnitIds.has(artifact.terminalOwnerUnitId) && artifact.artifactUnitId !== artifact.terminalOwnerUnitId,
  );
  if (deferredDerivedArtifact) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `unsealed prepared owner ${deferredDerivedArtifact.terminalOwnerUnitId} produced derived artifact ${deferredDerivedArtifact.artifactUnitId}`,
    );
  }
  return {
    compiled: compiledArtifactEvidence.map((artifact) => artifact.name),
    errors: report.errors.filter((error) => !deferredLegacyNames.has(error.func)),
    compiledArtifactEvidence,
    terminalEvidence: report.terminalEvidence.filter((evidence) => !deferredUnitIds.has(evidence.unitId)),
    terminalCompiledOwners: (report.terminalCompiledOwners ?? []).filter(
      (legacyName) => !deferredLegacyNames.has(legacyName),
    ),
    syntheticCompiledArtifacts: compiledArtifactEvidence
      .filter((artifact) => artifact.artifactUnitId !== artifact.terminalOwnerUnitId)
      .map((artifact) => artifact.name),
  };
}

function bodyProjection(
  unitIds: ReadonlySet<IrUnitId>,
  claimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>,
): IrLegacyUnitProjection {
  return buildIrLegacyUnitProjection(
    [...unitIds].map((unitId) => {
      const claim = claimsByUnitId.get(unitId);
      if (!claim) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `prepared body ${unitId} has no exact structural claim`,
        );
      }
      return { unitId, legacyName: claim.legacyName };
    }),
  );
}

function r2StableSignatureType(type: IrType | null): boolean {
  if (type === null || type.kind === "string") return true;
  if (type.kind === "vec") {
    const element = asVal(type.elementType);
    return element?.kind === "f64" || element?.kind === "i32";
  }
  const val = asVal(type);
  return val?.kind === "f64" || val?.kind === "i32";
}

/**
 * An unsealed early attempt is retried after direct emission. Nested executable
 * syntax can allocate derived callable identities during that attempt, and the
 * Program ABI deliberately rejects registering those identities twice. Keep
 * those owners on the late route until R3 owns their complete transaction.
 */
function containsNestedExecutableSyntax(declaration: ts.FunctionLikeDeclaration): boolean {
  if (!declaration.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isClassStaticBlockDeclaration(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration.body, visit);
  return found;
}

function identifierIsRuntimeFunctionValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent) && parent.expression === identifier) return false;
  if (
    ((ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && (parent.name === identifier || parent.propertyName === identifier)) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  return true;
}

function topLevelFunctionUnitsByName(
  sourceFile: ts.SourceFile,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): ReadonlyMap<string, readonly IrUnitId[]> {
  const byName = new Map<string, IrUnitId[]>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name) continue;
    const unitId = identityPlan.identityContext.unitIdByDeclaration.get(statement);
    if (!unitId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `top-level function ${statement.name.text} has no exact structural identity`,
      );
    }
    const ids = byName.get(statement.name.text) ?? [];
    ids.push(unitId);
    byName.set(statement.name.text, ids);
  }
  return byName;
}

function collectTopLevelFunctionValueTargets(
  sourceFile: ts.SourceFile,
  unitsByName: ReadonlyMap<string, readonly IrUnitId[]>,
): ReadonlySet<IrUnitId> {
  const targets = new Set<IrUnitId>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && identifierIsRuntimeFunctionValueReference(node)) {
      for (const unitId of unitsByName.get(node.text) ?? []) targets.add(unitId);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

function containsTopLevelFunctionValueReference(
  declaration: ts.FunctionLikeDeclaration,
  unitsByName: ReadonlyMap<string, readonly IrUnitId[]>,
): boolean {
  if (!declaration.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && unitsByName.has(node.text) && identifierIsRuntimeFunctionValueReference(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return found;
}

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

function r2StableValType(ctx: CodegenContext, type: IrType): ValType | undefined {
  if (type.kind === "string") {
    if (!ctx.nativeStrings) return { kind: "externref" };
    return ctx.anyStrTypeIdx >= 0 ? { kind: "ref", typeIdx: ctx.anyStrTypeIdx } : undefined;
  }
  if (type.kind === "vec") {
    const element = asVal(type.elementType);
    if (!element || (element.kind !== "f64" && element.kind !== "i32")) return undefined;
    const vecTypeIdx = getOrRegisterVecType(ctx, element.kind, element);
    return { kind: type.nullable ? "ref_null" : "ref", typeIdx: vecTypeIdx };
  }
  const val = asVal(type);
  return val?.kind === "f64" || val?.kind === "i32" ? val : undefined;
}

/**
 * Preparation may replace an empty declaration slot before direct emission,
 * but it must not change that slot's already allocated callable ABI. The
 * Program ABI registry observes the allocation contract, and later direct
 * callers/exports can already depend on it even when the body is still empty.
 */
function r2SignatureMatchesAllocatedSlot(
  ctx: CodegenContext,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
): boolean {
  const func = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") return false;
  const params = override.params.map((type) => r2StableValType(ctx, type));
  const result = override.returnType === null ? null : r2StableValType(ctx, override.returnType);
  if (
    params.some((type) => type === undefined) ||
    result === undefined ||
    signature.params.length !== params.length ||
    signature.results.length !== (override.returnType === null ? 0 : 1)
  ) {
    return false;
  }
  return (
    signature.params.every((type, index) => sameValType(type, params[index]!)) &&
    (result === null || sameValType(signature.results[0]!, result))
  );
}

/**
 * The certified Promise-delay owner is the first R3 closure component whose
 * complete derived population is already produced by the IR lowerer. Its
 * source return type is reference-shaped, so keep this ABI proof separate
 * from the scalar/string R2 predicate rather than widening R2 implicitly.
 */
function r3PromiseDelaySignatureMatchesAllocatedSlot(
  ctx: CodegenContext,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
): boolean {
  if (
    override.params.length !== 2 ||
    override.params.some((type) => asVal(type)?.kind !== "f64") ||
    override.returnType?.kind !== "extern" ||
    override.returnType.className !== "Promise"
  ) {
    return false;
  }
  const func = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  return (
    signature?.kind === "func" &&
    signature.params.length === 2 &&
    signature.params.every((type) => type.kind === "f64") &&
    signature.results.length === 1 &&
    signature.results[0]?.kind === "externref"
  );
}

/** Exact #4106 numeric fulfillment ABI projected onto a Promise callable slot. */
function r3SuspendingAsyncSignatureMatchesAllocatedSlot(
  ctx: CodegenContext,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
): boolean {
  if (
    override.params.some((type) => asVal(type)?.kind !== "f64") ||
    override.returnType === null ||
    asVal(override.returnType)?.kind !== "f64"
  ) {
    return false;
  }
  const func = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  return (
    signature?.kind === "func" &&
    signature.params.length === override.params.length &&
    signature.params.every((type) => type.kind === "f64") &&
    signature.results.length === 1 &&
    signature.results[0]?.kind === "externref"
  );
}

/**
 * Select only exact checker-certified Promise-delay components after their
 * final runtime/import preparation has retained the owner. The two nested
 * arrows are not a generic nested-syntax widening: the lowering plan owns
 * their derived unit IDs, capture order, signatures, and lifted bodies.
 */
export function selectR3PreparedPromiseDelayFunctions(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selectedLegacyNames: ReadonlySet<string>;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overridesByUnitId: ReadonlyMap<
    IrUnitId,
    { readonly params: readonly IrType[]; readonly returnType: IrType | null }
  >;
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
}): ReadonlySet<string> {
  const planByOwnerUnitId = new Map<IrUnitId, IrPromiseDelayLoweringPlan>();
  for (const [construction, plan] of input.promiseDelays.constructions) {
    if (construction !== plan.construction) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `R3 Promise-delay construction map lost exact AST identity for ${plan.ownerUnitId}`,
      );
    }
    const prior = planByOwnerUnitId.get(plan.ownerUnitId);
    if (prior && prior !== plan) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `R3 Promise-delay owner ${plan.ownerUnitId} has multiple lowering plans`,
      );
    }
    planByOwnerUnitId.set(plan.ownerUnitId, plan);
  }

  const functionUnitsByName = topLevelFunctionUnitsByName(input.sourceFile, input.identityPlan);
  const functionValueTargets = collectTopLevelFunctionValueTargets(input.sourceFile, functionUnitsByName);
  const selected = new Set<string>();
  for (const legacyName of input.selectedLegacyNames) {
    const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(input.identityPlan, legacyName);
    const plan = planByOwnerUnitId.get(unitId);
    if (!plan) continue;
    const claim = input.claimsByUnitId.get(unitId);
    const override = input.overridesByUnitId.get(unitId);
    if (!claim || !override) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `R3 Promise-delay candidate ${unitId} / ${legacyName} has no exact claim/signature`,
      );
    }
    if (
      plan.ownerName !== legacyName ||
      plan.construction.getSourceFile() !== input.sourceFile ||
      claim.declaration !== plan.construction.parent?.parent?.parent ||
      functionValueTargets.has(unitId) ||
      containsTopLevelFunctionValueReference(claim.declaration, functionUnitsByName) ||
      !r3PromiseDelaySignatureMatchesAllocatedSlot(input.ctx, unitId, override)
    ) {
      continue;
    }
    selected.add(legacyName);
  }
  return selected;
}

/** Select the exact #4106 host suspension owners whose Promise ABI is frozen. */
export function selectR3PreparedSuspendingAsyncFunctions(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selectedLegacyNames: ReadonlySet<string>;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overridesByUnitId: ReadonlyMap<
    IrUnitId,
    { readonly params: readonly IrType[]; readonly returnType: IrType | null }
  >;
  readonly suspendingAsyncUnitIds: ReadonlySet<IrUnitId>;
}): ReadonlySet<string> {
  const functionUnitsByName = topLevelFunctionUnitsByName(input.sourceFile, input.identityPlan);
  const functionValueTargets = collectTopLevelFunctionValueTargets(input.sourceFile, functionUnitsByName);
  const selected = new Set<string>();
  for (const legacyName of input.selectedLegacyNames) {
    const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(input.identityPlan, legacyName);
    if (!input.suspendingAsyncUnitIds.has(unitId)) continue;
    const claim = input.claimsByUnitId.get(unitId);
    const override = input.overridesByUnitId.get(unitId);
    if (!claim || !override) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `R3 suspending async candidate ${unitId} / ${legacyName} has no exact claim/signature`,
      );
    }
    if (
      containsNestedExecutableSyntax(claim.declaration) ||
      functionValueTargets.has(unitId) ||
      containsTopLevelFunctionValueReference(claim.declaration, functionUnitsByName) ||
      !r3SuspendingAsyncSignatureMatchesAllocatedSlot(input.ctx, unitId, override)
    ) {
      continue;
    }
    selected.add(legacyName);
  }
  return selected;
}

/**
 * R2 prepares only components whose top-level callable contracts are
 * ABI-stable scalars/strings. Reference-shaped callable contracts, fast-mode
 * grounded numerics, and async/generator frames still require direct discovery
 * and remain on the post-direct overlay. Nested callable syntax inside an
 * otherwise admitted owner does not by itself block that owner.
 */
export function selectR2PreparedFreeFunctions(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selectedLegacyNames: ReadonlySet<string>;
  readonly baselineLegacyNames: ReadonlySet<string>;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overridesByUnitId: ReadonlyMap<
    IrUnitId,
    { readonly params: readonly IrType[]; readonly returnType: IrType | null }
  >;
}): ReadonlySet<string> {
  const candidates = new Set<IrUnitId>();
  const baseline = new Set<IrUnitId>();
  const functionUnitsByName = topLevelFunctionUnitsByName(input.sourceFile, input.identityPlan);
  const functionValueTargets = collectTopLevelFunctionValueTargets(input.sourceFile, functionUnitsByName);
  for (const legacyName of input.baselineLegacyNames) {
    baseline.add(irOverlayIdentity.requireIrOverlayFunctionUnitId(input.identityPlan, legacyName));
  }
  for (const legacyName of input.selectedLegacyNames) {
    const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(input.identityPlan, legacyName);
    const claim = input.claimsByUnitId.get(unitId);
    const override = input.overridesByUnitId.get(unitId);
    if (!claim || !override) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `R2 prepared candidate ${unitId} / ${legacyName} has no exact claim/signature`,
      );
    }
    if (baseline.has(unitId)) {
      candidates.add(unitId);
      continue;
    }
    const isAsync = claim.declaration.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    if (
      input.ctx.fast ||
      isAsync ||
      claim.declaration.asteriskToken ||
      containsNestedExecutableSyntax(claim.declaration) ||
      functionValueTargets.has(unitId) ||
      containsTopLevelFunctionValueReference(claim.declaration, functionUnitsByName) ||
      !override.params.every(r2StableSignatureType) ||
      !r2StableSignatureType(override.returnType) ||
      !r2SignatureMatchesAllocatedSlot(input.ctx, unitId, override)
    ) {
      continue;
    }
    candidates.add(unitId);
  }

  const callEdges = collectLocalCallEdgesByIdentity(input.sourceFile, input.identityPlan.identityContext);
  const callers = new Map<IrUnitId, Set<IrUnitId>>();
  for (const [callerUnitId, calleeUnitIds] of callEdges.callees) {
    for (const calleeUnitId of calleeUnitIds) {
      const owners = callers.get(calleeUnitId) ?? new Set<IrUnitId>();
      owners.add(callerUnitId);
      callers.set(calleeUnitId, owners);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const unitId of [...candidates]) {
      if (baseline.has(unitId)) continue;
      const crossesOwnership =
        callEdges.calleesFromUnownedCallers.has(unitId) ||
        [...(callEdges.callees.get(unitId) ?? [])].some((calleeUnitId) => !candidates.has(calleeUnitId)) ||
        [...(callers.get(unitId) ?? [])].some((callerUnitId) => !candidates.has(callerUnitId));
      if (!crossesOwnership) continue;
      candidates.delete(unitId);
      changed = true;
    }
  }

  return new Set(
    [...candidates].map((unitId) => {
      const claim = input.claimsByUnitId.get(unitId);
      if (!claim) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `R2 retained prepared candidate ${unitId} lost its exact claim`,
        );
      }
      return claim.legacyName;
    }),
  );
}

/** Prepare and install retained free-function IR bodies before direct emission. */
export function prepareIrFreeFunctionBodies(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selection: Pick<IrSelection, "funcs">;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly loweringPlans: IrIntegrationLoweringPlans;
}): PreparedIrFreeFunctionBodies {
  const freeFunctionSelection: IrSelection = {
    funcs: new Set(input.selection.funcs),
    classMembers: new Set<string>(),
    moduleInit: undefined,
  };
  const initialReport: IrIntegrationReport =
    freeFunctionSelection.funcs.size === 0
      ? {
          compiled: [],
          errors: [],
          compiledArtifactEvidence: [],
          terminalEvidence: [],
          terminalCompiledOwners: [],
          syntheticCompiledArtifacts: [],
        }
      : compileIrPathFunctions(
          input.ctx,
          input.sourceFile,
          freeFunctionSelection,
          input.overrideMap,
          input.classShapes,
          input.loweringPlans,
          { sealPreparedComponents: true },
        );
  const routing = preparedIrBodyRouting(initialReport, input.claimsByUnitId);
  const report = deferUnsealedPreparedComponents(initialReport, routing.deferredUnitIds, input.claimsByUnitId);
  const requestedSkipProjection = buildIrRequestedFunctionSkipProjection(routing.irOwnedUnitIds, input.claimsByUnitId);
  const preparedProjection = buildIrRequestedFunctionSkipProjection(routing.preparedUnitIds, input.claimsByUnitId);
  const deferredProjection = buildIrRequestedFunctionSkipProjection(routing.deferredUnitIds, input.claimsByUnitId);
  const deferredBodies = new Set(deferredProjection.entries.map(({ legacyName }) => legacyName));
  return {
    report,
    requestedSkipProjection,
    completedBodies: new Set([...freeFunctionSelection.funcs].filter((legacyName) => !deferredBodies.has(legacyName))),
    skipBodies: new Set(requestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
    preserveBodies: new Set(preparedProjection.entries.map(({ legacyName }) => legacyName)),
  };
}

/** Prepare selected top-level ordinary class methods before direct class bodies. */
export function prepareIrClassMethodBodies(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selection: Pick<IrSelection, "classMembers">;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): PreparedIrClassMethodBodies | undefined {
  const methodNames = selectPreparedClassMethodNames(input.ctx, input.selection, input.identityPlan);
  const claimsByUnitId = new Map<IrUnitId, IrExactBodyClaim>();
  for (const claim of input.identityPlan.identitySelection.classMembers?.values() ?? []) {
    if (!methodNames.has(claim.legacyMatchName)) continue;
    claimsByUnitId.set(claim.unitId, { unitId: claim.unitId, legacyName: claim.legacyMatchName });
  }
  if (claimsByUnitId.size === 0) return undefined;
  const classLayouts = new Set<IrClassId>();
  for (const unitId of claimsByUnitId.keys()) {
    const terminal = input.identityPlan.identityContext.terminalByUnitId.get(unitId);
    if (terminal?.kind !== "class-instance-method") continue;
    const declaration = input.identityPlan.identityContext.declarationByUnitId.get(unitId);
    const owner = declaration?.parent;
    const classId =
      owner !== undefined && ts.isClassDeclaration(owner)
        ? input.identityPlan.identityContext.classIdByDeclaration.get(owner)
        : undefined;
    if (!classId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared instance method ${unitId} has no exact class-layout owner`,
      );
    }
    classLayouts.add(classId);
  }
  if (classLayouts.size > 0 && !input.ctx.programAbiTypes) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared instance methods require one exact class-layout ABI registry",
    );
  }
  for (const classId of classLayouts) input.ctx.programAbiTypes!.prepareScalarClassLayout(classId);
  const selection: IrSelection = {
    funcs: new Set<string>(),
    classMembers: methodNames,
    moduleInit: undefined,
  };
  const initialReport = compileIrPathFunctions(
    input.ctx,
    input.sourceFile,
    selection,
    input.overrideMap,
    input.classShapes,
    input.projectLoweringPlans(selection),
    { sealPreparedComponents: true },
  );
  const routing = preparedIrBodyRouting(initialReport, claimsByUnitId);
  const report = deferUnsealedPreparedComponents(initialReport, routing.deferredUnitIds, claimsByUnitId);
  const requestedSkipProjection = bodyProjection(routing.irOwnedUnitIds, claimsByUnitId);
  const preparedProjection = bodyProjection(routing.preparedUnitIds, claimsByUnitId);
  const deferredProjection = bodyProjection(routing.deferredUnitIds, claimsByUnitId);
  const deferredBodies = new Set(deferredProjection.entries.map(({ legacyName }) => legacyName));
  return {
    report,
    requestedSkipProjection,
    completedBodies: new Set([...methodNames].filter((legacyName) => !deferredBodies.has(legacyName))),
    skipBodies: new Set(requestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
    preserveBodies: new Set(preparedProjection.entries.map(({ legacyName }) => legacyName)),
  };
}

/**
 * Compile the population left after prepared bodies and combine both exact
 * terminal reports into the single audit/telemetry input.
 */
export function completePreparedIrIntegration(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selection: Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly preparedReport?: IrIntegrationReport;
  readonly preparedLegacyNames?: ReadonlySet<string>;
  readonly preparedClassMemberLegacyNames?: ReadonlySet<string>;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): IrIntegrationReport {
  const remainingSelection: IrSelection = input.preparedReport
    ? {
        funcs: new Set([...input.selection.funcs].filter((legacyName) => !input.preparedLegacyNames?.has(legacyName))),
        classMembers: new Set(
          [...(input.selection.classMembers ?? [])].filter(
            (legacyName) => !input.preparedClassMemberLegacyNames?.has(legacyName),
          ),
        ),
        moduleInit: input.selection.moduleInit,
      }
    : {
        funcs: new Set(input.selection.funcs),
        classMembers: input.selection.classMembers,
        moduleInit: input.selection.moduleInit,
      };
  const remainingLoweringPlans = input.projectLoweringPlans(remainingSelection);
  const loweringPlans = input.preparedReport
    ? {
        ...remainingLoweringPlans,
        // A deferred caller can still target a dependency whose sealed body
        // was settled by the early report. Retain those exact AST-site plans
        // without re-adding the prepared owner to the emission population.
        directCalls: new Map([
          ...input.projectLoweringPlans(input.selection).directCalls,
          ...remainingLoweringPlans.directCalls,
        ]),
      }
    : remainingLoweringPlans;
  const remainingReport = compileIrPathFunctions(
    input.ctx,
    input.sourceFile,
    remainingSelection,
    input.overrideMap,
    input.classShapes,
    loweringPlans,
  );
  return input.preparedReport ? mergeIrIntegrationReports(input.preparedReport, remainingReport) : remainingReport;
}
