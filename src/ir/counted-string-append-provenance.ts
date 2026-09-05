// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrCountedStringAppendLoweringPlan, PreparedCountedStringAppendReceipt } from "./ast-lowering-plans.js";
import { sameIrCallableBinding } from "./callable-bindings.js";
import type { IrSourceId, IrSourceKind, IrUnitId, IrUnitKind } from "./identity.js";
import { digestIrInstructions } from "./instruction-digest.js";
import { forEachInstrDeep, type IrInstr } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";
import {
  IR_STRING_REPEAT_COUNTED_NATIVE_FN,
  IR_STRING_REPEAT_FN,
  irCountedStringRepeatFitsNativeKernel,
} from "./string-runtime.js";

declare const irCountedStringAppendSiteIdBrand: unique symbol;

/** Immutable source-qualified identity for one checker-proven counted append loop. */
export type IrCountedStringAppendSiteId = string & {
  readonly [irCountedStringAppendSiteIdBrand]: "IrCountedStringAppendSiteId";
};

/** Identity primitives retained after the live AST proof has been validated. */
export interface IrCountedStringAppendSiteIdentity {
  readonly sourceId: IrSourceId;
  readonly ownerUnitId: IrUnitId;
  readonly loopStart: number;
  readonly loopEnd: number;
}

/** Untrusted site claim paired with the exact identity it is expected to represent. */
export interface IrCountedStringAppendSiteClaim extends IrCountedStringAppendSiteIdentity {
  readonly siteId: string;
}

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

const SITE_PREFIX = "ir-counted-string-append-site:v1";
const SITE_PATTERN = /^ir-counted-string-append-site:v1:([^:]+):([^:]+):([0-9]{16}):([0-9]{16})$/;
const DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const SOURCE_ID_PATTERN = /^ir-source:v1:([0-9]{16}):([^:]+):([^:]+)$/;
const SOURCE_OWNED_UNIT_ID_PATTERN = /^ir-unit:v1:([^:]+):([^:]+):([^:]+):([0-9]{16})$/;
const SOURCE_OWNED_CLASS_ID_PATTERN = /^ir-class:v1:([^:]+):([^:]+):([^:]+):([0-9]{16})$/;
const SOURCE_KIND_AUTHORITY: Readonly<Record<IrSourceKind, true>> = {
  entry: true,
  source: true,
  library: true,
  synthetic: true,
};
const SOURCE_KINDS: ReadonlySet<string> = new Set(Object.keys(SOURCE_KIND_AUTHORITY));
const UNIT_KIND_AUTHORITY: Readonly<Record<IrUnitKind, true>> = {
  "top-level-function": true,
  "nested-function": true,
  "function-expression": true,
  "arrow-function": true,
  "class-constructor": true,
  "class-implicit-constructor": true,
  "class-instance-method": true,
  "class-static-method": true,
  "class-instance-getter": true,
  "class-static-getter": true,
  "class-instance-setter": true,
  "class-static-setter": true,
  "class-instance-field-initializer": true,
  "class-static-field-initializer": true,
  "class-static-block": true,
  "object-method": true,
  "object-getter": true,
  "object-setter": true,
  "export-assignment": true,
  "module-init": true,
  "synthetic-support": true,
};
const UNIT_KINDS: ReadonlySet<string> = new Set(Object.keys(UNIT_KIND_AUTHORITY));
const MAX_LEXICAL_OWNER_DEPTH = 64;

function canonicalPosition(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${value}`);
  }
  return value.toString(10).padStart(16, "0");
}

function canonicalIdentityComponent(value: string): string {
  return encodeURIComponent(value);
}

function parseCanonicalIdentityComponent(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && canonicalIdentityComponent(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function hasCanonicalOrdinal(value: string): boolean {
  const ordinal = Number(value);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 && canonicalPosition(ordinal, "identity ordinal") === value;
}

function isCanonicalSourceId(value: string): value is IrSourceId {
  const match = SOURCE_ID_PATTERN.exec(value);
  return !!(
    match &&
    hasCanonicalOrdinal(match[1]!) &&
    SOURCE_KINDS.has(match[2]!) &&
    parseCanonicalIdentityComponent(match[3]!) !== undefined
  );
}

function isCanonicalLexicalOwner(component: string, sourceId: IrSourceId, depth: number): boolean {
  if (component === "root") return true;
  const ownerId = parseCanonicalIdentityComponent(component);
  if (!ownerId || depth >= MAX_LEXICAL_OWNER_DEPTH) return false;
  return (
    isCanonicalSourceOwnedUnitId(ownerId, sourceId, depth + 1) ||
    isCanonicalSourceOwnedClassId(ownerId, sourceId, depth + 1)
  );
}

/** Canonical source-qualified grammar only; inventory terminal membership is proven at later boundaries. */
function isCanonicalSourceOwnedUnitId(value: string, sourceId: IrSourceId, depth = 0): value is IrUnitId {
  const match = SOURCE_OWNED_UNIT_ID_PATTERN.exec(value);
  if (!match || depth > MAX_LEXICAL_OWNER_DEPTH) return false;
  const decodedSourceId = parseCanonicalIdentityComponent(match[1]!);
  return !!(
    decodedSourceId === sourceId &&
    isCanonicalLexicalOwner(match[2]!, sourceId, depth) &&
    UNIT_KINDS.has(match[3]!) &&
    hasCanonicalOrdinal(match[4]!)
  );
}

function isCanonicalSourceOwnedClassId(value: string, sourceId: IrSourceId, depth: number): boolean {
  const match = SOURCE_OWNED_CLASS_ID_PATTERN.exec(value);
  if (!match || depth > MAX_LEXICAL_OWNER_DEPTH) return false;
  const decodedSourceId = parseCanonicalIdentityComponent(match[1]!);
  return !!(
    decodedSourceId === sourceId &&
    isCanonicalLexicalOwner(match[2]!, sourceId, depth) &&
    (match[3] === "declaration" || match[3] === "expression") &&
    hasCanonicalOrdinal(match[4]!)
  );
}

/** Derive the sole canonical encoding of an exact source/owner/loop-span tuple. */
export function createIrCountedStringAppendSiteId(
  identity: IrCountedStringAppendSiteIdentity,
): IrCountedStringAppendSiteId {
  if (!isCanonicalSourceId(identity.sourceId)) {
    throw new TypeError("sourceId is not a canonical source identity");
  }
  if (!isCanonicalSourceOwnedUnitId(identity.ownerUnitId, identity.sourceId)) {
    throw new TypeError("ownerUnitId is not a canonical source-qualified non-derived identity for sourceId");
  }
  const loopStart = canonicalPosition(identity.loopStart, "loopStart");
  const loopEnd = canonicalPosition(identity.loopEnd, "loopEnd");
  if (identity.loopEnd <= identity.loopStart) {
    throw new RangeError(`loopEnd must be greater than loopStart, received ${identity.loopStart}..${identity.loopEnd}`);
  }
  return `${SITE_PREFIX}:${canonicalIdentityComponent(identity.sourceId)}:${canonicalIdentityComponent(
    identity.ownerUnitId,
  )}:${loopStart}:${loopEnd}` as IrCountedStringAppendSiteId;
}

/** Parse only the canonical v1 grammar; malformed and alternate encodings fail closed. */
export function parseIrCountedStringAppendSiteId(
  value: string,
): Readonly<IrCountedStringAppendSiteIdentity> | undefined {
  if (typeof value !== "string") return undefined;
  const match = SITE_PATTERN.exec(value);
  if (!match) return undefined;
  const sourceId = parseCanonicalIdentityComponent(match[1]!);
  const ownerUnitId = parseCanonicalIdentityComponent(match[2]!);
  if (!sourceId || !ownerUnitId) return undefined;
  if (!isCanonicalSourceId(sourceId) || !isCanonicalSourceOwnedUnitId(ownerUnitId, sourceId)) return undefined;

  const loopStart = Number(match[3]);
  const loopEnd = Number(match[4]);
  if (
    !Number.isSafeInteger(loopStart) ||
    !Number.isSafeInteger(loopEnd) ||
    canonicalPosition(loopStart, "loopStart") !== match[3] ||
    canonicalPosition(loopEnd, "loopEnd") !== match[4] ||
    loopEnd <= loopStart
  ) {
    return undefined;
  }
  return Object.freeze({
    sourceId: sourceId as IrSourceId,
    ownerUnitId: ownerUnitId as IrUnitId,
    loopStart,
    loopEnd,
  });
}

/** True only when a canonical site still denotes the exact authoritative tuple. */
export function irCountedStringAppendSiteIdIsCurrent(
  siteId: string,
  identity: IrCountedStringAppendSiteIdentity,
): siteId is IrCountedStringAppendSiteId {
  try {
    return (
      parseIrCountedStringAppendSiteId(siteId) !== undefined && createIrCountedStringAppendSiteId(identity) === siteId
    );
  } catch {
    return false;
  }
}

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

/**
 * Fail closed before constructing an expected-by-site index. Every claim must
 * be canonical, current for its exact source/owner/span, and unique.
 */
export function assertUniqueCurrentIrCountedStringAppendSites(claims: readonly IrCountedStringAppendSiteClaim[]): void {
  const seen = new Set<IrCountedStringAppendSiteId>();
  for (const claim of claims) {
    const siteId = claim.siteId;
    if (!irCountedStringAppendSiteIdIsCurrent(siteId, claim)) {
      throw new TypeError("counted-string append site is malformed or detached from its exact source/owner/span");
    }
    if (seen.has(siteId)) {
      throw new TypeError(`duplicate counted-string append site ${siteId}`);
    }
    seen.add(siteId);
  }
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
