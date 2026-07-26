// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import { irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrUnitId } from "../ir/identity.js";
import {
  makeIrIdentityImportedFunctionResolver,
  projectIrIdentityImportedFunctionResolverToLegacy,
  type IrIdentityImportedFunctionResolver,
  type IrIdentityResolvedFunctionTarget,
  type IrImportedFunctionResolver,
  type IrResolvedFunctionTarget,
} from "../ir/imported-functions.js";

export type { IrIdentityImportedFunctionResolver } from "../ir/imported-functions.js";
import { IrInvariantError } from "../ir/outcomes.js";
import {
  buildIrLegacyUnitProjection,
  type IrLegacyUnitProjection,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";
import {
  buildIrUnitTypeMap,
  projectIrUnitTypeMapToLegacy,
  type IrUnitTypeMap,
  type TypeMap,
  type TypeMapEntry,
} from "../ir/propagate.js";
import {
  planIrCompilationByIdentity,
  projectIrSelectionToLegacy,
  type IrIdentitySelection,
  type IrIdentitySelectionOptions,
  type IrLegacySelectionProjection,
} from "../ir/select-identity.js";

export interface IrOverlayIdentityFunctionClaim {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.FunctionDeclaration;
  readonly typeEntry: TypeMapEntry;
}

export interface IrOverlayIdentityPlan {
  readonly identityContext: IrPlanningIdentityContext;
  readonly identitySelection: IrIdentitySelection;
  readonly selectionProjection: IrLegacySelectionProjection;
  readonly functionClaims: readonly IrOverlayIdentityFunctionClaim[];
  /** Complete unambiguous terminal projection, including rejected units and module init. */
  readonly unitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly functionUnitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly declarationByLegacyName: ReadonlyMap<string, ts.FunctionDeclaration>;
  readonly safeFunctionUnitIds: Set<IrUnitId>;
}

export interface IrOverlayIdentityMaps {
  readonly unitTypeMap: IrUnitTypeMap;
  readonly projectedTypeMap: TypeMap;
}

function mismatch(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", detail);
}

export function buildIrOverlayIdentityMaps(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrOverlayIdentityMaps {
  const unitTypeMap = buildIrUnitTypeMap([sourceFile], checker, identityContext);
  const projectedTypeMap = projectIrUnitTypeMapToLegacy([sourceFile], unitTypeMap, identityContext);
  return { unitTypeMap, projectedTypeMap };
}

/**
 * Cross the legacy name seam only through conservative projections. Every
 * executable claim keeps its exact declaration and TypeMap row; colliding
 * names never enter the preparation population.
 */
export function planIrOverlayByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  options: IrIdentitySelectionOptions,
  maps: IrOverlayIdentityMaps,
): IrOverlayIdentityPlan {
  const identitySelection = planIrCompilationByIdentity(sourceFile, identityContext, options, maps.unitTypeMap);
  const selectionProjection = projectIrSelectionToLegacy(identitySelection);
  const functionClaims: IrOverlayIdentityFunctionClaim[] = [];
  const unitIdByLegacyName = new Map<string, IrUnitId>();
  const functionUnitIdByLegacyName = new Map<string, IrUnitId>();
  const declarationByLegacyName = new Map<string, ts.FunctionDeclaration>();

  for (const [unitId, claim] of identitySelection.funcs) {
    if (selectionProjection.omittedUnitIds.has(unitId)) continue;
    const legacyName = claim.legacyMatchName;
    const declaration = identityContext.declarationByUnitId.get(unitId);
    const typeEntry = maps.unitTypeMap.get(unitId);
    if (
      !selectionProjection.selection.funcs.has(legacyName) ||
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      declaration.parent !== sourceFile ||
      declaration.name?.text !== legacyName ||
      !declaration.body ||
      !typeEntry ||
      maps.projectedTypeMap.get(legacyName) !== typeEntry ||
      functionUnitIdByLegacyName.has(legacyName)
    ) {
      mismatch(`structural IR selection ${unitId} has no unique exact legacy projection in ${sourceFile.fileName}`);
    }
    functionClaims.push({ unitId, legacyName, declaration, typeEntry });
    functionUnitIdByLegacyName.set(legacyName, unitId);
    declarationByLegacyName.set(legacyName, declaration);
  }

  for (const [unitId, unit] of identitySelection.units) {
    if (selectionProjection.omittedUnitIds.has(unitId)) continue;
    if (unitIdByLegacyName.has(unit.legacyMatchName)) {
      mismatch(`legacy terminal label ${unit.legacyMatchName} has more than one structural owner`);
    }
    unitIdByLegacyName.set(unit.legacyMatchName, unitId);
  }
  if (identitySelection.moduleInit) {
    const { unitId, legacyMatchName } = identitySelection.moduleInit;
    if (unitIdByLegacyName.has(legacyMatchName)) {
      mismatch(`module-init label ${legacyMatchName} collides with a structural source unit`);
    }
    unitIdByLegacyName.set(legacyMatchName, unitId);
  }

  return {
    identityContext,
    identitySelection,
    selectionProjection,
    functionClaims,
    unitIdByLegacyName,
    functionUnitIdByLegacyName,
    declarationByLegacyName,
    safeFunctionUnitIds: new Set(),
  };
}

/** Project already-validated safe IDs to the remaining name-keyed backend. */
export function projectIrSafeFunctionNames(
  safeUnitIds: ReadonlySet<IrUnitId>,
  identityPlan: Pick<IrOverlayIdentityPlan, "identitySelection" | "selectionProjection">,
): Set<string> {
  const names = new Set<string>();
  for (const unitId of safeUnitIds) {
    const claim = identityPlan.identitySelection.funcs.get(unitId);
    if (
      !claim ||
      identityPlan.selectionProjection.omittedUnitIds.has(unitId) ||
      !identityPlan.selectionProjection.selection.funcs.has(claim.legacyMatchName) ||
      names.has(claim.legacyMatchName)
    ) {
      mismatch(`safe structural IR function ${unitId} has no unique retained legacy projection`);
    }
    names.add(claim.legacyMatchName);
  }
  return names;
}

/** Replace the retained function population without permitting a dropped owner to reappear. */
export function retainIrSafeFunctionUnitIds(
  identityPlan: IrOverlayIdentityPlan,
  retainedUnitIds: ReadonlySet<IrUnitId>,
): Set<string> {
  for (const unitId of retainedUnitIds) {
    if (!identityPlan.safeFunctionUnitIds.has(unitId)) {
      mismatch(`IR finalization attempted to resurrect dropped function unit ${unitId}`);
    }
  }
  identityPlan.safeFunctionUnitIds.clear();
  for (const unitId of retainedUnitIds) identityPlan.safeFunctionUnitIds.add(unitId);
  return projectIrSafeFunctionNames(identityPlan.safeFunctionUnitIds, identityPlan);
}

/** Remove a projected owner while keeping the exact safe-ID population aligned. */
export function dropIrSafeFunctionByLegacyName(identityPlan: IrOverlayIdentityPlan, legacyName: string): void {
  const unitId = identityPlan.functionUnitIdByLegacyName.get(legacyName);
  if (!unitId || !identityPlan.safeFunctionUnitIds.delete(unitId)) {
    mismatch(`IR preparation owner ${legacyName} has no retained structural unit identity`);
  }
}

export function requireIrOverlayFunctionUnitId(
  identityPlan: Pick<IrOverlayIdentityPlan, "functionUnitIdByLegacyName">,
  legacyName: string,
): IrUnitId {
  const unitId = identityPlan.functionUnitIdByLegacyName.get(legacyName);
  if (!unitId) mismatch(`IR preparation owner ${legacyName} has no retained structural unit identity`);
  return unitId;
}

export function requireIrOverlayUnitId(
  identityPlan: Pick<IrOverlayIdentityPlan, "unitIdByLegacyName">,
  legacyName: string,
): IrUnitId {
  const unitId = identityPlan.unitIdByLegacyName.get(legacyName);
  if (!unitId) mismatch(`IR preparation unit ${legacyName} has no retained structural identity`);
  return unitId;
}

/** Correlate a legacy certification with the exact resolver at the same AST site. */
export function requireIrIdentityImportedTarget(
  resolver: IrIdentityImportedFunctionResolver,
  kind: "imported-call" | "top-level-value",
  node: ts.Expression,
  legacyTarget: IrResolvedFunctionTarget,
): IrIdentityResolvedFunctionTarget {
  if (!ts.isIdentifier(node)) mismatch(`${kind} certification did not retain an identifier target`);
  const target =
    kind === "imported-call"
      ? resolver.resolveImportedFunctionTarget(node)
      : resolver.resolveTopLevelFunctionValueTarget(node);
  if (
    !target ||
    target.legacyProjection !== "unambiguous" ||
    target.targetName !== legacyTarget.targetName ||
    target.declaration !== legacyTarget.declaration
  ) {
    mismatch(`${kind} target at ${node.getSourceFile().fileName}:${node.pos} diverged across identity projection`);
  }
  return target;
}

export function projectIrOverlayImportedResolver(
  resolver: IrIdentityImportedFunctionResolver | undefined,
): IrImportedFunctionResolver | undefined {
  return resolver ? projectIrIdentityImportedFunctionResolverToLegacy(resolver) : undefined;
}

export function makeIrOverlayImportedResolver(
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrIdentityImportedFunctionResolver {
  const sourceFiles = identityContext.inventory.sources.map((source) => {
    const sourceFile = identityContext.sourceFileBySourceId.get(source.id);
    if (!sourceFile) mismatch(`imported resolver source ${source.id} has no exact planning SourceFile`);
    return sourceFile;
  });
  return makeIrIdentityImportedFunctionResolver(checker, sourceFiles, identityContext);
}

/** Pre-bind exact owner/target validation for feature-plan construction. */
export function makeIrFeaturePlanIdentity(
  identityPlan: IrOverlayIdentityPlan,
  resolver: IrIdentityImportedFunctionResolver,
) {
  const target = (
    ownerName: string,
    kind: "imported-call" | "top-level-value",
    node: ts.Expression,
    legacyTarget: IrResolvedFunctionTarget,
  ) => {
    const resolved = requireIrIdentityImportedTarget(resolver, kind, node, legacyTarget);
    return {
      ownerUnitId: requireIrOverlayFunctionUnitId(identityPlan, ownerName),
      target: irUnitFuncRef({ unitId: resolved.targetUnitId, name: resolved.targetName }),
    };
  };
  return {
    owner: (ownerName: string): IrUnitId => requireIrOverlayFunctionUnitId(identityPlan, ownerName),
    imported: (ownerName: string, node: ts.Expression, legacyTarget: IrResolvedFunctionTarget) =>
      target(ownerName, "imported-call", node, legacyTarget),
    value: (ownerName: string, node: ts.Expression, legacyTarget: IrResolvedFunctionTarget) =>
      target(ownerName, "top-level-value", node, legacyTarget),
  };
}

export function projectIrIntegrationLoweringPlans(
  plan: {
    readonly identityPlan: IrOverlayIdentityPlan;
    readonly overrideMapByUnitId: IrIntegrationLoweringPlans["signaturesByUnitId"];
    readonly directCalls?: IrIntegrationLoweringPlans["directCalls"];
  } & Pick<
    IrIntegrationLoweringPlans,
    "importedCalls" | "topLevelFunctionValues" | "hostVoidCallbacks" | "promiseDelays"
  >,
  selection: {
    readonly funcs: ReadonlySet<string>;
    readonly classMembers?: ReadonlySet<string>;
    readonly moduleInit?: { readonly stmtCount: number; readonly reason: string | null };
  },
): IrIntegrationLoweringPlans {
  const ownerProjection = buildIrIntegrationOwnerProjection(plan.identityPlan, selection);
  const ownerUnitIdByLegacyName = new Map(
    ownerProjection.entries.map(({ legacyName, unitId }) => [legacyName, unitId]),
  );
  return {
    identityContext: plan.identityPlan.identityContext,
    ownerProjection,
    ownerUnitIdByLegacyName,
    directCalls: plan.directCalls ?? new Map(),
    signaturesByUnitId: plan.overrideMapByUnitId,
    importedCalls: plan.importedCalls,
    topLevelFunctionValues: plan.topLevelFunctionValues,
    hostVoidCallbacks: plan.hostVoidCallbacks,
    promiseDelays: plan.promiseDelays,
  };
}

/** Validate the exact terminal population passed through the legacy integration seam. */
export function buildIrIntegrationOwnerProjection(
  identityPlan: IrOverlayIdentityPlan,
  selection: {
    readonly funcs: ReadonlySet<string>;
    readonly classMembers?: ReadonlySet<string>;
    readonly moduleInit?: { readonly stmtCount: number; readonly reason: string | null };
  },
): IrLegacyUnitProjection {
  return buildPreparedOwnerProjection(identityPlan, selection, false);
}

/** Structural membership for terminal reconciliation, including static-member policy rows. */
export function collectIrPreparedSelectionUnitIds(
  identityPlan: IrOverlayIdentityPlan,
  selection: {
    readonly funcs: ReadonlySet<string>;
    readonly classMembers?: ReadonlySet<string>;
    readonly moduleInit?: { readonly stmtCount: number; readonly reason: string | null };
  },
): ReadonlySet<IrUnitId> {
  return new Set(buildPreparedOwnerProjection(identityPlan, selection, true).entries.map(({ unitId }) => unitId));
}

function buildPreparedOwnerProjection(
  identityPlan: IrOverlayIdentityPlan,
  selection: {
    readonly funcs: ReadonlySet<string>;
    readonly classMembers?: ReadonlySet<string>;
    readonly moduleInit?: { readonly stmtCount: number; readonly reason: string | null };
  },
  includeStaticClassMembers: boolean,
): IrLegacyUnitProjection {
  const entries: { unitId: IrUnitId; legacyName: string }[] = [];
  const structural = identityPlan.identitySelection;
  const omitted = identityPlan.selectionProjection.omittedUnitIds;

  const addSelected = (
    legacyNames: ReadonlySet<string> | undefined,
    claims: ReadonlyMap<IrUnitId, { readonly unitId: IrUnitId; readonly legacyMatchName: string }> | undefined,
    kind: "function" | "class member",
    include: (unitId: IrUnitId) => boolean = () => true,
  ): void => {
    const expected = new Set(legacyNames ?? []);
    for (const claim of claims?.values() ?? []) {
      if (omitted.has(claim.unitId) || !expected.delete(claim.legacyMatchName) || !include(claim.unitId)) continue;
      entries.push({ unitId: claim.unitId, legacyName: claim.legacyMatchName });
    }
    if (expected.size > 0) {
      mismatch(`prepared IR ${kind} names have no exact structural projection: ${[...expected].sort().join(", ")}`);
    }
  };

  addSelected(selection.funcs, structural.funcs, "function");
  addSelected(selection.classMembers, structural.classMembers, "class member", (unitId) => {
    if (includeStaticClassMembers) return true;
    return identityPlan.identityContext.terminalByUnitId.get(unitId)?.staticClassMember !== true;
  });

  const moduleSelected = selection.moduleInit?.reason === null && (selection.moduleInit.stmtCount ?? 0) > 0;
  if (moduleSelected) {
    const moduleInit = structural.moduleInit;
    if (!moduleInit || moduleInit.reason !== null || moduleInit.stmtCount === 0) {
      mismatch("prepared IR module init has no exact structural projection");
    }
    entries.push({ unitId: moduleInit.unitId, legacyName: moduleInit.legacyMatchName });
  }
  return buildIrLegacyUnitProjection(entries);
}
