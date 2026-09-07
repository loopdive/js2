// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "../ir/identity.js";
import type { Import, Instr, StructTypeDef, TagDef, ValType, WasmFunction } from "../ir/types.js";

/** Process-local, post-acceptance authority. Never part of PreparedIrProgram. */
export interface PreparedFrameHandle<T extends object> {
  readonly bindingId: IrBindingId;
  readonly target: T;
}
export type PreparedFrameFunction = PreparedFrameHandle<WasmFunction | Import>;

export interface PreparedFrameAllocator {
  function(handle: PreparedFrameFunction): { readonly index: number; readonly target: WasmFunction | Import };
  type(handle: PreparedFrameHandle<StructTypeDef>): { readonly index: number; readonly target: StructTypeDef };
  tag(handle: PreparedFrameHandle<TagDef | Import>): { readonly index: number; readonly target: TagDef | Import };
}

export interface PreparedFrameEmission {
  readonly body: Instr[];
  local(value: number): number;
  call(target: PreparedFrameFunction): Instr;
  convert(from: ValType, to: ValType): void;
  undefinedValue(): void;
  /** Push the delivered externref from this frame; conversion remains explicit. */
  resumeValue(): void;
}

export interface PreparedFrameConversion {
  readonly from: ValType;
  readonly to: ValType;
  readonly operation:
    | { readonly kind: "identity" }
    | {
        readonly kind: "numeric";
        readonly op: "f64.convert_i32_s" | "f64.convert_i32_u" | "i32.trunc_sat_f64_s" | "f64.promote_f32";
      }
    | { readonly kind: "helper"; readonly target: PreparedFrameFunction };
}

/** Each operation has already been lowered from validated IR. */
export type PreparedFrameOperation = (emission: PreparedFrameEmission) => void;
export type PreparedFrameTerminator =
  | {
      readonly kind: "suspend";
      readonly awaited: PreparedFrameOperation;
      readonly next: number;
      readonly live: readonly number[];
    }
  | { readonly kind: "resolve"; readonly value: PreparedFrameOperation }
  | { readonly kind: "goto"; readonly target: number }
  | {
      readonly kind: "branch";
      readonly condition: PreparedFrameOperation;
      readonly whenTrue: number;
      readonly whenFalse: number;
    };

export interface PreparedFrameState {
  readonly id: number;
  readonly resume?: PreparedFrameOperation;
  readonly restore: readonly number[];
  readonly body: PreparedFrameOperation;
  readonly terminator: PreparedFrameTerminator;
}

export interface PreparedFramePlan {
  readonly owner: IrUnitId;
  readonly states: readonly PreparedFrameState[];
  readonly handlers: readonly never[];
  readonly values: readonly {
    readonly id: number;
    readonly type: ValType;
    readonly param?: number;
    readonly spill?: number;
  }[];
}

interface PreparedFrameCommonRuntime {
  readonly fulfill: PreparedFrameFunction;
  readonly reject: PreparedFrameFunction;
}
export type PreparedFrameRuntime =
  | (PreparedFrameCommonRuntime & {
      readonly kind: "host";
      readonly create: PreparedFrameFunction;
      readonly resolve: PreparedFrameFunction;
      readonly react: PreparedFrameFunction;
      readonly wrap: PreparedFrameFunction;
      readonly fulfillCallback: { readonly id: number; readonly target: PreparedFrameHandle<WasmFunction> };
      readonly rejectCallback: { readonly id: number; readonly target: PreparedFrameHandle<WasmFunction> };
      readonly caught: PreparedFrameFunction;
    })
  | (PreparedFrameCommonRuntime & {
      readonly kind: "native";
      readonly promise: PreparedFrameHandle<StructTypeDef>;
      readonly reaction: PreparedFrameHandle<StructTypeDef>;
      readonly enqueue: PreparedFrameFunction;
      readonly markHandled:
        | { readonly kind: "not-required" }
        | { readonly kind: "function"; readonly target: PreparedFrameFunction };
    });

/** Complete physical reservations, supplied by acceptance/materialization. */
export interface PreparedFrameResources {
  readonly owner: IrUnitId;
  readonly allocator: PreparedFrameAllocator;
  readonly frame: PreparedFrameHandle<StructTypeDef>;
  readonly resultField: number;
  readonly entry: PreparedFrameHandle<WasmFunction>;
  readonly resume: PreparedFrameHandle<WasmFunction>;
  readonly fulfillStep: PreparedFrameHandle<WasmFunction>;
  readonly rejectStep: PreparedFrameHandle<WasmFunction>;
  readonly exceptionTag: PreparedFrameHandle<TagDef | Import>;
  readonly runtime: PreparedFrameRuntime;
  /** Includes every callable used by state operations (boxing, helper calls, etc.). */
  readonly operations: readonly PreparedFrameFunction[];
  readonly conversions: readonly PreparedFrameConversion[];
  readonly undefinedSource:
    | { readonly kind: "not-required" }
    | { readonly kind: "helper"; readonly target: PreparedFrameFunction };
  /** The owning backend revalidates semantic plan/current-runtime authority here. */
  assertCurrent(): void;
}

export interface PreparedFrameOutput {
  readonly entry: Pick<WasmFunction, "body" | "locals">;
  readonly resume: Pick<WasmFunction, "body" | "locals">;
  readonly fulfillStep: Pick<WasmFunction, "body" | "locals">;
  readonly rejectStep: Pick<WasmFunction, "body" | "locals">;
}

/** C's process-local, accepted IR-to-physical mapping; never serialized. */
export interface PreparedIrAsyncFrameResources extends PreparedFrameResources {
  readonly values: PreparedFramePlan["values"];
  /** Canonical keys; C authenticates signatures against the reserved objects. */
  readonly callTargets: ReadonlyMap<string, PreparedFrameFunction>;
  readonly callSignatures: ReadonlyMap<string, PreparedIrAsyncCallSignature>;
}

export interface PreparedIrAsyncCallSignature {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}
