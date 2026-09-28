// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createObjectPropertyEntryDeclaration,
  createObjectPropertyMapDeclaration,
  createOpenObjectDeclaration,
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
}
export interface NativeObjectLayoutDeclarationPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly types: { readonly propEntry: string; readonly propMap: string; readonly object: string };
}
export interface NativeObjectLayoutReservations {
  readonly propEntry: TypeReservation;
  readonly propMap: TypeReservation;
  readonly object: TypeReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeObjectLayoutRequirements;
  readonly plan: NativeObjectLayoutDeclarationPlan;
  readonly sourcePlan: NativeObjectLayoutDeclarationPlan;
  readonly tokens: readonly TypeReservation[];
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
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !descriptor.value)
    fail("missing or non-data resource key");
  const key: string = descriptor.value;
  const types = { propEntry: key + ":entry", propMap: key + ":map", object: key + ":object" };
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
      shape: createOpenObjectDeclaration(types.object, types.propMap),
    },
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
): NativeObjectLayoutReservations {
  const plan = preflightNativeResourceRecipe(expectedPlan);
  same(declareNativeObjectLayouts(requirements), plan, "substituted declaration plan");
  const retainedPlan = freezeNativeResourceRecipe(plan);
  const records = executeNativeResourceRecipe(tx, retainedPlan);
  const pack = Object.freeze({
    propEntry: requireNativeDeclaredReservation(records, retainedPlan.types.propEntry, "type"),
    propMap: requireNativeDeclaredReservation(records, retainedPlan.types.propMap, "type"),
    object: requireNativeDeclaredReservation(records, retainedPlan.types.object, "type"),
  });
  owners.set(pack, {
    tx,
    requirements,
    plan: retainedPlan,
    sourcePlan: expectedPlan,
    tokens: Object.freeze([pack.propEntry, pack.propMap, pack.object]),
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
  same(preflightNativeResourceRecipe(expectedPlan), owner.plan, "changed retained declaration plan");
  same(declareNativeObjectLayouts(owner.requirements), owner.plan, "stale layout requirements");
  const current = [pack.propEntry, pack.propMap, pack.object];
  if (owner.tokens.some((token, i) => current[i] !== token)) fail("substituted layout token");
  const types = new Map(owner.tokens.map((token) => [token.key, token]));
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
