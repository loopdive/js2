// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrHostVoidCallbackLoweringPlan, IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import { isBoundedPreparedAccessorClass, isBoundedPreparedNestedOrdinaryClass } from "../ir/class-accessor-safety.js";
import { compilerTimerShimTerminalUnitIds } from "../ir/compiler-timer-shim-preparation.js";
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
import { constructorHasIrSafeReceiverSemantics, type IrSelection } from "../ir/select.js";
import { MODULE_INIT_UNIT_NAME } from "../ir/module-init.js";
import type { ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { withSelectedTopLevelAccessorUnitIds } from "../ir/module-bindings.js";
import { resolveIrDynamicCarrierType } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { installAstFreeClassConstructorNewWrapper } from "./class-constructor-wrapper.js";
import { preparedIrAsyncSourceCanSuspend, preparedIrAsyncSourceShape } from "./async-ir-planning.js";
import { addFuncType, getOrRegisterVecType } from "./registry/types.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import { timerShimOutsideCaller } from "./ir-timer-shim-planning.js";
import { closeIrBlockedComponentByIdentity } from "./ir-overlay-finalize.js";
import { applyIrFinalContextFunctionUnitIds, type IrOverlayPreparationPlan } from "./ir-overlay-preparation.js";
import {
  buildIrRequestedFunctionSkipProjection,
  computeIrFirstSkipUnitIds,
  mergeIrIntegrationReports,
  preparedIrBodyRouting,
  type IrExactBodyClaim,
  type IrExactFunctionClaim,
} from "./ir-overlay-safety.js";
import { containsUnplannedNestedExecutableSyntax } from "./ir-prepared-nested-executable-syntax.js";
import { prepareImplicitConstructorSupports } from "./ir-plain-implicit-constructors.js";

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

interface PreparedIrBodyFamily {
  readonly requestedSkipProjection: IrLegacyUnitProjection;
  /** Owners settled by the preparation attempt and excluded from the late overlay. */
  readonly completedBodies: ReadonlySet<string>;
  readonly skipBodies: ReadonlySet<string>;
  readonly preserveBodies: ReadonlySet<string>;
}

export interface PreparedIrFreeFunctionBodies extends PreparedIrBodyFamily {}

export interface PreparedIrClassMemberBodies extends PreparedIrBodyFamily {
  readonly completedBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly skipBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly preserveBodyUnitIds: ReadonlySet<IrUnitId>;
}

export interface PreparedIrModuleInitBody extends PreparedIrBodyFamily {
  readonly unitId: IrUnitId;
}

export interface PreparedIrBodies {
  readonly report: IrIntegrationReport;
  readonly freeFunctions: PreparedIrFreeFunctionBodies;
  readonly classMembers?: PreparedIrClassMemberBodies;
  readonly moduleInit?: PreparedIrModuleInitBody;
  /** Exact support units whose plain implicit constructor bodies were prepared before direct emission. */
  readonly implicitConstructorUnitIds: ReadonlySet<IrUnitId>;
}

function topLevelClassDeclarationsByName(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.ClassDeclaration> {
  const declarations = new Map<string, ts.ClassDeclaration>();
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
  }
  return declarations;
}

function classConstructorHierarchyHasIrSafeReceiverSemantics(
  declaration: ts.ClassDeclaration,
  declarationsByName: ReadonlyMap<string, ts.ClassDeclaration>,
  visiting: ReadonlySet<ts.ClassDeclaration> = new Set(),
): boolean {
  if (visiting.has(declaration)) return false;
  const constructorDeclaration = declaration.members.find(ts.isConstructorDeclaration);
  if (constructorDeclaration && !constructorHasIrSafeReceiverSemantics(constructorDeclaration)) return false;
  const heritage = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const baseExpression = heritage?.types[0]?.expression;
  if (!baseExpression) return true;
  if (!ts.isIdentifier(baseExpression)) return false;
  const base = declarationsByName.get(baseExpression.text);
  if (!base) return false;
  return classConstructorHierarchyHasIrSafeReceiverSemantics(
    base,
    declarationsByName,
    new Set([...visiting, declaration]),
  );
}

/** Project selected constructors/methods/accessors through exact structural class ownership. */
export function selectPreparedClassMemberUnitIds(
  ctx: CodegenContext,
  selection: Pick<IrSelection, "classMembers" | "classMemberUnitIds">,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): ReadonlySet<IrUnitId> {
  const selectedNames = new Set(selection.classMembers ?? []);
  const selectedUnitIds = selection.classMemberUnitIds;
  const memberUnitIds = new Set<IrUnitId>();
  const topLevelClassesBySource = new Map<ts.SourceFile, ReadonlyMap<string, ts.ClassDeclaration>>();
  for (const claim of identityPlan.identitySelection.classMembers?.values() ?? []) {
    const terminal = identityPlan.identityContext.terminalByUnitId.get(claim.unitId);
    const declaration = identityPlan.identityContext.declarationByUnitId.get(claim.unitId);
    const implicitConstructorBody = terminal?.kind === "class-implicit-constructor";
    const owner = implicitConstructorBody ? declaration : declaration?.parent;
    const classId =
      owner !== undefined && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner))
        ? identityPlan.identityContext.classIdByDeclaration.get(owner)
        : undefined;
    const classOwnerIsPreparable =
      owner !== undefined &&
      (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) &&
      classId !== undefined &&
      ctx.programAbiTypes?.canPrepareClassLayout(classId) === true;
    let instanceHierarchyIsPreparable =
      owner !== undefined && ts.isClassDeclaration(owner) && ts.isSourceFile(owner.parent) && classOwnerIsPreparable;
    if (instanceHierarchyIsPreparable && owner && ts.isClassDeclaration(owner)) {
      let declarationsByName = topLevelClassesBySource.get(owner.getSourceFile());
      if (!declarationsByName) {
        declarationsByName = topLevelClassDeclarationsByName(owner.getSourceFile());
        topLevelClassesBySource.set(owner.getSourceFile(), declarationsByName);
      }
      instanceHierarchyIsPreparable = classConstructorHierarchyHasIrSafeReceiverSemantics(owner, declarationsByName);
    }
    const instanceBody =
      terminal?.kind === "class-instance-method" ||
      terminal?.kind === "class-instance-getter" ||
      terminal?.kind === "class-instance-setter";
    const instanceAccessorBody =
      terminal?.kind === "class-instance-getter" || terminal?.kind === "class-instance-setter";
    const constructorBody = terminal?.kind === "class-constructor" || implicitConstructorBody;
    const staticAccessorBody = terminal?.kind === "class-static-getter" || terminal?.kind === "class-static-setter";
    const nestedAccessorBody =
      (instanceAccessorBody || staticAccessorBody) && terminal?.containingTerminalOwnerId !== undefined;
    const nestedOrdinaryBody =
      terminal?.containingTerminalOwnerId !== undefined &&
      owner !== undefined &&
      (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) &&
      isBoundedPreparedNestedOrdinaryClass(owner);
    const selectedTopLevelStaticAccessorBody = staticAccessorBody && terminal?.containingTerminalOwnerId === undefined;
    if (
      (selectedUnitIds ? selectedUnitIds.has(claim.unitId) : selectedNames.has(claim.legacyMatchName)) &&
      (terminal?.kind === "class-static-method" ||
        ((instanceBody || constructorBody) && instanceHierarchyIsPreparable) ||
        ((instanceBody || constructorBody) && nestedOrdinaryBody && classOwnerIsPreparable) ||
        ((nestedAccessorBody || selectedTopLevelStaticAccessorBody) && classOwnerIsPreparable)) &&
      declaration !== undefined &&
      (ts.isMethodDeclaration(declaration) ||
        ts.isGetAccessorDeclaration(declaration) ||
        ts.isSetAccessorDeclaration(declaration) ||
        (implicitConstructorBody && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) ||
        (ts.isConstructorDeclaration(declaration) && constructorHasIrSafeReceiverSemantics(declaration))) &&
      (implicitConstructorBody || !containsNestedExecutableSyntax(declaration as ts.FunctionLikeDeclaration))
    ) {
      memberUnitIds.add(claim.unitId);
    }
  }
  return memberUnitIds;
}

/** Compatibility projection retained for name-keyed preparation callers. */
export function selectPreparedClassMemberNames(
  ctx: CodegenContext,
  selection: Pick<IrSelection, "classMembers" | "classMemberUnitIds">,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): ReadonlySet<string> {
  const unitIds = selectPreparedClassMemberUnitIds(ctx, selection, identityPlan);
  return new Set(
    [...unitIds].map((unitId) => {
      const claim = identityPlan.identitySelection.classMembers?.get(unitId);
      if (!claim) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `prepared class member ${unitId} has no exact structural claim`,
        );
      }
      return claim.legacyMatchName;
    }),
  );
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
    const retryableEvidence =
      (evidence?.kind === "patched" && evidence.preparedComponentId === undefined) ||
      (evidence?.kind === "failed" && evidence.error.outcome.kind === "unsupported");
    if (!claim || !retryableEvidence) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `deferred prepared component ${unitId} has no exact retryable owner evidence`,
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
    const ownerEvidence = report.terminalEvidence.find(
      (evidence) => evidence.unitId === deferredDerivedArtifact.terminalOwnerUnitId,
    );
    const detail =
      ownerEvidence?.kind === "failed"
        ? `: ${ownerEvidence.error.outcome.code}: ${ownerEvidence.error.outcome.detail}`
        : "";
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `unsealed prepared owner ${deferredDerivedArtifact.terminalOwnerUnitId} produced derived artifact ${deferredDerivedArtifact.artifactUnitId}${detail}`,
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

function r2StableSignatureType(
  type: IrType | null,
  options?: { readonly allowOpaqueExternrefValue?: boolean },
): boolean {
  if (type === null || type.kind === "string") return true;
  // #2951 generator owners — the source return contract of a `function*` is the
  // opaque generator object, which both front-ends project to the same physical
  // `externref`. Only the generator admission path opts in; every other owner
  // keeps the narrower vocabulary so an unproven reference contract cannot
  // silently enter preparation.
  if (options?.allowOpaqueExternrefValue === true && asVal(type)?.kind === "externref") return true;
  // #3522 returned-closure ownership — an exact callable source boundary is
  // the same canonical externref contract in both backends. Admit the owner to
  // prepare-before-emit so its inventoried lifted literal is allocated inside
  // the sealed component instead of relying on a direct-body closure slot.
  if (type.kind === "callable") return true;
  // #3522 Builtins retirement — opaque host-class contracts have one
  // backend-independent physical representation in the JS-host lane:
  // externref. Admission is still fail-closed because
  // r2SignatureMatchesAllocatedSlot compares that projection with the exact
  // Program ABI slot before preparation can replace the direct body.
  if (type.kind === "extern") return true;
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

function prepareClassConstructorSupports(ctx: CodegenContext, classShapes: ReadonlyMap<string, IrClassShape>): void {
  for (const shape of classShapes.values()) {
    const target = shape.constructorTarget;
    if (target?.binding.kind !== "support") continue;
    if (!ctx.programAbiClassCallables) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared class constructor ${shape.classId} has no class-callable ABI registry`,
      );
    }
    ctx.programAbiClassCallables.prepareSupport(target.binding.bindingId);
  }
}

function identifierIsRuntimeFunctionValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent) && parent.expression === identifier) return false;
  // The direct owner already lowers an immediately invoked `.call` / `.apply`
  // without retaining a generic runtime function value. Preparing singleton
  // support for this receiver alone would keep the JS-string bridge and the
  // whole generic closure surface alive in an otherwise tiny optimized module.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === identifier &&
    (parent.name.text === "call" || parent.name.text === "apply") &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return false;
  }
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
): ReadonlyMap<string, readonly { readonly declaration: ts.FunctionDeclaration; readonly unitId: IrUnitId }[]> {
  const byName = new Map<string, { readonly declaration: ts.FunctionDeclaration; readonly unitId: IrUnitId }[]>();
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
    const units = byName.get(statement.name.text) ?? [];
    units.push({ declaration: statement, unitId });
    byName.set(statement.name.text, units);
  }
  return byName;
}

/**
 * The checker oracle can retain a declaration node from a sibling Program
 * snapshot while selection walks the structurally identical current source.
 * Compare the stable source site as well as object identity so incremental
 * compilation cannot silently lose an otherwise exact declaration match.
 */
function sameDeclarationSite(left: ts.Declaration, right: ts.Declaration): boolean {
  if (left === right) return true;
  return (
    left.kind === right.kind &&
    left.pos === right.pos &&
    left.end === right.end &&
    left.getSourceFile().fileName === right.getSourceFile().fileName
  );
}

function identifierResolvesToDeclaration(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  declaration: ts.Declaration,
): boolean {
  const resolved = ctx.oracle.valueDeclarationOf(identifier);
  return resolved !== undefined && sameDeclarationSite(resolved, declaration);
}

function collectTopLevelFunctionValueTargets(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  unitsByName: ReadonlyMap<
    string,
    readonly { readonly declaration: ts.FunctionDeclaration; readonly unitId: IrUnitId }[]
  >,
): ReadonlySet<IrUnitId> {
  const targets = new Set<IrUnitId>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && identifierIsRuntimeFunctionValueReference(node)) {
      const declaration = ctx.oracle.valueDeclarationOf(node);
      const exact =
        declaration === undefined
          ? undefined
          : (unitsByName.get(node.text) ?? []).find((unit) => sameDeclarationSite(unit.declaration, declaration));
      if (exact) targets.add(exact.unitId);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

/**
 * A source that observes the active `caller` of one of its own functions keeps
 * every runtime-materialized top-level function direct. The caller-strictness
 * hand-off is a source-wide call contract: preparing a different callable in
 * the same script can still change the final direct-call instrumentation and
 * therefore the observed activation. The observing function is withheld by
 * its own poison-pill guard below; this gate only withholds the runtime-
 * materialized sibling population. Unrelated source functions remain eligible.
 */
function sourceObservesCurrentFunctionCaller(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.body !== undefined &&
      containsCurrentFunctionPoisonPillRead(ctx, statement),
  );
}

/** Function-value targets that must stay on the direct caller-activation route. */
export function collectDirectCallerActivationTargetUnitIds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): ReadonlySet<IrUnitId> {
  if (!sourceObservesCurrentFunctionCaller(ctx, sourceFile)) return new Set<IrUnitId>();
  return collectTopLevelFunctionValueTargets(ctx, sourceFile, topLevelFunctionUnitsByName(sourceFile, identityPlan));
}

/** Exact top-level source callables materialized as runtime values anywhere in this source. */
export function collectPreparedTopLevelFunctionValueTargetUnitIds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): ReadonlySet<IrUnitId> {
  return collectTopLevelFunctionValueTargets(ctx, sourceFile, topLevelFunctionUnitsByName(sourceFile, identityPlan));
}

function containsTopLevelFunctionValueReference(
  ctx: CodegenContext,
  declaration: ts.FunctionLikeDeclaration,
  unitsByName: ReadonlyMap<
    string,
    readonly { readonly declaration: ts.FunctionDeclaration; readonly unitId: IrUnitId }[]
  >,
): boolean {
  if (!declaration.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && identifierIsRuntimeFunctionValueReference(node)) {
      const valueDeclaration = ctx.oracle.valueDeclarationOf(node);
      if (
        valueDeclaration !== undefined &&
        (unitsByName.get(node.text) ?? []).some((unit) => sameDeclarationSite(unit.declaration, valueDeclaration))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return found;
}

/**
 * The direct backend currently owns ES5 Function `caller` / `arguments`
 * activation semantics. In particular, a sloppy function that reads its own
 * `caller` observes the direct-eval call boundary through the caller-strictness
 * hand-off. Preparing that body without an equivalent IR activation contract
 * turns the function-value support added below into a semantic regression.
 *
 * Keep only the exact current-function poison-pill shape direct. Unrelated
 * property reads named `caller` / `arguments` and ordinary function-value
 * targets remain eligible for Prepared IR.
 */
function containsCurrentFunctionPoisonPillRead(ctx: CodegenContext, declaration: ts.FunctionLikeDeclaration): boolean {
  if (!declaration.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    let receiver: ts.Expression | undefined;
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name)) {
      receiver = node.expression;
      name = node.name.text;
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        receiver = node.expression;
        name = key.text;
      }
    }
    if (
      receiver !== undefined &&
      (name === "caller" || name === "arguments") &&
      ts.isIdentifier(receiver) &&
      (identifierResolvesToDeclaration(ctx, receiver, declaration) ||
        (declaration.name !== undefined &&
          ts.isIdentifier(declaration.name) &&
          receiver.text === declaration.name.text))
    ) {
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

function r2StableValType(
  ctx: CodegenContext,
  type: IrType,
  options?: { readonly allowOpaqueExternrefValue?: boolean },
): ValType | undefined {
  if (type.kind === "extern" || type.kind === "callable") return { kind: "externref" };
  if (options?.allowOpaqueExternrefValue === true && asVal(type)?.kind === "externref") {
    return { kind: "externref" };
  }
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
 * #2951 — IR-claimed generators compile once only in the JS-host lane. The
 * standalone / WASI / no-host-import lanes lower generators through the
 * disjoint #680 sequential-numeric-yield native carrier, whose self-sufficiency
 * without the legacy body is unproven; keep them on the compile-twice route.
 * Mirrors the `generatorsSkippable` condition of the inherited allowlist.
 */
function generatorsPreparable(ctx: CodegenContext): boolean {
  return !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports);
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
  options?: { readonly allowOpaqueExternrefValue?: boolean },
): boolean {
  const func = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") return false;
  const params = override.params.map((type) => r2StableValType(ctx, type, options));
  const result = override.returnType === null ? null : r2StableValType(ctx, override.returnType, options);
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
 * (#4514) The narrow value vocabulary whose physical carrier is fixed by the
 * declaration alone, with no decision the prepared component could re-plan:
 * `void`, `f64`/`i32` scalars, `string` (one `nativeStrings`-keyed carrier both
 * front-ends read from the same two context fields), and a vector of those
 * scalars (one interned vec type). Deliberately EXCLUDES `callable`, `extern`
 * and the generator-only opaque-externref admission that
 * `r2StableSignatureType` accepts: those are reference-shaped contracts whose
 * carrier a prepared component may still re-plan, so they must not inherit an
 * outside-caller exemption.
 */
function r2CarrierFixedByDeclaration(type: IrType | null): boolean {
  if (type === null || type.kind === "string") return true;
  if (type.kind === "vec") {
    const element = asVal(type.elementType);
    return element?.kind === "f64" || element?.kind === "i32";
  }
  const val = asVal(type);
  return val?.kind === "f64" || val?.kind === "i32";
}

/**
 * (#4514) Keep a prepared owner beside an outside caller only when its callable
 * signature cannot diverge. The caller already targets the allocated Program
 * ABI slot, so this predicate re-proves that slot at the exemption point:
 *
 * 1. every parameter and the return carrier is fixed by the declaration
 *    (`r2CarrierFixedByDeclaration`), so the prepared component has no carrier
 *    decision left to re-plan; and
 * 2. the prepared projection still equals the allocated slot's function type
 *    (`r2SignatureMatchesAllocatedSlot`, no opaque-externref widening).
 *
 * Same proof shape as `hasFullyAnnotatedScalarAbi`
 * (`src/codegen/ir-legacy-caller-abi.ts`), which already exempts this family
 * from the select-stage caller-direction closure. It is intentionally narrower
 * than R2 admission: admission may accept reference contracts this exemption
 * refuses.
 *
 * The other three fixed-point directions are NOT covered by this proof and stay
 * untouched — the callee edge (a prepared body needs a callable plan for what
 * it calls), the construction edge (#4494, `new C()` seals an exact unit-bound
 * dependency) and the storage edge (#4508, a module-binding read pins the
 * module-init terminal). Those are lowerability/sealing constraints, not
 * signature ones.
 */
function r2CertifiedAgainstOutsideCallers(
  ctx: CodegenContext,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
): boolean {
  if (!override.params.every((type) => r2CarrierFixedByDeclaration(type))) return false;
  if (!r2CarrierFixedByDeclaration(override.returnType)) return false;
  return r2SignatureMatchesAllocatedSlot(ctx, unitId, override);
}

/**
 * (#4514) Names a NON-top-level function declaration also declares.
 *
 * The signature proof above says nothing about support bindings drafted for an
 * owner AFTER its component seals, and annexB web-compat function hoisting
 * (B.3.3.2 `CanDeclareGlobalFunction`) is exactly that shape: a block-scoped
 * `function f` beside a top-level `function f` drafts a
 * `function-value-trampoline` on the top-level unit at hoist time, which throws
 * `would mutate sealed prepared scope`. Measured — the eight
 * `annexB/language/global-code/*-global-existing-fn-no-init.js` regressions in
 * the #4627 merge_group run were all and only this shape; an ordinary
 * function-value reference from a withdrawn caller is fine, and so is a nested
 * declaration whose name is unique.
 *
 * Deliberately over-approximate: EVERY non-top-level function-declaration name
 * is collected, not just the ones that provably redeclare a top-level unit.
 * This only ever removes an exemption, so an over-approximation costs
 * compile-once on an unusual shape and can never admit an unsound one.
 */
function collectNestedFunctionDeclarationNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && !ts.isSourceFile(node.parent)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return names;
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

function r3SuspendingAsyncParamValType(ctx: CodegenContext, type: IrType): ValType | undefined {
  const scalar = asVal(type);
  if (scalar?.kind === "f64") return scalar;
  if (type.kind !== "vec" || asVal(type.elementType)?.kind !== "f64") return undefined;
  const vecTypeIdx = ctx.vecTypeMap.get("f64");
  return vecTypeIdx === undefined ? undefined : { kind: type.nullable ? "ref_null" : "ref", typeIdx: vecTypeIdx };
}

/** Exact numeric fulfillment ABI projected onto a Promise callable slot. */
function r3SuspendingAsyncSignatureMatchesAllocatedSlot(
  ctx: CodegenContext,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
  allowVoidFulfillment = false,
): boolean {
  const params = override.params.map((type) => r3SuspendingAsyncParamValType(ctx, type));
  if (params.some((type) => type === undefined)) {
    return false;
  }
  const fulfillmentMatches =
    (override.returnType !== null && asVal(override.returnType)?.kind === "f64") ||
    (allowVoidFulfillment && override.returnType === null);
  if (!fulfillmentMatches) return false;
  const func = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  return (
    signature?.kind === "func" &&
    signature.params.length === override.params.length &&
    signature.params.every((type, index) => sameValType(type, params[index]!)) &&
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
  const functionValueTargets = collectTopLevelFunctionValueTargets(input.ctx, input.sourceFile, functionUnitsByName);
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
      containsTopLevelFunctionValueReference(input.ctx, claim.declaration, functionUnitsByName) ||
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
  readonly preparedDependencyLegacyNames: ReadonlySet<string>;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): ReadonlySet<string> {
  const functionUnitsByName = topLevelFunctionUnitsByName(input.sourceFile, input.identityPlan);
  const functionValueTargets = collectTopLevelFunctionValueTargets(input.ctx, input.sourceFile, functionUnitsByName);
  const callEdges = collectLocalCallEdgesByIdentity(input.sourceFile, input.identityPlan.identityContext);
  const selected = new Set<string>();
  const prepared = new Set(input.preparedDependencyLegacyNames);
  for (let changed = true; changed; ) {
    changed = false;
    const additions: string[] = [];
    const dependencySelection: IrSelection = {
      funcs: new Set(prepared),
      classMembers: new Set(),
      moduleInit: undefined,
    };
    const preparedDependencyUnitIds = new Set(
      [...prepared].map((legacyName) =>
        irOverlayIdentity.requireIrOverlayFunctionUnitId(input.identityPlan, legacyName),
      ),
    );
    for (const legacyName of input.selectedLegacyNames) {
      if (selected.has(legacyName)) continue;
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
      const sourceShape = preparedIrAsyncSourceShape(input.ctx, claim.declaration);
      if (
        containsNestedExecutableSyntax(claim.declaration) ||
        functionValueTargets.has(unitId) ||
        containsTopLevelFunctionValueReference(input.ctx, claim.declaration, functionUnitsByName) ||
        !r3SuspendingAsyncSignatureMatchesAllocatedSlot(input.ctx, unitId, override, sourceShape?.kind === "final-main")
      ) {
        continue;
      }
      if (!sourceShape || !preparedIrAsyncSourceCanSuspend(input.ctx, claim.declaration)) continue;
      const sourceCallees = callEdges.callees.get(unitId) ?? new Set<IrUnitId>();
      if ([...sourceCallees].some((calleeUnitId) => !preparedDependencyUnitIds.has(calleeUnitId))) continue;
      const candidatePlans = input.projectLoweringPlans({
        ...dependencySelection,
        funcs: new Set([...dependencySelection.funcs, legacyName]),
      });
      const unitCalls = [...candidatePlans.directCalls.values()].filter(
        (call) => call.ownerUnitId === unitId && call.target.binding.kind === "unit",
      );
      if (
        unitCalls.some(
          (call) => call.target.binding.kind !== "unit" || !preparedDependencyUnitIds.has(call.target.binding.unitId),
        )
      ) {
        continue;
      }
      if (sourceShape.kind === "identity") {
        const awaitedCall = candidatePlans.directCalls.get(sourceShape.awaitedCall);
        if (
          awaitedCall?.ownerUnitId !== unitId ||
          awaitedCall.target.binding.kind !== "unit" ||
          !preparedDependencyUnitIds.has(awaitedCall.target.binding.unitId)
        ) {
          continue;
        }
      } else if (unitCalls.length === 0) {
        continue;
      }
      additions.push(legacyName);
    }
    for (const legacyName of additions) {
      selected.add(legacyName);
      prepared.add(legacyName);
      changed = true;
    }
  }
  return selected;
}

/** Reconcile the final async fixed point with whole-source IR ownership. */
export function finalizeR3PreparedOwnerPopulation(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly plan: IrOverlayPreparationPlan & {
    readonly suspendingAsyncUnitIds: ReadonlySet<IrUnitId>;
    readonly functionClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
    readonly overrideMapByUnitId: ReadonlyMap<
      IrUnitId,
      { readonly params: readonly IrType[]; readonly returnType: IrType | null }
    >;
  };
  readonly selection: IrSelection;
  readonly preliminaryClassMemberUnitIds: ReadonlySet<IrUnitId>;
  readonly preliminaryR2Names: ReadonlySet<string>;
  readonly promiseDelayNames: ReadonlySet<string>;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): {
  readonly selection: IrSelection;
  readonly classMemberNames: ReadonlySet<string>;
  readonly classMemberUnitIds: ReadonlySet<IrUnitId>;
  readonly freeFunctionNames: ReadonlySet<string>;
} {
  let selection = input.selection;
  const selectClassMemberPopulation = (): {
    readonly unitIds: ReadonlySet<IrUnitId>;
    readonly names: ReadonlySet<string>;
  } => {
    const selectedUnitIds = selectPreparedClassMemberUnitIds(input.ctx, selection, input.plan.identityPlan);
    const unitIds = new Set([...selectedUnitIds].filter((unitId) => input.preliminaryClassMemberUnitIds.has(unitId)));
    const missing = [...input.preliminaryClassMemberUnitIds].filter((unitId) => !unitIds.has(unitId));
    if (missing.length > 0) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `R3 final-context preparation changed preflight-certified class-member UnitIds: ${missing.join(", ")}`,
      );
    }
    const names = selectPreparedClassMemberNames(
      input.ctx,
      { classMembers: selection.classMembers, classMemberUnitIds: unitIds },
      input.plan.identityPlan,
    );
    return { unitIds, names };
  };
  let classMemberPopulation = selectClassMemberPopulation();

  let suspendingAsyncNames = selectR3PreparedSuspendingAsyncFunctions({
    ctx: input.ctx,
    sourceFile: input.sourceFile,
    selectedLegacyNames: selection.funcs,
    identityPlan: input.plan.identityPlan,
    claimsByUnitId: input.plan.functionClaimsByUnitId,
    overridesByUnitId: input.plan.overrideMapByUnitId,
    suspendingAsyncUnitIds: input.plan.suspendingAsyncUnitIds,
    preparedDependencyLegacyNames: new Set([...input.preliminaryR2Names, ...input.promiseDelayNames]),
    projectLoweringPlans: input.projectLoweringPlans,
  });
  const rejectedUnitIds = new Set(
    [...input.plan.suspendingAsyncUnitIds].filter((unitId) => {
      const claim = input.plan.functionClaimsByUnitId.get(unitId);
      if (!claim) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `R3 suspending async candidate ${unitId} has no exact function claim`,
        );
      }
      return !suspendingAsyncNames.has(claim.legacyName);
    }),
  );
  if (rejectedUnitIds.size > 0) {
    const retainedUnitIds = closeIrBlockedComponentByIdentity(
      input.sourceFile,
      input.plan.identityPlan.identityContext,
      input.plan.identityPlan.safeFunctionUnitIds,
      rejectedUnitIds,
    );
    selection = applyIrFinalContextFunctionUnitIds(input.plan, selection, retainedUnitIds);
    classMemberPopulation = selectClassMemberPopulation();
    suspendingAsyncNames = new Set([...suspendingAsyncNames].filter((name) => selection.funcs.has(name)));
  }
  return {
    selection,
    classMemberNames: classMemberPopulation.names,
    classMemberUnitIds: classMemberPopulation.unitIds,
    freeFunctionNames: new Set(
      [...input.preliminaryR2Names, ...input.promiseDelayNames, ...suspendingAsyncNames].filter((name) =>
        selection.funcs.has(name),
      ),
    ),
  };
}

/**
 * R2/R3 prepare only components whose free-function and class-member contracts
 * have one backend-stable Program ABI projection: scalars, strings, selected
 * vectors, and opaque JS-host externrefs. Other reference-shaped contracts,
 * fast-mode grounded numerics, and async/generator frames still require direct
 * discovery and remain on the post-direct overlay. Nested callable syntax
 * inside an otherwise admitted owner does not by itself block that owner.
 */
export function selectR2PreparedOwnerComponents(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selectedLegacyNames: ReadonlySet<string>;
  readonly baselineLegacyNames: ReadonlySet<string>;
  readonly classMemberUnitIds: ReadonlySet<IrUnitId>;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overridesByUnitId: ReadonlyMap<
    IrUnitId,
    { readonly params: readonly IrType[]; readonly returnType: IrType | null }
  >;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly timerShimUnitIds?: ReadonlySet<IrUnitId>;
  /**
   * (#4508) Storage terminals this transaction actually prepares — today the
   * module-init unit, and only when `preparedExactLexicalModuleInit` admitted
   * it. Empty on every lane that refuses a prepared module-init.
   */
  readonly preparedStorageTerminalUnitIds: ReadonlySet<IrUnitId>;
}): {
  readonly freeFunctionNames: ReadonlySet<string>;
  readonly classMemberUnitIds: ReadonlySet<IrUnitId>;
} {
  const freeFunctionCandidates = new Set<IrUnitId>();
  const baseline = new Set<IrUnitId>();
  const functionUnitsByName = topLevelFunctionUnitsByName(input.sourceFile, input.identityPlan);
  const directCallerActivationTargets = collectDirectCallerActivationTargetUnitIds(
    input.ctx,
    input.sourceFile,
    input.identityPlan,
  );
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
      freeFunctionCandidates.add(unitId);
      continue;
    }
    const isAsync = claim.declaration.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    const isGenerator = claim.declaration.asteriskToken !== undefined;
    // #2951 — a JS-host generator owner returns the opaque generator object.
    // Admit that one reference contract for generators only; the standalone /
    // WASI / no-host-import lanes keep the compile-twice route because their
    // legacy lowering is the disjoint #680 native carrier.
    const signatureOptions = isGenerator ? { allowOpaqueExternrefValue: true } : undefined;
    if (
      input.ctx.fast ||
      isAsync ||
      (isGenerator && !generatorsPreparable(input.ctx)) ||
      containsUnplannedNestedExecutableSyntax(claim.declaration, unitId, claim.legacyName, input.hostVoidCallbacks) ||
      containsCurrentFunctionPoisonPillRead(input.ctx, claim.declaration) ||
      directCallerActivationTargets.has(unitId) ||
      containsTopLevelFunctionValueReference(input.ctx, claim.declaration, functionUnitsByName) ||
      !override.params.every((type) => r2StableSignatureType(type, signatureOptions)) ||
      !r2StableSignatureType(override.returnType, signatureOptions) ||
      !r2SignatureMatchesAllocatedSlot(input.ctx, unitId, override, signatureOptions)
    ) {
      continue;
    }
    freeFunctionCandidates.add(unitId);
  }

  // Close free functions and class members together. A class-to-free edge is
  // safe only when both endpoints survive the same bidirectional ownership
  // fixed point; preparing either family in isolation would leave an exact
  // source call without a callable plan or retain a legacy caller.
  const candidates = new Set<IrUnitId>([...freeFunctionCandidates, ...input.classMemberUnitIds]);
  const callEdges = collectLocalCallEdgesByIdentity(input.sourceFile, input.identityPlan.identityContext);
  const callers = new Map<IrUnitId, Set<IrUnitId>>();
  for (const [callerUnitId, calleeUnitIds] of callEdges.callees) {
    for (const calleeUnitId of calleeUnitIds) {
      const owners = callers.get(calleeUnitId) ?? new Set<IrUnitId>();
      owners.add(callerUnitId);
      callers.set(calleeUnitId, owners);
    }
  }
  // (#4514) Free-function owners whose ABI an outside caller provably cannot
  // observe changing. Computed once, before the fixed point: the inputs are the
  // admission-time override and the already-allocated slot, neither of which
  // the fixed point mutates. Class members are absent by construction — their
  // admission never ran the R2 signature proofs.
  const nestedFunctionDeclarationNames = collectNestedFunctionDeclarationNames(input.sourceFile);
  const outsideCallerCertifiedUnitIds = new Set<IrUnitId>(
    [...freeFunctionCandidates].filter((unitId) => {
      const override = input.overridesByUnitId.get(unitId);
      const claim = input.claimsByUnitId.get(unitId);
      if (override === undefined || claim === undefined) return false;
      // Support bindings drafted after the component seals are outside what the
      // signature proof covers; annexB block-function hoisting is that shape.
      if (claim.declaration.name && nestedFunctionDeclarationNames.has(claim.declaration.name.text)) return false;
      if (timerShimOutsideCaller(input, unitId, override, r2SignatureMatchesAllocatedSlot)) return true;
      return r2CertifiedAgainstOutsideCallers(input.ctx, unitId, override);
    }),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const unitId of [...candidates]) {
      if (baseline.has(unitId)) continue;
      const crossesOwnership =
        callEdges.calleesFromUnownedCallers.has(unitId) ||
        [...(callEdges.callees.get(unitId) ?? [])].some((calleeUnitId) => !candidates.has(calleeUnitId)) ||
        // (#4494) claim ⇔ PREPARABILITY parity. `new C()` makes this owner
        // execute `C`'s explicit constructor chain, and sealing records that as
        // an exact unit-bound dependency. Withdrawing the constructing owner
        // here — before it can claim — is a clean per-unit demotion; leaving it
        // in produces a component that always fails closed on
        // `foreign-source-unit` and degrades the whole prepared owner after the
        // claim. Only this direction is checked: a constructor does not need its
        // constructing callers co-prepared.
        [...(callEdges.constructionCallees.get(unitId) ?? [])].some(
          (constructedUnitId) => !candidates.has(constructedUnitId),
        ) ||
        // (#4508) The second parity edge #4494's follow-up named. Reading a
        // top-level binding pins the module-init storage terminal, and
        // `recordGlobalReference` fails that read closed with
        // `source-global-outside-component` whenever the module-init is outside
        // the transaction. Resolved against the prepared STORAGE terminals, not
        // `candidates`: the module-init is never a member of the free/class
        // candidate population, so testing `candidates` would withdraw every
        // reader unconditionally. Only this direction is checked — the
        // module-init does not need its readers co-prepared. A forward-only
        // SECOND closure was measured instead and is UNSOUND: it leaves a direct
        // reader beside a still-prepared component, whose late-discovered
        // runtime providers then break the frozen prepared ABI
        // (`callable provider … discovered after prepared provider planning`).
        [...(callEdges.moduleBindingStorageTerminals.get(unitId) ?? [])].some(
          (storageUnitId) => !input.preparedStorageTerminalUnitIds.has(storageUnitId),
        ) ||
        // (#4514) Reverse-callers edge, directionally refined. An outside
        // caller is a SIGNATURE hazard: its `call` is emitted against this
        // unit's allocated Program ABI slot, so preparation must not re-plan
        // that slot. `outsideCallerCertifiedUnitIds` proves it cannot for the
        // declaration-fixed carrier family; every other unit still withdraws.
        // Without this refinement one withdrawn caller drags its whole callee
        // fan-out out of the component — #4508's enlarged `algorithms.ts`
        // component lost compile-once for `fibIter`, `binarySearch`,
        // `quicksort` and `joinNums` that way, none of which had any other
        // blocking edge (measured; see the issue file).
        (!outsideCallerCertifiedUnitIds.has(unitId) &&
          [...(callers.get(unitId) ?? [])].some((callerUnitId) => !candidates.has(callerUnitId)));
      if (!crossesOwnership) continue;
      candidates.delete(unitId);
      changed = true;
    }
  }

  const freeFunctionNames = new Set(
    [...candidates]
      .filter((unitId) => freeFunctionCandidates.has(unitId))
      .map((unitId) => {
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
  return {
    freeFunctionNames,
    classMemberUnitIds: new Set([...input.classMemberUnitIds].filter((unitId) => candidates.has(unitId))),
  };
}

/**
 * Retype only exact selected top-level setters for the prepared transaction.
 * Collection keeps the direct ABI untouched. Once the exact claim enters ABI
 * preparation, the selected dynamic contract remains authoritative even when
 * typed preparation later withdraws the body to direct emission.
 */
function stageSelectedTopLevelAccessorSetterAbis(input: {
  readonly ctx: CodegenContext;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly unitIds: ReadonlySet<IrUnitId>;
  readonly classShapesById: ReadonlyMap<IrClassId, IrClassShape>;
}): ReadonlySet<IrUnitId> {
  const candidates: {
    readonly unitId: IrUnitId;
    readonly allocated: WasmFunction;
    readonly selfParam: ValType;
  }[] = [];
  for (const unitId of input.unitIds) {
    const terminal = input.identityPlan.identityContext.terminalByUnitId.get(unitId);
    if (
      (terminal?.kind !== "class-instance-setter" && terminal?.kind !== "class-static-setter") ||
      terminal.containingTerminalOwnerId !== undefined
    ) {
      continue;
    }
    const declaration = input.identityPlan.identityContext.declarationByUnitId.get(unitId);
    const owner = declaration?.parent;
    if (
      !owner ||
      !ts.isClassDeclaration(owner) ||
      !ts.isSourceFile(owner.parent) ||
      !isBoundedPreparedAccessorClass(owner)
    ) {
      continue;
    }
    const classId = input.identityPlan.identityContext.classIdByDeclaration.get(owner);
    const shape = classId === undefined ? undefined : input.classShapesById.get(classId);
    const descriptors = shape?.methods.filter(
      (descriptor) =>
        descriptor.memberKind === "setter" &&
        descriptor.placement?.unitId === unitId &&
        descriptor.placement.classId === classId &&
        descriptor.params.length === 1 &&
        descriptor.params[0]?.kind === "dynamic",
    );
    const allocated = input.ctx.programAbiClassCallables?.functionForUnit(unitId);
    const signature = allocated === undefined ? undefined : input.ctx.mod.types[allocated.typeIdx];
    if (
      declaration === undefined ||
      !ts.isSetAccessorDeclaration(declaration) ||
      declaration.parameters.length !== 1 ||
      declaration.parameters[0]!.type !== undefined ||
      descriptors?.length !== 1 ||
      !allocated ||
      !signature ||
      signature.kind !== "func" ||
      signature.params.length !== 2 ||
      signature.results.length !== 0
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `selected top-level accessor setter ${unitId} has no exact dynamic descriptor / callable ABI`,
      );
    }
    candidates.push({ unitId, allocated, selfParam: signature.params[0]! });
  }

  // Validate the complete selected population before changing any callable.
  // Reserving all replacement types first also keeps a registry/type-allocation
  // failure from leaving only a prefix of the callable population retyped.
  if (candidates.length === 0) return new Set();
  const dynamicCarrier = resolveIrDynamicCarrierType(input.ctx);
  const staged = candidates.map((candidate) => ({
    ...candidate,
    typeIdx: addFuncType(input.ctx, [candidate.selfParam, dynamicCarrier], [], `${candidate.allocated.name}_type`),
  }));
  for (const candidate of staged) candidate.allocated.typeIdx = candidate.typeIdx;
  return new Set(staged.map(({ unitId }) => unitId));
}

interface PreparedIrClassMemberPopulation {
  readonly memberNames: ReadonlySet<string>;
  readonly memberUnitIds: ReadonlySet<IrUnitId>;
  readonly claimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>;
}

/** Reserve the exact class ABI needed by one combined prepared-body transaction. */
function prepareIrClassMemberPopulation(input: {
  readonly ctx: CodegenContext;
  readonly selection: Pick<IrSelection, "classMembers" | "classMemberUnitIds">;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly classShapesById: ReadonlyMap<IrClassId, IrClassShape>;
}): PreparedIrClassMemberPopulation | undefined {
  const memberUnitIds = selectPreparedClassMemberUnitIds(input.ctx, input.selection, input.identityPlan);
  const memberNames = new Set<string>();
  const claimsByUnitId = new Map<IrUnitId, IrExactBodyClaim>();
  for (const claim of input.identityPlan.identitySelection.classMembers?.values() ?? []) {
    if (!memberUnitIds.has(claim.unitId)) continue;
    if (claimsByUnitId.has(claim.unitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared class member ${claim.unitId} / ${claim.legacyMatchName} has a duplicate structural claim`,
      );
    }
    claimsByUnitId.set(claim.unitId, { unitId: claim.unitId, legacyName: claim.legacyMatchName });
    memberNames.add(claim.legacyMatchName);
  }
  if (claimsByUnitId.size === 0) return undefined;
  const classLayouts = new Set<IrClassId>();
  const shapeByClassId = input.classShapesById;
  for (const unitId of claimsByUnitId.keys()) {
    const terminal = input.identityPlan.identityContext.terminalByUnitId.get(unitId);
    if (terminal?.kind === "class-static-method") continue;
    if (
      terminal?.kind !== "class-constructor" &&
      terminal?.kind !== "class-implicit-constructor" &&
      terminal?.kind !== "class-instance-method" &&
      terminal?.kind !== "class-instance-getter" &&
      terminal?.kind !== "class-instance-setter" &&
      terminal?.kind !== "class-static-getter" &&
      terminal?.kind !== "class-static-setter"
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared class member ${unitId} has no layout-bearing terminal kind`,
      );
    }
    const declaration = input.identityPlan.identityContext.declarationByUnitId.get(unitId);
    const owner = terminal.kind === "class-implicit-constructor" ? declaration : declaration?.parent;
    const classId =
      owner !== undefined && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner))
        ? input.identityPlan.identityContext.classIdByDeclaration.get(owner)
        : undefined;
    if (!classId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared instance member or constructor ${unitId} has no exact class-layout owner`,
      );
    }
    let shape = shapeByClassId.get(classId);
    while (shape) {
      classLayouts.add(shape.classId);
      shape = shape.parent;
    }
  }
  if (classLayouts.size > 0 && !input.ctx.programAbiTypes) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared instance members and constructors require one exact class-layout ABI registry",
    );
  }
  // The combined free/class build can still finalize one of these allocator-
  // owned structs. Dependency sealing publishes every referenced layout from
  // the final post-pass IR, after that mutation window has closed.
  prepareClassConstructorSupports(input.ctx, input.classShapes);
  for (const unitId of claimsByUnitId.keys()) {
    const terminal = input.identityPlan.identityContext.terminalByUnitId.get(unitId);
    if (terminal?.kind !== "class-constructor" && terminal?.kind !== "class-implicit-constructor") continue;
    const declaration = input.identityPlan.identityContext.declarationByUnitId.get(unitId);
    const owner = terminal.kind === "class-implicit-constructor" ? declaration : declaration?.parent;
    const classId =
      owner !== undefined && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner))
        ? input.identityPlan.identityContext.classIdByDeclaration.get(owner)
        : undefined;
    const shape = classId === undefined ? undefined : shapeByClassId.get(classId);
    const newTarget = shape?.constructorTarget;
    const initTarget = shape?.constructorInitTarget;
    const layout = classId === undefined ? undefined : input.ctx.programAbiTypes!.layoutForClass(classId);
    if (
      !classId ||
      !shape ||
      newTarget?.binding.kind !== "support" ||
      initTarget?.binding.kind !== "unit" ||
      initTarget.binding.unitId !== unitId ||
      !layout ||
      !input.ctx.programAbiClassCallables
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared constructor ${unitId} has no exact _new support / _init unit transaction`,
      );
    }
    const newFuncIdx = input.ctx.programAbiClassCallables.prepareSupport(newTarget.binding.bindingId);
    const initFuncIdx = input.ctx.programAbiClassCallables.handleForUnit(unitId);
    if (initFuncIdx === undefined) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `prepared constructor ${unitId} has no exact _init allocator`,
      );
    }
    installAstFreeClassConstructorNewWrapper(input.ctx, {
      className: shape.className,
      structTypeIdx: layout.typeIdx,
      fields: layout.type.fields,
      newFuncIdx,
      initFuncIdx,
    });
  }
  return { memberNames, memberUnitIds, claimsByUnitId };
}

function partitionPreparedUnitIds(
  unitIds: ReadonlySet<IrUnitId>,
  freeFunctionClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>,
  classMemberClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>,
  moduleInitClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>,
  routingKind: "IR-owned" | "prepared" | "deferred",
): {
  readonly freeFunctionUnitIds: ReadonlySet<IrUnitId>;
  readonly classMemberUnitIds: ReadonlySet<IrUnitId>;
  readonly moduleInitUnitIds: ReadonlySet<IrUnitId>;
} {
  const freeFunctionUnitIds = new Set<IrUnitId>();
  const classMemberUnitIds = new Set<IrUnitId>();
  const moduleInitUnitIds = new Set<IrUnitId>();
  for (const unitId of unitIds) {
    const freeFunction = freeFunctionClaimsByUnitId.has(unitId);
    const classMember = classMemberClaimsByUnitId.has(unitId);
    const moduleInit = moduleInitClaimsByUnitId.has(unitId);
    const familyCount = Number(freeFunction) + Number(classMember) + Number(moduleInit);
    if (familyCount !== 1) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `${routingKind} prepared body ${unitId} belongs to ${familyCount} routing families`,
      );
    }
    (freeFunction ? freeFunctionUnitIds : classMember ? classMemberUnitIds : moduleInitUnitIds).add(unitId);
  }
  return { freeFunctionUnitIds, classMemberUnitIds, moduleInitUnitIds };
}

/**
 * Prepare free functions and class members in one dependency-sealing
 * transaction. Cross-owner components must see one combined claim denominator;
 * routing either family against only its own claims would reject the other
 * family's evidence and leave otherwise complete components unsealed.
 */
export function prepareIrBodies(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly functionClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly classShapesById: ReadonlyMap<IrClassId, IrClassShape>;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): PreparedIrBodies {
  const freeFunctionNames = new Set(input.selection.funcs);
  const freeFunctionClaimsByUnitId = new Map<IrUnitId, IrExactFunctionClaim>();
  for (const legacyName of freeFunctionNames) {
    const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(input.identityPlan, legacyName);
    const claim = input.functionClaimsByUnitId.get(unitId);
    if (!claim || claim.legacyName !== legacyName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared free function ${unitId} / ${legacyName} has no exact structural claim`,
      );
    }
    freeFunctionClaimsByUnitId.set(unitId, claim);
  }

  const classPopulation = prepareIrClassMemberPopulation({
    ctx: input.ctx,
    selection: {
      classMembers: input.selection.classMembers,
      classMemberUnitIds: input.selection.classMemberUnitIds,
    },
    identityPlan: input.identityPlan,
    classShapes: input.classShapes,
    classShapesById: input.classShapesById,
  });
  if (!classPopulation && freeFunctionNames.size > 0) {
    prepareClassConstructorSupports(input.ctx, input.classShapes);
  }

  const claimsByUnitId = new Map<IrUnitId, IrExactBodyClaim>(freeFunctionClaimsByUnitId);
  for (const [unitId, claim] of classPopulation?.claimsByUnitId ?? []) {
    if (claimsByUnitId.has(unitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared body ${unitId} is claimed by both free-function and class-member families`,
      );
    }
    claimsByUnitId.set(unitId, claim);
  }

  const moduleInitClaimsByUnitId = new Map<IrUnitId, IrExactBodyClaim>();
  if (input.selection.moduleInit?.reason === null && input.selection.moduleInit.stmtCount > 0) {
    const unitId = input.identityPlan.identityContext.moduleInitUnitIdBySourceFile.get(input.sourceFile);
    const terminal = unitId ? input.identityPlan.identityContext.terminalByUnitId.get(unitId) : undefined;
    if (!unitId || terminal?.observedKind !== "module-init" || terminal.legacyMatchName !== MODULE_INIT_UNIT_NAME) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared module initializer has no exact structural claim",
      );
    }
    const claim = { unitId, legacyName: MODULE_INIT_UNIT_NAME };
    moduleInitClaimsByUnitId.set(unitId, claim);
    claimsByUnitId.set(unitId, claim);
  }

  const selection: IrSelection = {
    funcs: freeFunctionNames,
    classMembers: classPopulation?.memberNames ?? new Set<string>(),
    classMemberUnitIds: classPopulation?.memberUnitIds ?? new Set<IrUnitId>(),
    moduleInit: input.selection.moduleInit,
  };
  const implicitConstructorUnitIds = prepareImplicitConstructorSupports({
    ctx: input.ctx,
    sourceFile: input.sourceFile,
    ownerUnitIds: new Set(claimsByUnitId.keys()),
    identityPlan: input.identityPlan,
    classShapes: input.classShapes,
    classShapesById: input.classShapesById,
  });
  const stagedTopLevelAccessorSetterUnitIds = classPopulation
    ? stageSelectedTopLevelAccessorSetterAbis({
        ctx: input.ctx,
        identityPlan: input.identityPlan,
        unitIds: classPopulation.memberUnitIds,
        classShapesById: input.classShapesById,
      })
    : new Set<IrUnitId>();
  const initialReport = withSelectedTopLevelAccessorUnitIds(
    input.identityPlan.identityContext,
    stagedTopLevelAccessorSetterUnitIds,
    (): IrIntegrationReport =>
      claimsByUnitId.size === 0
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
            selection,
            input.overrideMap,
            input.classShapes,
            input.projectLoweringPlans(selection),
            { sealPreparedComponents: true },
          ),
  );
  const timerUnitIds = compilerTimerShimTerminalUnitIds(input.identityPlan.identityContext.inventory);
  const deferUnsupportedUnitIds = new Set([...freeFunctionClaimsByUnitId.keys()].filter((id) => !timerUnitIds.has(id)));
  const routing = preparedIrBodyRouting(initialReport, claimsByUnitId, { deferUnsupportedUnitIds });
  const report = deferUnsealedPreparedComponents(initialReport, routing.deferredUnitIds, claimsByUnitId);
  const classMemberClaimsByUnitId = classPopulation?.claimsByUnitId ?? new Map<IrUnitId, IrExactBodyClaim>();
  const irOwnedPartition = partitionPreparedUnitIds(
    routing.irOwnedUnitIds,
    freeFunctionClaimsByUnitId,
    classMemberClaimsByUnitId,
    moduleInitClaimsByUnitId,
    "IR-owned",
  );
  const preparedPartition = partitionPreparedUnitIds(
    routing.preparedUnitIds,
    freeFunctionClaimsByUnitId,
    classMemberClaimsByUnitId,
    moduleInitClaimsByUnitId,
    "prepared",
  );
  const deferredPartition = partitionPreparedUnitIds(
    routing.deferredUnitIds,
    freeFunctionClaimsByUnitId,
    classMemberClaimsByUnitId,
    moduleInitClaimsByUnitId,
    "deferred",
  );

  const freeRequestedSkipProjection = buildIrRequestedFunctionSkipProjection(
    irOwnedPartition.freeFunctionUnitIds,
    freeFunctionClaimsByUnitId,
  );
  const freePreparedProjection = buildIrRequestedFunctionSkipProjection(
    preparedPartition.freeFunctionUnitIds,
    freeFunctionClaimsByUnitId,
  );
  const freeDeferredProjection = buildIrRequestedFunctionSkipProjection(
    deferredPartition.freeFunctionUnitIds,
    freeFunctionClaimsByUnitId,
  );
  const freeDeferredBodies = new Set(freeDeferredProjection.entries.map(({ legacyName }) => legacyName));
  const freeFunctions: PreparedIrFreeFunctionBodies = {
    requestedSkipProjection: freeRequestedSkipProjection,
    completedBodies: new Set([...freeFunctionNames].filter((legacyName) => !freeDeferredBodies.has(legacyName))),
    skipBodies: new Set(freeRequestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
    preserveBodies: new Set(freePreparedProjection.entries.map(({ legacyName }) => legacyName)),
  };

  const classRequestedSkipProjection = classPopulation
    ? bodyProjection(irOwnedPartition.classMemberUnitIds, classPopulation.claimsByUnitId)
    : undefined;
  const classPreparedProjection = classPopulation
    ? bodyProjection(preparedPartition.classMemberUnitIds, classPopulation.claimsByUnitId)
    : undefined;
  const classDeferredProjection = classPopulation
    ? bodyProjection(deferredPartition.classMemberUnitIds, classPopulation.claimsByUnitId)
    : undefined;
  const classDeferredBodies = new Set(classDeferredProjection?.entries.map(({ legacyName }) => legacyName) ?? []);
  const moduleClaim = moduleInitClaimsByUnitId.values().next().value as IrExactBodyClaim | undefined;
  const moduleRequestedSkipProjection = moduleClaim
    ? bodyProjection(irOwnedPartition.moduleInitUnitIds, moduleInitClaimsByUnitId)
    : undefined;
  const modulePreparedProjection = moduleClaim
    ? bodyProjection(preparedPartition.moduleInitUnitIds, moduleInitClaimsByUnitId)
    : undefined;
  const moduleDeferredProjection = moduleClaim
    ? bodyProjection(deferredPartition.moduleInitUnitIds, moduleInitClaimsByUnitId)
    : undefined;
  const moduleDeferredBodies = new Set(moduleDeferredProjection?.entries.map(({ legacyName }) => legacyName) ?? []);
  return {
    report,
    freeFunctions,
    implicitConstructorUnitIds,
    ...(classPopulation && classRequestedSkipProjection && classPreparedProjection
      ? {
          classMembers: {
            requestedSkipProjection: classRequestedSkipProjection,
            completedBodies: new Set(
              [...classPopulation.memberNames].filter((legacyName) => !classDeferredBodies.has(legacyName)),
            ),
            skipBodies: new Set(classRequestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
            preserveBodies: new Set(classPreparedProjection.entries.map(({ legacyName }) => legacyName)),
            completedBodyUnitIds: new Set(
              [...classPopulation.memberUnitIds].filter((unitId) => !deferredPartition.classMemberUnitIds.has(unitId)),
            ),
            skipBodyUnitIds: irOwnedPartition.classMemberUnitIds,
            preserveBodyUnitIds: preparedPartition.classMemberUnitIds,
          },
        }
      : {}),
    ...(moduleClaim && moduleRequestedSkipProjection && modulePreparedProjection
      ? {
          moduleInit: {
            unitId: moduleClaim.unitId,
            requestedSkipProjection: moduleRequestedSkipProjection,
            completedBodies: new Set(moduleDeferredBodies.has(MODULE_INIT_UNIT_NAME) ? [] : [MODULE_INIT_UNIT_NAME]),
            skipBodies: new Set(moduleRequestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
            preserveBodies: new Set(modulePreparedProjection.entries.map(({ legacyName }) => legacyName)),
          },
        }
      : {}),
  };
}

/**
 * Compile the population left after prepared bodies and combine both exact
 * terminal reports into the single audit/telemetry input.
 */
export function completePreparedIrIntegration(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly preparedReport?: IrIntegrationReport;
  readonly preparedLegacyNames?: ReadonlySet<string>;
  readonly preparedClassMemberLegacyNames?: ReadonlySet<string>;
  readonly preparedClassMemberUnitIds?: ReadonlySet<IrUnitId>;
  readonly preparedModuleInitLegacyNames?: ReadonlySet<string>;
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
        classMemberUnitIds: new Set(
          [...(input.selection.classMemberUnitIds ?? [])].filter(
            (unitId) => !input.preparedClassMemberUnitIds?.has(unitId),
          ),
        ),
        moduleInit: input.preparedModuleInitLegacyNames?.has(MODULE_INIT_UNIT_NAME)
          ? undefined
          : input.selection.moduleInit,
      }
    : {
        funcs: new Set(input.selection.funcs),
        classMembers: input.selection.classMembers,
        classMemberUnitIds: input.selection.classMemberUnitIds,
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
