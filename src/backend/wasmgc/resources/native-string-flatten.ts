// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
  GlobalReservation,
} from "../../../wasm/physical/module-reservations.js";
import {
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  buildStringCopyTreeDefinition,
  buildStringFlattenDefinition,
} from "../../../runtime/wasmgc/values/string-flatten-bodies.js";
import { buildStringUtf8ToFlatDefinition } from "../../../runtime/wasmgc/values/string-utf8-decode-bodies.js";

export interface NativeStringFlattenReservations {
  readonly stringPack: NativeStringLiteralReservations;
  readonly worklist: TypeReservation;
  readonly copyTree: FunctionReservation;
  readonly utf8Decoder: FunctionReservation | null;
  readonly flatten: FunctionReservation;
  readonly emptyLiteral: GlobalReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly stringPack: NativeStringLiteralReservations;
  readonly emptyLiteral: GlobalReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeStringFlattenReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native string flatten: " + detail);
}

/** Reservation admission is not completion; this also works before ledger freeze. */
export function requireNativeStringFlattenReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringFlattenReservations,
): NativeStringFlattenReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.stringPack !== pack.stringPack || owner.emptyLiteral !== pack.emptyLiteral)
    fail("foreign or forged resource owner");
  const empty = requireNativeStringLiteral(tx, owner.stringPack, "", "wtf16");
  if (empty.kind !== "global" || empty.global !== owner.emptyLiteral) fail("substituted UTF-16 empty literal");
  if (tx.state !== "reserving") {
    for (const token of [...pack.stringPack.types, pack.emptyLiteral, pack.worklist, pack.copyTree, pack.flatten])
      tx.physicalIndex(token);
    if (pack.utf8Decoder) tx.physicalIndex(pack.utf8Decoder);
  }
  return pack;
}

export function reserveNativeStringFlattenResources(
  tx: PhysicalModuleReservations,
  key: string,
  stringPack: NativeStringLiteralReservations,
): NativeStringFlattenReservations {
  if (!key || tx.state !== "reserving") fail("invalid reservation phase/key");
  const empty = requireNativeStringLiteral(tx, stringPack, "", "wtf16");
  if (empty.kind !== "global") fail("UTF-16 empty literal must be a global");
  const layout = stringPack.layout;
  const anyRef = { kind: "ref", typeIdx: layout.anyStrTypeIdx } as const;
  const flatRef = { kind: "ref", typeIdx: layout.nativeStrTypeIdx } as const;
  const worklist = tx.reserveType(`${key}:worklist`, {
    kind: "array",
    name: `__arr_ref_${layout.anyStrTypeIdx}`,
    element: { kind: "ref_null", typeIdx: layout.anyStrTypeIdx },
    mutable: true,
  });
  const copyTree = tx.reserveFunction(`${key}:copy-tree`, "__str_copy_tree", {
    params: [anyRef, { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx }, { kind: "i32" }],
    results: [{ kind: "i32" }],
  });
  const utf8Decoder =
    layout.utf8StrTypeIdx >= 0
      ? tx.reserveFunction(`${key}:utf8-decoder`, "__str_utf8_to_flat", {
          params: [{ kind: "ref", typeIdx: layout.utf8StrTypeIdx }],
          results: [flatRef],
        })
      : null;
  const flatten = tx.reserveFunction(`${key}:flatten`, "__str_flatten", { params: [anyRef], results: [flatRef] });
  const pack = Object.freeze({ stringPack, worklist, copyTree, utf8Decoder, flatten, emptyLiteral: empty.global });
  owners.set(pack, { tx, stringPack, emptyLiteral: empty.global, filled: false });
  return pack;
}

export function fillNativeStringFlattenResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringFlattenReservations,
): void {
  requireNativeStringFlattenReservations(tx, pack);
  const owner = owners.get(pack)!;
  if (owner.filled) fail("duplicate fill");
  requireCompletedNativeStringLiterals(tx, owner.stringPack);
  const layout = pack.stringPack.layout;
  const copy = buildStringCopyTreeDefinition(layout, pack.worklist.typeIndex);
  const decoder = pack.utf8Decoder ? buildStringUtf8ToFlatDefinition(layout) : null;
  const flat = buildStringFlattenDefinition(layout, {
    copyTree: pack.copyTree.handle,
    emptyLiteralGlobalIndex: tx.physicalIndex(pack.emptyLiteral),
    utf8Decoder: pack.utf8Decoder ? { kind: "present", handle: pack.utf8Decoder.handle } : { kind: "absent" },
  });
  tx.fillFunction(pack.copyTree, copy);
  if (pack.utf8Decoder && decoder) tx.fillFunction(pack.utf8Decoder, decoder);
  tx.fillFunction(pack.flatten, flat);
  owner.filled = true;
}

export function requireCompletedNativeStringFlatten(
  tx: PhysicalModuleReservations,
  pack: NativeStringFlattenReservations,
  expectedStringPack: NativeStringLiteralReservations,
): NativeStringFlattenReservations {
  requireNativeStringFlattenReservations(tx, pack);
  const owner = owners.get(pack)!;
  if (owner.stringPack !== expectedStringPack) fail("foreign string dependency");
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeStringLiterals(tx, owner.stringPack);
  return pack;
}
