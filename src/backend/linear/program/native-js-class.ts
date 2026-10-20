// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr } from "../../../ir/core/nodes.js";
import type { LinearMemoryPlan, LinearAllocationSitePlan } from "../../../ir/analysis/linear-memory-from-facts.js";
import { JS_TAG_IDS } from "../../../ir/core/js-value-tag-identities.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";

export interface NativeJsClassLinearBox {
  readonly allocation: LinearAllocationSitePlan;
  readonly tag: number;
  readonly payload: "i32" | "f64";
  readonly offset: number;
  readonly bytes: number;
}
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native class Linear box: " + detail);
}
/** Require genuine existing scalar-box geometry. This returns DATA, not an
 * allocator binding or permission to bypass demand/currentness validation. */
export function describeNativeJsClassLinearBox(
  planner: LinearMemoryPlan,
  instruction: Extract<IrInstr, { kind: "box" }>,
): NativeJsClassLinearBox {
  if (
    instruction.alloc === undefined ||
    instruction.toType.kind !== "dynamic" ||
    instruction.resultType?.kind !== "dynamic" ||
    instruction.toType.tag !== instruction.resultType.tag
  )
    invalid("missing original box site/type");
  const tag = instruction.toType.tag;
  if (tag !== JS_TAG_IDS.NumberF64 && tag !== JS_TAG_IDS.Boolean) invalid("unsupported primitive box");
  const payload = tag === JS_TAG_IDS.NumberF64 ? "f64" : "i32";
  const allocation = planner.allocation(instruction.alloc);
  if (!allocation || allocation.allocationKind !== "box" || allocation.allocationClass !== "arena")
    invalid("missing checked arena box");
  const layout = planner.requireLayout(allocation.layoutId);
  if (
    layout.kind !== "record" ||
    layout.id !== "record:box:scalar:" + payload ||
    layout.headerBytes !== 8 ||
    layout.typeTagOffset !== 0 ||
    layout.payloadSizeOffset !== 4 ||
    layout.alignment !== 8 ||
    layout.pointerMap.kind !== "none" ||
    layout.size.kind !== "constant" ||
    layout.size.bytes !== 16 ||
    allocation.size.kind !== "constant" ||
    allocation.size.bytes !== 16 ||
    layout.fields.length !== 1
  )
    invalid("different canonical scalar box geometry");
  const field = layout.fields[0]!;
  if (
    field.name !== "value" ||
    field.storage !== payload ||
    field.offset !== 8 ||
    field.slotBytes !== 8 ||
    field.containsPointer
  )
    invalid("different canonical box payload");
  return Object.freeze({ allocation, tag: Number(tag), payload, offset: field.offset, bytes: layout.size.bytes });
}
