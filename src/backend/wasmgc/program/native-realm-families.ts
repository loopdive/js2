// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1) What the kernel seeds for the intrinsic families a realm holds (`heldCatalogRows`): each member's own
 * properties beyond `length` and `name`, and the family's ordinary objects (its prototypes), read from the catalog so
 * the kernel writes no row of its own. (#7354 W2) A property whose value is a member the realm does not hold
 * (`String.fromCharCode`) is not seeded: the IR refuses its key by name (`builtin-prototype-keys.ts`).
 */
import type { NativeRealmIntrinsic } from "../../../runtime/contracts/native-realm-catalog.js";
import type { NativeBuiltinObject, NativeBuiltinProperty } from "../resources/native-builtin-function-requests.js";

const SEEDED_BY_THE_KERNEL = new Set(["length", "name"]);

/** A family row's data properties whose values the realm holds (`holds`), as the kernel defines them (catalog order). */
export function familyProperties(row: NativeRealmIntrinsic, holds: (id: string) => boolean): NativeBuiltinProperty[] {
  return row.properties.flatMap((property) => {
    if (property.key.kind !== "string" || (row.callable && SEEDED_BY_THE_KERNEL.has(property.key.value))) return [];
    if (property.kind !== "data")
      throw Error(`native realm families: ${row.id}.${property.key.value} is no data property`);
    if (property.value.kind === "intrinsic" && !holds(property.value.id)) return [];
    return [
      {
        key: property.key.value,
        value: property.value,
        writable: property.writable,
        configurable: property.configurable,
      },
    ];
  });
}

/**
 * (#7557) Whether the catalog gives `row` a property the kernel does not seed from `seeded` (Object.prototype's
 * `toString`, Function.prototype's `caller` or @@hasInstance, String.prototype's `charAt`, an unheld static): an own
 * miss on such an object may be that property, which the realm cannot answer as absent.
 */
export function lacksCatalogProperty(row: NativeRealmIntrinsic, seeded: readonly NativeBuiltinProperty[]): boolean {
  const keys = new Set(seeded.map((property) => property.key));
  return row.properties.some(
    ({ key }) =>
      key.kind !== "string" || !(keys.has(key.value) || (row.callable && SEEDED_BY_THE_KERNEL.has(key.value))),
  );
}

/**
 * (#7557) %Function.prototype%'s own data properties the realm holds (its held methods, `constructor` where it holds
 * %Function%); its `caller` / `arguments` accessors are the IR's refusal (`FUNCTION_PROTOTYPE_ACCESSOR_KEYS`).
 */
export const functionPrototypeProperties = (
  row: NativeRealmIntrinsic,
  holds: (id: string) => boolean,
): NativeBuiltinProperty[] =>
  familyProperties({ ...row, properties: row.properties.filter((property) => property.kind === "data") }, holds);

/**
 * The held families' ordinary objects, each after the object it links to (catalog order), as the kernel's requirement
 * field: none where the realm holds no family, so such a realm's requirements are what they were.
 */
export function familyObjects(
  heldRows: readonly NativeRealmIntrinsic[],
  holds: (id: string) => boolean,
): { readonly objects?: NativeBuiltinObject[] } {
  const objects = heldRows
    .filter((row) => row.heldWith !== undefined && row.callable === undefined)
    .map((row) => ({
      id: row.id,
      prototype: row.prototype === "%Object.prototype%" ? "object-prototype" : row.prototype!,
      ...(row.primitive ? { primitive: row.primitive } : {}),
      ...(row.array ? { array: row.array } : {}),
      properties: familyProperties(row, holds),
    }));
  return objects.length === 0 ? {} : { objects };
}
