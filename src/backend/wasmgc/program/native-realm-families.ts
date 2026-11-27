// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 G1) What the kernel seeds for the intrinsic families a realm holds (`heldCatalogRows`): each member's own
 * properties beyond `length` and `name` (strings, (#7350 B3a) numbers, realm references), and the family's ordinary
 * objects (its prototypes), read from the catalog so the kernel writes no row of its own. (#7574) The realm's root,
 * `%Object.prototype%`, is the kernel's `object-prototype` wherever a row links or refers to it.
 */
import {
  OBJECT_PROTOTYPE_ID,
  type NativeRealmIntrinsic,
  type NativeRealmProperty,
} from "../../../runtime/contracts/native-realm-catalog.js";
import type {
  NativeBuiltinFunctionRequirements,
  NativeBuiltinProperty,
} from "../resources/native-builtin-function-requests.js";

const SEEDED_BY_THE_KERNEL = new Set(["length", "name"]);

/** The kernel's name of the realm object `id`: the root is its `object-prototype`. */
const kernelId = (id: string): string => (id === OBJECT_PROTOTYPE_ID ? "object-prototype" : id);

/** `properties` as the kernel defines them (catalog order), on a row that is callable or not. */
function kernelProperties(
  row: NativeRealmIntrinsic,
  properties: readonly NativeRealmProperty[] = row.properties,
): NativeBuiltinProperty[] {
  return properties.flatMap((property) => {
    if (property.key.kind !== "string" || (row.callable && SEEDED_BY_THE_KERNEL.has(property.key.value))) return [];
    if (property.kind !== "data")
      throw Error(`native realm families: ${row.id}.${property.key.value} is no data property`);
    const { value } = property;
    return [
      {
        key: property.key.value,
        value: value.kind === "intrinsic" ? { kind: "intrinsic", id: kernelId(value.id) } : value,
        writable: property.writable,
        configurable: property.configurable,
      },
    ];
  });
}

/**
 * (#7580) Whether `row`, a function value the realm holds without a family, is the root's own property (P1's
 * methods), which the kernel installs there; any other (`Object`'s statics) is held by its family's property lists.
 */
export const isRootMethod = (heldRows: readonly NativeRealmIntrinsic[], row: NativeRealmIntrinsic): boolean =>
  row.heldWith === undefined &&
  heldRows
    .find(({ id }) => id === OBJECT_PROTOTYPE_ID)!
    .properties.some(
      (property) => property.kind === "data" && property.value.kind === "intrinsic" && property.value.id === row.id,
    );

/** A family row's data properties, as the kernel defines them (catalog order). */
export const familyProperties = (row: NativeRealmIntrinsic): NativeBuiltinProperty[] => kernelProperties(row);

/**
 * The held families' ordinary objects, each after the object it links to (catalog order), and (#7574) the root's
 * properties whose value is a held family member, as the kernel's requirement fields: none where the realm holds no
 * family, so such a realm's requirements are what they were.
 */
export function familyObjects(
  heldRows: readonly NativeRealmIntrinsic[],
): Pick<NativeBuiltinFunctionRequirements, "objects" | "root"> {
  const objects = heldRows
    .filter((row) => row.heldWith !== undefined && row.callable === undefined)
    .map((row) => ({
      id: row.id,
      prototype: kernelId(row.prototype!),
      ...(row.primitiveData === undefined ? {} : { primitiveData: row.primitiveData }),
      ...(row.array ? { array: row.array } : {}),
      properties: familyProperties(row),
    }));
  const members = new Set(heldRows.flatMap((row) => (row.heldWith === undefined ? [] : [row.id])));
  const rootRow = heldRows.find((row) => row.id === OBJECT_PROTOTYPE_ID)!;
  const root = kernelProperties(
    rootRow,
    rootRow.properties.filter(
      (property) => property.kind === "data" && property.value.kind === "intrinsic" && members.has(property.value.id),
    ),
  );
  return { ...(objects.length === 0 ? {} : { objects }), ...(root.length === 0 ? {} : { root }) };
}
