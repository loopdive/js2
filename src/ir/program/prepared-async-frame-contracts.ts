// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrSourceRecord } from "../../shared/contracts/ir-unit-inventory.js";
import type { PreparedAsyncHostCapabilityId } from "../../runtime/contracts/async-provider-schema.js";
import type { PreparedIrFunction as IrFunction } from "../runtime/contracts/prepared.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType, IrTypeRef } from "../core/types.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";

export type PreparedAsyncFrameSignatureType = ValType | Extract<IrType, { kind: "support-ref" }>;

export interface PreparedAsyncFrameCallable {
  readonly reference: IrFuncRef;
  readonly bindingId: IrBindingId;
  readonly params: readonly PreparedAsyncFrameSignatureType[];
  readonly results: readonly PreparedAsyncFrameSignatureType[];
  readonly entry: ProgramAbiPlanEntry;
}

export interface PreparedHostAsyncFramePlan {
  readonly owner: IrUnitId;
  readonly kind: "host";
  readonly frame: {
    readonly reference: IrTypeRef;
    readonly entry: ProgramAbiPlanEntry;
    readonly fields: readonly {
      readonly name: string;
      readonly type: ValType;
      readonly mutable: boolean;
    }[];
  };
  readonly resultField: number;
  readonly values: readonly {
    readonly id: number;
    readonly type: ValType;
    readonly param?: number;
    readonly spill?: number;
  }[];
  readonly primary: PreparedAsyncFrameCallable;
  readonly auxiliaries: {
    readonly resume: PreparedAsyncFrameCallable;
    readonly fulfillStep: PreparedAsyncFrameCallable;
    readonly rejectStep: PreparedAsyncFrameCallable;
  };
  readonly imports: readonly (PreparedAsyncFrameCallable & {
    readonly capability: PreparedAsyncHostCapabilityId;
    readonly module: string;
    readonly field: string;
    readonly referenceKey: string;
  })[];
  readonly calls: readonly {
    readonly referenceKey: string;
    readonly bindingId: IrBindingId;
    readonly params: readonly ValType[];
    readonly results: readonly ValType[];
  }[];
  readonly conversions: readonly {
    readonly from: ValType;
    readonly to: ValType;
    readonly operation:
      | {
          readonly kind: "numeric";
          readonly op: "f64.convert_i32_s" | "i32.trunc_sat_f64_s" | "f64.promote_f32";
        }
      | { readonly kind: "helper"; readonly bindingId: IrBindingId };
  }[];
  readonly undefinedSource:
    | { readonly kind: "not-required" }
    | { readonly kind: "helper"; readonly bindingId: IrBindingId };
  readonly callbacks: readonly {
    readonly id: number;
    readonly externalName: string;
    readonly targetBindingId: IrBindingId;
    readonly entry: ProgramAbiPlanEntry;
  }[];
  /** Complete supplemental ABI rows, in caller-reserved declaration order. */
  readonly entries: readonly ProgramAbiPlanEntry[];
}

export interface PreparedHostAsyncFrameInput {
  readonly fn: IrFunction;
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
  readonly abiEntries: readonly PreparedIrAbiEntry[];
  readonly anchor: IrSourceRecord;
  readonly declarationOrderStart: number;
  readonly callbacks: {
    readonly fulfill: number;
    readonly reject: number;
    readonly occupiedIds: readonly number[];
    readonly occupiedNames: readonly string[];
  };
}

export type PreparedHostAsyncFrameOutcome =
  | { readonly kind: "planned"; readonly plan: PreparedHostAsyncFramePlan }
  | {
      readonly kind: "unsupported";
      readonly unitId: IrUnitId;
      readonly feature: "prepared-host-async-frame";
      readonly detail: string;
      readonly stateId?: number;
      readonly valueId?: number;
    };

export type PreparedFrameInput = Omit<PreparedHostAsyncFrameInput, "callbacks"> & {
  readonly callbacks?: PreparedHostAsyncFrameInput["callbacks"];
};
export type FrameValue = PreparedHostAsyncFramePlan["values"][number];
export type FrameNumericConversion = Extract<
  PreparedHostAsyncFramePlan["conversions"][number]["operation"],
  { kind: "numeric" }
>;
export interface NativeFrameBridge {
  readonly kind: "native-helper";
  readonly role: "number.box" | "number.unbox" | "async.value.undefined";
}
export type FrameBridge = NativeFrameBridge | { readonly kind: "helper"; readonly bindingId: IrBindingId };
export type FrameField = {
  readonly name: string;
  readonly type: ValType | { readonly kind: "native-promise" };
  readonly mutable: boolean;
};
export interface PreparedNativeAsyncFramePlan extends Omit<
  PreparedHostAsyncFramePlan,
  "kind" | "frame" | "conversions" | "undefinedSource" | "imports" | "callbacks"
> {
  readonly kind: "native";
  readonly frame: Omit<PreparedHostAsyncFramePlan["frame"], "fields"> & { readonly fields: readonly FrameField[] };
  readonly conversions: readonly {
    readonly from: ValType;
    readonly to: ValType;
    readonly operation: FrameNumericConversion | NativeFrameBridge;
  }[];
  readonly undefinedSource: { readonly kind: "not-required" } | NativeFrameBridge;
  readonly bridges: readonly NativeFrameBridge[];
}
