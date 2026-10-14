import { analyzeNativeNumberUndefined } from "./allocation-evidence/native-number-undefined-producer.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Compatibility producer: analyses remain here; frozen facts use the pure planner authority.
import type { AllocSiteRegistry } from "./alloc-registry.js";
import { ALLOC_NAMESPACES, type EscapeInfo } from "./contracts/allocations.js";
import type { PreparedIrModule as IrModule } from "../runtime/contracts/prepared.js";
import { analyzeEncoding, type Encoding } from "./encoding.js";
import { analyzeNativeVectorControl } from "./allocation-evidence/native-control-producer.js";
import { analyzeEscape } from "./escape.js";
import { analyzeOwnership } from "./ownership.js";
import { findStackAllocCandidates } from "./stack-alloc.js";
import { canonicalIndexFromSnapshot, metadataValue } from "./allocations/snapshot.js";
import { collectModuleAllocationInstructions, verifyLinearPreparedAllocationFacts } from "./linear/allocation-facts.js";
import type {
  LinearPreparedAllocationFact,
  LinearPreparedAllocationFacts,
  OwnershipMetadata,
} from "./linear/contracts/allocation-facts.js";
import {
  DEFAULT_ARENA_POLICY,
  planLinearMemoryFromFrozenFacts,
  type LinearMemoryPlan,
} from "./linear-memory-from-facts.js";
import type { LinearAllocatorPolicy } from "./contracts/linear-memory-layout.js";
export { sameDetachedValue } from "./allocations/snapshot.js";
export { verifyLinearPreparedAllocationFacts } from "./linear/allocation-facts.js";
export type {
  LinearPreparedAllocationFact,
  LinearPreparedAllocationFacts,
} from "./linear/contracts/allocation-facts.js";
export {
  LINEAR_STACK_ARENA_BYTES,
  LinearMemoryPlan,
  DEFAULT_ARENA_POLICY,
  ANALYSIS_STACK_ARENA_POLICY,
  linearAllocatorPolicy,
  planLinearMemoryFromFrozenFacts,
  planLinearVectorLayout,
  linearObjectLayoutId,
  linearClassLayoutId,
  linearRefCellLayoutId,
  linearVectorLayoutId,
  linearStringDataSegmentId,
  linearStorageForIrType,
  linearRuntimeOperationKey,
  defaultOperationsForLayout,
} from "./linear-memory-from-facts.js";
export type {
  LinearAllocatorPolicyId,
  LinearOpaqueLayoutPlan,
  LinearLayoutPlan,
  LinearAllocationFacts,
  LinearAllocatorPolicy,
  LinearDataSegmentPlan,
  LinearGlobalStoragePlan,
  LinearMemoryPlanSnapshot,
  LinearStorageKind,
  LinearAllocationClass,
  LinearSizePlan,
  LinearFieldPlan,
  LinearPointerMap,
  LinearRecordLayoutPlan,
  LinearVectorLayoutPlan,
  LinearRuntimeOperation,
  LinearRootPlan,
  LinearSafepointPlan,
  LinearBarrierPlan,
  LinearLifetime,
  LinearAllocationDecision,
  LinearAllocationSitePlan,
} from "./contracts/linear-memory-layout.js";
export type { LinearStringLayoutPlan } from "../../shared/contracts/linear-memory-layout.js";
export {
  LINEAR_POINTER_BYTES,
  LINEAR_RECORD_ALIGNMENT,
  LINEAR_RECORD_HEADER_BYTES,
  LINEAR_RECORD_FIELD_SLOT_BYTES,
  LINEAR_RECORD_TAG_OFFSET,
  LINEAR_RECORD_PAYLOAD_SIZE_OFFSET,
  LINEAR_ARRAY_FORWARDING,
  LINEAR_VECTOR_LENGTH_OFFSET,
  LINEAR_VECTOR_CAPACITY_OFFSET,
  LINEAR_VECTOR_ELEMENTS_OFFSET,
  LINEAR_VECTOR_MINIMUM_CAPACITY,
  LINEAR_STRING_LENGTH_OFFSET,
  LINEAR_STRING_ELEMENTS_OFFSET,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
  storageBytes,
  storageAlignment,
  planLinearRecordLayout,
  linearStringLayoutId,
  planLinearStringLayout,
} from "../../shared/contracts/linear-memory-layout.js";

/**
 * Run allocation analyses once and return their detached evidence. This is
 * the producer half of the linear body handoff; it deliberately does not
 * choose addresses, segments, or backend operations.
 */
export function prepareLinearAllocationFacts(
  module: IrModule,
  registry: AllocSiteRegistry,
  nativeVectorControl = false,
): LinearPreparedAllocationFacts {
  for (const fn of module.functions) {
    analyzeEncoding(fn, registry);
    const ownership = analyzeOwnership(fn, registry);
    analyzeEscape(fn, registry, ownership);
    findStackAllocCandidates(fn, registry, ownership);
    if (nativeVectorControl) analyzeNativeVectorControl(fn, registry, true);
  }

  if (nativeVectorControl) analyzeNativeNumberUndefined(module, registry, true);
  const registrySnapshot = registry.snapshot();
  const located = collectModuleAllocationInstructions(module);
  const allocations: LinearPreparedAllocationFact[] = [];
  const seen = new Set<number>();

  for (const { instr } of located.allocations) {
    const alloc = instr.alloc;
    if (alloc === undefined) continue;
    const numericId = alloc as number;
    if (seen.has(numericId)) throw new Error(`duplicate live allocation-site id ${numericId} in linear-memory plan`);
    seen.add(numericId);
    const site = registry.resolve(alloc);
    if (!site) {
      const state = registry.isKnown(alloc) ? "retired or broken alias" : "unknown";
      throw new Error(`linear-memory allocation facts cannot resolve ${state} site ${numericId}`);
    }
    const canonicalIndex = canonicalIndexFromSnapshot(alloc, registrySnapshot);
    const ownershipEvidence = metadataValue(registrySnapshot, canonicalIndex, ALLOC_NAMESPACES.ownership);
    const escapeEvidence = metadataValue(registrySnapshot, canonicalIndex, ALLOC_NAMESPACES.escape);
    const encodingEvidence = metadataValue(registrySnapshot, canonicalIndex, ALLOC_NAMESPACES.encoding);
    const ownership = (ownershipEvidence.value as OwnershipMetadata | undefined) ?? {};
    const escapeInfo = (escapeEvidence.value as EscapeInfo | undefined) ?? {
      classification: "opaque",
      stackAllocatable: false,
    };
    const encoding = encodingEvidence.value as Encoding | undefined;
    allocations.push({
      id: alloc,
      site,
      ownership: ownership.state ?? "escaped",
      accesses: ownership.ops ?? [],
      escape: escapeInfo.classification,
      stackCandidate: ownership.stackCandidate === true,
      ...(encodingEvidence.present ? { encoding } : {}),
      evidence: {
        ownership: {
          present: ownershipEvidence.present,
          value: ownershipEvidence.value as OwnershipMetadata | undefined,
        },
        escape: { present: escapeEvidence.present, value: escapeEvidence.value as EscapeInfo | undefined },
        encoding: { present: encodingEvidence.present, value: encoding },
      },
    });
  }

  allocations.sort((left, right) => (left.id as number) - (right.id as number));
  const preparedFacts = {
    allocations: Object.freeze(allocations),
    registry: registrySnapshot,
  };
  verifyLinearPreparedAllocationFacts(module, preparedFacts);
  return preparedFacts;
}

/** Run analyses and build one canonical plan for compatibility callers. */
export function planLinearMemory(
  module: IrModule,
  registry: AllocSiteRegistry,
  policy: LinearAllocatorPolicy = DEFAULT_ARENA_POLICY,
): LinearMemoryPlan {
  return planLinearMemoryFromFrozenFacts(module, prepareLinearAllocationFacts(module, registry), policy);
}
