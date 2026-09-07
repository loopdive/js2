// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  linearStringLayoutId,
  type LinearAllocationSitePlan,
  type LinearMemoryPlan,
  type LinearStringLayoutPlan,
} from "./linear-memory-plan.js";
import type { AllocSiteId } from "../nodes.js";
import { IR_STRING_RUNTIME, type IrStringRuntimeIntrinsic } from "../string-runtime.js";
import type { Encoding } from "./encoding.js";

export const LINEAR_STRING_ASCII_PROOF_REQUIRED = "ir/linear-string: ASCII encoding proof required";

/** A known representation gap, distinct from a missing layout/allocation. */
export class LinearStringEncodingUnsupportedError extends Error {
  constructor(
    readonly intrinsic: IrStringRuntimeIntrinsic,
    readonly position: "input" | "result",
    readonly encoding: Encoding | undefined,
  ) {
    super(`${LINEAR_STRING_ASCII_PROOF_REQUIRED} for ${intrinsic} ${position} (got ${encoding ?? "unproven"})`);
    this.name = "LinearStringEncodingUnsupportedError";
  }
}

export interface LinearStringRuntimeRequest {
  readonly intrinsic: IrStringRuntimeIntrinsic;
  readonly alloc?: AllocSiteId;
  /** Encoding of the receiver/input string when no allocation records it. */
  readonly inputEncoding?: Encoding;
}

export interface LinearStringRuntimeOperation {
  readonly family: "string";
  readonly operation: IrStringRuntimeIntrinsic;
  readonly elementStorage: "i8" | "i16";
  readonly encoding: "ascii";
  readonly indexUnit?: "utf16-code-unit";
  readonly outOfBounds?: "empty-string" | "nan";
}

export interface LinearStringRuntimeBinding {
  readonly layout: LinearStringLayoutPlan;
  readonly allocation?: LinearAllocationSitePlan;
  readonly operation: LinearStringRuntimeOperation;
}

/** Validate producer encoding facts without choosing an allocation policy. */
export function validateLinearStringRuntimeEncoding(
  request: LinearStringRuntimeRequest,
  allocation?: Pick<LinearAllocationSitePlan, "id" | "encoding">,
): void {
  const { intrinsic, alloc } = request;
  const spec = IR_STRING_RUNTIME[intrinsic];
  if (spec.allocatesResult) {
    if (alloc === undefined) throw new Error(`linear string contract: ${intrinsic} requires an allocation site`);
    if (!allocation) throw new Error(`linear string contract: allocation site ${alloc as number} is absent`);
    if (allocation.id !== alloc)
      throw new Error(`linear string contract: allocation site ${alloc as number} is mismatched`);
    requireAscii(intrinsic, "result", allocation.encoding);
  }
  if (spec.operands.includes("string")) {
    // An ASCII concat result proves both operands ASCII under the existing
    // encoding lattice. Non-allocating reads and charAt need receiver proof.
    const inputEncoding = intrinsic === "concat" ? allocation?.encoding : request.inputEncoding;
    requireAscii(intrinsic, "input", inputEncoding);
  }
}

/**
 * Bind semantic string work to the source-derived linear-memory layout and,
 * for allocating operations, to the exact allocation-site decision.
 */
export function bindLinearStringRuntime(
  plan: LinearMemoryPlan,
  request: LinearStringRuntimeRequest,
): LinearStringRuntimeBinding {
  const { intrinsic, alloc } = request;
  const layout = plan.requireLayout(linearStringLayoutId());
  if (layout.kind !== "string") throw new Error(`linear string contract: '${layout.id}' is not a string layout`);

  const spec = IR_STRING_RUNTIME[intrinsic];
  let allocation: LinearAllocationSitePlan | undefined;
  if (spec.allocatesResult && alloc !== undefined) {
    allocation = plan.allocation(alloc);
    if (allocation && allocation.layoutId !== layout.id) {
      throw new Error(
        `linear string contract: allocation site ${alloc as number} uses '${allocation.layoutId}', expected '${layout.id}'`,
      );
    }
  }
  validateLinearStringRuntimeEncoding(request, allocation);

  const operation: LinearStringRuntimeOperation = Object.freeze({
    family: "string",
    operation: intrinsic,
    elementStorage: layout.elementStorage,
    encoding: "ascii",
    ...(spec.index
      ? {
          indexUnit: spec.index.unit,
          outOfBounds: spec.index.outOfBounds,
        }
      : {}),
  });
  return Object.freeze({ layout, ...(allocation ? { allocation } : {}), operation });
}

function requireAscii(
  intrinsic: IrStringRuntimeIntrinsic,
  position: "input" | "result",
  encoding: Encoding | undefined,
) {
  if (encoding === "ascii") return;
  throw new LinearStringEncodingUnsupportedError(intrinsic, position, encoding);
}
