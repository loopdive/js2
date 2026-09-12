// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PreparedAsyncHostAdapter,
  PreparedAsyncHostCapabilityId,
} from "../../../runtime/contracts/async-provider-schema.js";
import type { IrAsyncPlan, IrAsyncState } from "../../core/async-plan.js";
import type { IrFunction as CoreIrFunction, IrModule as CoreIrModule, IrInstrIntrinsic } from "../../core/nodes.js";
import type { IrType, IrVecLayoutRef } from "../../core/types.js";
import type { IrFuncRef } from "../../core/value-references.js";
import type {
  FrozenRuntimeManifest,
  RuntimeBackendRequirement,
  RuntimeProviderDefinition,
  RuntimeProviderPlan,
} from "./manifest.js";

export interface PreparedIrFunction extends CoreIrFunction {
  /**
   * Lookup-only backend attachment added after runtime-manifest freeze. This
   * is deliberately separate from `asyncPlan` so plan hashes stay target
   * independent while Program ABI sealing can see exact adapter callables.
   */
  readonly asyncRuntime?: PreparedIrAsyncRuntime;
}

export interface PreparedIrModule extends CoreIrModule {
  readonly functions: readonly PreparedIrFunction[];
}

/**
 * Backend attachment created only after the semantic runtime manifest freezes.
 * The plan above stays target-neutral; this lookup-only record gives prepared
 * component sealing exact symbolic dependencies for the selected adapter.
 */
export interface PreparedIrAsyncHostAdapter {
  readonly capability: PreparedAsyncHostCapabilityId;
  readonly target: IrFuncRef;
  /** Exact canonical capability record selected by the frozen manifest. */
  readonly record: PreparedAsyncHostAdapter;
}

interface PreparedIrAsyncRuntimeBase {
  // Optional in the structural type only for legacy generic-pass fixtures that
  // model a pre-manifest placeholder. Production consumers must call
  // `assertPreparedIrAsyncRuntimeCurrent`, which requires all four fields.
  /** Exact semantic plan authenticated when this backend decision was attached. */
  readonly plan?: IrAsyncPlan;
  /** Exact frozen whole-program manifest used to select this owner's providers. */
  readonly manifest?: FrozenRuntimeManifest;
  /** Exact manifest provider objects selected for this owner, in manifest order. */
  readonly providers?: readonly RuntimeProviderDefinition[];
  /** Closed, canonical backend reservations projected from `providers`. */
  readonly backendRequirements?: readonly RuntimeBackendRequirement[];
  /** Backend-only layouts keyed by the exact logical types in `asyncPlan`. */
  readonly typeLayouts?: readonly {
    readonly logicalType: IrType;
    readonly layout: IrVecLayoutRef;
    /** Present only for a host-fulfilled resume value that crosses representations. */
    readonly fromExtern?: IrFuncRef;
  }[];
  /** State bodies with post-freeze intrinsic provider attachments. */
  readonly states: readonly IrAsyncState[];
}

export type PreparedIrAsyncRuntime =
  | (PreparedIrAsyncRuntimeBase & {
      readonly kind: "host-wasmgc";
      readonly adapters: readonly PreparedIrAsyncHostAdapter[];
    })
  | (PreparedIrAsyncRuntimeBase & {
      readonly kind: "standalone-native-wasmgc";
      readonly adapters: readonly [];
    });

export type CurrentPreparedIrAsyncRuntime = PreparedIrAsyncRuntime & {
  readonly plan: IrAsyncPlan;
  readonly manifest: FrozenRuntimeManifest;
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly backendRequirements: readonly RuntimeBackendRequirement[];
};

export type PreparedIrAsyncRuntimeInput = {
  readonly plan: IrAsyncPlan;
  readonly manifest: FrozenRuntimeManifest;
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly backendRequirements: readonly RuntimeBackendRequirement[];
  readonly states: readonly IrAsyncState[];
  readonly typeLayouts?: PreparedIrAsyncRuntimeBase["typeLayouts"];
} & (
  | {
      readonly kind: "host-wasmgc";
      readonly adapters: readonly PreparedIrAsyncHostAdapter[];
    }
  | {
      readonly kind: "standalone-native-wasmgc";
      readonly adapters: readonly [];
    }
);

export interface PreparedIrRuntimeManifest {
  readonly functions: readonly PreparedIrFunction[];
  readonly manifest: FrozenRuntimeManifest;
  /** Lookup-only handle retained after freeze for verifier/lowering adapters. */
  readonly providers: ReadonlyMap<IrInstrIntrinsic["id"], RuntimeProviderPlan>;
}
