// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  buildStringExoticIndexDefinition,
  buildStringVirtualOwnDescriptorDefinition,
  buildStringExoticOwnDescriptorDefinition,
} from "../../../runtime/wasmgc/values/string-exotic-bodies.js";
import {
  requireNativePrimitiveWrapperLayouts,
  type NativePrimitiveWrapperLayoutDependencies,
  type NativePrimitiveWrapperLayoutReservations,
} from "./native-primitive-wrapper-layouts.js";
import {
  requireNativeObjectLookupReservations,
  requireCompletedNativeObjectLookup,
  type NativeObjectLookupDependencies,
  type NativeObjectLookupReservations,
} from "./native-object-access.js";
import { nativeStringLiteralReservationInventory, nativeStringTypeKeys } from "./native-string-literals.js";
import { requireCompletedNativeStringFlatten } from "./native-string-flatten.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeStringOwnDescriptorDependencies {
  readonly layouts: NativePrimitiveWrapperLayoutReservations;
  readonly layoutPlan: NativeResourceRecipe;
  readonly layoutDependencies: NativePrimitiveWrapperLayoutDependencies;
  readonly lookup: NativeObjectLookupReservations;
  readonly lookupDependencies: NativeObjectLookupDependencies;
}
export interface NativeStringOwnDescriptorReservations {
  readonly arrayIndex: FunctionReservation;
  readonly virtualOwn: FunctionReservation;
  readonly findOwn: FunctionReservation;
  /** Does not grant StringCreate, mutation, enumeration or realm/provider completion. */
  readonly completionScope: "string-exotic-own-descriptors";
}
const dependencyKeys = ["layouts", "layoutPlan", "layoutDependencies", "lookup", "lookupDependencies"] as const;
const roles = ["array-index", "virtual-own", "find-own"] as const;
function fail(detail: string): never {
  throw Error("native String own descriptor: " + detail);
}
function capture(d: NativeStringOwnDescriptorDependencies): NativeStringOwnDescriptorDependencies {
  if (!d || typeof d !== "object" || Array.isArray(d)) fail("data dependencies required");
  const fields = Object.getOwnPropertyDescriptors(d);
  if (Reflect.ownKeys(fields).some((key) => !dependencyKeys.includes(key as (typeof dependencyKeys)[number])))
    fail("unknown dependency");
  return Object.freeze(
    Object.fromEntries(
      dependencyKeys.map((key) => {
        const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (!field || !Object.hasOwn(field, "value")) fail("missing/non-data dependency " + key);
        return [key, field.value];
      }),
    ),
  ) as unknown as NativeStringOwnDescriptorDependencies;
}
function prerequisites(tx: PhysicalModuleReservations, d: NativeStringOwnDescriptorDependencies) {
  requireNativePrimitiveWrapperLayouts(tx, d.layouts, d.layoutPlan, d.layoutDependencies);
  requireNativeObjectLookupReservations(tx, d.lookup, d.lookupDependencies);
  const w = d.layoutDependencies,
    l = d.lookupDependencies;
  if (w.objects !== l.layouts || w.objectPlan !== l.layoutPlan || w.strings !== l.strings || w.symbols !== l.symbols)
    fail("different object, String or Symbol owner");
  if (l.flatten.stringPack !== w.strings) fail("different flatten owner");
  const inventory = nativeStringLiteralReservationInventory(tx, w.strings);
  const keys = nativeStringTypeKeys(inventory.typePack.key);
  const type = (key: string) => {
    const token = inventory.typePack.types.find((row) => row.key === key);
    if (!token) fail("missing issued String type " + key);
    return token;
  };
  return { any: type(keys.any), flat: type(keys.flat), data: type(keys.data), objects: w.objects };
}
export function declareNativeStringOwnDescriptorResources(
  key: string,
  types: { readonly object: string; readonly propEntry: string },
): NativeResourceRecipe {
  if (
    typeof key !== "string" ||
    !key ||
    typeof types.object !== "string" ||
    !types.object ||
    typeof types.propEntry !== "string" ||
    !types.propEntry ||
    types.object === types.propEntry
  )
    fail("invalid declaration keys");
  const ext = { kind: "externref" } as const;
  const declarations = roles.map((role) => ({
    key: key + ":" + role,
    role: ["string-exotic-own-descriptors", role],
    space: "function" as const,
    name: "__string_exotic_" + role.replaceAll("-", "_"),
    signature:
      role === "array-index"
        ? { params: [ext], results: [{ kind: "i64" } as const] }
        : {
            params: [{ kind: "ref" as const, typeKey: types.object }, ext],
            results: [{ kind: "ref_null" as const, typeKey: types.propEntry }],
          },
  }));
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly dependencies: NativeStringOwnDescriptorDependencies;
  readonly sourceDependencies: NativeStringOwnDescriptorDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly functions: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeStringOwnDescriptorReservations, Owner>();
function current(tx: PhysicalModuleReservations, pack: NativeStringOwnDescriptorReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("unissued, copied or foreign owner");
  const fields = capture(owner.sourceDependencies);
  if (dependencyKeys.some((key) => fields[key] !== owner.dependencies[key])) fail("substituted dependency");
  const p = prerequisites(tx, owner.dependencies);
  const plan = declareNativeStringOwnDescriptorResources(owner.key, {
    object: p.objects.object.key,
    propEntry: p.objects.propEntry.key,
  });
  const supplied = preflightNativeResourceRecipe(owner.sourcePlan, [p.objects.object.key, p.objects.propEntry.key]);
  if (
    preparedIrDataMismatch(plan, owner.plan) !== undefined ||
    preparedIrDataMismatch(supplied, owner.plan) !== undefined
  )
    fail("changed declaration plan");
  if (
    pack.arrayIndex !== owner.functions[0] ||
    pack.virtualOwn !== owner.functions[1] ||
    pack.findOwn !== owner.functions[2] ||
    pack.completionScope !== "string-exotic-own-descriptors"
  )
    fail("substituted reservation/scope");
  if (tx.state !== "reserving") owner.functions.forEach((token) => tx.physicalIndex(token));
  return owner;
}
export function reserveNativeStringOwnDescriptorResources(
  tx: PhysicalModuleReservations,
  key: string,
  sourcePlan: NativeResourceRecipe,
  sourceDependencies: NativeStringOwnDescriptorDependencies,
): NativeStringOwnDescriptorReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const dependencies = capture(sourceDependencies),
    p = prerequisites(tx, dependencies);
  const plan = declareNativeStringOwnDescriptorResources(key, {
    object: p.objects.object.key,
    propEntry: p.objects.propEntry.key,
  });
  const supplied = preflightNativeResourceRecipe(sourcePlan, [p.objects.object.key, p.objects.propEntry.key]);
  if (preparedIrDataMismatch(plan, supplied) !== undefined) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(
    tx,
    plan,
    new Map([p.objects.object, p.objects.propEntry].map((token) => [token.key, token])),
  );
  const functions = roles.map((role) => requireNativeDeclaredReservation(records, key + ":" + role, "function"));
  const pack = Object.freeze({
    arrayIndex: functions[0]!,
    virtualOwn: functions[1]!,
    findOwn: functions[2]!,
    completionScope: "string-exotic-own-descriptors" as const,
  });
  owners.set(pack, { tx, key, dependencies, sourceDependencies, sourcePlan, plan, functions, filled: false });
  return pack;
}
export function requireNativeStringOwnDescriptorReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringOwnDescriptorReservations,
  expectedDependencies: NativeStringOwnDescriptorDependencies,
): NativeStringOwnDescriptorReservations {
  if (current(tx, pack).sourceDependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}
function completedDependencies(tx: PhysicalModuleReservations, d: NativeStringOwnDescriptorDependencies): void {
  requireCompletedNativeObjectLookup(tx, d.lookup, d.lookupDependencies);
  requireCompletedNativeStringFlatten(tx, d.lookupDependencies.flatten, d.layoutDependencies.strings);
}
export function fillNativeStringOwnDescriptorResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringOwnDescriptorReservations,
): void {
  const owner = current(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  completedDependencies(tx, d);
  const p = prerequisites(tx, d);
  const strings = {
    anyStrTypeIdx: p.any.typeIndex,
    nativeStrTypeIdx: p.flat.typeIndex,
    nativeStrDataTypeIdx: p.data.typeIndex,
    flattenIdx: d.lookupDependencies.flatten.flatten.handle,
  };
  tx.fillFunction(pack.arrayIndex, buildStringExoticIndexDefinition(strings));
  tx.fillFunction(
    pack.virtualOwn,
    buildStringVirtualOwnDescriptorDefinition({
      ...strings,
      objectTypeIdx: p.objects.object.typeIndex,
      stringObjectTypeIdx: d.layouts.types.String.typeIndex,
      propEntryTypeIdx: p.objects.propEntry.typeIndex,
      indexIdx: pack.arrayIndex.handle,
    }),
  );
  tx.fillFunction(
    pack.findOwn,
    buildStringExoticOwnDescriptorDefinition({
      propEntryTypeIdx: p.objects.propEntry.typeIndex,
      ordinaryFindIdx: d.lookup.findOwn.handle,
      virtualOwnIdx: pack.virtualOwn.handle,
    }),
  );
  owner.filled = true;
}
export function requireCompletedNativeStringOwnDescriptors(
  tx: PhysicalModuleReservations,
  pack: NativeStringOwnDescriptorReservations,
  expectedDependencies: NativeStringOwnDescriptorDependencies,
): NativeStringOwnDescriptorReservations {
  requireNativeStringOwnDescriptorReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  completedDependencies(tx, owner.dependencies);
  owner.functions.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}
