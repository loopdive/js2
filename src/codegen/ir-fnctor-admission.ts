// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Source-qualified producer for the bounded #3521 fnctor admission seam.
 *
 * This module deliberately produces only the small propagation/selection
 * evidence object.  It does not allocate a Wasm type, plan a support
 * callable, or lower an AST node.  Those later stages must consume the same
 * source/unit identity and remain fail-closed when their ABI sidecar is not
 * populated.
 */

import { ts, forEachChild } from "../ts-api.js";
import type {
  IrFnctorAdmission,
  IrFnctorPropagationAdmissionResolver,
  IrFnctorSelectionAdmissionResolver,
  LatticeType,
} from "../ir/propagate.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrSourceId } from "../ir/identity.js";
import {
  collectIrFnctorArgumentProjections,
  proveIrFnctorInputConstructorSyntax,
  type IrFnctorArgumentProjection,
  type IrFnctorArgumentProjectionAuthority,
  type IrFnctorInputConstructorSyntaxProof,
} from "../ir/fnctor-argument-projection.js";
import type { IrUnitTypeMap } from "../ir/propagate.js";
import type { CodegenContext } from "./context/types.js";

export interface IrFnctorArgumentProjectionRoute {
  readonly experimentalIR: boolean;
  /** True only after legacy bodies have materialized the physical reservation. */
  readonly postLegacyPhysicalReservation: boolean;
  /** Exact environment snapshot; L1 is intentionally limited to the literal escape hatch. */
  readonly irFirstEnvironment: string | undefined;
}

/** Normative route authority for the dormant L1 evidence. */
export function irFnctorArgumentProjectionRouteIsActive(
  ctx: CodegenContext,
  route: IrFnctorArgumentProjectionRoute,
): boolean {
  return (
    route.experimentalIR &&
    route.postLegacyPhysicalReservation &&
    route.irFirstEnvironment === "0" &&
    ctx.standalone === true &&
    ctx.nativeStrings === true &&
    ctx.wasi === false &&
    ctx.fast === false &&
    ctx.targetProfile.semanticProviders === "native-first"
  );
}

function aliasedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

function symbolOwnsDeclaration(checker: ts.TypeChecker, node: ts.Identifier, declaration: ts.Node): boolean {
  const symbol = aliasedSymbol(checker, node);
  if (!symbol) return false;
  return (symbol.getDeclarations() ?? []).some((candidate) => candidate === declaration);
}

function isStringType(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return (type.flags & ts.TypeFlags.StringLike) !== 0;
}

/** Prove the admitted value stays inside source-local member receivers. */
function hasNoEscape(checker: ts.TypeChecker, site: ts.NewExpression): boolean {
  let value: ts.Expression = site;
  let parent = value.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent))
  ) {
    value = parent;
    parent = parent.parent;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === value) return true;
  if (ts.isElementAccessExpression(parent) && parent.expression === value) return true;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== value || !ts.isIdentifier(parent.name)) return false;
  const binding = parent.name;
  const symbol = aliasedSymbol(checker, binding);
  if (!symbol) return false;
  let ownerFunction: ts.FunctionLikeDeclaration | undefined;
  for (let ancestor: ts.Node | undefined = parent.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isFunctionLike(ancestor)) {
      ownerFunction = ancestor as ts.FunctionLikeDeclaration;
      break;
    }
  }
  let sawUse = false;
  let invalidUse = false;
  let nestedFunctionUse = false;
  const root: ts.Node = ownerFunction?.body ?? site.getSourceFile();
  const referencesBinding = (node: ts.Node): boolean => {
    let found = false;
    const scan = (candidate: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(candidate) && candidate !== binding && aliasedSymbol(checker, candidate) === symbol) {
        found = true;
        return;
      }
      forEachChild(candidate, scan);
    };
    scan(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) {
      if (referencesBinding(node)) nestedFunctionUse = true;
      return;
    }
    if (ts.isIdentifier(node) && aliasedSymbol(checker, node) === symbol && node !== binding) {
      const use = node.parent;
      if (
        !(ts.isPropertyAccessExpression(use) && use.expression === node) &&
        !(ts.isElementAccessExpression(use) && use.expression === node)
      ) {
        invalidUse = true;
        return;
      }
      sawUse = true;
    }
    forEachChild(node, visit);
  };
  visit(root);
  return sawUse && !invalidUse && !nestedFunctionUse;
}

function resolveAdmission(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
  site: ts.NewExpression,
): IrFnctorAdmission | undefined {
  const gate = ctx.fnctorEscapeGate;
  if (!gate || !ts.isIdentifier(site.expression) || !gate.approved.has(site)) return undefined;
  const sourceFile = site.getSourceFile();
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (sourceId === undefined) return undefined;
  const name = site.expression.text;
  if (!gate.approvedNames.has(name) || gate.provenance.refusedNames.includes(name)) return undefined;
  const declaration = gate.ctorDeclByName.get(name);
  if (!declaration || declaration.getSourceFile() !== sourceFile) return undefined;
  if (!symbolOwnsDeclaration(checker, site.expression, declaration)) return undefined;
  const constructorUnitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!constructorUnitId) return undefined;
  const reservedTypeIdx = ctx.fnctorReservedTypeIdx.get(name);
  if (reservedTypeIdx === undefined || ctx.structMap.get(`__fnctor_${name}`) !== reservedTypeIdx) return undefined;
  const syntax = proveIrFnctorInputConstructorSyntax(checker, identityContext, declaration);
  if (
    !syntax ||
    syntax.constructorUnitId !== constructorUnitId ||
    !ts.isIdentifier(syntax.parameterDeclaration.name) ||
    syntax.parameterDeclaration.name.text !== "input" ||
    !isStringType(checker, syntax.parameterDeclaration)
  ) {
    return undefined;
  }
  if (!hasNoEscape(checker, site)) return undefined;
  const argumentsList = site.arguments ?? [];
  if (argumentsList.length !== 1 || argumentsList.some((argument) => ts.isSpreadElement(argument))) return undefined;

  return {
    kind: "fnctor-admission",
    sourceId,
    constructorUnitId,
    constructorDeclaration: declaration,
    constructorSite: site,
    shape: { kind: "fnctor-shape", fields: [{ name: "input", type: "string" }] },
    proof: {
      sameSource: true,
      approved: true,
      reserved: true,
      directConstructor: true,
      fixedUnconditionalInput: true,
      noAlias: true,
      noReassignment: true,
      noEscape: true,
      noCrossSourceCollision: true,
    },
  };
}

/** Build the checker/context-owned resolver used by selector and propagation. */
export function makeIrFnctorAdmissionResolver(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrFnctorSelectionAdmissionResolver {
  return (site) => resolveAdmission(ctx, checker, identityContext, site);
}

/** Adapt the same source-qualified proof to the propagation callback shape. */
export function makeIrFnctorPropagationAdmissionResolver(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrFnctorPropagationAdmissionResolver {
  return (site, sourceId, _scope: ReadonlyMap<string, LatticeType>) => {
    const admission = resolveAdmission(ctx, checker, identityContext, site);
    return admission?.sourceId === sourceId ? admission : undefined;
  };
}

function resolveArgumentProjectionReservation(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  site: ts.NewExpression,
  constructorProof: IrFnctorInputConstructorSyntaxProof,
) {
  const gate = ctx.fnctorEscapeGate;
  if (!gate || !ts.isIdentifier(site.expression) || !gate.approved.has(site)) return undefined;
  const name = gate.siteCtorName.get(site);
  if (
    name === undefined ||
    name !== site.expression.text ||
    !gate.approvedNames.has(name) ||
    gate.provenance.refusedNames.includes(name) ||
    gate.ctorDeclByName.get(name) !== constructorProof.constructorDeclaration ||
    !symbolOwnsDeclaration(checker, site.expression, constructorProof.constructorDeclaration)
  ) {
    return undefined;
  }
  const reservationKey = `__fnctor_${name}`;
  const reservedTypeIdx = ctx.fnctorReservedTypeIdx.get(name);
  if (
    reservedTypeIdx === undefined ||
    !Number.isSafeInteger(reservedTypeIdx) ||
    reservedTypeIdx < 0 ||
    ctx.structMap.get(reservationKey) !== reservedTypeIdx
  ) {
    return undefined;
  }
  return {
    kind: "fnctor-physical-reservation" as const,
    sourceId: constructorProof.sourceId,
    constructorUnitId: constructorProof.constructorUnitId,
    constructorDeclaration: constructorProof.constructorDeclaration,
    constructorSite: site,
    reservationKey,
    reservedTypeIdx,
  };
}

/** Bind retained L1 evidence back to the live checker and reservation registry. */
export function makeIrFnctorArgumentProjectionAuthority(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
): IrFnctorArgumentProjectionAuthority {
  return Object.freeze({
    checker,
    resolvePhysicalReservation: (site: ts.NewExpression, constructorProof: IrFnctorInputConstructorSyntaxProof) =>
      resolveArgumentProjectionReservation(ctx, checker, site, constructorProof),
  });
}

/** Collect evidence for structural retention only; L1 has no selector or lowering consumer. */
export function collectIrFnctorArgumentProjectionsForPlanning(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
  unitTypeMap: IrUnitTypeMap,
  route: IrFnctorArgumentProjectionRoute,
): readonly IrFnctorArgumentProjection[] {
  if (!irFnctorArgumentProjectionRouteIsActive(ctx, route)) return Object.freeze([]);
  const authority = makeIrFnctorArgumentProjectionAuthority(ctx, checker);
  return collectIrFnctorArgumentProjections({
    sourceFile,
    checker,
    identityContext,
    unitTypeMap,
    resolvePhysicalReservation: authority.resolvePhysicalReservation,
  });
}
