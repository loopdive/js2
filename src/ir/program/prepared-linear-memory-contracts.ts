// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { LinearMemoryPlanSnapshot, LinearRuntimeOperation } from "../analysis/contracts/linear-memory-layout.js";
import type { PreparedLinearMemoryDemand } from "./linear-memory-demand.js";
import type { LocalDef, ValType } from "../../wasm/model/instructions.js";

/** Physical descriptions; only the original issued memory plan can authorize them. */
export interface NativeNumberUndefinedMemoryDescription {
  readonly boxes: readonly {
    readonly allocationId: number;
    readonly layoutId: string;
  }[];
  readonly singleton: {
    readonly key: string;
    readonly offset: number;
    readonly alignment: number;
    readonly bytes: readonly number[];
  };
}

/** Target descriptions only. Executable authority lives in the private issued-plan record. */
export interface PreparedLinearMemoryPlan {
  readonly schema: "prepared-linear-memory-v1";
  readonly snapshot: LinearMemoryPlanSnapshot;
  readonly demand: PreparedLinearMemoryDemand;
  readonly numberUndefined?: NativeNumberUndefinedMemoryDescription;
  readonly functions: readonly {
    readonly key: string;
    readonly name: string;
    readonly role: "malloc" | "array-new" | "initialize-element" | "resolve-forwarding" | "append-f64";
    readonly params: readonly ValType[];
    readonly results: readonly ValType[];
    readonly locals: readonly LocalDef[];
    readonly operation?: LinearRuntimeOperation;
  }[];
  readonly memory?: { readonly key: string; readonly min: number; readonly max: number };
  readonly heapPointer?: { readonly key: string; readonly name: string; readonly floor: number };
  readonly exports: readonly {
    readonly key: string;
    readonly externalName: string;
    readonly kind: "memory";
    readonly targetKey: string;
  }[];
}
export type PreparedLinearMemoryResult =
  | { readonly kind: "supported"; readonly plan: PreparedLinearMemoryPlan }
  | {
      readonly kind: "unsupported";
      readonly code: "array-representation-unsupported";
      readonly detail: string;
      readonly location?: unknown;
    };
