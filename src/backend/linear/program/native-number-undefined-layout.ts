// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { NativeNumberUndefinedMemoryDescription } from "../../../ir/program/prepared-linear-memory-contracts.js";
import type { LinearAllocationSitePlan, LinearMemoryPlan } from "../../../ir/analysis/linear-memory-from-facts.js";
import type { GlobalReservation } from "../../../wasm/physical/module-reservations.js";
import { JS_TAG_IDS } from "../../../ir/core/js-value-tag-identities.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
export { JS_TAG_IDS };

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native Number/Undefined Linear: " + detail);
}

export function requireNativeNumberUndefinedBoxLayout(
  planner: LinearMemoryPlan,
  allocationId: Parameters<LinearMemoryPlan["allocation"]>[0],
): LinearAllocationSitePlan {
  const allocation = planner.allocation(allocationId);
  if (!allocation || allocation.allocationKind !== "box" || allocation.allocationClass !== "arena")
    fail("box has no canonical arena allocation");
  const layout = planner.requireLayout(allocation.layoutId);
  if (
    layout.id !== "record:box:scalar:f64" ||
    layout.kind !== "record" ||
    layout.alignment !== 8 ||
    layout.size.kind !== "constant" ||
    layout.size.bytes !== 16 ||
    layout.headerBytes !== 8 ||
    layout.typeTagOffset !== 0 ||
    layout.payloadSizeOffset !== 4 ||
    layout.pointerMap.kind !== "none" ||
    layout.fields.length !== 1 ||
    layout.fields[0]!.name !== "value" ||
    layout.fields[0]!.storage !== "f64" ||
    layout.fields[0]!.offset !== 8 ||
    layout.fields[0]!.slotBytes !== 8 ||
    layout.fields[0]!.containsPointer ||
    allocation.size.kind !== "constant" ||
    allocation.size.bytes !== 16
  )
    fail("box differs from the unchanged canonical f64 record");
  return allocation;
}

export function describeNativeNumberUndefinedMemory(
  planner: LinearMemoryPlan,
  allocationIds: readonly Parameters<LinearMemoryPlan["allocation"]>[0][],
  floor: number,
): NativeNumberUndefinedMemoryDescription {
  if (!Number.isSafeInteger(floor) || floor < 1024 || floor % 8 || floor > 0x7fffffff - 16)
    fail("invalid singleton address");
  if (new Set(allocationIds).size !== allocationIds.length) fail("duplicate box allocation");
  const boxes = allocationIds.map((allocationId) => ({
    allocationId: Number(allocationId),
    layoutId: requireNativeNumberUndefinedBoxLayout(planner, allocationId).layoutId,
  }));
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, Number(JS_TAG_IDS.Undefined), true);
  view.setInt32(4, 8, true);
  view.setFloat64(8, NaN, true);
  return Object.freeze({
    boxes: Object.freeze(boxes.map((box) => Object.freeze(box))),
    singleton: Object.freeze({
      key: "linear:number-undefined:singleton",
      offset: floor,
      alignment: 8,
      bytes: Object.freeze([...bytes]),
    }),
  });
}

export interface NativeNumberUndefinedLinearBindings {
  readonly singletonAddress: number;
  readonly allocatorIndex: number;
  readonly singletonGlobal: GlobalReservation;
  readonly singletonGlobalIndex: number;
  assertCurrent(): void;
  requireBox(allocationId: Parameters<LinearMemoryPlan["allocation"]>[0]): LinearAllocationSitePlan;
}
