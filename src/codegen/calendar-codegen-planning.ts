// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { irCapabilityImportFuncRef, irImportFuncRef } from "../ir/callable-bindings.js";
import {
  makeIrStandaloneDomCapabilityPlan,
  sourceTouchesIrStandaloneDomSurface,
  type IrStandaloneDomCapabilityPlan,
} from "../ir/dom-capability.js";
import {
  type IrHostDateGetterLoweringPlan,
  type IrHostDateSnapshotGetter,
  type IrHostDateSnapshotLoweringPlan,
  type IrHostVoidCallbackLoweringPlan,
} from "../ir/ast-lowering-plans.js";
import { makeIrHostVoidCallbackResolver, type IrHostVoidCallbackResolver } from "../ir/host-extern.js";
import { makeIrHostDateSnapshotResolver, type IrHostDateSnapshotResolver } from "../ir/host-date.js";
import { buildIrUnitInventory, type BuildIrUnitInventoryOptions, type IrUnitId } from "../ir/identity.js";
import { collectModuleInitPopulation } from "../ir/module-init.js";
import { IrInvariantError } from "../ir/outcomes.js";
import {
  buildIrPlanningIdentityContext,
  requireIrPlanningOwnerUnitId,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";
import type { IrSelection } from "../ir/select.js";
import type { CodegenContext } from "./context/types.js";
import { publishStandaloneDomStringBoundary } from "./dom-string-boundary.js";
import { requireIrOverlayFunctionUnitId, type IrOverlayIdentityPlan } from "./ir-overlay-identity.js";
import { ensureStandaloneClockCapabilityImport, STANDALONE_CLOCK_IMPORT_NAME } from "./standalone-clock-capability.js";
import {
  hasReservedStandaloneDomCallbackDispatch,
  reserveStandaloneDomCallbackDispatch,
} from "./standalone-dom-callback-authority.js";

/** Exact Calendar capability lifecycle shared by one compile driver. */
export interface StandaloneCalendarPlanning {
  /**
   * Reserve direct callback authority at the existing pre-body boundary. The
   * unchanged context return lets the driver anchor this side effect directly
   * in the declaration-compilation argument evaluation.
   */
  reserveDirectCallbacks(
    identityContext: IrPlanningIdentityContext | undefined,
    directBodiesWillEmit?: boolean,
  ): CodegenContext;
  /** Publish the DOM boundary with the callback slot selected during planning. */
  publishDomStringBoundary(): void;
}

function supportsStandaloneCalendarCapabilities(ctx: CodegenContext): boolean {
  return (
    ctx.standalone &&
    !ctx.wasi &&
    ctx.nativeStrings &&
    ctx.targetProfile.environment === "none" &&
    ctx.targetProfile.semanticProviders === "native-first"
  );
}

/** Build one exact DOM plan only in the standalone native-provider lane. */
export function planStandaloneDomCapability(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): IrStandaloneDomCapabilityPlan | undefined {
  if (!supportsStandaloneCalendarCapabilities(ctx)) return undefined;
  return makeIrStandaloneDomCapabilityPlan(checker, sourceFile);
}

function standaloneClockCapabilityDemanded(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  if (!supportsStandaloneCalendarCapabilities(ctx)) return false;
  const resolveSnapshot = makeIrHostDateSnapshotResolver(checker);
  let demanded = false;
  const visit = (node: ts.Node): void => {
    if (demanded) return;
    if (ts.isNewExpression(node) && resolveSnapshot(node)) {
      demanded = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return demanded;
}

function isNonBindingIdentifierName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isQualifiedName(parent) && parent.right === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isEnumMember(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    (ts.isExportSpecifier(parent) && (parent.name === identifier || parent.propertyName === identifier)) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier)
  );
}

function isImportBindingIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isImportClause(parent) && parent.name === identifier) ||
    (ts.isImportSpecifier(parent) && (parent.name === identifier || parent.propertyName === identifier)) ||
    (ts.isNamespaceImport(parent) && parent.name === identifier) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === identifier)
  );
}

function symbolUsesReservedStandaloneClockName(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) return false;
  if (symbol.getName() === STANDALONE_CLOCK_IMPORT_NAME) return true;
  return (symbol.declarations ?? []).some((declaration) => {
    const name = (declaration as ts.NamedDeclaration).name;
    return name !== undefined && ts.isIdentifier(name) && name.text === STANDALONE_CLOCK_IMPORT_NAME;
  });
}

function importBindingResolvesToReservedStandaloneClock(checker: ts.TypeChecker, identifier: ts.Identifier): boolean {
  if (!isImportBindingIdentifier(identifier)) return false;
  try {
    let symbol = checker.getSymbolAtLocation(identifier);
    const seen = new Set<ts.Symbol>();
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
      seen.add(symbol);
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbolUsesReservedStandaloneClockName(symbol);
  } catch {
    // A detector that cannot resolve an import alias may not silently grant the
    // compiler-owned clock namespace to it.
    return true;
  }
}

/**
 * Refuse the compiler-owned clock slot when source owns or references the same
 * value binding. Member/property names are deliberately excluded:
 * `obj.__date_now` does not occupy the callable namespace. Import aliases are
 * resolved through the checker so `import { __date_now as clock }` is
 * contested under either name.
 */
function sourceContestsReservedStandaloneClockBinding(checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  let contested = false;
  const visit = (node: ts.Node): void => {
    if (contested) return;
    if (ts.isIdentifier(node)) {
      if (importBindingResolvesToReservedStandaloneClock(checker, node)) {
        contested = true;
        return;
      }
      if (node.text === STANDALONE_CLOCK_IMPORT_NAME && !isNonBindingIdentifierName(node)) {
        try {
          const symbol = checker.getSymbolAtLocation(node);
          if (!symbol || (symbol.flags & ts.SymbolFlags.Value) !== 0 || isImportBindingIdentifier(node)) {
            contested = true;
            return;
          }
        } catch {
          contested = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return contested;
}

function configureStandaloneCalendarCapabilities(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  domPlans: readonly IrStandaloneDomCapabilityPlan[],
  domAuthorityClosed: boolean,
): void {
  ctx.requiresStandaloneDomCapability = domAuthorityClosed && domPlans.length > 0;
  ctx.requiresStandaloneDomInteractionCapability =
    domAuthorityClosed && domPlans.some(({ requiresInteraction }) => Boolean(requiresInteraction));
  const clockNamespaceContested = sourceFiles.some((sourceFile) =>
    sourceContestsReservedStandaloneClockBinding(checker, sourceFile),
  );
  ctx.requiresStandaloneClockCapability =
    !clockNamespaceContested &&
    sourceFiles.some((sourceFile) => standaloneClockCapabilityDemanded(ctx, checker, sourceFile));
  if (ctx.requiresStandaloneClockCapability) ensureStandaloneClockCapabilityImport(ctx);
}

/** Checker-certify one source's exact direct-front-end callback population. */
function collectStandaloneDomCallbackAuthorityPlans(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  domPlan: IrStandaloneDomCapabilityPlan,
  identityContext: IrPlanningIdentityContext,
): Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan> {
  const certify = makeIrHostVoidCallbackResolver(checker);
  const callbacks = new Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
    const ownerUnitId = identityContext.unitIdByDeclaration.get(statement);
    const owner = ownerUnitId === undefined ? undefined : identityContext.terminalByUnitId.get(ownerUnitId);
    if (!owner || owner.terminalOwnerId !== ownerUnitId) continue;
    let liftedOrdinal = 0;
    const visit = (node: ts.Node): void => {
      if (node !== statement.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && domPlan.operation(node)?.importName === "HTMLElement_addEventListener") {
        const certified = certify(node);
        if (certified) {
          if (requireIrPlanningOwnerUnitId(identityContext, certified.callback) !== ownerUnitId) {
            throw new Error("standalone DOM callback certification changed its exact terminal owner");
          }
          callbacks.set(certified.callback, {
            ownerUnitId,
            ownerName: owner.legacyMatchName,
            signature: { params: [], returnType: null },
            captureNames: certified.captureNames,
            liftedOrdinal: liftedOrdinal++,
            standaloneDomReusable: true,
          });
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement.body);
  }
  return callbacks;
}

function collectMultiStandaloneDomCallbackAuthorityPlans(
  checker: ts.TypeChecker,
  domPlans: readonly IrStandaloneDomCapabilityPlan[],
  identityContext: IrPlanningIdentityContext,
): Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan> {
  const callbacks = new Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>();
  for (const domPlan of domPlans) {
    for (const [callback, plan] of collectStandaloneDomCallbackAuthorityPlans(
      checker,
      domPlan.sourceFile,
      domPlan,
      identityContext,
    )) {
      if (callbacks.has(callback)) {
        throw new Error("standalone DOM callback certification repeated one exact multi-source callback node");
      }
      callbacks.set(callback, plan);
    }
  }
  return callbacks;
}

function makeStandaloneCalendarPlanning(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  domPlans: readonly IrStandaloneDomCapabilityPlan[],
  buildIdentityContext: () => IrPlanningIdentityContext,
  reservationFailure: string,
): StandaloneCalendarPlanning {
  return {
    reserveDirectCallbacks(identityContext, directBodiesWillEmit = true): CodegenContext {
      if (!directBodiesWillEmit || ctx.requiresStandaloneDomInteractionCapability !== true) return ctx;
      const callbacks = collectMultiStandaloneDomCallbackAuthorityPlans(
        checker,
        domPlans,
        identityContext ?? buildIdentityContext(),
      );
      if (
        !reserveStandaloneDomCallbackDispatch(ctx, callbacks) ||
        !hasReservedStandaloneDomCallbackDispatch(ctx, callbacks)
      ) {
        throw new Error(reservationFailure);
      }
      return ctx;
    },
    publishDomStringBoundary(): void {
      publishStandaloneDomStringBoundary(ctx, {
        interactionCallbackDispatch: ctx.requiresStandaloneDomInteractionCapability === true,
      });
    },
  };
}

/** Configure the one-source Calendar capability and direct-callback lifecycle. */
export function planSingleSourceStandaloneCalendar(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  inventoryOptions: BuildIrUnitInventoryOptions,
): StandaloneCalendarPlanning {
  const domPlan = planStandaloneDomCapability(ctx, checker, sourceFile);
  const domPlans = domPlan ? [domPlan] : [];
  configureStandaloneCalendarCapabilities(ctx, checker, [sourceFile], domPlans, true);
  return makeStandaloneCalendarPlanning(
    ctx,
    checker,
    domPlans,
    () =>
      buildIrPlanningIdentityContext(
        buildIrUnitInventory([sourceFile], { ...inventoryOptions, entrySource: sourceFile }),
      ),
    "standalone DOM callback dispatcher could not reserve its exact certified plan population",
  );
}

/** Configure a graph-wide Calendar capability and direct-callback lifecycle. */
export function planMultiCalendar(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  entrySource: ts.SourceFile,
): StandaloneCalendarPlanning {
  const domPlans = sourceFiles
    .map((sourceFile) => planStandaloneDomCapability(ctx, checker, sourceFile))
    .filter((plan): plan is IrStandaloneDomCapabilityPlan => plan !== undefined);
  const plannedSources = new Set(domPlans.map(({ sourceFile }) => sourceFile));
  const domAuthorityClosed = sourceFiles.every(
    (sourceFile) => !sourceTouchesIrStandaloneDomSurface(checker, sourceFile) || plannedSources.has(sourceFile),
  );
  if (!domAuthorityClosed && domPlans.length > 0) {
    throw new Error(
      "generateMultiModule: explicit DOM capability requires an exact per-source plan for every DOM-surface source",
    );
  }
  configureStandaloneCalendarCapabilities(ctx, checker, sourceFiles, domPlans, domAuthorityClosed);
  return makeStandaloneCalendarPlanning(
    ctx,
    checker,
    domPlans,
    () =>
      buildIrPlanningIdentityContext(
        buildIrUnitInventory(sourceFiles, {
          entrySource,
          checker,
        }),
      ),
    "standalone DOM callback dispatcher could not reserve its exact multi-source certified plan population",
  );
}

export interface IrCalendarResolverPlan {
  readonly supportsDateSnapshots: boolean;
  readonly hostVoidCallback?: IrHostVoidCallbackResolver;
  readonly hostDateSnapshot?: IrHostDateSnapshotResolver;
}

/** Share the exact host/standalone resolver selection used by claim and plan. */
export function planIrCalendarResolvers(
  checker: ts.TypeChecker,
  jsHostExterns: boolean,
  supportsHostDateSnapshots: boolean,
  standaloneDomCapability: IrStandaloneDomCapabilityPlan | undefined,
  supportsStandaloneClockSnapshots: boolean,
): IrCalendarResolverPlan {
  const supportsStandaloneDomInteraction = standaloneDomCapability?.requiresInteraction === true;
  const baseCallback =
    jsHostExterns || supportsStandaloneDomInteraction ? makeIrHostVoidCallbackResolver(checker) : undefined;
  const hostVoidCallback = baseCallback
    ? jsHostExterns
      ? baseCallback
      : (call: ts.CallExpression) =>
          standaloneDomCapability?.operation(call)?.importName === "HTMLElement_addEventListener"
            ? baseCallback(call)
            : undefined
    : undefined;
  const supportsDateSnapshots = supportsHostDateSnapshots || supportsStandaloneClockSnapshots;
  return {
    supportsDateSnapshots,
    ...(hostVoidCallback ? { hostVoidCallback } : {}),
    ...(supportsDateSnapshots ? { hostDateSnapshot: makeIrHostDateSnapshotResolver(checker) } : {}),
  };
}

export interface IrCalendarLoweringPlans {
  readonly hostVoidCallbacks: Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly hostDateSnapshots: Map<ts.NewExpression, IrHostDateSnapshotLoweringPlan>;
  readonly hostDateGetters: Map<ts.CallExpression, IrHostDateGetterLoweringPlan>;
  readonly hostDateImportsByOwnerUnitId: Map<
    IrUnitId,
    { ownerUnitId: IrUnitId; ownerName: string; importNames: Set<string> }
  >;
}

function collectIrHostVoidCallbackPlans(
  identityPlan: IrOverlayIdentityPlan,
  safeFunctionNames: ReadonlySet<string>,
  resolveCallback: IrHostVoidCallbackResolver | undefined,
  standaloneDomReusable: boolean,
): Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan> {
  const callbacks = new Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>();
  if (!resolveCallback) return callbacks;
  for (const [ownerName, declaration] of identityPlan.declarationByLegacyName) {
    if (!safeFunctionNames.has(ownerName) || !declaration.body) continue;
    let liftedOrdinal = 0;
    const visit = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const certified = resolveCallback(node);
        if (certified) {
          callbacks.set(certified.callback, {
            ownerUnitId: requireIrOverlayFunctionUnitId(identityPlan, ownerName),
            ownerName,
            signature: { params: [], returnType: null },
            captureNames: certified.captureNames,
            liftedOrdinal: liftedOrdinal++,
            ...(standaloneDomReusable ? { standaloneDomReusable: true as const } : {}),
          });
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  return callbacks;
}

function collectIrHostDatePlans(
  sourceFile: ts.SourceFile,
  identityPlan: IrOverlayIdentityPlan,
  safeSelection: Pick<IrSelection, "funcs" | "moduleInit">,
  resolveSnapshot: IrHostDateSnapshotResolver | undefined,
  standaloneClockCapability: boolean,
): Pick<IrCalendarLoweringPlans, "hostDateSnapshots" | "hostDateGetters" | "hostDateImportsByOwnerUnitId"> {
  const hostDateSnapshots = new Map<ts.NewExpression, IrHostDateSnapshotLoweringPlan>();
  const hostDateGetters = new Map<ts.CallExpression, IrHostDateGetterLoweringPlan>();
  const hostDateImportsByOwnerUnitId = new Map<
    IrUnitId,
    { ownerUnitId: IrUnitId; ownerName: string; importNames: Set<string> }
  >();
  if (!resolveSnapshot) return { hostDateSnapshots, hostDateGetters, hostDateImportsByOwnerUnitId };

  const collectOwner = (ownerUnitId: IrUnitId, ownerName: string, root: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (node !== root && ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node)) {
        const certified = resolveSnapshot(node);
        if (certified) {
          const snapshotPlan = {
            ownerUnitId,
            ownerName,
            target: standaloneClockCapability
              ? irCapabilityImportFuncRef("env", "__date_now", "clock", "embedder")
              : irImportFuncRef("env", "__date_now"),
          } satisfies IrHostDateSnapshotLoweringPlan;
          const existingSnapshot = hostDateSnapshots.get(node);
          if (
            existingSnapshot &&
            (existingSnapshot.ownerUnitId !== ownerUnitId || existingSnapshot.ownerName !== ownerName)
          ) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "resolve",
              `host-Date snapshot changed owner from ${existingSnapshot.ownerUnitId} to ${ownerUnitId}`,
            );
          }
          hostDateSnapshots.set(node, snapshotPlan);
          let importPlan = hostDateImportsByOwnerUnitId.get(ownerUnitId);
          if (!importPlan) {
            importPlan = { ownerUnitId, ownerName, importNames: new Set() };
            hostDateImportsByOwnerUnitId.set(ownerUnitId, importPlan);
          } else if (importPlan.ownerName !== ownerName) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "resolve",
              `host-Date owner ${ownerUnitId} has conflicting legacy labels ${importPlan.ownerName} / ${ownerName}`,
            );
          }
          importPlan.importNames.add("__date_now");
          collectIrHostDateGetterPlans(hostDateGetters, certified.getterCalls, snapshotPlan, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  for (const [ownerName, declaration] of identityPlan.declarationByLegacyName) {
    if (!safeSelection.funcs.has(ownerName) || !declaration.body) continue;
    collectOwner(requireIrOverlayFunctionUnitId(identityPlan, ownerName), ownerName, declaration.body);
  }
  if (safeSelection.moduleInit?.reason === null && safeSelection.moduleInit.stmtCount > 0) {
    const moduleInit = identityPlan.identitySelection.moduleInit;
    if (!moduleInit || moduleInit.reason !== null || moduleInit.stmtCount === 0) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "host-Date module-init collection has no exact structural identity",
      );
    }
    for (const statement of collectModuleInitPopulation(sourceFile)) {
      collectOwner(moduleInit.unitId, moduleInit.legacyMatchName, statement);
    }
  }
  return { hostDateSnapshots, hostDateGetters, hostDateImportsByOwnerUnitId };
}

function collectIrHostDateGetterPlans(
  plans: Map<ts.CallExpression, IrHostDateGetterLoweringPlan>,
  getterCalls: ReadonlySet<ts.CallExpression>,
  snapshotPlan: IrHostDateSnapshotLoweringPlan,
  snapshot: ts.NewExpression,
): void {
  for (const call of getterCalls) {
    const access = call.expression;
    if (!ts.isPropertyAccessExpression(access)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `host-Date getter in ${snapshotPlan.ownerName} lost its property-access identity`,
      );
    }
    const getter = access.name.text as IrHostDateSnapshotGetter;
    if (getter !== "getDate" && getter !== "getMonth" && getter !== "getFullYear") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `host-Date snapshot in ${snapshotPlan.ownerName} gained unsupported getter ${getter}`,
      );
    }
    const getterPlan = { ...snapshotPlan, snapshot, getter } satisfies IrHostDateGetterLoweringPlan;
    const existing = plans.get(call);
    if (
      existing &&
      (existing.ownerUnitId !== getterPlan.ownerUnitId ||
        existing.snapshot !== getterPlan.snapshot ||
        existing.getter !== getterPlan.getter)
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `host-Date getter in ${snapshotPlan.ownerName} has conflicting exact plans`,
      );
    }
    plans.set(call, getterPlan);
  }
}

/** Collect exact Calendar lowering plans after the safe terminal set is frozen. */
export function collectIrCalendarLoweringPlans(input: {
  readonly ctx: Pick<CodegenContext, "requiresStandaloneClockCapability">;
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly safeSelection: Pick<IrSelection, "funcs" | "moduleInit">;
  readonly resolvers: IrCalendarResolverPlan;
  readonly standaloneDomReusable: boolean;
}): IrCalendarLoweringPlans {
  const hostVoidCallbacks = collectIrHostVoidCallbackPlans(
    input.identityPlan,
    input.safeSelection.funcs,
    input.resolvers.hostVoidCallback,
    input.standaloneDomReusable,
  );
  return {
    hostVoidCallbacks,
    ...collectIrHostDatePlans(
      input.sourceFile,
      input.identityPlan,
      input.safeSelection,
      input.resolvers.hostDateSnapshot,
      input.ctx.requiresStandaloneClockCapability === true,
    ),
  };
}
