// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createObjectPropertyEntryDeclaration,
  createObjectPropertyMapDeclaration,
  createOpenObjectDeclaration,
  createExtensibleOpenObjectDeclaration,
  createArrayObjectDeclaration,
} from "../../../runtime/wasmgc/values/object-layouts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeObjectLayoutRequirements {
  readonly key: string;
  /** Explicit opt-in; absent preserves the final ordinary layout. */
  readonly extensible?: true;
  /**
   * (#7352 arrays) The type key of the element vector an Array object holds. Its presence declares the `$Array`
   * subtype, which needs the extensible root.
   */
  readonly arrayElements?: string;
}
export interface NativeObjectLayoutDeclarationPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly types: {
    readonly propEntry: string;
    readonly propMap: string;
    readonly object: string;
    readonly array?: string;
  };
}
export interface NativeObjectLayoutReservations {
  readonly propEntry: TypeReservation;
  readonly propMap: TypeReservation;
  readonly object: TypeReservation;
  readonly array?: TypeReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeObjectLayoutRequirements;
  readonly plan: NativeObjectLayoutDeclarationPlan;
  readonly sourcePlan: NativeObjectLayoutDeclarationPlan;
  readonly tokens: readonly TypeReservation[];
  /** The element vector type an `$Array` declaration references; absent without arrays. */
  readonly prerequisites: ReadonlyMap<string, TypeReservation>;
}
const owners = new WeakMap<NativeObjectLayoutReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native object layouts: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

export function declareNativeObjectLayouts(
  requirements: NativeObjectLayoutRequirements,
): NativeObjectLayoutDeclarationPlan {
  const descriptor = Object.getOwnPropertyDescriptor(requirements, "key");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string" || !descriptor.value)
    fail("missing or non-data resource key");
  const extensible = Object.getOwnPropertyDescriptor(requirements, "extensible");
  if (extensible && (!Object.hasOwn(extensible, "value") || extensible.value !== true))
    fail("extensible layout requires an explicit true data field");
  const key: string = descriptor.value;
  const elements = Object.getOwnPropertyDescriptor(requirements, "arrayElements");
  if (elements && (!Object.hasOwn(elements, "value") || typeof elements.value !== "string" || !elements.value))
    fail("array layout requires an element vector type key");
  if (elements && !extensible) fail("array layout requires the extensible root");
  const types = {
    propEntry: key + ":entry",
    propMap: key + ":map",
    object: key + ":object",
    ...(elements ? { array: key + ":array" } : {}),
  };
  const declarations = [
    {
      key: types.propEntry,
      role: ["object", "entry"],
      space: "type" as const,
      shape: createObjectPropertyEntryDeclaration(),
    },
    {
      key: types.propMap,
      role: ["object", "map"],
      space: "type" as const,
      shape: createObjectPropertyMapDeclaration(types.propEntry),
    },
    {
      key: types.object,
      role: ["object", "carrier"],
      space: "type" as const,
      shape: extensible
        ? createExtensibleOpenObjectDeclaration(types.object, types.propMap)
        : createOpenObjectDeclaration(types.object, types.propMap),
    },
    ...(types.array
      ? [
          {
            key: types.array,
            role: ["object", "array"],
            space: "type" as const,
            shape: createArrayObjectDeclaration(types.object, types.propMap, elements!.value as string),
          },
        ]
      : []),
  ];
  return freezeNativeResourceRecipe({
    key,
    types,
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}

export function reserveNativeObjectLayouts(
  tx: PhysicalModuleReservations,
  requirements: NativeObjectLayoutRequirements,
  expectedPlan: NativeObjectLayoutDeclarationPlan,
  arrayElements?: TypeReservation,
): NativeObjectLayoutReservations {
  if (arrayElements?.key !== requirements.arrayElements) fail("array element vector differs from the requirements");
  const prerequisites = new Map(arrayElements ? [[arrayElements.key, arrayElements]] : []);
  const plan = preflightNativeResourceRecipe(expectedPlan, [...prerequisites.keys()]);
  same(declareNativeObjectLayouts(requirements), plan, "substituted declaration plan");
  const retainedPlan = freezeNativeResourceRecipe(plan);
  const records = executeNativeResourceRecipe(tx, retainedPlan, prerequisites);
  const array = retainedPlan.types.array;
  const pack = Object.freeze({
    propEntry: requireNativeDeclaredReservation(records, retainedPlan.types.propEntry, "type"),
    propMap: requireNativeDeclaredReservation(records, retainedPlan.types.propMap, "type"),
    object: requireNativeDeclaredReservation(records, retainedPlan.types.object, "type"),
    ...(array ? { array: requireNativeDeclaredReservation(records, array, "type") } : {}),
  });
  owners.set(pack, {
    tx,
    requirements,
    plan: retainedPlan,
    sourcePlan: expectedPlan,
    tokens: Object.freeze([pack.propEntry, pack.propMap, pack.object, ...(pack.array ? [pack.array] : [])]),
    prerequisites,
  });
  return pack;
}

export function requireNativeObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeObjectLayoutReservations,
  expectedPlan: NativeObjectLayoutDeclarationPlan,
): NativeObjectLayoutReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.sourcePlan !== expectedPlan) fail("foreign or substituted layout owner/plan");
  same(
    preflightNativeResourceRecipe(expectedPlan, [...owner.prerequisites.keys()]),
    owner.plan,
    "changed retained declaration plan",
  );
  same(declareNativeObjectLayouts(owner.requirements), owner.plan, "stale layout requirements");
  const current = [pack.propEntry, pack.propMap, pack.object, ...(pack.array ? [pack.array] : [])];
  if (current.length !== owner.tokens.length || owner.tokens.some((token, i) => current[i] !== token))
    fail("substituted layout token");
  const types = new Map([...owner.prerequisites, ...owner.tokens.map((token) => [token.key, token] as const)]);
  owner.tokens.forEach((token, i) => {
    if (tx.state === "reserving") tx.assertTypeReservation(token);
    else tx.physicalIndex(token);
    compareNativeResourceDeclarationShape(
      tx,
      owner.plan.declarations[i]!,
      { key: token.key, space: "type", definition: token.object },
      types,
    );
  });
  return pack;
}

/** Types are complete at reservation; this attests no object/property executable body. */
export function nativeObjectLayoutReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeObjectLayoutReservations,
  expectedPlan: NativeObjectLayoutDeclarationPlan,
): readonly TypeReservation[] {
  requireNativeObjectLayouts(tx, pack, expectedPlan);
  return owners.get(pack)!.tokens;
}
