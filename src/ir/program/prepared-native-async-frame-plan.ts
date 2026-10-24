// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ASYNC_RUNTIME_PROVIDERS } from "../runtime/async-providers.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { FrameDeclarations, frameMachinery } from "./prepared-async-frame-declarations.js";
import { FrameGap, gap, authenticatedRuntime, primary, frameLayout } from "./prepared-async-frame-layout.js";
import { FrameOperations } from "./prepared-async-frame-operations.js";
import type {
  NativeFrameBridge,
  PreparedFrameInput,
  PreparedNativeAsyncFramePlan,
  PreparedHostAsyncFrameOutcome,
} from "./prepared-async-frame-contracts.js";

export type PreparedNativeAsyncFrameInput = Omit<PreparedFrameInput, "callbacks">;
export type PreparedNativeAsyncFrameOutcome =
  | { readonly kind: "planned"; readonly plan: PreparedNativeAsyncFramePlan }
  | (Omit<Extract<PreparedHostAsyncFrameOutcome, { kind: "unsupported" }>, "feature"> & {
      readonly feature: "prepared-native-async-frame";
    });
export type { PreparedNativeAsyncFramePlan } from "./prepared-async-frame-contracts.js";

/** Descriptive native frame recipe; complete program/resource acceptance remains mandatory. */
export function planPreparedNativeAsyncFrame(input: PreparedNativeAsyncFrameInput): PreparedNativeAsyncFrameOutcome {
  try {
    if (Object.hasOwn(input, "callbacks")) gap("native frames cannot publish host callbacks");
    const runtime = authenticatedRuntime(input, "native");
    const entry = primary(input, runtime, "native");
    const layout = frameLayout(runtime, "native");
    const declarations = new FrameDeclarations(input);
    const bridges = new Map<NativeFrameBridge["role"], NativeFrameBridge>();
    const bridge = (role: NativeFrameBridge["role"]): NativeFrameBridge => {
      const feature = role === "async.value.undefined" ? "value.undefined" : "promise.number.bridge";
      const canonical = ASYNC_RUNTIME_PROVIDERS.find((row) => row.id === `native.${feature}`);
      const selected = runtime.providers?.filter((row) => row.feature === feature || row.id === canonical?.id);
      if (!canonical || selected?.length !== 1 || preparedIrDataMismatch(selected[0], canonical) !== undefined)
        return gap(`missing canonical native ${feature} provider`);
      const existing = bridges.get(role);
      if (existing) return existing;
      const requirement = { kind: "native-helper" as const, role };
      bridges.set(role, requirement);
      return requirement;
    };
    const operations = new FrameOperations(input, runtime, layout.values, bridge, "native");
    operations.states();
    const fields = layout.fields.map((field, index) =>
      index === layout.resultField ? { ...field, type: { kind: "native-promise" as const } } : field,
    );
    const { frame, auxiliaries } = frameMachinery(declarations, fields);
    const plan: PreparedNativeAsyncFramePlan = {
      owner: input.fn.unitId,
      kind: "native",
      frame,
      auxiliaries,
      primary: entry,
      resultField: layout.resultField,
      values: layout.values,
      calls: [...operations.calls.values()],
      conversions: operations.conversions,
      undefinedSource: operations.undefinedSource,
      bridges: [...bridges.values()],
      entries: declarations.entries,
    };
    return { kind: "planned", plan: freezePreparedIrValue(plan) as PreparedNativeAsyncFramePlan };
  } catch (error) {
    if (!(error instanceof FrameGap)) throw error;
    return {
      kind: "unsupported",
      unitId: input.fn.unitId,
      feature: "prepared-native-async-frame",
      detail: error.message,
      ...(error.stateId === undefined ? {} : { stateId: error.stateId }),
      ...(error.valueId === undefined ? {} : { valueId: error.valueId }),
    };
  }
}
