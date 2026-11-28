// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1) What the kernel seeds for the intrinsic families a realm holds (`heldCatalogRows`): each member's own
 * properties beyond `length` and `name` (strings, (#7350 B3a) numbers, realm references), and the family's ordinary
 * objects (its prototypes), read from the catalog so the kernel writes no row of its own.
 */
import type { NativeRealmIntrinsic } from "../../../runtime/contracts/native-realm-catalog.js";
import type { NativeBuiltinObject, NativeBuiltinProperty } from "../resources/native-builtin-function-requests.js";

const SEEDED_BY_THE_KERNEL = new Set(["length", "name"]);

/**
 * A held row's own properties beyond `length` and `name`, as the kernel defines them (catalog order). `entryOf` names
 * the realm's entry or object for a catalog id, or `undefined` where the realm does not hold that intrinsic: a property
 * naming one is not seeded, and every read that could reach it refuses or aborts at its site
 * (`BUILTIN_REACHABLE_KEYS`). (#7489) Where `accessors` (the program can reach one, `restrictedFunctionAccessors`) an
 * accessor is seeded with its realm getter and setter (%Function.prototype%'s `caller` and `arguments`, both
 * %ThrowTypeError%).
 */
export function familyProperties(
  row: NativeRealmIntrinsic,
  entryOf: (id: string) => string | undefined,
  accessors: boolean,
): NativeBuiltinProperty[] {
  return row.properties.flatMap((property): NativeBuiltinProperty[] => {
    if (property.key.kind !== "string" || (row.callable && SEEDED_BY_THE_KERNEL.has(property.key.value))) return [];
    const seeded = (value: NativeBuiltinProperty["value"], writable: boolean): NativeBuiltinProperty[] => [
      { key: property.key.value, value, writable, configurable: property.configurable },
    ];
    if (property.kind === "accessor") {
      const [get, set] = [entryOf(property.get), entryOf(property.set)];
      return !accessors || get === undefined || set === undefined ? [] : seeded({ kind: "accessor", get, set }, false);
    }
    if (property.value.kind !== "intrinsic") return seeded(property.value, property.writable);
    const id = entryOf(property.value.id);
    return id === undefined ? [] : seeded({ kind: "intrinsic", id }, property.writable);
  });
}

/**
 * The held families' ordinary objects, each after the object it links to (catalog order), as the kernel's requirement
 * field: none where the realm holds no family, so such a realm's requirements are what they were.
 */
export function familyObjects(
  heldRows: readonly NativeRealmIntrinsic[],
  entryOf: (id: string) => string | undefined,
): { readonly objects?: NativeBuiltinObject[] } {
  const objects = heldRows
    .filter((row) => row.heldWith !== undefined && row.callable === undefined)
    .map((row) => ({
      id: row.id,
      prototype: row.prototype === "%Object.prototype%" ? "object-prototype" : row.prototype!,
      // A family's ordinary objects hold no accessor in the catalog.
      properties: familyProperties(row, entryOf, false),
      ...(row.identityOnly ? { identityOnly: true as const } : {}),
    }));
  return objects.length === 0 ? {} : { objects };
}
