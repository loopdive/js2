// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import {
  GlobalReservation,
  PhysicalModuleReservations,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../../../runtime/wasmgc/values/primitive-layouts.js";
import { JS_TAG_IDS } from "../../../ir/runtime/js-tag-domain.js";
import type { IrInstr } from "../../../ir/core/nodes.js";
import {
  assertPreparedIrData,
  preparedIrDataMismatch,
  freezePreparedIrValue,
} from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";

type NativeNumberUndefinedInstruction = Extract<
  IrInstr,
  { kind: "const" | "box" | "tag.test" | "dyn.eq" | "dyn.to_number" }
>;

export interface NativeNumberUndefinedGcReservations {
  readonly carrier: TypeReservation;
  readonly singleton: GlobalReservation;
}
const prototype = PhysicalModuleReservations.prototype;
const reserveType = prototype.reserveType,
  reserveGlobal = prototype.reserveGlobal;
const auditReserved = prototype.assertReservationKeysAvailable;
const indexOf = prototype.physicalIndex,
  completed = prototype.assertCompletedReservation;
const stateOf = Object.getOwnPropertyDescriptor(prototype, "state")!.get!;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly carrier: TypeReservation;
  readonly singleton: GlobalReservation;
  readonly empty: readonly Instr[];
  readonly definition: unknown;
}
const owners = new WeakMap<NativeNumberUndefinedGcReservations, Owner>();

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native Number/Undefined GC: " + detail);
}

export function reserveNativeNumberUndefinedGc(
  tx: PhysicalModuleReservations,
  key: string,
): NativeNumberUndefinedGcReservations {
  if (typeof key !== "string" || !key) fail("empty resource key");
  const carrier = reserveType.call(tx, key + ":carrier", buildAnyValueType());
  const singleton = reserveGlobal.call(
    tx,
    key + ":undefined",
    "__native_undefined",
    { kind: "ref", typeIdx: carrier.typeIndex },
    false,
  );
  const pack = Object.freeze({ carrier, singleton });
  owners.set(pack, {
    tx,
    carrier,
    singleton,
    empty: singleton.object.init,
    definition: freezePreparedIrValue(carrier.object),
  });
  return pack;
}

function current(tx: PhysicalModuleReservations, pack: NativeNumberUndefinedGcReservations): number {
  const owner = owned(tx, pack);
  if (stateOf.call(tx) !== "filling") fail("foreign pack or inactive reservation phase");
  indexOf.call(tx, owner.carrier);
  indexOf.call(tx, owner.singleton);
  if (pack.singleton.object.type.kind !== "ref" || pack.singleton.object.type.typeIdx !== pack.carrier.typeIndex)
    fail("singleton carrier changed");
  return pack.carrier.typeIndex;
}

function owned(tx: PhysicalModuleReservations, pack: NativeNumberUndefinedGcReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("unissued/copied/foreign pack");
  assertPreparedIrData(pack);
  if (preparedIrDataMismatch(owner.definition, pack.carrier.object) !== undefined) fail("altered type descriptor");
  if (
    pack.carrier !== owner.carrier ||
    pack.singleton !== owner.singleton ||
    pack.singleton.object.name !== "__native_undefined" ||
    pack.singleton.object.mutable ||
    preparedIrDataMismatch(pack.singleton.object.type, { kind: "ref", typeIdx: pack.carrier.typeIndex }) !== undefined
  )
    fail("issued carrier DATA changed");
  return owner;
}

/** Signature authority during genuine reservation; completion remains a separate contract. */
export function requireNativeNumberUndefinedGcSignatureCarrier(
  tx: PhysicalModuleReservations,
  pack: NativeNumberUndefinedGcReservations,
): Readonly<ValType> {
  const owner = owned(tx, pack);
  if (stateOf.call(tx) === "reserving") {
    auditReserved.call(tx, []);
    if (pack.singleton.object.init !== owner.empty || owner.empty.length !== 0) fail("premature singleton initializer");
  } else {
    requireCompletedNativeNumberUndefinedGc(tx, pack);
    if (
      preparedIrDataMismatch(pack.singleton.object.init, buildUndefinedInitializer(pack.carrier.typeIndex)) !==
      undefined
    )
      fail("noncanonical Undefined initializer");
  }
  return Object.freeze({ kind: "ref_null", typeIdx: pack.carrier.typeIndex });
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
  completed.call(tx, pack.singleton);
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
  completed.call(tx, pack.singleton);
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
