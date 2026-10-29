// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { freezePreparedIrValue } from "./data.js";
import { FrameGap, gap, authenticatedRuntime, primary, frameLayout } from "./prepared-async-frame-layout.js";
import { FrameDeclarations, frameMachinery } from "./prepared-async-frame-declarations.js";
import { FrameOperations } from "./prepared-async-frame-operations.js";
import type {
  PreparedHostAsyncFrameInput,
  PreparedHostAsyncFrameOutcome,
  PreparedHostAsyncFramePlan,
} from "./prepared-async-frame-contracts.js";
export type {
  PreparedAsyncFrameSignatureType,
  PreparedAsyncFrameCallable,
  PreparedHostAsyncFrameInput,
  PreparedHostAsyncFrameOutcome,
  PreparedHostAsyncFramePlan,
} from "./prepared-async-frame-contracts.js";

/** Data-only preflight. Acceptance must rederive it against its exact current projection before allocation. */
export function planPreparedHostAsyncFrame(input: PreparedHostAsyncFrameInput): PreparedHostAsyncFrameOutcome {
  try {
    const runtime = authenticatedRuntime(input);
    const entry = primary(input, runtime);
    const layout = frameLayout(runtime);
    const declarations = new FrameDeclarations(input);
    const imports = declarations.imports(runtime);
    const operations = new FrameOperations(input, runtime, layout.values, (capability) => {
      const row = imports.find((row) => row.capability === capability);
      if (!row) return gap(`missing selected ${capability} adapter`);
      return { kind: "helper" as const, bindingId: row.bindingId };
    });
    operations.states();
    const resources = frameMachinery(declarations, layout.fields);
    const plan: PreparedHostAsyncFramePlan = {
      owner: input.fn.unitId,
      kind: "host",
      ...resources,
      resultField: layout.resultField,
      values: layout.values,
      primary: entry,
      imports,
      calls: [...operations.calls.values()],
      conversions: operations.conversions,
      undefinedSource: operations.undefinedSource,
      entries: declarations.entries,
    };
    return {
      kind: "planned",
      plan: freezePreparedIrValue(plan) as PreparedHostAsyncFramePlan,
    };
  } catch (error) {
    if (!(error instanceof FrameGap)) throw error;
    return {
      kind: "unsupported",
      unitId: input.fn.unitId,
      feature: "prepared-host-async-frame",
      detail: error instanceof Error ? error.message : String(error),
      ...(error instanceof FrameGap && error.stateId !== undefined ? { stateId: error.stateId } : {}),
      ...(error instanceof FrameGap && error.valueId !== undefined ? { valueId: error.valueId } : {}),
    };
  }
}
