// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrCountedStringAppendLoweringPlan, PreparedCountedStringAppendReceipt } from "./ast-lowering-plans.js";
import { sameIrCallableBinding } from "./callable-bindings.js";
import type { IrUnitId } from "./identity.js";
import {
  parseIrCountedStringAppendSiteId,
  irCountedStringAppendSiteIdIsCurrent,
} from "../shared/contracts/ir-counted-string-site-id.js";
export {
  createIrCountedStringAppendSiteId,
  parseIrCountedStringAppendSiteId,
  irCountedStringAppendSiteIdIsCurrent,
  assertUniqueCurrentIrCountedStringAppendSites,
} from "../shared/contracts/ir-counted-string-site-id.js";
import { digestIrInstructions } from "./instruction-digest.js";
import { forEachInstrDeep, type IrInstr } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";
import {
  IR_STRING_REPEAT_COUNTED_NATIVE_FN,
  IR_STRING_REPEAT_FN,
  irCountedStringRepeatFitsNativeKernel,
} from "./string-runtime.js";

import type {
  IrCountedStringAppendSiteId,
  IrCountedStringAppendSiteIdentity,
} from "../shared/contracts/ir-counted-string-identity.js";
export type {
  IrCountedStringAppendSiteId,
  IrCountedStringAppendSiteIdentity,
  IrCountedStringAppendSiteClaim,
} from "../shared/contracts/ir-counted-string-identity.js";

/** Successful final IR artifact supplied by either backend preparation path. */
export interface IrCountedStringAppendFinalArtifact {
  readonly artifactUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly instructions: readonly IrInstr[];
}

/** Minimal function shape needed to select the final executable instruction roots. */
export interface IrCountedStringAppendFinalFunction {
  readonly blocks: readonly { readonly instrs: readonly IrInstr[] }[];
  readonly asyncPlan?: { readonly states: readonly { readonly body: readonly IrInstr[] }[] };
  readonly asyncRuntime?: { readonly states: readonly { readonly body: readonly IrInstr[] }[] };
}

const DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/** Recompute and authenticate a retained plan's site from its exact source span. */
export function requireCurrentIrCountedStringAppendPlanSite(
  plan: IrCountedStringAppendLoweringPlan,
): Readonly<IrCountedStringAppendSiteIdentity> {
  if (
    plan.syntaxPlan.sourceFile !== plan.sourceFile ||
    plan.syntaxPlan.loop.getSourceFile() !== plan.sourceFile ||
    !irCountedStringAppendSiteIdIsCurrent(plan.siteId, {
      sourceId: plan.sourceId,
      ownerUnitId: plan.ownerUnitId,
      loopStart: plan.syntaxPlan.loop.getStart(plan.sourceFile),
      loopEnd: plan.syntaxPlan.loop.getEnd(),
    })
  ) {
    throw new TypeError("counted-string append plan site is malformed or detached from its exact source/owner/span");
  }
  return parseIrCountedStringAppendSiteId(plan.siteId)!;
}

function requireCanonicalCountedStringAppendProvider(plan: IrCountedStringAppendLoweringPlan): void {
  if (plan.provider.binding.kind !== "intrinsic" || plan.provider.binding.symbol !== IR_STRING_REPEAT_FN) {
    throw new TypeError(`counted-string append plan ${plan.siteId} has a non-canonical provider`);
  }
}

/** Authenticate a published receipt without relying on live AST object identity. */
export function requireValidPreparedCountedStringAppendReceipt(
  receipt: PreparedCountedStringAppendReceipt,
): Readonly<IrCountedStringAppendSiteIdentity> {
  if (
    !Object.isFrozen(receipt) ||
    !Object.isFrozen(receipt.plan) ||
    !Object.isFrozen(receipt.plan.syntaxPlan) ||
    receipt.siteId !== receipt.plan.siteId ||
    !DIGEST_PATTERN.test(receipt.finalInstructionDigest)
  ) {
    throw new TypeError("prepared counted-string receipt is mutable or has detached site/digest evidence");
  }
  requireCanonicalCountedStringAppendProvider(receipt.plan);
  return requireCurrentIrCountedStringAppendPlanSite(receipt.plan);
}

function associationMismatch(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", `counted-string provenance: ${detail}`);
}

/** Prefer prepared executable async states; the semantic plan is the pre-attachment fallback. */
export function collectFinalIrCountedStringAppendInstructions(
  fn: IrCountedStringAppendFinalFunction,
): readonly IrInstr[] {
  const asyncStates = fn.asyncRuntime?.states ?? fn.asyncPlan?.states ?? [];
  return [...fn.blocks.flatMap((block) => block.instrs), ...asyncStates.flatMap((state) => state.body)];
}

function associationPlanIdentity(plan: IrCountedStringAppendLoweringPlan): Readonly<IrCountedStringAppendSiteIdentity> {
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.syntaxPlan)) {
    return associationMismatch(`site ${plan.siteId} has mutable retained plan evidence`);
  }
  if (!Number.isSafeInteger(plan.syntaxPlan.tripCount) || plan.syntaxPlan.tripCount < 0) {
    return associationMismatch(`site ${plan.siteId} has invalid trip count ${plan.syntaxPlan.tripCount}`);
  }
  try {
    requireCanonicalCountedStringAppendProvider(plan);
    return requireCurrentIrCountedStringAppendPlanSite(plan);
  } catch (error) {
    return associationMismatch(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Join every retained plan to exactly one final provenance-bearing repeat.
 * Generic site-less repeats are deliberately ignored. Receipts for all trip
 * counts are returned in retained-plan order and digest the exact owner body.
 */
export function associateFinalIrCountedStringAppendSites(
  retainedPlans: readonly IrCountedStringAppendLoweringPlan[],
  finalArtifacts: readonly IrCountedStringAppendFinalArtifact[],
): readonly PreparedCountedStringAppendReceipt[] {
  const allPlansBySite = new Map<IrCountedStringAppendSiteId, IrCountedStringAppendLoweringPlan>();
  const expectedBySite = new Map<IrCountedStringAppendSiteId, IrCountedStringAppendLoweringPlan>();
  for (const plan of retainedPlans) {
    associationPlanIdentity(plan);
    if (allPlansBySite.has(plan.siteId)) {
      associationMismatch(`duplicate retained site ${plan.siteId}`);
    }
    allPlansBySite.set(plan.siteId, plan);
    if (plan.syntaxPlan.tripCount >= 2) expectedBySite.set(plan.siteId, plan);
  }

  const artifactsByUnitId = new Map<IrUnitId, IrCountedStringAppendFinalArtifact>();
  const digestsByUnitId = new Map<IrUnitId, string>();
  const observedSites = new Set<IrCountedStringAppendSiteId>();
  for (const artifact of finalArtifacts) {
    if (artifactsByUnitId.has(artifact.artifactUnitId)) {
      associationMismatch(`final artifact ${artifact.artifactUnitId} occurs more than once`);
    }
    artifactsByUnitId.set(artifact.artifactUnitId, artifact);
    digestsByUnitId.set(artifact.artifactUnitId, digestIrInstructions(artifact.instructions));
    for (const instr of artifact.instructions) {
      forEachInstrDeep(instr, (nested) => {
        if (nested.kind !== "string.repeat" || nested.countedStringAppendSite === undefined) return;
        const parsed = parseIrCountedStringAppendSiteId(nested.countedStringAppendSite);
        if (!parsed) associationMismatch(`final artifact ${artifact.artifactUnitId} carries a malformed site`);
        const siteId = nested.countedStringAppendSite;
        const plan = allPlansBySite.get(siteId);
        if (!plan) associationMismatch(`final artifact ${artifact.artifactUnitId} carries unknown site ${siteId}`);
        if (plan.syntaxPlan.tripCount < 2) {
          associationMismatch(`zero/one-trip site ${siteId} unexpectedly emitted string.repeat`);
        }
        if (
          parsed.sourceId !== plan.sourceId ||
          parsed.ownerUnitId !== plan.ownerUnitId ||
          artifact.terminalOwnerUnitId !== plan.ownerUnitId ||
          artifact.artifactUnitId !== plan.ownerUnitId
        ) {
          associationMismatch(`site ${siteId} is borrowed by final artifact ${artifact.artifactUnitId}`);
        }
        const expectedTripCount = irCountedStringRepeatFitsNativeKernel(
          plan.syntaxPlan.tripCount,
          plan.syntaxPlan.fragmentValue.length,
        )
          ? plan.syntaxPlan.tripCount
          : undefined;
        if (nested.countedStringAppendTripCount !== expectedTripCount) {
          associationMismatch(`site ${siteId} carries a mismatched counted trip-count proof`);
        }
        const providerSymbol =
          nested.provider?.binding.kind === "intrinsic" ? nested.provider.binding.symbol : undefined;
        const hasCanonicalProvider =
          nested.provider !== undefined &&
          (sameIrCallableBinding(nested.provider.binding, plan.provider.binding) ||
            (expectedTripCount !== undefined && providerSymbol === IR_STRING_REPEAT_COUNTED_NATIVE_FN));
        if (!hasCanonicalProvider) {
          associationMismatch(`site ${siteId} carries a non-canonical final provider`);
        }
        if (observedSites.has(siteId)) associationMismatch(`site ${siteId} occurs more than once in final IR`);
        observedSites.add(siteId);
      });
    }
  }

  for (const [siteId] of expectedBySite) {
    if (!observedSites.has(siteId)) associationMismatch(`expected site ${siteId} is missing from final IR`);
  }

  const receipts = retainedPlans.map((plan): PreparedCountedStringAppendReceipt => {
    const artifact = artifactsByUnitId.get(plan.ownerUnitId);
    if (!artifact || artifact.terminalOwnerUnitId !== plan.ownerUnitId) {
      return associationMismatch(`site ${plan.siteId} has no exact final terminal artifact ${plan.ownerUnitId}`);
    }
    const finalInstructionDigest = digestsByUnitId.get(plan.ownerUnitId);
    if (!finalInstructionDigest) {
      return associationMismatch(`site ${plan.siteId} has no final instruction digest for ${plan.ownerUnitId}`);
    }
    return Object.freeze({ siteId: plan.siteId, plan, finalInstructionDigest });
  });
  for (const receipt of receipts) requireValidPreparedCountedStringAppendReceipt(receipt);
  return Object.freeze(receipts);
}
