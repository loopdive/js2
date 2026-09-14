// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { buildRyuPowerTables, createRyuPowerArrayType } from "../../../runtime/wasmgc/values/number-ryu-tables.js";
import {
  buildRyuMulShiftBody,
  buildRyuDigitsBody,
  buildRyuToBufferBody,
  ryuMulShiftSignature,
  ryuDigitsSignature,
  ryuToBufferSignature,
} from "../../../runtime/wasmgc/values/number-ryu-bodies.js";
import { createStringDataType } from "../../../runtime/wasmgc/values/string-layouts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  nativeScalarTypeDeclaration,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

function fail(detail: string): never {
  throw new Error("native Ryū: " + detail);
}
function resourceKeys(key: string) {
  if (typeof key !== "string" || !key) fail("missing parent resource key");
  return {
    mulShift: key + ":mul-shift",
    tableType: key + ":table-type",
    inverse: key + ":inverse",
    powers: key + ":powers",
    digits: key + ":digits",
    toBuffer: key + ":to-buffer",
  };
}
export function declareNativeRyuResources(key: string, stringKey: string): NativeResourceRecipe {
  if (typeof stringKey !== "string" || !stringKey) fail("missing string resource key");
  const keys = resourceKeys(key),
    dataKey = nativeStringTypeKeys(stringKey).data;
  const declarations: NativeStringValueDeclaration[] = [
    {
      key: keys.mulShift,
      role: ["number-ryu", "mul-shift"],
      space: "function",
      name: "__ryu_mul_shift",
      signature: ryuMulShiftSignature(),
    },
    {
      key: keys.tableType,
      role: ["number-ryu", "table-type"],
      space: "type",
      shape: nativeScalarTypeDeclaration(createRyuPowerArrayType()),
    },
    {
      key: keys.inverse,
      role: ["number-ryu", "inverse"],
      space: "global",
      name: "__ryu_pow5_inv",
      valueType: { kind: "ref", typeKey: keys.tableType },
      mutable: false,
    },
    {
      key: keys.powers,
      role: ["number-ryu", "powers"],
      space: "global",
      name: "__ryu_pow5",
      valueType: { kind: "ref", typeKey: keys.tableType },
      mutable: false,
    },
    {
      key: keys.digits,
      role: ["number-ryu", "digits"],
      space: "function",
      name: "__num_ryu_digits",
      signature: ryuDigitsSignature(),
    },
    {
      key: keys.toBuffer,
      role: ["number-ryu", "to-buffer"],
      space: "function",
      name: "__num_ryu_to_buf",
      signature: ryuToBufferSignature({ kind: "ref", typeKey: dataKey }),
    },
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}
export interface NativeRyuReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly tableType: TypeReservation;
  readonly inverse: GlobalReservation;
  readonly powers: GlobalReservation;
  readonly mulShift: FunctionReservation;
  readonly digits: FunctionReservation;
  readonly toBuffer: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly strings: NativeStringLiteralReservations;
  readonly data: TypeReservation;
  readonly stringKey: string;
  filled: boolean;
}
const owners = new WeakMap<NativeRyuReservations, Owner>();
function stringData(tx: PhysicalModuleReservations, strings: NativeStringLiteralReservations) {
  const inventory = nativeStringLiteralReservationInventory(tx, strings);
  const key = nativeStringTypeKeys(inventory.typePack.key).data;
  const matches = inventory.typePack.types.filter((token) => token.key === key);
  if (matches.length !== 1) fail("missing or duplicate issued string data");
  const data = matches[0]!;
  if (tx.state === "reserving") tx.assertTypeReservation(data);
  else tx.physicalIndex(data);
  if (preparedIrDataMismatch(data.object, createStringDataType()) !== undefined)
    fail("incompatible string data descriptor");
  return { data, stringKey: inventory.typePack.key };
}
export function reserveNativeRyuResources(
  tx: PhysicalModuleReservations,
  key: string,
  strings: NativeStringLiteralReservations,
): NativeRyuReservations {
  const dependency = stringData(tx, strings);
  const keys = resourceKeys(key);
  const recipe = declareNativeRyuResources(key, dependency.stringKey);
  const rows = executeNativeResourceRecipe(tx, recipe, new Map([[dependency.data.key, dependency.data]]));
  const pack: NativeRyuReservations = Object.freeze({
    strings,
    tableType: requireNativeDeclaredReservation(rows, keys.tableType, "type"),
    inverse: requireNativeDeclaredReservation(rows, keys.inverse, "global"),
    powers: requireNativeDeclaredReservation(rows, keys.powers, "global"),
    mulShift: requireNativeDeclaredReservation(rows, keys.mulShift, "function"),
    digits: requireNativeDeclaredReservation(rows, keys.digits, "function"),
    toBuffer: requireNativeDeclaredReservation(rows, keys.toBuffer, "function"),
  });
  owners.set(pack, { tx, key, strings, ...dependency, filled: false });
  return pack;
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeRyuReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.strings !== pack.strings) fail("foreign or copied owner");
  const dependency = stringData(tx, owner.strings);
  if (dependency.data !== owner.data || dependency.stringKey !== owner.stringKey) fail("changed string dependency");
  if (tx.state === "reserving") tx.assertTypeReservation(pack.tableType);
  else
    for (const token of [pack.mulShift, pack.tableType, pack.inverse, pack.powers, pack.digits, pack.toBuffer])
      tx.physicalIndex(token);
  return owner;
}
export function requireNativeRyuReservations(
  tx: PhysicalModuleReservations,
  pack: NativeRyuReservations,
  key: string,
  strings: NativeStringLiteralReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.key !== key || owner.strings !== strings) fail("substituted key or string pack");
}
export function fillNativeRyuResources(tx: PhysicalModuleReservations, pack: NativeRyuReservations): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("already filled");
  if (tx.state !== "filling") fail("fill requires frozen reservations");
  const tableTypeIdx = tx.physicalIndex(pack.tableType);
  const tables = buildRyuPowerTables();
  const initializer = (values: readonly bigint[]): Instr[] => [
    ...values.map((value): Instr => ({ op: "i64.const", value })),
    { op: "array.new_fixed", typeIdx: tableTypeIdx, length: values.length },
  ];
  tx.fillGlobal(pack.inverse, initializer(tables.inverse));
  tx.fillGlobal(pack.powers, initializer(tables.powers));
  tx.fillFunction(pack.mulShift, buildRyuMulShiftBody());
  tx.fillFunction(
    pack.digits,
    buildRyuDigitsBody({
      mulShift: pack.mulShift.handle,
      tableTypeIdx,
      inverseGlobalIdx: tx.physicalIndex(pack.inverse),
      powersGlobalIdx: tx.physicalIndex(pack.powers),
    }),
  );
  tx.fillFunction(
    pack.toBuffer,
    buildRyuToBufferBody({ digits: pack.digits.handle, stringDataTypeIdx: tx.physicalIndex(owner.data) }),
  );
  owner.filled = true;
}
export function requireCompletedNativeRyu(
  tx: PhysicalModuleReservations,
  pack: NativeRyuReservations,
  strings: NativeStringLiteralReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.strings !== strings || !owner.filled || tx.state !== "sealed")
    fail("incomplete or substituted resource pack");
}
