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
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  buildStringCopyTreeDefinition,
  buildStringFlattenDefinition,
} from "../../../runtime/wasmgc/values/string-flatten-bodies.js";
import { buildStringUtf8ToFlatDefinition } from "../../../runtime/wasmgc/values/string-utf8-decode-bodies.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export function declareNativeStringFlattenResources(
  key: string,
  stringKey: string,
  utf8Storage: boolean,
): NativeResourceRecipe {
  const keys = nativeStringTypeKeys(stringKey);
  const ref = (typeKey: string) => ({ kind: "ref" as const, typeKey });
  const declarations: NativeStringValueDeclaration[] = [
    {
      key: `${key}:worklist`,
      role: ["flatten", "worklist"],
      space: "type",
      shape: {
        kind: "array",
        name: { kind: "array-ref-index", typeKey: keys.any },
        element: { kind: "ref_null", typeKey: keys.any },
        mutable: true,
      },
    },
    {
      key: `${key}:copy-tree`,
      role: ["flatten", "copy-tree"],
      space: "function",
      name: "__str_copy_tree",
      signature: {
        params: [ref(keys.any), ref(keys.data), { kind: "i32" }],
        results: [{ kind: "i32" }],
      },
    },
  ];
  if (utf8Storage)
    declarations.push({
      key: `${key}:utf8-decoder`,
      role: ["flatten", "utf8-decoder"],
      space: "function",
      name: "__str_utf8_to_flat",
      signature: { params: [ref(keys.utf8)], results: [ref(keys.flat)] },
    });
  declarations.push({
    key: `${key}:flatten`,
    role: ["flatten", "flatten"],
    space: "function",
    name: "__str_flatten",
    signature: { params: [ref(keys.any)], results: [ref(keys.flat)] },
  });
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}

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
  const { typePack } = nativeStringLiteralReservationInventory(tx, stringPack);
  const recipe = declareNativeStringFlattenResources(key, typePack.key, typePack.utf8Storage);
  const records = executeNativeResourceRecipe(tx, recipe, new Map(typePack.types.map((token) => [token.key, token])));
  const worklist = requireNativeDeclaredReservation(records, `${key}:worklist`, "type");
  const copyTree = requireNativeDeclaredReservation(records, `${key}:copy-tree`, "function");
  const utf8Decoder = typePack.utf8Storage
    ? requireNativeDeclaredReservation(records, `${key}:utf8-decoder`, "function")
    : null;
  const flatten = requireNativeDeclaredReservation(records, `${key}:flatten`, "function");
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
  const copy = buildStringCopyTreeDefinition(
    layout,
    pack.worklist.typeIndex,
    pack.utf8Decoder ? { kind: "present", handle: pack.utf8Decoder.handle } : { kind: "absent" },
  );
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
