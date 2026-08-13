// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Target-neutral linear-memory planning (#3298).
//
// This module is the middle-end authority for allocation class, record/vector/
// string layout, pointer maps, lifetime, roots, safepoints, barriers, and
// relocatable static-storage requirements. It deliberately contains no Wasm
// instructions or module indices, Porffor representation values, renderer
// records, concrete runtime symbol names, or artifact fragments.

import { ALLOC_NAMESPACES, type AllocSite, type AllocSiteRegistry } from "../alloc-registry.js";
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

/** JS2's current linear address width. Kept here rather than in an emitter. */
export const LINEAR_POINTER_BYTES = 4;
export const LINEAR_STACK_ARENA_BYTES = 64 * 1024;
export const LINEAR_RECORD_ALIGNMENT = 8;
export const LINEAR_RECORD_HEADER_BYTES = 8;
export const LINEAR_RECORD_FIELD_SLOT_BYTES = 8;
export const LINEAR_RECORD_TAG_OFFSET = 0;
export const LINEAR_RECORD_PAYLOAD_SIZE_OFFSET = 4;
/**
 * Shared forwarding-record representation for relocated linear arrays.
 *
 * A grown array rewrites its old record header to this tag plus the pointer
 * to the replacement record. Keep this contract beside the canonical linear
 * layout offsets so every artifact adapter and the direct linear runtime read
 * and write the same representation.
 */
export const LINEAR_ARRAY_FORWARDING = Object.freeze({
  tag: 0x06,
  tagOffset: LINEAR_RECORD_TAG_OFFSET,
  pointerOffset: LINEAR_RECORD_PAYLOAD_SIZE_OFFSET,
  pointerBytes: LINEAR_POINTER_BYTES,
});
export const LINEAR_VECTOR_LENGTH_OFFSET = 8;
export const LINEAR_VECTOR_CAPACITY_OFFSET = 12;
export const LINEAR_VECTOR_ELEMENTS_OFFSET = 16;
export const LINEAR_VECTOR_MINIMUM_CAPACITY = 16;
export const LINEAR_STRING_LENGTH_OFFSET = 8;
export const LINEAR_STRING_ELEMENTS_OFFSET = 12;
export const LINEAR_STRING_PAYLOAD_SIZE_OFFSET = LINEAR_RECORD_PAYLOAD_SIZE_OFFSET;
/** Bytes between the record header and the first string element (the length field). */
export const LINEAR_STRING_PAYLOAD_PREFIX_BYTES = LINEAR_STRING_ELEMENTS_OFFSET - LINEAR_RECORD_HEADER_BYTES;

/** Storage vocabulary independent of a machine instruction set. */
export type LinearStorageKind = "i8" | "i16" | "i32" | "i64" | "f32" | "f64" | "bytes16" | "pointer";

export type LinearAllocationClass = "static" | "stack" | "arena" | "managed";
export type LinearAllocatorPolicyId = "arena-v1" | "analysis-stack-arena-v1";

export type LinearSizePlan =
  | { readonly kind: "constant"; readonly bytes: number }
  | {
      readonly kind: "elements";
      readonly baseBytes: number;
      readonly strideBytes: number;
      readonly minimumElements: number;
    }
  | { readonly kind: "runtime"; readonly minimumBytes: number };

export interface LinearFieldPlan {
  readonly name: string;
  readonly offset: number;
  readonly storage: LinearStorageKind;
  /** Reserved bytes in the containing record, which can exceed storage width. */
  readonly slotBytes: number;
  readonly alignment: number;
  readonly containsPointer: boolean;
}

export type LinearPointerMap =
  | { readonly kind: "none" }
  | { readonly kind: "fixed"; readonly offsets: readonly number[] }
  | {
      readonly kind: "elements";
      readonly fixedOffsets: readonly number[];
      readonly elementsOffset: number;
      readonly elementStride: number;
      readonly elementsContainPointers: boolean;
    };

interface LinearLayoutBase {
  /** Stable semantic identity; never a module/type-table index. */
  readonly id: string;
  readonly alignment: number;
  readonly size: LinearSizePlan;
  readonly pointerMap: LinearPointerMap;
}

export interface LinearRecordLayoutPlan extends LinearLayoutBase {
  readonly kind: "record";
  readonly headerBytes: number;
  readonly typeTagOffset: number;
  readonly payloadSizeOffset: number;
  readonly fields: readonly LinearFieldPlan[];
}

export interface LinearVectorLayoutPlan extends LinearLayoutBase {
  readonly kind: "vector";
  readonly lengthOffset: number;
  readonly capacityOffset: number;
  readonly elementsOffset: number;
  readonly elementStorage: LinearStorageKind;
  readonly elementStride: number;
  readonly minimumCapacity: number;
}

export interface LinearStringLayoutPlan extends LinearLayoutBase {
  readonly kind: "string";
  readonly payloadSizeOffset: number;
  readonly payloadPrefixBytes: number;
  readonly lengthOffset: number;
  readonly elementsOffset: number;
  readonly elementStorage: "i8" | "i16";
  readonly elementStride: 1 | 2;
}

export interface LinearOpaqueLayoutPlan extends LinearLayoutBase {
  readonly kind: "opaque";
  readonly allocationKind: AllocKind;
}

export type LinearLayoutPlan =
  | LinearRecordLayoutPlan
  | LinearVectorLayoutPlan
  | LinearStringLayoutPlan
  | LinearOpaqueLayoutPlan;

/** Semantic operations that a backend may bind to its own runtime. */
export type LinearRuntimeOperation =
  | {
      readonly family: "memory";
      readonly operation: "allocate";
      readonly allocationClass: LinearAllocationClass;
      readonly zeroed: boolean;
    }
  | {
      readonly family: "vector";
      readonly operation: "allocate" | "grow" | "initialize-element";
      readonly allocationClass: LinearAllocationClass;
      readonly elementStorage: LinearStorageKind;
    }
  | {
      readonly family: "string";
      readonly operation: "materialize-data" | "concatenate";
      readonly allocationClass: LinearAllocationClass;
      readonly elementStorage: "i8" | "i16";
    }
  | {
      readonly family: "managed";
      readonly operation: "allocate" | "root" | "write-barrier";
    }
  | {
      readonly family: "stack";
      readonly operation: "mark" | "restore";
    };

export type LinearRootPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "managed";
      readonly lifetime: LinearLifetime;
      readonly operation: Extract<LinearRuntimeOperation, { readonly family: "managed" }>;
    };

export type LinearSafepointPlan = { readonly kind: "none" } | { readonly kind: "calls-and-backedges" };

export type LinearBarrierPlan =
  | { readonly kind: "none" }
  | { readonly kind: "pointer-stores"; readonly operation: LinearRuntimeOperation };

export type LinearLifetime = "function" | "caller" | "heap" | "closure" | "unknown";

export interface LinearAllocationFacts {
  readonly site: AllocSite;
  readonly layout: LinearLayoutPlan;
  readonly ownership: Ownership;
  readonly accesses: readonly string[];
  readonly escape: EscapeClass;
  readonly stackCandidate: boolean;
  readonly encoding?: Encoding;
}

export interface LinearAllocationDecision {
  readonly allocationClass: LinearAllocationClass;
  readonly lifetime: LinearLifetime;
  readonly root: LinearRootPlan;
  readonly safepoints: LinearSafepointPlan;
  readonly barrier: LinearBarrierPlan;
  readonly operations: readonly LinearRuntimeOperation[];
}

/** Policy seam. Policies consume facts only; target adapters bind operations. */
export interface LinearAllocatorPolicy {
  readonly id: string;
  decide(facts: LinearAllocationFacts): LinearAllocationDecision;
}

export interface LinearAllocationSitePlan extends LinearAllocationDecision {
  readonly id: AllocSiteId;
  /** Stable owning IR function identity for function-lifetime policies. */
  readonly ownerFunction: string;
  readonly allocationKind: AllocKind;
  readonly origin?: IrSiteId;
  readonly layoutId: string;
  readonly size: LinearSizePlan;
  readonly ownership: Ownership;
  readonly accesses: readonly string[];
  readonly escape: EscapeClass;
  readonly stackCandidate: boolean;
  readonly encoding?: Encoding;
  readonly dataSegmentId?: string;
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

/** Run the producer analyses and build one canonical plan for an IR module. */
export function planLinearMemory(
  module: IrModule,
  registry: AllocSiteRegistry,
  policy: LinearAllocatorPolicy = DEFAULT_ARENA_POLICY,
): LinearMemoryPlan {
  for (const fn of module.functions) {
    analyzeEncoding(fn, registry);
    const ownership = analyzeOwnership(fn, registry);
    analyzeEscape(fn, registry, ownership);
    findStackAllocCandidates(fn, registry, ownership);
  }

  const layouts = new Map<string, LinearLayoutPlan>();
  const segments = new Map<string, LinearDataSegmentPlan>();
  const globals = new Map<string, LinearGlobalStoragePlan>();
  const located = collectModuleFacts(module, layouts, globals);
  const allocations: LinearAllocationSitePlan[] = [];
  const seen = new Set<number>();

  for (const { instr, valueTypes, ownerFunction } of located.allocations) {
    const alloc = instr.alloc;
    if (alloc === undefined) continue;
    const numericId = alloc as number;
    if (seen.has(numericId)) throw new Error(`duplicate live allocation-site id ${numericId} in linear-memory plan`);
    seen.add(numericId);
    const site = registry.resolve(alloc);
    if (!site) throw new Error(`linear-memory plan cannot resolve allocation-site id ${numericId}`);

    const layout = layoutForAllocation(instr, site, valueTypes);
    const canonicalLayout = internLayout(layouts, layout);
    const ownership = registry.read<OwnershipMetadata>(alloc, ALLOC_NAMESPACES.ownership) ?? {};
    const escapeInfo = registry.read<EscapeInfo>(alloc, ALLOC_NAMESPACES.escape) ?? {
      classification: "opaque",
      stackAllocatable: false,
    };
    const encoding = registry.read<Encoding>(alloc, ALLOC_NAMESPACES.encoding);
    const facts: LinearAllocationFacts = {
      site,
      layout: canonicalLayout,
      ownership: ownership.state ?? "escaped",
      accesses: ownership.ops ?? [],
      escape: escapeInfo.classification,
      stackCandidate: ownership.stackCandidate === true,
      encoding,
    };
    const decision = policy.decide(facts);
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
      ownership: facts.ownership,
      accesses: facts.accesses,
      escape: facts.escape,
      stackCandidate: facts.stackCandidate,
      encoding,
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

/** Shared record-layout primitive consumed by IR and direct linear-Wasm paths. */
export function planLinearRecordLayout(
  id: string,
  fields: readonly { readonly name: string; readonly storage: LinearStorageKind }[],
): LinearRecordLayoutPlan {
  const plannedFields = fields.map((field, index): LinearFieldPlan => {
    const containsPointer = field.storage === "pointer";
    return {
      name: field.name,
      offset: LINEAR_RECORD_HEADER_BYTES + index * LINEAR_RECORD_FIELD_SLOT_BYTES,
      storage: field.storage,
      slotBytes: LINEAR_RECORD_FIELD_SLOT_BYTES,
      alignment: storageAlignment(field.storage),
      containsPointer,
    };
  });
  const pointerOffsets = plannedFields.filter((field) => field.containsPointer).map((field) => field.offset);
  return {
    id,
    kind: "record",
    alignment: LINEAR_RECORD_ALIGNMENT,
    size: {
      kind: "constant",
      bytes: LINEAR_RECORD_HEADER_BYTES + plannedFields.length * LINEAR_RECORD_FIELD_SLOT_BYTES,
    },
    pointerMap: pointerOffsets.length === 0 ? { kind: "none" } : { kind: "fixed", offsets: pointerOffsets },
    headerBytes: LINEAR_RECORD_HEADER_BYTES,
    typeTagOffset: LINEAR_RECORD_TAG_OFFSET,
    payloadSizeOffset: LINEAR_RECORD_PAYLOAD_SIZE_OFFSET,
    fields: plannedFields,
  };
}

export function planLinearVectorLayout(element: IrType): LinearVectorLayoutPlan {
  const storage = linearStorageForIrType(element);
  const stride = storageBytes(storage);
  return {
    id: linearVectorLayoutId(element),
    kind: "vector",
    alignment: Math.max(LINEAR_RECORD_ALIGNMENT, storageAlignment(storage)),
    size: {
      kind: "elements",
      baseBytes: LINEAR_VECTOR_ELEMENTS_OFFSET,
      strideBytes: stride,
      minimumElements: LINEAR_VECTOR_MINIMUM_CAPACITY,
    },
    pointerMap: {
      kind: "elements",
      fixedOffsets: [],
      elementsOffset: LINEAR_VECTOR_ELEMENTS_OFFSET,
      elementStride: stride,
      elementsContainPointers: storage === "pointer",
    },
    lengthOffset: LINEAR_VECTOR_LENGTH_OFFSET,
    capacityOffset: LINEAR_VECTOR_CAPACITY_OFFSET,
    elementsOffset: LINEAR_VECTOR_ELEMENTS_OFFSET,
    elementStorage: storage,
    elementStride: stride,
    minimumCapacity: LINEAR_VECTOR_MINIMUM_CAPACITY,
  };
}

export function planLinearStringLayout(): LinearStringLayoutPlan {
  return {
    id: linearStringLayoutId(),
    kind: "string",
    alignment: LINEAR_RECORD_ALIGNMENT,
    size: { kind: "elements", baseBytes: LINEAR_STRING_ELEMENTS_OFFSET, strideBytes: 1, minimumElements: 0 },
    pointerMap: { kind: "none" },
    payloadSizeOffset: LINEAR_STRING_PAYLOAD_SIZE_OFFSET,
    payloadPrefixBytes: LINEAR_STRING_PAYLOAD_PREFIX_BYTES,
    lengthOffset: LINEAR_STRING_LENGTH_OFFSET,
    elementsOffset: LINEAR_STRING_ELEMENTS_OFFSET,
    elementStorage: "i8",
    elementStride: 1,
  };
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
  return `vector:${linearIrTypeKey(element)}`;
}

export function linearStringLayoutId(): string {
  return "string:utf8-bytes-v1";
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

export function storageBytes(storage: LinearStorageKind): number {
  switch (storage) {
    case "i8":
      return 1;
    case "i16":
      return 2;
    case "i32":
    case "f32":
    case "pointer":
      return 4;
    case "i64":
    case "f64":
      return 8;
    case "bytes16":
      return 16;
  }
}

export function storageAlignment(storage: LinearStorageKind): number {
  return storageBytes(storage);
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
  const allocations: { instr: IrInstr; valueTypes: ReadonlyMap<IrValueId, IrType>; ownerFunction: string }[] = [];
  for (const fn of module.functions) {
    const valueTypes = collectValueTypes(fn);
    for (const param of fn.params) collectLayoutsFromType(param.type, layouts);
    for (const type of fn.resultTypes) collectLayoutsFromType(type, layouts);
    for (const block of fn.blocks) {
      for (const type of block.blockArgTypes) collectLayoutsFromType(type, layouts);
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.resultType) collectLayoutsFromType(nested.resultType, layouts);
          if (nested.alloc !== undefined) allocations.push({ instr: nested, valueTypes, ownerFunction: fn.name });
          collectGlobalStorage(nested, valueTypes, globals);
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
    case "val":
      return `scalar:${linearStorageForIrType(type)}`;
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
