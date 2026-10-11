// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { buildNativePrototypeType } from "../../../runtime/wasmgc/values/prototype-layouts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativePrototypeLayoutRequirements {
  readonly key: string;
}
export interface NativePrototypeLayoutDeclarationPlan extends NativeResourceRecipe {
  readonly key: string;
  readonly types: { readonly prototype: string };
}
export interface NativePrototypeLayoutReservations {
  readonly prototype: TypeReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativePrototypeLayoutRequirements;
  readonly plan: NativePrototypeLayoutDeclarationPlan;
  readonly sourcePlan: NativePrototypeLayoutDeclarationPlan;
  readonly tokens: readonly TypeReservation[];
}
const owners = new WeakMap<NativePrototypeLayoutReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native prototype layouts: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

export function declareNativePrototypeLayouts(
  requirements: NativePrototypeLayoutRequirements,
): NativePrototypeLayoutDeclarationPlan {
  const descriptor = Object.getOwnPropertyDescriptor(requirements, "key");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !descriptor.value)
    fail("missing or non-data resource key");
  const key: string = descriptor.value;
  const types = { prototype: key + ":prototype" };
  const donor = buildNativePrototypeType();
  if (typeof donor.name !== "string") fail("missing prototype type name");
  const fields = donor.fields.map((field) => {
    const kind = field.type.kind;
    if (kind !== "i32" && kind !== "externref") fail("unexpected prototype field representation");
    return { name: field.name, mutable: field.mutable, type: { kind } };
  });
  const declarations = [
    {
      key: types.prototype,
      role: ["prototype", "carrier"],
      space: "type" as const,
      shape: { kind: "struct" as const, name: donor.name, fields },
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

export function reserveNativePrototypeLayouts(
  tx: PhysicalModuleReservations,
  requirements: NativePrototypeLayoutRequirements,
  expectedPlan: NativePrototypeLayoutDeclarationPlan,
): NativePrototypeLayoutReservations {
  const plan = preflightNativeResourceRecipe(expectedPlan);
  same(declareNativePrototypeLayouts(requirements), plan, "substituted declaration plan");
  const retainedPlan = freezeNativeResourceRecipe(plan);
  const records = executeNativeResourceRecipe(tx, retainedPlan);
  const pack = Object.freeze({
    prototype: requireNativeDeclaredReservation(records, retainedPlan.types.prototype, "type"),
  });
  owners.set(pack, {
    tx,
    requirements,
    plan: retainedPlan,
    sourcePlan: expectedPlan,
    tokens: Object.freeze([pack.prototype]),
  });
  return pack;
}

export function requireNativePrototypeLayouts(
  tx: PhysicalModuleReservations,
  pack: NativePrototypeLayoutReservations,
  expectedPlan: NativePrototypeLayoutDeclarationPlan,
  expectedRequirements: NativePrototypeLayoutRequirements,
): NativePrototypeLayoutReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.sourcePlan !== expectedPlan || owner.requirements !== expectedRequirements)
    fail("foreign or substituted layout owner/plan");
  same(preflightNativeResourceRecipe(expectedPlan), owner.plan, "changed retained declaration plan");
  same(declareNativePrototypeLayouts(owner.requirements), owner.plan, "stale layout requirements");
  const current = [pack.prototype];
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

/** Types are complete at reservation; this attests no singleton, constructor, member or executable provider. */
export function nativePrototypeLayoutReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativePrototypeLayoutReservations,
  expectedPlan: NativePrototypeLayoutDeclarationPlan,
  expectedRequirements: NativePrototypeLayoutRequirements,
): readonly TypeReservation[] {
  requireNativePrototypeLayouts(tx, pack, expectedPlan, expectedRequirements);
  return owners.get(pack)!.tokens;
}
