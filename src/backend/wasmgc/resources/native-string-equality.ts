// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { buildStringEqualityDefinition } from "../../../runtime/wasmgc/values/string-equality-body.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";
import {
  nativeStringTypeKeys,
  nativeStringLiteralReservationInventory,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  requireNativeStringFlattenReservations,
  requireCompletedNativeStringFlatten,
  type NativeStringFlattenReservations,
} from "./native-string-flatten.js";

export function declareNativeStringEqualityResources(key: string, stringKey: string): NativeResourceRecipe {
  const any = nativeStringTypeKeys(stringKey).any;
  return freezeNativeResourceRecipe({
    declarations: [
      {
        key: `${key}:equals`,
        role: ["string-equality", "equals"],
        space: "function",
        name: "__str_equals",
        signature: {
          params: [
            { kind: "ref", typeKey: any },
            { kind: "ref", typeKey: any },
          ],
          results: [{ kind: "i32" }],
        },
      },
    ],
    reservationSteps: [{ phase: "resources", kind: "reserve", resourceKey: `${key}:equals` }],
  });
}

export interface NativeStringEqualityReservations {
  readonly stringPack: NativeStringLiteralReservations;
  readonly flattenPack: NativeStringFlattenReservations;
  readonly equals: FunctionReservation;
  readonly lazy: boolean;
}
interface Owner extends NativeStringEqualityReservations {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly recipe: NativeResourceRecipe;
  filled: boolean;
}
const owners = new WeakMap<NativeStringEqualityReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native string equality: " + detail);
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeStringEqualityReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or forged owner");
  if (
    pack.stringPack !== owner.stringPack ||
    pack.flattenPack !== owner.flattenPack ||
    pack.equals !== owner.equals ||
    pack.lazy !== owner.lazy
  )
    fail("substituted resources or lazy plan");
  requireNativeStringFlattenReservations(tx, owner.flattenPack);
  if (owner.flattenPack.stringPack !== owner.stringPack) fail("foreign flatten string pack");
  if (tx.state !== "reserving") tx.physicalIndex(owner.equals);
  return owner;
}

export function reserveNativeStringEqualityResources(
  tx: PhysicalModuleReservations,
  key: string,
  flattenPack: NativeStringFlattenReservations,
  lazy: boolean,
): NativeStringEqualityReservations {
  if (tx.state !== "reserving" || !key || typeof lazy !== "boolean") fail("invalid reservation phase/key/lazy plan");
  requireNativeStringFlattenReservations(tx, flattenPack);
  const stringPack = flattenPack.stringPack;
  const { typePack } = nativeStringLiteralReservationInventory(tx, stringPack);
  const recipe = declareNativeStringEqualityResources(key, typePack.key);
  const records = executeNativeResourceRecipe(tx, recipe, new Map(typePack.types.map((token) => [token.key, token])));
  const equals = requireNativeDeclaredReservation(records, `${key}:equals`, "function");
  const pack = Object.freeze({ stringPack, flattenPack, equals, lazy });
  owners.set(pack, { ...pack, tx, key, recipe, filled: false });
  return pack;
}

export function fillNativeStringEqualityResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringEqualityReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate canonical fill");
  requireCompletedNativeStringFlatten(tx, owner.flattenPack, owner.stringPack);
  tx.assertCompletedReservation(owner.flattenPack.flatten);
  tx.fillFunction(
    owner.equals,
    buildStringEqualityDefinition(owner.stringPack.layout, owner.flattenPack.flatten.handle, owner.lazy),
  );
  owner.filled = true;
}

export function requireCompletedNativeStringEquality(
  tx: PhysicalModuleReservations,
  pack: NativeStringEqualityReservations,
  expectedStrings: NativeStringLiteralReservations,
): NativeStringEqualityReservations {
  const owner = requireOwner(tx, pack);
  if (owner.stringPack !== expectedStrings) fail("foreign expected string pack");
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeStringFlatten(tx, owner.flattenPack, expectedStrings);
  tx.assertCompletedReservation(owner.flattenPack.flatten);
  tx.assertCompletedReservation(owner.equals);
  return pack;
}

/** Authenticate issued dependencies before freeze; no signature/name inference. */
export function requireNativeStringEqualityReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringEqualityReservations,
  expectedStrings: NativeStringLiteralReservations,
): NativeStringEqualityReservations {
  const owner = requireOwner(tx, pack);
  if (owner.stringPack !== expectedStrings) fail("foreign expected string pack");
  return pack;
}

/** Actual issued reservation inventory, not an attestation of canonical fill. */
export function nativeStringEqualityReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeStringEqualityReservations,
): Readonly<{ key: string; recipe: NativeResourceRecipe; equals: FunctionReservation }> {
  const owner = requireOwner(tx, pack);
  return Object.freeze({ key: owner.key, recipe: owner.recipe, equals: owner.equals });
}
