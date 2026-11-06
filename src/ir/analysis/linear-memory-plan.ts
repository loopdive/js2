// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Target-neutral linear-memory planning (#3298).
//
// This module is the middle-end authority for allocation class, record/vector/
// string layout, pointer maps, lifetime, roots, safepoints, barriers, and
// relocatable static-storage requirements. It deliberately contains no Wasm
// instructions or module indices, Porffor representation values, renderer
// records, concrete runtime symbol names, or artifact fragments.

import {
  LINEAR_POINTER_BYTES,
  storageBytes,
  storageAlignment,
  planLinearRecordLayout,
  planLinearStringLayout,
  linearScalarStorageKey,
  linearVectorLayoutIdForElementKey,
  planLinearVectorStorageLayout,
  planLinearScalarVectorLayout,
} from "../../shared/contracts/linear-memory-layout.js";
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
import type { LinearStringLayoutPlan } from "../../shared/contracts/linear-memory-layout.js";
export type { LinearStringLayoutPlan } from "../../shared/contracts/linear-memory-layout.js";

import {
  ALLOC_NAMESPACES,
  type AllocRegistrySnapshot,
  type AllocSite,
  type AllocSiteRegistry,
} from "../alloc-registry.js";
import {
  forEachInstrDeep,
  type AllocKind,
  type AllocSiteId,
  type IrClassShape,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrObjectShape,
  type IrSiteId,
  type IrType,
  type IrValueId,
} from "../nodes.js";
import { analyzeEncoding, type Encoding } from "./encoding.js";
import { analyzeEscape, type EscapeClass, type EscapeInfo } from "./escape.js";
import type { Ownership } from "./lattice.js";
import { analyzeOwnership } from "./ownership.js";
import { findStackAllocCandidates } from "./stack-alloc.js";
import { irFnctorShapeKey } from "../type-key.js";
import type {
  LinearStorageKind,
  LinearAllocationClass,
  LinearSizePlan,
  LinearLayoutBase,
  LinearRecordLayoutPlan,
  LinearVectorLayoutPlan,
  LinearRuntimeOperation,
  LinearLifetime,
  LinearAllocationDecision,
  LinearAllocationSitePlan,
} from "./contracts/linear-memory-layout.js";
export type {
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
export const LINEAR_STACK_ARENA_BYTES = 64 * 1024;
export type LinearAllocatorPolicyId = "arena-v1" | "analysis-stack-arena-v1";

export interface LinearOpaqueLayoutPlan extends LinearLayoutBase {
  readonly kind: "opaque";
  readonly allocationKind: AllocKind;
}

export type LinearLayoutPlan =
  | LinearRecordLayoutPlan
  | LinearVectorLayoutPlan
  | LinearStringLayoutPlan
  | LinearOpaqueLayoutPlan;

export interface LinearAllocationFacts {
  readonly site: AllocSite;
  readonly layout: LinearLayoutPlan;
  readonly ownership: Ownership;
  readonly accesses: readonly string[];
  readonly escape: EscapeClass;
  readonly stackCandidate: boolean;
  readonly encoding?: Encoding;
}

/**
 * Allocation analysis output detached from the mutable registry and physical
 * layout. The batch boundary owns this value before a backend chooses layout.
 */
export interface LinearPreparedAllocationFact {
  readonly id: AllocSiteId;
  readonly site: AllocSite;
  readonly ownership: Ownership;
  readonly accesses: readonly string[];
  readonly escape: EscapeClass;
  readonly stackCandidate: boolean;
  readonly encoding?: Encoding;
  /** Presence is separate from the value so absent and explicit undefined survive freeze. */
  readonly evidence: {
    readonly ownership: { readonly present: boolean; readonly value: OwnershipMetadata | undefined };
    readonly escape: { readonly present: boolean; readonly value: EscapeInfo | undefined };
    readonly encoding: { readonly present: boolean; readonly value: Encoding | undefined };
  };
}

export interface LinearPreparedAllocationFacts {
  readonly allocations: readonly LinearPreparedAllocationFact[];
  readonly registry: AllocRegistrySnapshot;
}

/** Policy seam. Policies consume facts only; target adapters bind operations. */
export interface LinearAllocatorPolicy {
  readonly id: string;
  decide(facts: LinearAllocationFacts): LinearAllocationDecision;
}

/** Relocatable bytes. The artifact adapter chooses the final address/order. */
export interface LinearDataSegmentPlan {
  readonly id: string;
  readonly alignment: number;
  readonly bytes: readonly number[];
}

/** Symbolic static storage. The artifact adapter chooses the global index. */
export interface LinearGlobalStoragePlan {
  readonly id: string;
  readonly allocationClass: "static";
  readonly storage: LinearStorageKind;
  readonly sizeBytes: number;
  readonly alignment: number;
  readonly containsPointer: boolean;
  readonly mutable: boolean;
  readonly initializer: "zero";
}

export interface LinearMemoryPlanSnapshot {
  readonly policy: string;
  readonly layouts: readonly LinearLayoutPlan[];
  readonly allocations: readonly LinearAllocationSitePlan[];
  readonly dataSegments: readonly LinearDataSegmentPlan[];
  readonly globals: readonly LinearGlobalStoragePlan[];
}

/** Immutable, indexed view over the serializable target-neutral plan. */
export class LinearMemoryPlan {
  readonly policy: string;
  readonly layouts: readonly LinearLayoutPlan[];
  readonly allocations: readonly LinearAllocationSitePlan[];
  readonly dataSegments: readonly LinearDataSegmentPlan[];
  readonly globals: readonly LinearGlobalStoragePlan[];

  private readonly layoutsById: ReadonlyMap<string, LinearLayoutPlan>;
  private readonly allocationsById: ReadonlyMap<number, LinearAllocationSitePlan>;
  private readonly dataSegmentsById: ReadonlyMap<string, LinearDataSegmentPlan>;
  private readonly globalsById: ReadonlyMap<string, LinearGlobalStoragePlan>;

  constructor(snapshot: LinearMemoryPlanSnapshot) {
    const frozen = freezePlanValue(snapshot);
    this.policy = frozen.policy;
    this.layouts = frozen.layouts;
    this.allocations = frozen.allocations;
    this.dataSegments = frozen.dataSegments;
    this.globals = frozen.globals;
    this.layoutsById = indexUnique(this.layouts, (layout) => layout.id, "layout");
    this.allocationsById = indexUnique(this.allocations, (allocation) => allocation.id as number, "allocation site");
    this.dataSegmentsById = indexUnique(this.dataSegments, (segment) => segment.id, "data segment");
    this.globalsById = indexUnique(this.globals, (global) => global.id, "global storage");

    for (const allocation of this.allocations) {
      if (!this.layoutsById.has(allocation.layoutId)) {
        throw new Error(
          `linear-memory allocation site ${allocation.id as number} references missing layout '${allocation.layoutId}'`,
        );
      }
      if (allocation.dataSegmentId !== undefined && !this.dataSegmentsById.has(allocation.dataSegmentId)) {
        throw new Error(
          `linear-memory allocation site ${allocation.id as number} references missing data segment '${allocation.dataSegmentId}'`,
        );
      }
    }
    Object.freeze(this);
  }

  layout(id: string): LinearLayoutPlan | undefined {
    return this.layoutsById.get(id);
  }

  requireLayout(id: string): LinearLayoutPlan {
    const layout = this.layout(id);
    if (!layout) throw new Error(`linear-memory plan has no layout '${id}'`);
    return layout;
  }

  allocation(id: AllocSiteId): LinearAllocationSitePlan | undefined {
    return this.allocationsById.get(id as number);
  }

  dataSegment(id: string): LinearDataSegmentPlan | undefined {
    return this.dataSegmentsById.get(id);
  }

  requireDataSegment(id: string): LinearDataSegmentPlan {
    const segment = this.dataSegment(id);
    if (!segment) throw new Error(`linear-memory plan has no data segment '${id}'`);
    return segment;
  }

  global(id: string): LinearGlobalStoragePlan | undefined {
    return this.globalsById.get(id);
  }

  layoutForObjectShape(shape: IrObjectShape): LinearRecordLayoutPlan | undefined {
    const layout = this.layout(linearObjectLayoutId(shape));
    return layout?.kind === "record" ? layout : undefined;
  }

  layoutForClassShape(shape: IrClassShape): LinearRecordLayoutPlan | undefined {
    const layout = this.layout(linearClassLayoutId(shape));
    return layout?.kind === "record" ? layout : undefined;
  }

  layoutForRefCell(inner: IrType): LinearRecordLayoutPlan | undefined {
    const layout = this.layout(linearRefCellLayoutId(inner));
    return layout?.kind === "record" ? layout : undefined;
  }

  layoutForVector(element: IrType): LinearVectorLayoutPlan | undefined {
    const layout = this.layout(linearVectorLayoutId(element));
    return layout?.kind === "vector" ? layout : undefined;
  }

  allocationsForLayout(layoutId: string): readonly LinearAllocationSitePlan[] {
    return this.allocations.filter((allocation) => allocation.layoutId === layoutId);
  }

  toJSON(): LinearMemoryPlanSnapshot {
    return Object.freeze({
      policy: this.policy,
      layouts: this.layouts,
      allocations: this.allocations,
      dataSegments: this.dataSegments,
      globals: this.globals,
    });
  }
}

/** Clone + freeze the plan's deliberately plain, serializable value graph. */
function freezePlanValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezePlanValue(item))) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) clone[key] = freezePlanValue(item);
  return Object.freeze(clone) as T;
}

function indexUnique<T, K>(values: readonly T[], keyOf: (value: T) => K, label: string): ReadonlyMap<K, T> {
  const indexed = new Map<K, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (indexed.has(key)) throw new Error(`linear-memory plan has duplicate ${label} '${String(key)}'`);
    indexed.set(key, value);
  }
  return indexed;
}

interface OwnershipMetadata {
  readonly state?: Ownership;
  readonly ops?: readonly string[];
  readonly stackCandidate?: boolean;
}

/** Current arena policy: analysis facts are recorded but do not change bytes. */
export const DEFAULT_ARENA_POLICY: LinearAllocatorPolicy = {
  id: "arena-v1",
  decide(facts): LinearAllocationDecision {
    // Externally-owned allocations are conservatively managed. They are not
    // lowered by the linear backend today, but still receive a complete plan.
    const external = facts.site.kind === "extern" || facts.site.kind === "iterator" || facts.site.kind === "generator";
    const allocationClass: LinearAllocationClass = external ? "managed" : "arena";
    const lifetime = lifetimeFromEscape(facts.escape);
    const operations = operationsForLayout(facts.layout, allocationClass);
    if (allocationClass === "arena") {
      return {
        allocationClass,
        lifetime,
        root: { kind: "none" },
        safepoints: { kind: "none" },
        barrier: { kind: "none" },
        operations,
      };
    }
    const barrierOperation: LinearRuntimeOperation = { family: "managed", operation: "write-barrier" };
    return {
      allocationClass,
      lifetime,
      root: { kind: "managed", lifetime, operation: { family: "managed", operation: "root" } },
      safepoints: { kind: "calls-and-backedges" },
      barrier:
        facts.layout.pointerMap.kind === "none"
          ? { kind: "none" }
          : { kind: "pointer-stores", operation: barrierOperation },
      operations,
    };
  },
};

/**
 * Analysis-guided function stack with the existing arena as the conservative
 * fallback. Only fixed-size allocations already proven owned, local, and safe
 * by #747/#1587 are promoted. The policy deliberately does not introduce a
 * collector: ADR-0017 keeps raw JS2 pointers non-moving in both consumers.
 */
export const ANALYSIS_STACK_ARENA_POLICY: LinearAllocatorPolicy = {
  id: "analysis-stack-arena-v1",
  decide(facts): LinearAllocationDecision {
    const stack =
      facts.stackCandidate &&
      facts.escape === "local" &&
      facts.layout.size.kind === "constant" &&
      facts.site.kind !== "extern" &&
      facts.site.kind !== "iterator" &&
      facts.site.kind !== "generator";
    if (!stack) return DEFAULT_ARENA_POLICY.decide(facts);
    const operations = operationsForLayout(facts.layout, "stack");
    return {
      allocationClass: "stack",
      lifetime: "function",
      root: { kind: "none" },
      safepoints: { kind: "none" },
      barrier: { kind: "none" },
      operations: [...operations, { family: "stack", operation: "mark" }, { family: "stack", operation: "restore" }],
    };
  },
};

export function linearAllocatorPolicy(id: string): LinearAllocatorPolicy {
  if (id === DEFAULT_ARENA_POLICY.id) return DEFAULT_ARENA_POLICY;
  if (id === ANALYSIS_STACK_ARENA_POLICY.id) return ANALYSIS_STACK_ARENA_POLICY;
  throw new Error(`unknown linear-memory allocation policy '${id}'`);
}

/**
 * Run allocation analyses once and return their detached evidence. This is
 * the producer half of the linear body handoff; it deliberately does not
 * choose addresses, segments, or backend operations.
 */
export function prepareLinearAllocationFacts(
  module: IrModule,
  registry: AllocSiteRegistry,
): LinearPreparedAllocationFacts {
  for (const fn of module.functions) {
    analyzeEncoding(fn, registry);
    const ownership = analyzeOwnership(fn, registry);
    analyzeEscape(fn, registry, ownership);
    findStackAllocCandidates(fn, registry, ownership);
  }

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

function canonicalSiteFromSnapshot(id: AllocSiteId, snapshot: AllocRegistrySnapshot): AllocSite {
  return snapshotSiteAtCanonicalIndex(canonicalIndexFromSnapshot(id, snapshot), snapshot);
}

function canonicalIndexFromSnapshot(id: AllocSiteId, snapshot: AllocRegistrySnapshot): number {
  let current = id as number;
  const seen = new Set<number>();
  while (true) {
    if (current < 0 || current >= snapshot.entries.length || !snapshot.entries[current]) {
      throw new Error(`linear-memory frozen allocation facts have unknown site ${id as number}`);
    }
    if (seen.has(current)) throw new Error(`linear-memory frozen allocation facts have cyclic alias at ${current}`);
    seen.add(current);
    const entry = snapshot.entries[current]!;
    if (entry.state === "live") return current;
    if (entry.state === "retired") {
      throw new Error(`linear-memory frozen allocation facts reference retired site ${current}`);
    }
    current = entry.to as number;
  }
}

function snapshotSiteAtCanonicalIndex(index: number, snapshot: AllocRegistrySnapshot): AllocSite {
  const entry = snapshot.entries[index];
  if (!entry || entry.state !== "live") {
    throw new Error(`linear-memory frozen allocation facts have no live canonical site ${index}`);
  }
  return entry.site;
}

function metadataValue(
  snapshot: AllocRegistrySnapshot,
  id: number,
  namespace: string,
): { readonly present: boolean; readonly value: unknown } {
  const row = snapshot.metadata.find((candidate) => (candidate.id as number) === id);
  if (!row) return { present: false, value: undefined };
  const entry = row.entries.find(([key]) => key === namespace);
  return entry ? { present: true, value: entry[1] } : { present: false, value: undefined };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameDetachedValue(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  let paired = seen.get(left);
  if (paired?.has(right)) return true;
  if (!paired) {
    paired = new WeakSet<object>();
    seen.set(left, paired);
  }
  paired.add(right);

  const leftTag = Object.prototype.toString.call(left);
  const rightTag = Object.prototype.toString.call(right);
  const leftMap = leftTag === "[object Map]" || leftTag === "[object FrozenMap]";
  const rightMap = rightTag === "[object Map]" || rightTag === "[object FrozenMap]";
  if (leftMap || rightMap) {
    if (!leftMap || !rightMap) return false;
    const leftEntries = [...(left as ReadonlyMap<unknown, unknown>)];
    const rightEntries = [...(right as ReadonlyMap<unknown, unknown>)];
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(
        ([leftKey, leftValue], index) =>
          sameDetachedValue(leftKey, rightEntries[index]![0], seen) &&
          sameDetachedValue(leftValue, rightEntries[index]![1], seen),
      )
    );
  }
  const leftSet = leftTag === "[object Set]" || leftTag === "[object FrozenSet]";
  const rightSet = rightTag === "[object Set]" || rightTag === "[object FrozenSet]";
  if (leftSet || rightSet) {
    if (!leftSet || !rightSet) return false;
    const leftValues = [...(left as ReadonlySet<unknown>)];
    const rightValues = [...(right as ReadonlySet<unknown>)];
    return (
      leftValues.length === rightValues.length &&
      leftValues.every((value, index) => sameDetachedValue(value, rightValues[index], seen))
    );
  }

  const leftKeys = Reflect.ownKeys(left).sort((a, b) => String(a).localeCompare(String(b)));
  const rightKeys = Reflect.ownKeys(right).sort((a, b) => String(a).localeCompare(String(b)));
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const leftKey = leftKeys[index]!;
    const rightKey = rightKeys[index]!;
    if (
      typeof leftKey !== typeof rightKey ||
      (typeof leftKey === "symbol" ? leftKey !== rightKey : leftKey !== rightKey)
    ) {
      return false;
    }
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, leftKey);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, rightKey);
    if (!leftDescriptor || !rightDescriptor || !("value" in leftDescriptor) || !("value" in rightDescriptor)) {
      return false;
    }
    if (!sameDetachedValue(leftDescriptor.value, rightDescriptor.value, seen)) return false;
  }
  return true;
}

function verifyRegistrySnapshot(snapshot: AllocRegistrySnapshot): void {
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.entries.length !== snapshot.size) {
    throw new Error("linear-memory frozen allocation facts have an incomplete registry snapshot");
  }
  for (let index = 0; index < snapshot.entries.length; index++) {
    const entry = snapshot.entries[index]!;
    if (entry.state === "live" && (entry.site.id as number) !== index) {
      throw new Error(`linear-memory frozen allocation facts site identity mismatch at ${index}`);
    }
    if (entry.state === "aliased") canonicalIndexFromSnapshot(entry.to, snapshot);
  }
  const metadataIds = new Set<number>();
  for (const row of snapshot.metadata) {
    const id = row.id as number;
    if (!Number.isSafeInteger(id) || id < 0 || id >= snapshot.size) {
      throw new Error(`linear-memory frozen allocation facts metadata has unknown site ${id}`);
    }
    if (metadataIds.has(id)) throw new Error(`linear-memory frozen allocation facts duplicate metadata site ${id}`);
    metadataIds.add(id);
    const namespaces = new Set<string>();
    for (const [namespace] of row.entries) {
      if (namespaces.has(namespace)) {
        throw new Error(`linear-memory frozen allocation facts duplicate metadata namespace ${namespace}`);
      }
      namespaces.add(namespace);
    }
  }
}

/** Validate exact body-site joins and all producer evidence before layout. */
export function verifyLinearPreparedAllocationFacts(
  module: IrModule,
  preparedFacts: LinearPreparedAllocationFacts,
): void {
  verifyRegistrySnapshot(preparedFacts.registry);
  const located = collectModuleAllocationInstructions(module);
  const factsById = new Map<number, LinearPreparedAllocationFact>();
  for (const fact of preparedFacts.allocations) {
    const id = fact.id as number;
    if (factsById.has(id)) throw new Error(`linear-memory frozen allocation facts duplicate site ${id}`);
    const canonicalIndex = canonicalIndexFromSnapshot(fact.id, preparedFacts.registry);
    const canonical = snapshotSiteAtCanonicalIndex(canonicalIndex, preparedFacts.registry);
    if (fact.site.id !== canonical.id || !sameDetachedValue(fact.site, canonical)) {
      throw new Error(`linear-memory frozen allocation fact ${id} has a falsified site projection`);
    }
    const ownership = metadataValue(preparedFacts.registry, canonicalIndex, ALLOC_NAMESPACES.ownership);
    const escapeMetadata = metadataValue(preparedFacts.registry, canonicalIndex, ALLOC_NAMESPACES.escape);
    const encoding = metadataValue(preparedFacts.registry, canonicalIndex, ALLOC_NAMESPACES.encoding);
    if (!fact.evidence || typeof fact.evidence !== "object") {
      throw new Error(`linear-memory frozen allocation fact ${id} has no evidence-presence projection`);
    }
    const factOwnershipEvidence = fact.evidence.ownership;
    const factEscapeEvidence = fact.evidence.escape;
    const factEncodingEvidence = fact.evidence.encoding;
    if (
      !factOwnershipEvidence ||
      !factEscapeEvidence ||
      !factEncodingEvidence ||
      factOwnershipEvidence.present !== ownership.present ||
      factEscapeEvidence.present !== escapeMetadata.present
    ) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with metadata presence`);
    }
    if (
      !sameDetachedValue(factOwnershipEvidence.value, ownership.value) ||
      !sameDetachedValue(factEscapeEvidence.value, escapeMetadata.value)
    ) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with metadata evidence`);
    }
    const factEncodingPresent = Object.prototype.hasOwnProperty.call(fact, "encoding");
    if (factEncodingPresent !== encoding.present || factEncodingEvidence.present !== encoding.present) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with encoding presence`);
    }
    if (!sameDetachedValue(factEncodingEvidence.value, encoding.value)) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with encoding evidence`);
    }
    const ownershipValue = ownership.value;
    if (ownershipValue !== undefined && (typeof ownershipValue !== "object" || ownershipValue === null)) {
      throw new Error(`linear-memory frozen allocation fact ${id} has malformed ownership evidence`);
    }
    const ownershipRecord = ownershipValue as OwnershipMetadata | undefined;
    const expectedOwnership = ownershipRecord?.state ?? "escaped";
    const expectedAccesses = ownershipRecord?.ops ?? [];
    const expectedStackCandidate = ownershipRecord?.stackCandidate === true;
    if (
      fact.ownership !== expectedOwnership ||
      !sameStringArray(fact.accesses, expectedAccesses) ||
      fact.stackCandidate !== expectedStackCandidate
    ) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with ownership evidence`);
    }
    const escapeValue = escapeMetadata.value;
    if (escapeValue !== undefined && (typeof escapeValue !== "object" || escapeValue === null)) {
      throw new Error(`linear-memory frozen allocation fact ${id} has malformed escape evidence`);
    }
    const escapeRecord = escapeValue as EscapeInfo | undefined;
    if (fact.escape !== (escapeRecord?.classification ?? "opaque")) {
      throw new Error(`linear-memory frozen allocation fact ${id} disagrees with escape evidence`);
    }
    factsById.set(id, fact);
  }
  const bodyIds = new Set<number>();
  for (const { instr } of located.allocations) {
    if (instr.alloc === undefined) continue;
    const id = instr.alloc as number;
    if (bodyIds.has(id)) throw new Error(`duplicate live allocation-site id ${id} in linear-memory facts`);
    bodyIds.add(id);
    if (!factsById.has(id)) throw new Error(`linear-memory facts are missing body allocation site ${id}`);
  }
  for (const id of factsById.keys()) {
    if (!bodyIds.has(id)) throw new Error(`linear-memory facts contain extra site ${id}`);
  }
}

/**
 * Consume detached allocation facts to choose physical layouts and runtime
 * policy decisions. No producer analysis or mutable registry is consulted.
 */
export function planLinearMemoryFromFrozenFacts(
  module: IrModule,
  preparedFacts: LinearPreparedAllocationFacts,
  policy: LinearAllocatorPolicy = DEFAULT_ARENA_POLICY,
): LinearMemoryPlan {
  verifyLinearPreparedAllocationFacts(module, preparedFacts);
  const layouts = new Map<string, LinearLayoutPlan>();
  const segments = new Map<string, LinearDataSegmentPlan>();
  const globals = new Map<string, LinearGlobalStoragePlan>();
  const located = collectModuleFacts(module, layouts, globals);
  const factsById = new Map<number, LinearPreparedAllocationFact>();
  for (const fact of preparedFacts.allocations) {
    const id = fact.id as number;
    if (factsById.has(id)) throw new Error(`linear-memory frozen allocation facts duplicate site ${id}`);
    const canonical = canonicalSiteFromSnapshot(fact.id, preparedFacts.registry);
    if (canonical.id !== fact.site.id) {
      throw new Error(`linear-memory frozen allocation fact ${id} has a detached canonical-site mismatch`);
    }
    factsById.set(id, fact);
  }
  const allocations: LinearAllocationSitePlan[] = [];
  const seen = new Set<number>();

  for (const { instr, valueTypes, ownerFunction } of located.allocations) {
    const alloc = instr.alloc;
    if (alloc === undefined) continue;
    const numericId = alloc as number;
    if (seen.has(numericId)) throw new Error(`duplicate live allocation-site id ${numericId} in linear-memory plan`);
    seen.add(numericId);
    const fact = factsById.get(numericId);
    if (!fact) throw new Error(`linear-memory plan has no frozen allocation facts for site ${numericId}`);
    const site = canonicalSiteFromSnapshot(alloc, preparedFacts.registry);
    if (site.id !== fact.site.id) {
      throw new Error(`linear-memory allocation site ${numericId} changed between preparation and layout`);
    }

    const layout = layoutForAllocation(instr, site, valueTypes);
    const canonicalLayout = internLayout(layouts, layout);
    const linearFacts: LinearAllocationFacts = {
      site,
      layout: canonicalLayout,
      ownership: fact.ownership,
      accesses: fact.accesses,
      escape: fact.escape,
      stackCandidate: fact.stackCandidate,
      encoding: fact.encoding,
    };
    const decision = policy.decide(linearFacts);
    let dataSegmentId: string | undefined;
    if (instr.kind === "string.const") {
      const bytes = [...new TextEncoder().encode(instr.value)];
      dataSegmentId = linearStringDataSegmentId(instr.value);
      if (!segments.has(dataSegmentId)) {
        segments.set(dataSegmentId, { id: dataSegmentId, alignment: 1, bytes });
      }
    }
    allocations.push({
      id: alloc,
      ownerFunction,
      allocationKind: site.kind,
      origin: site.origin,
      layoutId: canonicalLayout.id,
      size: allocationSize(instr, canonicalLayout),
      ownership: linearFacts.ownership,
      accesses: linearFacts.accesses,
      escape: linearFacts.escape,
      stackCandidate: linearFacts.stackCandidate,
      encoding: linearFacts.encoding,
      dataSegmentId,
      ...decision,
    });
  }

  allocations.sort((left, right) => (left.id as number) - (right.id as number));
  return new LinearMemoryPlan({
    policy: policy.id,
    layouts: [...layouts.values()].sort((left, right) => compareText(left.id, right.id)),
    allocations,
    dataSegments: [...segments.values()].sort((left, right) => compareText(left.id, right.id)),
    globals: [...globals.values()].sort((left, right) => compareText(left.id, right.id)),
  });
}

/** Run analyses and build one canonical plan for compatibility callers. */
export function planLinearMemory(
  module: IrModule,
  registry: AllocSiteRegistry,
  policy: LinearAllocatorPolicy = DEFAULT_ARENA_POLICY,
): LinearMemoryPlan {
  return planLinearMemoryFromFrozenFacts(module, prepareLinearAllocationFacts(module, registry), policy);
}

export function planLinearVectorLayout(element: IrType): LinearVectorLayoutPlan {
  const storage = linearStorageForIrType(element);
  if (element.kind === "val") return planLinearScalarVectorLayout(storage);
  return planLinearVectorStorageLayout(linearIrTypeKey(element), storage);
}

export function linearObjectLayoutId(shape: IrObjectShape): string {
  return `record:object:${shape.fields.map((field) => `${JSON.stringify(field.name)}=${linearIrTypeKey(field.type)}`).join(";")}`;
}

export function linearClassLayoutId(shape: IrClassShape): string {
  return `record:class:${JSON.stringify(shape.classId)}`;
}

export function linearRefCellLayoutId(inner: IrType): string {
  return `record:refcell:${linearIrTypeKey(inner)}`;
}

export function linearVectorLayoutId(element: IrType): string {
  return linearVectorLayoutIdForElementKey(linearIrTypeKey(element));
}

export function linearStringDataSegmentId(value: string): string {
  return `string-data:${JSON.stringify(value)}`;
}

export function linearStorageForIrType(type: IrType): LinearStorageKind {
  if (type.kind !== "val") return "pointer";
  switch (type.val.kind) {
    case "i8":
      return "i8";
    case "i16":
      return "i16";
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "f32";
    case "f64":
      return "f64";
    case "v128":
      return "bytes16";
    default:
      return "pointer";
  }
}

export function linearRuntimeOperationKey(operation: LinearRuntimeOperation): string {
  return JSON.stringify(operation);
}

export function defaultOperationsForLayout(
  layout: LinearLayoutPlan,
  allocationClass: LinearAllocationClass = "arena",
): readonly LinearRuntimeOperation[] {
  return operationsForLayout(layout, allocationClass);
}

function operationsForLayout(
  layout: LinearLayoutPlan,
  allocationClass: LinearAllocationClass,
): readonly LinearRuntimeOperation[] {
  switch (layout.kind) {
    case "record":
      return [{ family: "memory", operation: "allocate", allocationClass, zeroed: false }];
    case "vector":
      return [
        { family: "vector", operation: "allocate", allocationClass, elementStorage: layout.elementStorage },
        { family: "vector", operation: "grow", allocationClass, elementStorage: layout.elementStorage },
        {
          family: "vector",
          operation: "initialize-element",
          allocationClass,
          elementStorage: layout.elementStorage,
        },
      ];
    case "string":
      return [
        {
          family: "string",
          operation: "materialize-data",
          allocationClass,
          elementStorage: layout.elementStorage,
        },
        {
          family: "string",
          operation: "concatenate",
          allocationClass,
          elementStorage: layout.elementStorage,
        },
      ];
    case "opaque":
      return [{ family: "managed", operation: "allocate" }];
  }
}

function allocationSize(instr: IrInstr, layout: LinearLayoutPlan): LinearSizePlan {
  if (layout.kind === "vector" && instr.kind === "vec.new_fixed") {
    return {
      kind: "constant",
      bytes:
        layout.elementsOffset +
        Math.max(instr.capacity ?? instr.elements.length, layout.minimumCapacity) * layout.elementStride,
    };
  }
  if (layout.kind === "string" && instr.kind === "string.const") {
    return { kind: "constant", bytes: layout.elementsOffset + new TextEncoder().encode(instr.value).length };
  }
  return layout.size;
}

function layoutForAllocation(
  instr: IrInstr,
  site: AllocSite,
  valueTypes: ReadonlyMap<IrValueId, IrType>,
): LinearLayoutPlan {
  switch (instr.kind) {
    case "object.new":
      return recordLayoutForObject(instr.shape);
    case "class.new":
      return recordLayoutForClass(instr.shape);
    case "refcell.new": {
      const inner = site.type.kind === "boxed" ? site.type.inner : valueTypes.get(instr.value);
      if (!inner) return opaqueLayout(site);
      return planLinearRecordLayout(linearRefCellLayoutId(inner), [
        { name: "value", storage: linearStorageForIrType(inner) },
      ]);
    }
    case "box": {
      const inner = valueTypes.get(instr.value);
      if (!inner) return opaqueLayout(site);
      return planLinearRecordLayout(`record:box:${linearIrTypeKey(inner)}`, [
        { name: "value", storage: linearStorageForIrType(inner) },
      ]);
    }
    case "closure.new":
      return planLinearRecordLayout(
        `record:closure:${linearIrTypeKey(site.type)}:${instr.captureFieldTypes.map(linearIrTypeKey).join(",")}`,
        [
          { name: "function", storage: "pointer" },
          ...instr.captureFieldTypes.map((type, index) => ({
            name: `capture-${index}`,
            storage: linearStorageForIrType(type),
          })),
        ],
      );
    case "vec.new_fixed":
      return planLinearVectorLayout(instr.elementType);
    case "string.const":
    case "string.concat":
    case "string.repeat":
      return planLinearStringLayout();
    default:
      return site.kind === "string" ? planLinearStringLayout() : opaqueLayout(site);
  }
}

function recordLayoutForObject(shape: IrObjectShape): LinearRecordLayoutPlan {
  return planLinearRecordLayout(
    linearObjectLayoutId(shape),
    shape.fields.map((field) => ({ name: field.name, storage: linearStorageForIrType(field.type) })),
  );
}

function recordLayoutForClass(shape: IrClassShape): LinearRecordLayoutPlan {
  return planLinearRecordLayout(
    linearClassLayoutId(shape),
    shape.fields.map((field) => ({ name: field.name, storage: linearStorageForIrType(field.type) })),
  );
}

function opaqueLayout(site: AllocSite): LinearOpaqueLayoutPlan {
  return {
    id: `opaque:${site.kind}:${linearIrTypeKey(site.type)}`,
    kind: "opaque",
    allocationKind: site.kind,
    alignment: LINEAR_POINTER_BYTES,
    size: { kind: "runtime", minimumBytes: 0 },
    pointerMap: { kind: "none" },
  };
}

function internLayout(layouts: Map<string, LinearLayoutPlan>, layout: LinearLayoutPlan): LinearLayoutPlan {
  const existing = layouts.get(layout.id);
  if (existing) return existing;
  layouts.set(layout.id, layout);
  return layout;
}

function collectModuleFacts(
  module: IrModule,
  layouts: Map<string, LinearLayoutPlan>,
  globals: Map<string, LinearGlobalStoragePlan>,
): {
  allocations: {
    readonly instr: IrInstr;
    readonly valueTypes: ReadonlyMap<IrValueId, IrType>;
    readonly ownerFunction: string;
  }[];
} {
  const allocations = collectModuleAllocationInstructions(module).allocations;
  for (const fn of module.functions) {
    const valueTypes = collectValueTypes(fn);
    for (const param of fn.params) collectLayoutsFromType(param.type, layouts);
    for (const type of fn.resultTypes) collectLayoutsFromType(type, layouts);
    for (const block of fn.blocks) {
      for (const type of block.blockArgTypes) collectLayoutsFromType(type, layouts);
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.resultType) collectLayoutsFromType(nested.resultType, layouts);
          collectGlobalStorage(nested, valueTypes, globals);
        });
      }
    }
    for (const state of fn.asyncPlan?.states ?? []) {
      for (const instr of state.body) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.resultType) collectLayoutsFromType(nested.resultType, layouts);
          collectGlobalStorage(nested, valueTypes, globals);
        });
      }
    }
  }
  return { allocations };
}

/**
 * Collect only allocation instructions and their value-type environments.
 * Keeping this census separate prevents preparation facts from invoking the
 * backend layout/storage walk before the immutable handoff.
 */
function collectModuleAllocationInstructions(module: IrModule): {
  allocations: {
    readonly instr: IrInstr;
    readonly valueTypes: ReadonlyMap<IrValueId, IrType>;
    readonly ownerFunction: string;
  }[];
} {
  const allocations: { instr: IrInstr; valueTypes: ReadonlyMap<IrValueId, IrType>; ownerFunction: string }[] = [];
  for (const fn of module.functions) {
    const valueTypes = collectValueTypes(fn);
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.alloc !== undefined) allocations.push({ instr: nested, valueTypes, ownerFunction: fn.name });
        });
      }
    }
    for (const state of fn.asyncPlan?.states ?? []) {
      for (const instr of state.body) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.alloc !== undefined) allocations.push({ instr: nested, valueTypes, ownerFunction: fn.name });
        });
      }
    }
  }
  return { allocations };
}

function collectLayoutsFromType(
  type: IrType,
  layouts: Map<string, LinearLayoutPlan>,
  seenClassShapes = new Set<IrClassShape>(),
): void {
  switch (type.kind) {
    case "object":
      internLayout(layouts, recordLayoutForObject(type.shape));
      for (const field of type.shape.fields) collectLayoutsFromType(field.type, layouts, seenClassShapes);
      return;
    case "class":
      internLayout(layouts, recordLayoutForClass(type.shape));
      if (seenClassShapes.has(type.shape)) return;
      seenClassShapes.add(type.shape);
      for (const field of type.shape.fields) collectLayoutsFromType(field.type, layouts, seenClassShapes);
      return;
    case "boxed":
      internLayout(
        layouts,
        planLinearRecordLayout(linearRefCellLayoutId(type.inner), [
          { name: "value", storage: linearStorageForIrType(type.inner) },
        ]),
      );
      collectLayoutsFromType(type.inner, layouts, seenClassShapes);
      return;
    case "string":
      internLayout(layouts, planLinearStringLayout());
      return;
    case "vec":
      internLayout(layouts, planLinearVectorLayout(type.elementType));
      collectLayoutsFromType(type.elementType, layouts, seenClassShapes);
      return;
    case "closure":
    case "callable":
      for (const param of type.signature.params) collectLayoutsFromType(param, layouts, seenClassShapes);
      if (type.signature.returnType !== null)
        collectLayoutsFromType(type.signature.returnType, layouts, seenClassShapes);
      return;
    case "union":
      for (const member of type.members) collectLayoutsFromType(member, layouts, seenClassShapes);
      return;
    default:
      return;
  }
}

function collectValueTypes(fn: IrFunction): Map<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  for (const param of fn.params) types.set(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) types.set(value.value, value.type);
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => {
      const type = block.blockArgTypes[index];
      if (type) types.set(value, type);
    });
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (nested.result !== null && nested.resultType) types.set(nested.result, nested.resultType);
      });
    }
  }
  return types;
}

function collectGlobalStorage(
  instr: IrInstr,
  valueTypes: ReadonlyMap<IrValueId, IrType>,
  globals: Map<string, LinearGlobalStoragePlan>,
): void {
  let id: string | undefined;
  let type: IrType | undefined;
  if (instr.kind === "global.get" && instr.resultType) {
    id = instr.target.binding.bindingId;
    type = instr.resultType;
  } else if (instr.kind === "global.set") {
    id = instr.target.binding.bindingId;
    type = valueTypes.get(instr.value);
  }
  if (!id || !type) return;
  const storage = linearStorageForIrType(type);
  const candidate: LinearGlobalStoragePlan = {
    id,
    allocationClass: "static",
    storage,
    sizeBytes: storageBytes(storage),
    alignment: storageAlignment(storage),
    containsPointer: storage === "pointer",
    mutable: true,
    initializer: "zero",
  };
  const existing = globals.get(id);
  if (existing && existing.storage !== candidate.storage) {
    throw new Error(`linear-memory plan global '${id}' has inconsistent storage`);
  }
  globals.set(id, candidate);
}

function linearIrTypeKey(type: IrType): string {
  switch (type.kind) {
    case "support-ref":
      throw new Error("linear-memory plan does not support compiler support references");
    case "val":
      return linearScalarStorageKey(linearStorageForIrType(type));
    case "string":
      return "string";
    case "vec":
      return `vec:${linearIrTypeKey(type.elementType)}${type.nullable ? "?" : ""}`;
    case "object":
      return `object:${shapeKey(type.shape)}`;
    case "class":
      return `class:${JSON.stringify(type.shape.classId)}`;
    case "closure":
      return `closure:(${type.signature.params.map(linearIrTypeKey).join(",")})->${type.signature.returnType === null ? "void" : linearIrTypeKey(type.signature.returnType)}`;
    case "callable":
      return `callable:(${type.signature.params.map(linearIrTypeKey).join(",")})->${type.signature.returnType === null ? "void" : linearIrTypeKey(type.signature.returnType)}`;
    case "extern":
      return `extern:${JSON.stringify(type.className)}`;
    case "union":
      return `union:${type.members.map(linearIrTypeKey).join("|")}`;
    case "boxed":
      return `boxed:${linearIrTypeKey(type.inner)}`;
    case "fnctor":
      return irFnctorShapeKey(type.shape);
    case "dynamic":
      return "dynamic";
  }
}

function shapeKey(shape: IrObjectShape): string {
  return shape.fields.map((field) => `${JSON.stringify(field.name)}=${linearIrTypeKey(field.type)}`).join(";");
}

function lifetimeFromEscape(classification: EscapeClass): LinearLifetime {
  switch (classification) {
    case "local":
      return "function";
    case "returned":
      return "caller";
    case "stored":
      return "heap";
    case "captured":
      return "closure";
    case "opaque":
      return "unknown";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
