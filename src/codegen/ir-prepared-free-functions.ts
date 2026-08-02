// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import type { IrUnitId } from "../ir/identity.js";
import { compileIrPathFunctions, type IrIntegrationReport, type IrTypeOverrideMap } from "../ir/integration.js";
import { asVal, type IrClassShape, type IrType } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrLegacyUnitProjection } from "../ir/planning-identity.js";
import type { IrSelection } from "../ir/select.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import {
  buildIrRequestedFunctionSkipProjection,
  mergeIrIntegrationReports,
  preparedIrFunctionRouting,
  type IrExactFunctionClaim,
} from "./ir-overlay-safety.js";

export interface PreparedIrFreeFunctionBodies {
  readonly report: IrIntegrationReport;
  readonly requestedSkipProjection: IrLegacyUnitProjection;
  readonly attemptedBodies: ReadonlySet<string>;
  readonly skipBodies: ReadonlySet<string>;
  readonly preserveBodies: ReadonlySet<string>;
}

function r2StableSignatureType(type: IrType | null): boolean {
  if (type === null || type.kind === "string") return true;
  const val = asVal(type);
  return val?.kind === "f64" || val?.kind === "i32";
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
  const report: IrIntegrationReport =
    freeFunctionSelection.funcs.size === 0
      ? {
          compiled: [],
          errors: [],
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
  const routing = preparedIrFunctionRouting(report, input.claimsByUnitId);
  const requestedSkipProjection = buildIrRequestedFunctionSkipProjection(routing.irOwnedUnitIds, input.claimsByUnitId);
  const preparedProjection = buildIrRequestedFunctionSkipProjection(routing.preparedUnitIds, input.claimsByUnitId);
  return {
    report,
    requestedSkipProjection,
    attemptedBodies: freeFunctionSelection.funcs,
    skipBodies: new Set(requestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
    preserveBodies: new Set(preparedProjection.entries.map(({ legacyName }) => legacyName)),
  };
}

/**
 * Compile the population left after prepared free functions and combine both
 * exact terminal reports into the single audit/telemetry input.
 */
export function completePreparedIrIntegration(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly selection: Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly preparedReport?: IrIntegrationReport;
  readonly preparedLegacyNames?: ReadonlySet<string>;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): IrIntegrationReport {
  const remainingSelection: IrSelection = input.preparedReport
    ? {
        funcs: new Set([...input.selection.funcs].filter((legacyName) => !input.preparedLegacyNames?.has(legacyName))),
        classMembers: input.selection.classMembers,
        moduleInit: input.selection.moduleInit,
      }
    : {
        funcs: new Set(input.selection.funcs),
        classMembers: input.selection.classMembers,
        moduleInit: input.selection.moduleInit,
      };
  const remainingReport = compileIrPathFunctions(
    input.ctx,
    input.sourceFile,
    remainingSelection,
    input.overrideMap,
    input.classShapes,
    input.projectLoweringPlans(remainingSelection),
  );
  return input.preparedReport ? mergeIrIntegrationReports(input.preparedReport, remainingReport) : remainingReport;
}
