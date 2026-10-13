// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunction, IrInstr, AllocSiteId } from "../core/nodes.js";
import type { LinearRuntimeOperation } from "../analysis/contracts/linear-memory-layout.js";
import type { FuncTypeDef } from "../../wasm/model/module-records.js";
import {
  reserveLinearBodyBatchExceptionTag,
  type ExceptionTagResources,
} from "../../wasm/physical/linear-body-batch-exception-tag.js";
export {
  reserveLinearBodyBatchExceptionTag,
  readLinearBodyBatchExceptionTag,
  type ExceptionTagResources,
} from "../../wasm/physical/linear-body-batch-exception-tag.js";

/**
 * Backend resources required by one already-built linear IR module.
 *
 * The names are runtime bindings, while operations/layouts/data segments stay
 * symbolic. This is deliberately a demand projection: it never assigns a
 * final linear address or discovers a new source/runtime intent.
 */
export interface LinearBackendResourceDemand {
  readonly runtimeFunctions: readonly string[];
  readonly runtimeOperations: readonly LinearRuntimeOperation[];
  readonly allocationSites: readonly AllocSiteId[];
  readonly layoutIds: readonly string[];
  readonly dataSegmentIds: readonly string[];
}

interface BodyBatchResourcePorts {
  validateDemand(demand: LinearBackendResourceDemand): void;
  resolveRuntimeOperation(operation: LinearRuntimeOperation): number;
  internFunctionType(signature: FuncTypeDef): number;
  forEachInstruction(fn: IrFunction, visit: (instr: IrInstr) => void): void;
}

/** Complete resource preflight before any frozen body consumer runs. */
export function preflightLinearBodyBatchResources(
  module: { readonly functions: readonly IrFunction[] },
  resources: ExceptionTagResources,
  demand: LinearBackendResourceDemand,
  ports: BodyBatchResourcePorts,
): void {
  ports.validateDemand(demand);
  for (const operation of demand.runtimeOperations) {
    if (operation.family === "vector" && operation.operation === "resolve-forwarding")
      ports.resolveRuntimeOperation(operation);
  }
  let needsExceptionTag = false;
  for (const fn of module.functions) {
    ports.forEachInstruction(fn, (instr) => {
      if (instr.kind === "try" || instr.kind === "throw") needsExceptionTag = true;
    });
  }
  if (needsExceptionTag) reserveLinearBodyBatchExceptionTag(resources, ports.internFunctionType);
}
