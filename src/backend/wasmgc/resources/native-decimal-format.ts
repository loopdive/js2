// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  buildNumberFormatFinalizeBody,
  buildRyuNumberToStringBody,
  numberFormatSignatures,
} from "../../../runtime/wasmgc/values/number-format-bodies.js";
import { nativeRyuBinding, type NativeRyuReservations } from "./native-number-ryu.js";
import type { NativeStringLiteralReservations } from "./native-string-literals.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";

export interface NativeDecimalFormat {
  readonly toString: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly strings: NativeStringLiteralReservations;
  readonly ryu: NativeRyuReservations;
  readonly finalize: FunctionReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeDecimalFormat, Owner>();
function fail(message: string): never {
  throw Error("native decimal format: " + message);
}
function current(tx: PhysicalModuleReservations, pack: NativeDecimalFormat): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  return owner;
}
/** Borrow the existing Ryu population, including one owned by the full radix formatter. */
export function reserveNativeDecimalFormat(
  tx: PhysicalModuleReservations,
  key: string,
  strings: NativeStringLiteralReservations,
  ryu: NativeRyuReservations,
): NativeDecimalFormat {
  if (tx.state !== "reserving" || !key) fail("invalid reservation phase/key");
  nativeRyuBinding(tx, ryu, strings);
  tx.assertReservationKeysAvailable([key + ":finalize", key + ":string"]);
  const layout = strings.layout;
  const signatures = numberFormatSignatures({
    data: { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx } as const,
    nullableData: { kind: "ref_null", typeIdx: layout.nativeStrDataTypeIdx } as const,
    anyString: { kind: "ref", typeIdx: layout.anyStrTypeIdx } as const,
  });
  const finalize = tx.reserveFunction(key + ":finalize", "__decimal_finalize", signatures.finalize);
  const pack = Object.freeze({
    toString: tx.reserveFunction(key + ":string", "__decimal_string", signatures.toString),
  });
  owners.set(pack, { tx, strings, ryu, finalize, filled: false });
  return pack;
}
function definitions(tx: PhysicalModuleReservations, pack: NativeDecimalFormat, owner: Owner) {
  const ryu = nativeRyuBinding(tx, owner.ryu, owner.strings, true);
  const layout = owner.strings.layout;
  const types = {
    dataTypeIdx: layout.nativeStrDataTypeIdx,
    nativeStringTypeIdx: layout.nativeStrTypeIdx,
    anyStringTypeIdx: layout.anyStrTypeIdx,
  };
  return [
    { token: owner.finalize, definition: buildNumberFormatFinalizeBody(types) },
    {
      token: pack.toString,
      definition: buildRyuNumberToStringBody({ types, finalize: owner.finalize.handle, ryuToBuffer: ryu.handle }),
    },
  ];
}
export function fillNativeDecimalFormat(tx: PhysicalModuleReservations, pack: NativeDecimalFormat): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  for (const row of definitions(tx, pack, owner)) tx.fillFunction(row.token, row.definition);
  owner.filled = true;
}
/** A real decimal producer for one exact string carrier, without whole-realm authority. */
export function nativeDecimalFormatBinding(
  tx: PhysicalModuleReservations,
  pack: NativeDecimalFormat,
  strings: NativeStringLiteralReservations,
  completed = false,
): FunctionReservation {
  const owner = current(tx, pack);
  if (owner.strings !== strings) fail("different string producer");
  nativeRyuBinding(tx, owner.ryu, strings, completed);
  if (completed) {
    if (!owner.filled) fail("missing canonical decimal fill");
    for (const row of definitions(tx, pack, owner)) requireCanonicalNativeFunction(tx, row.token, row.definition);
  }
  return pack.toString;
}
