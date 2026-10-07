// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocKind, AllocSiteId, IrSiteId } from "../../core/nodes.js";
import type { Ownership } from "../lattice.js";
import type { EscapeClass } from "../escape.js";
import type { Encoding } from "../encoding.js";

/** Storage vocabulary independent of a machine instruction set. */
export type LinearStorageKind = "i8" | "i16" | "i32" | "i64" | "f32" | "f64" | "bytes16" | "pointer";

export type LinearAllocationClass = "static" | "stack" | "arena" | "managed";

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

export interface LinearLayoutBase {
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
      readonly family: "vector";
      readonly operation: "resolve-forwarding";
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

export interface LinearAllocationDecision {
  readonly allocationClass: LinearAllocationClass;
  readonly lifetime: LinearLifetime;
  readonly root: LinearRootPlan;
  readonly safepoints: LinearSafepointPlan;
  readonly barrier: LinearBarrierPlan;
  readonly operations: readonly LinearRuntimeOperation[];
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
