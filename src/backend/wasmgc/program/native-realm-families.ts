// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1) What the kernel seeds for the intrinsic families a realm holds (`heldCatalogRows`): each member's own
 * properties beyond `length` and `name`, and the family's ordinary objects (its prototypes), read from the catalog so
 * the kernel writes no row of its own.
 */
import type { NativeRealmIntrinsic } from "../../../runtime/contracts/native-realm-catalog.js";
import { heldCatalogRows, type NativeRealmDescription } from "../../../ir/program/native-realm-requirements.js";
import type { NativeBuiltinObject, NativeBuiltinProperty } from "../resources/native-builtin-function-requests.js";

const SEEDED_BY_THE_KERNEL = new Set(["length", "name"]);

/** A family row's data properties, as the kernel defines them (catalog order). */
export function familyProperties(row: NativeRealmIntrinsic): NativeBuiltinProperty[] {
  return row.properties.flatMap((property) => {
    if (property.key.kind !== "string" || (row.callable && SEEDED_BY_THE_KERNEL.has(property.key.value))) return [];
    if (property.kind !== "data" || property.value.kind === "number")
      throw Error(`native realm families: ${row.id}.${property.key.value} is no string or intrinsic data property`);
    return [
      {
        key: property.key.value,
        value:
          property.value.kind === "string"
            ? { kind: "string", value: property.value.value }
            : { kind: "intrinsic", id: property.value.id },
        writable: property.writable,
        configurable: property.configurable,
      },
    ];
  });
}

/** The held families' ordinary objects, each after the object it links to (catalog order). */
export function familyObjects(description: NativeRealmDescription): NativeBuiltinObject[] {
  return heldCatalogRows(description)
    .filter((row) => row.heldWith !== undefined && row.callable === undefined)
    .map((row) => ({
      id: row.id,
      prototype: row.prototype === "%Object.prototype%" ? "object-prototype" : row.prototype!,
      properties: familyProperties(row),
    }));
}
