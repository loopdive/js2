// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../ir/identity.js";
import type { IrIntegrationReport } from "../ir/integration-report.js";
import { asVal, type IrType } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import {
  buildIrLegacyUnitProjection,
  IrLegacyUnitProjectionInvariantError,
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrLegacyUnitProjection,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";
import { ts } from "../ts-api.js";
import { closeIrBlockedComponentByIdentity } from "./ir-overlay-finalize.js";
import { collectLocalCallEdgesByIdentity, irFirstBodyIsProvenLowerable, type ValueDomain } from "./ir-first-gate.js";

export interface IrExactFunctionClaim {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.FunctionDeclaration;
}

export interface IrExactBodyClaim {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
}

export interface IrCorrelatedSkippedFunctions {
  readonly unitIds: ReadonlySet<IrUnitId>;
  /** Preserves the declaration compiler's public return order after validation. */
  readonly legacyNames: readonly string[];
}

function planningInvariant(
  code: "duplicate-unit-id" | "unit-record-mismatch" | "source-record-mismatch",
  detail: string,
): never {
  throw new IrPlanningIdentityInvariantError(code, `IR overlay safety: ${detail}`);
}

/** Validate and index the exact function claims for one source. */
export function buildIrExactFunctionClaimIndex(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  claims: readonly IrExactFunctionClaim[],
): ReadonlyMap<IrUnitId, IrExactFunctionClaim> {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return planningInvariant("source-record-mismatch", `source ${sourceFile.fileName} has a stale identity mapping`);
  }
  const indexed = new Map<IrUnitId, IrExactFunctionClaim>();
  for (const claim of claims) {
    if (indexed.has(claim.unitId)) {
      return planningInvariant("duplicate-unit-id", `function claim ${claim.unitId} occurs more than once`);
    }
    const terminal = identityContext.terminalByUnitId.get(claim.unitId);
    if (
      !terminal ||
      terminal.sourceId !== sourceId ||
      terminal.observedKind !== "function" ||
      terminal.legacyMatchName !== claim.legacyName ||
      identityContext.unitByUnitId.get(claim.unitId) !== terminal ||
      identityContext.declarationByUnitId.get(claim.unitId) !== claim.declaration ||
      identityContext.unitIdByDeclaration.get(claim.declaration) !== claim.unitId ||
      claim.declaration.parent !== sourceFile ||
      claim.declaration.getSourceFile() !== sourceFile ||
      !sourceFile.statements.includes(claim.declaration) ||
      claim.declaration.name?.text !== claim.legacyName ||
      !claim.declaration.body ||
      terminal.declarationStart !== claim.declaration.getStart(sourceFile) ||
      terminal.declarationEnd !== claim.declaration.end
    ) {
      return planningInvariant(
        terminal?.sourceId === sourceId ? "unit-record-mismatch" : "source-record-mismatch",
        `function claim ${claim.unitId} / ${JSON.stringify(claim.legacyName)} is not its exact authoritative declaration`,
      );
    }
    indexed.set(claim.unitId, claim);
  }
  return indexed;
}

/** Build the sole name projection for the exact functions requested at the legacy body-skip seam. */
export function buildIrRequestedFunctionSkipProjection(
  requestedUnitIds: ReadonlySet<IrUnitId>,
  claimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>,
): IrLegacyUnitProjection {
  const entries = [];
  for (const unitId of requestedUnitIds) {
    const claim = claimsByUnitId.get(unitId);
    if (!claim) {
      throw new IrLegacyUnitProjectionInvariantError(
        "missing-unit",
        `requested IR-first skip ${unitId} has no exact function claim`,
      );
    }
    entries.push({ unitId, legacyName: claim.legacyName });
  }
  return buildIrLegacyUnitProjection(entries);
}

/** Correlate one direct-emitter result list against its exact requested projection. */
export function correlateIrSkippedBodyNames(
  requested: IrLegacyUnitProjection,
  returnedLegacyNames: readonly string[],
  kind: "function" | "class member" | "module initializer",
): IrCorrelatedSkippedFunctions {
  const correlation = requested.startResultCorrelation<true>();
  for (const legacyName of returnedLegacyNames) {
    const entry = requested.getByLegacyName(legacyName);
    if (!entry) {
      throw new IrLegacyUnitProjectionInvariantError(
        "foreign-result-correlation",
        `legacy declaration compiler returned unrequested skipped ${kind} ${JSON.stringify(legacyName)}`,
      );
    }
    correlation.consume({ ...entry, result: true });
  }
  const completed = correlation.complete();
  return {
    unitIds: new Set(completed.keys()),
    legacyNames: Object.freeze([...returnedLegacyNames]),
  };
}

/**
 * Reconcile the direct class-body seam against its authoritative UnitId
 * population. Nested class members deliberately bypass the lossy physical-name
 * projection, so duplicates, foreign observations, and omissions all fail
 * closed here.
 */
export function correlateIrSkippedBodyUnitIds(
  requestedUnitIds: ReadonlySet<IrUnitId>,
  returnedUnitIds: readonly IrUnitId[],
  kind: "class member" | "implicit constructor support",
): ReadonlySet<IrUnitId> {
  const completed = new Set<IrUnitId>();
  for (const unitId of returnedUnitIds) {
    if (!requestedUnitIds.has(unitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `direct declaration compiler returned foreign skipped ${kind} ${unitId}`,
      );
    }
    if (completed.has(unitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `direct declaration compiler returned duplicate skipped ${kind} ${unitId}`,
      );
    }
    completed.add(unitId);
  }
  const missing = [...requestedUnitIds].filter((unitId) => !completed.has(unitId));
  if (missing.length > 0) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `direct declaration compiler omitted skipped ${kind} UnitIds: ${missing.join(", ")}`,
    );
  }
  return completed;
}

/**
 * Correlate top-level function names returned by `compileDeclarations` only
 * against the requested projection. Foreign, duplicate, and missing results
 * all fail closed.
 */
export function correlateIrSkippedFunctionNames(
  requested: IrLegacyUnitProjection,
  returnedLegacyNames: readonly string[],
): IrCorrelatedSkippedFunctions {
  return correlateIrSkippedBodyNames(requested, returnedLegacyNames, "function");
}

/**
 * Derive exact free-function body ownership from prepare-before-direct terminal
 * evidence. Public compiled-name lists are deliberately insufficient here:
 * every terminal row must correlate to the authoritative claim index.
 */
export function preparedIrBodyRouting(
  report: IrIntegrationReport,
  claimsByUnitId: ReadonlyMap<IrUnitId, IrExactBodyClaim>,
  options: { readonly deferUnsupportedUnitIds?: ReadonlySet<IrUnitId> } = {},
): {
  readonly irOwnedUnitIds: ReadonlySet<IrUnitId>;
  readonly preparedUnitIds: ReadonlySet<IrUnitId>;
  readonly deferredUnitIds: ReadonlySet<IrUnitId>;
} {
  if (!report.terminalEvidence) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      "prepared free-function report has no exact terminal evidence",
    );
  }
  const irOwned = new Set<IrUnitId>();
  const prepared = new Set<IrUnitId>();
  const deferred = new Set<IrUnitId>();
  for (const evidence of report.terminalEvidence) {
    const claim = claimsByUnitId.get(evidence.unitId);
    if (!claim || claim.legacyName !== evidence.legacyName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `prepared free-function evidence ${evidence.unitId} / ${evidence.legacyName} has no exact claim`,
      );
    }
    if (evidence.kind === "patched") {
      if (evidence.preparedComponentId === undefined) {
        deferred.add(evidence.unitId);
      } else {
        irOwned.add(evidence.unitId);
        prepared.add(evidence.unitId);
      }
    } else if (evidence.error.outcome.kind === "invariant") {
      // A failed invariant is terminal IR ownership: compilation must fail
      // without giving the direct emitter a retry. The declaration pass will
      // install only its non-shipping structural placeholder.
      irOwned.add(evidence.unitId);
    } else if (
      evidence.error.outcome.code !== "timer-component-not-isolated" &&
      options.deferUnsupportedUnitIds?.has(evidence.unitId)
    ) {
      // A typed Unsupported during early preparation is a soft withdrawal,
      // not completed ownership. Let direct emission establish the remaining
      // ABI, then include this exact owner in the ordinary post-direct IR
      // population so free-function callers and dependencies are reconciled
      // together. Only explicitly named free-function UnitIds enter this
      // retry seam; class/module owners and an atomically rejected timer
      // component keep Unsupported as a terminal direct-only withdrawal.
      deferred.add(evidence.unitId);
    }
  }
  return { irOwnedUnitIds: irOwned, preparedUnitIds: prepared, deferredUnitIds: deferred };
}

/** Combine disjoint preparation/emission reports without losing exact rows. */
export function mergeIrIntegrationReports(
  first: IrIntegrationReport,
  second: IrIntegrationReport,
): IrIntegrationReport {
  if (!first.terminalEvidence || !second.terminalEvidence) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      "split IR integration reports must both retain exact terminal evidence",
    );
  }
  return {
    compiled: [...first.compiled, ...second.compiled],
    errors: [...first.errors, ...second.errors],
    ...(!first.compiledArtifactEvidence && !second.compiledArtifactEvidence
      ? {}
      : {
          compiledArtifactEvidence: [
            ...(first.compiledArtifactEvidence ?? []),
            ...(second.compiledArtifactEvidence ?? []),
          ],
        }),
    terminalEvidence: [...first.terminalEvidence, ...second.terminalEvidence],
    terminalCompiledOwners: [...(first.terminalCompiledOwners ?? []), ...(second.terminalCompiledOwners ?? [])],
    syntheticCompiledArtifacts: [
      ...(first.syntheticCompiledArtifacts ?? []),
      ...(second.syntheticCompiledArtifacts ?? []),
    ],
  };
}

export interface IrFirstSkipIdentityInput {
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
}

/** Exact-ID IR-first allowlist, caller fixpoint, and late-feature closure. */
export function computeIrFirstSkipUnitIds(input: IrFirstSkipIdentityInput): ReadonlySet<IrUnitId> {
  const skip = new Set<IrUnitId>();
  if (input.safeFunctionUnitIds.size === 0) return skip;
  const isF64 = (type: IrType): boolean => asVal(type)?.kind === "f64";
  const isI32 = (type: IrType): boolean => asVal(type)?.kind === "i32";
  const exactRows = new Map<
    IrUnitId,
    {
      claim: IrExactFunctionClaim;
      override: { readonly params: readonly IrType[]; readonly returnType: IrType | null };
    }
  >();
  for (const unitId of input.safeFunctionUnitIds) {
    const claim = input.claimsByUnitId.get(unitId);
    const override = input.overridesByUnitId.get(unitId);
    if (!claim || !override) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `IR-first exact function ${unitId} has no retained claim/override row`,
      );
    }
    exactRows.set(unitId, { claim, override });
  }

  // The body predicate consumes bare call spellings. Derive that compatibility
  // input only from the exact one-to-one active population.
  const claimedArity = new Map<string, number>();
  for (const { claim, override } of exactRows.values()) {
    if (!override.params.every(isF64) || override.returnType === null || !isF64(override.returnType)) continue;
    if (claimedArity.has(claim.legacyName)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `IR-first active function label ${claim.legacyName} has more than one exact owner`,
      );
    }
    claimedArity.set(claim.legacyName, claim.declaration.parameters.length);
  }

  const positionDomain = (annotation: ts.TypeNode | undefined, resolved: IrType): ValueDomain | null => {
    if (isF64(resolved)) return "number";
    if (isI32(resolved) && annotation?.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    return null;
  };
  const signatureDomains = (
    fn: ts.FunctionDeclaration,
    override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
  ): { paramDomains: ValueDomain[]; returnDomain: ValueDomain | "void" } | null => {
    for (const parameter of fn.parameters) {
      if (
        parameter.questionToken ||
        parameter.dotDotDotToken ||
        parameter.initializer ||
        !ts.isIdentifier(parameter.name)
      ) {
        return null;
      }
    }
    const paramDomains: ValueDomain[] = [];
    for (let index = 0; index < override.params.length; index++) {
      const domain = positionDomain(fn.parameters[index]?.type, override.params[index]!);
      if (domain === null) return null;
      paramDomains.push(domain);
    }
    if (override.returnType === null) return { paramDomains, returnDomain: "void" };
    const returnDomain = positionDomain(fn.type, override.returnType);
    return returnDomain === null ? null : { paramDomains, returnDomain };
  };

  for (const [unitId, { claim, override }] of exactRows) {
    const fn = claim.declaration;
    if (fn.asteriskToken && !input.generatorsSkippable) continue;
    const signature = signatureDomains(fn, override);
    if (signature && irFirstBodyIsProvenLowerable(fn, claimedArity, signature.paramDomains, signature.returnDomain)) {
      skip.add(unitId);
    }
  }

  const callEdges = collectLocalCallEdgesByIdentity(input.sourceFile, input.identityContext);
  const callers = new Map<IrUnitId, Set<IrUnitId>>();
  for (const [caller, callees] of callEdges.callees) {
    for (const callee of callees) {
      const owners = callers.get(callee) ?? new Set<IrUnitId>();
      owners.add(caller);
      callers.set(callee, owners);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const unitId of skip) {
      const hasLegacyCaller =
        callEdges.calleesFromUnownedCallers.has(unitId) || [...(callers.get(unitId) ?? [])].some((id) => !skip.has(id));
      if (!hasLegacyCaller) continue;
      skip.delete(unitId);
      changed = true;
    }
  }

  if (skip.size === 0) return skip;
  // Late feature preparation demotes whole selected call components. Close
  // over the full safe population before intersecting with the narrower body-
  // skip allowlist; a selected-but-not-skippable middle node must not break
  // propagation from a blocked owner to a skipped transitive caller/callee.
  const retained = closeIrBlockedComponentByIdentity(
    input.sourceFile,
    input.identityContext,
    input.safeFunctionUnitIds,
    input.potentiallyBlockedOwnerUnitIds,
  );
  for (const unitId of skip) if (!retained.has(unitId)) skip.delete(unitId);
  return skip;
}
