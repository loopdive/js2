// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type {
  GlobalReservation,
  PhysicalModuleReservations,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../../../runtime/wasmgc/values/primitive-layouts.js";
import { JS_TAG_IDS } from "../../../ir/runtime/js-tag-domain.js";
import type { IrInstr } from "../../../ir/core/nodes.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";

type NativeNumberUndefinedInstruction = Extract<
  IrInstr,
  { kind: "const" | "box" | "tag.test" | "dyn.eq" | "dyn.to_number" }
>;

export interface NativeNumberUndefinedGcReservations {
  readonly carrier: TypeReservation;
  readonly singleton: GlobalReservation;
}
const owners = new WeakMap<NativeNumberUndefinedGcReservations, PhysicalModuleReservations>();

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native Number/Undefined GC: " + detail);
}

export function reserveNativeNumberUndefinedGc(
  tx: PhysicalModuleReservations,
  key: string,
): NativeNumberUndefinedGcReservations {
  const carrier = tx.reserveType(key + ":carrier", buildAnyValueType());
  const singleton = tx.reserveGlobal(
    key + ":undefined",
    "__native_undefined",
    { kind: "ref", typeIdx: carrier.typeIndex },
    false,
  );
  const pack = Object.freeze({ carrier, singleton });
  owners.set(pack, tx);
  return pack;
}

function current(tx: PhysicalModuleReservations, pack: NativeNumberUndefinedGcReservations): number {
  if (owners.get(pack) !== tx || tx.state !== "filling") fail("foreign pack or inactive reservation phase");
  tx.physicalIndex(pack.carrier);
  tx.physicalIndex(pack.singleton);
  if (pack.singleton.object.type.kind !== "ref" || pack.singleton.object.type.typeIdx !== pack.carrier.typeIndex)
    fail("singleton carrier changed");
  return pack.carrier.typeIndex;
}

export function fillNativeNumberUndefinedGc(
  tx: PhysicalModuleReservations,
  pack: NativeNumberUndefinedGcReservations,
): void {
  const typeIndex = current(tx, pack);
  tx.fillGlobal(pack.singleton, buildUndefinedInitializer(typeIndex));
}

export function requireCompletedNativeNumberUndefinedGc(
  tx: PhysicalModuleReservations,
  pack: NativeNumberUndefinedGcReservations,
): void {
  current(tx, pack);
  tx.assertCompletedReservation(pack.singleton);
}

/** Pure physical operations after the complete program checker has authorized this occurrence. */
export function emitNativeNumberUndefinedGc(
  tx: PhysicalModuleReservations,
  pack: NativeNumberUndefinedGcReservations,
  instr: NativeNumberUndefinedInstruction,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
): readonly Instr[] {
  const typeIdx = current(tx, pack);
  tx.assertCompletedReservation(pack.singleton);
  const carrier: ValType = { kind: "ref_null", typeIdx };
  const tag = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx, fieldIdx: 0 },
  ];
  const value = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx, fieldIdx: 2 },
  ];
  if (instr.kind === "const") {
    if (instr.value.kind !== "undefined" || operands.length) fail("unexpected constant");
    return [{ op: "global.get", index: tx.physicalIndex(pack.singleton) }];
  }
  if (instr.kind === "box") {
    if (
      operands.length !== 1 ||
      instr.toType.kind !== "dynamic" ||
      instr.alloc === undefined ||
      (instr.toType.tag !== undefined && instr.toType.tag !== JS_TAG_IDS.NumberF64)
    )
      fail("unowned box");
    return [
      { op: "i32.const", value: Number(JS_TAG_IDS.NumberF64) },
      { op: "i32.const", value: 0 },
      ...operands[0]!,
      { op: "ref.null", typeIdx: -19 },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx },
    ];
  }
  const left = scratch(carrier);
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
  const right = scratch(carrier);
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
