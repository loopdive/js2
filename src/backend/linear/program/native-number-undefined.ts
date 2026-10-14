// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type { NativeNumberUndefinedInstruction } from "../../../ir/backend/native-number-undefined.js";
import type { NativeNumberUndefinedMemoryDescription } from "../../../ir/program/prepared-linear-memory-contracts.js";
import type { LinearAllocationSitePlan, LinearMemoryPlan } from "../../../ir/analysis/linear-memory-from-facts.js";
import { JS_TAG_IDS } from "../../../ir/runtime/js-tag-domain.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";
import type { GlobalReservation } from "../../../wasm/physical/module-reservations.js";

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native Number/Undefined Linear: " + detail);
}

/** Require the existing frozen-facts planner's geometry; never manufacture a replacement layout. */
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

/** Issued only by the existing checked memory pack after its reservations are frozen. */
export interface NativeNumberUndefinedLinearBindings {
  readonly singletonAddress: number;
  readonly allocatorIndex: number;
  readonly singletonGlobal: GlobalReservation;
  readonly singletonGlobalIndex: number;
  assertCurrent(): void;
  requireBox(allocationId: Parameters<LinearMemoryPlan["allocation"]>[0]): LinearAllocationSitePlan;
}

export function emitNativeNumberUndefinedLinear(
  bindings: NativeNumberUndefinedLinearBindings,
  instr: NativeNumberUndefinedInstruction,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
): readonly Instr[] {
  bindings.assertCurrent();
  const tag = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "i32.load", align: 2, offset: 0 },
  ];
  const value = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "f64.load", align: 3, offset: 8 },
  ];
  if (instr.kind === "const") {
    if (instr.value.kind !== "undefined" || operands.length) fail("unexpected constant");
    return [{ op: "global.get", index: bindings.singletonGlobalIndex }];
  }
  if (instr.kind === "box") {
    if (
      instr.alloc === undefined ||
      operands.length !== 1 ||
      instr.toType.kind !== "dynamic" ||
      (instr.toType.tag !== undefined && instr.toType.tag !== JS_TAG_IDS.NumberF64)
    )
      fail("unowned box");
    bindings.requireBox(instr.alloc);
    const payload = scratch({ kind: "f64" }),
      pointer = scratch({ kind: "i32" });
    return [
      ...operands[0]!,
      { op: "local.set", index: payload },
      { op: "i32.const", value: 16 },
      { op: "call", funcIdx: bindings.allocatorIndex },
      { op: "local.set", index: pointer },
      { op: "local.get", index: pointer },
      { op: "i32.const", value: Number(JS_TAG_IDS.NumberF64) },
      { op: "i32.store", align: 2, offset: 0 },
      { op: "local.get", index: pointer },
      { op: "i32.const", value: 8 },
      { op: "i32.store", align: 2, offset: 4 },
      { op: "local.get", index: pointer },
      { op: "local.get", index: payload },
      { op: "f64.store", align: 3, offset: 8 },
      { op: "local.get", index: pointer },
    ];
  }
  const left = scratch({ kind: "i32" });
  if (instr.kind === "tag.test") {
    if (operands.length !== 1 || (instr.tagId !== JS_TAG_IDS.Undefined && instr.tagId !== JS_TAG_IDS.NumberF64))
      fail("unsupported tag probe");
    return [
      ...operands[0]!,
      { op: "local.set", index: left },
      ...tag(left),
      {
        op: "i32.const",
        value: Number(instr.tagId),
      },
      { op: "i32.eq" },
    ];
  }
  if (instr.kind === "dyn.to_number") {
    if (operands.length !== 1) fail("numeric conversion operands differ");
    return [
      ...operands[0]!,
      { op: "local.set", index: left },
      ...tag(left),
      { op: "i32.const", value: Number(JS_TAG_IDS.Undefined) },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [{ op: "f64.const", value: NaN }],
        else: value(left),
      },
    ];
  }
  if (instr.loose !== false || typeof instr.negate !== "boolean" || operands.length !== 2) fail("unsupported equality");
  const right = scratch({ kind: "i32" });
  const undef = (local: number): Instr[] => [
    ...tag(local),
    { op: "i32.const", value: Number(JS_TAG_IDS.Undefined) },
    { op: "i32.eq" },
  ];
  return [
    ...operands[0]!,
    { op: "local.set", index: left },
    ...operands[1]!,
    { op: "local.set", index: right },
    ...undef(left),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: undef(right),
      else: [
        ...undef(right),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0 }],
          else: [...value(left), ...value(right), { op: "f64.eq" }],
        },
      ],
    },
    ...(instr.negate ? [{ op: "i32.eqz" } as Instr] : []),
  ];
}
