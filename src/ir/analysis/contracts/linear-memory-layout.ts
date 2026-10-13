// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  LinearStorageKind,
  LinearSizePlan,
  LinearLayoutBase,
  LinearRecordLayoutPlan,
  LinearVectorLayoutPlan,
  LinearStringLayoutPlan,
} from "../../../shared/contracts/linear-memory-layout.js";
export type {
  LinearStorageKind,
  LinearSizePlan,
  LinearFieldPlan,
  LinearPointerMap,
  LinearLayoutBase,
  LinearRecordLayoutPlan,
  LinearVectorLayoutPlan,
} from "../../../shared/contracts/linear-memory-layout.js";

import type { AllocKind, AllocSiteId, IrSiteId } from "../../core/nodes.js";
import type { AllocSite, Ownership, EscapeClass } from "./allocations.js";
import type { IrStringEncoding as Encoding } from "../../core/string-types.js";

export type LinearAllocationClass = "static" | "stack" | "arena" | "managed";

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
