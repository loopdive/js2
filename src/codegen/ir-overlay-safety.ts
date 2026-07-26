// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../ir/identity.js";
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

/**
 * Correlate names returned by `compileDeclarations` only against the requested
 * projection. Foreign, duplicate, and missing results all fail closed.
 */
export function correlateIrSkippedFunctionNames(
  requested: IrLegacyUnitProjection,
  returnedLegacyNames: readonly string[],
): IrCorrelatedSkippedFunctions {
  const correlation = requested.startResultCorrelation<true>();
  for (const legacyName of returnedLegacyNames) {
    const entry = requested.getByLegacyName(legacyName);
    if (!entry) {
      throw new IrLegacyUnitProjectionInvariantError(
        "foreign-result-correlation",
        `legacy declaration compiler returned unrequested skipped function ${JSON.stringify(legacyName)}`,
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
