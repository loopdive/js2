// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { buildStringIndexKeyDefinition } from "../../../runtime/wasmgc/values/string-index-key-body.js";
import {
  buildStringKeyOrderDefinition,
  buildStringOwnKeysDefinition,
} from "../../../runtime/wasmgc/values/string-own-keys-body.js";
import { nativeStringLiteralReservationInventory, nativeStringTypeKeys } from "./native-string-literals.js";
import {
  requireNativeStringOwnDescriptorReservations,
  requireCompletedNativeStringOwnDescriptors,
  type NativeStringOwnDescriptorReservations,
  type NativeStringOwnDescriptorDependencies,
} from "./native-string-exotic-own-descriptors.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeStringOwnKeysDependencies {
  readonly own: NativeStringOwnDescriptorReservations;
  readonly ownDependencies: NativeStringOwnDescriptorDependencies;
}
export interface NativeStringOwnKeysReservations {
  readonly list: TypeReservation;
  readonly indexKey: FunctionReservation;
  readonly entryBefore: FunctionReservation;
  readonly ownKeys: FunctionReservation;
  /** Internal spec List; does not authenticate a user Array or realm/public provider. */
  readonly completionScope: "string-own-key-list";
}
const roles = ["index-key", "entry-before", "own-keys"] as const;
const dependencyKeys = ["own", "ownDependencies"] as const;
function fail(detail: string): never {
  throw Error("native String own keys: " + detail);
}
function capture(d: NativeStringOwnKeysDependencies): NativeStringOwnKeysDependencies {
  if (!d || typeof d !== "object" || Array.isArray(d)) fail("plain dependencies required");
  const proto = Object.getPrototypeOf(d);
  if (proto !== Object.prototype && proto !== null) fail("plain dependencies required");
  const fields = Object.getOwnPropertyDescriptors(d);
  if (Reflect.ownKeys(fields).some((key) => !dependencyKeys.includes(key as (typeof dependencyKeys)[number])))
    fail("unknown dependency");
  return Object.freeze(
    Object.fromEntries(
      dependencyKeys.map((key) => {
        const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (!field || !Object.hasOwn(field, "value")) fail("missing/non-data " + key);
        return [key, field.value];
      }),
    ),
  ) as unknown as NativeStringOwnKeysDependencies;
}
function prerequisites(tx: PhysicalModuleReservations, d: NativeStringOwnKeysDependencies) {
  requireNativeStringOwnDescriptorReservations(tx, d.own, d.ownDependencies);
  const shared = d.ownDependencies;
  const strings = nativeStringLiteralReservationInventory(tx, shared.layoutDependencies.strings);
  const keys = nativeStringTypeKeys(strings.typePack.key);
  const type = (key: string) => {
    const token = strings.typePack.types.find((row) => row.key === key);
    if (!token) fail("missing issued String type " + key);
    return token;
  };
  return {
    string: shared.layouts.types.String,
    object: shared.layoutDependencies.objects.object,
    propMap: shared.layoutDependencies.objects.propMap,
    propEntry: shared.layoutDependencies.objects.propEntry,
    symbol: shared.lookupDependencies.symbols.types.symbol,
    any: type(keys.any),
    flat: type(keys.flat),
    data: type(keys.data),
  };
}
const listShape = (key: string) => ({
  kind: "array" as const,
  name: "$StringOwnKeyList_" + key,
  element: { kind: "externref" as const },
  mutable: true,
});
function declarationTypes(input: { readonly stringObject: string; readonly propEntry: string }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("plain declaration types required");
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) fail("plain declaration types required");
  const keys = ["stringObject", "propEntry"] as const;
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).some((key) => !keys.includes(key as (typeof keys)[number])))
    fail("unknown declaration type field");
  const text = (key: (typeof keys)[number]) => {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    const value: unknown = field && Object.hasOwn(field, "value") ? field.value : undefined;
    if (typeof value !== "string" || !value) fail("invalid/non-data declaration type " + key);
    return value;
  };
  const stringObject = text("stringObject"),
    propEntry = text("propEntry");
  if (stringObject === propEntry) fail("duplicate declaration type keys");
  return Object.freeze({ stringObject, propEntry });
}

export function declareNativeStringOwnKeysResources(
  key: string,
  types: { readonly stringObject: string; readonly propEntry: string },
): NativeResourceRecipe {
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  const selected = declarationTypes(types);
  const list = key + ":list";
  const declarations: NativeResourceRecipe["declarations"] = [
    { key: list, role: ["string-own-keys", "list"], space: "type", shape: listShape(key) },
    ...roles.map((role) => ({
      key: key + ":" + role,
      role: ["string-own-keys", role],
      space: "function" as const,
      name: "__string_" + role.replaceAll("-", "_"),
      signature:
        role === "index-key"
          ? { params: [{ kind: "i32" as const }], results: [{ kind: "externref" as const }] }
          : role === "entry-before"
            ? {
                params: [
                  { kind: "ref" as const, typeKey: selected.propEntry },
                  { kind: "ref" as const, typeKey: selected.propEntry },
                ],
                results: [{ kind: "i32" as const }],
              }
            : {
                params: [{ kind: "ref" as const, typeKey: selected.stringObject }],
                results: [{ kind: "ref" as const, typeKey: list }],
              },
    })),
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourceDependencies: NativeStringOwnKeysDependencies;
  readonly dependencies: NativeStringOwnKeysDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly list: TypeReservation;
  readonly functions: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeStringOwnKeysReservations, Owner>();
function current(tx: PhysicalModuleReservations, pack: NativeStringOwnKeysReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("unissued, copied or foreign owner");
  const latest = capture(owner.sourceDependencies);
  if (dependencyKeys.some((key) => latest[key] !== owner.dependencies[key])) fail("substituted dependency");
  const p = prerequisites(tx, owner.dependencies);
  const expected = declareNativeStringOwnKeysResources(owner.key, {
    stringObject: p.string.key,
    propEntry: p.propEntry.key,
  });
  const supplied = preflightNativeResourceRecipe(owner.sourcePlan, [p.string.key, p.propEntry.key]);
  if (preparedIrDataMismatch(expected, owner.plan) || preparedIrDataMismatch(supplied, owner.plan))
    fail("changed declaration plan");
  if (
    pack.list !== owner.list ||
    pack.indexKey !== owner.functions[0] ||
    pack.entryBefore !== owner.functions[1] ||
    pack.ownKeys !== owner.functions[2] ||
    pack.completionScope !== "string-own-key-list"
  )
    fail("substituted reservation/scope");
  if (preparedIrDataMismatch(pack.list.object, listShape(owner.key))) fail("changed list type");
  if (tx.state === "reserving") tx.assertTypeReservation(pack.list);
  else {
    tx.physicalIndex(pack.list);
    owner.functions.forEach((token) => tx.physicalIndex(token));
  }
  return owner;
}
export function reserveNativeStringOwnKeysResources(
  tx: PhysicalModuleReservations,
  key: string,
  sourcePlan: NativeResourceRecipe,
  sourceDependencies: NativeStringOwnKeysDependencies,
): NativeStringOwnKeysReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const dependencies = capture(sourceDependencies),
    p = prerequisites(tx, dependencies);
  const plan = declareNativeStringOwnKeysResources(key, { stringObject: p.string.key, propEntry: p.propEntry.key });
  const supplied = preflightNativeResourceRecipe(sourcePlan, [p.string.key, p.propEntry.key]);
  if (preparedIrDataMismatch(plan, supplied)) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(
    tx,
    plan,
    new Map([p.string, p.propEntry].map((token) => [token.key, token])),
  );
  const list = requireNativeDeclaredReservation(records, key + ":list", "type");
  const functions = roles.map((role) => requireNativeDeclaredReservation(records, key + ":" + role, "function"));
  const pack = Object.freeze({
    list,
    indexKey: functions[0]!,
    entryBefore: functions[1]!,
    ownKeys: functions[2]!,
    completionScope: "string-own-key-list" as const,
  });
  owners.set(pack, { tx, key, sourceDependencies, dependencies, sourcePlan, plan, list, functions, filled: false });
  return pack;
}
export function requireNativeStringOwnKeysReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringOwnKeysReservations,
  expectedDependencies: NativeStringOwnKeysDependencies,
): NativeStringOwnKeysReservations {
  if (current(tx, pack).sourceDependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}
export function fillNativeStringOwnKeysResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringOwnKeysReservations,
): void {
  const owner = current(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  requireCompletedNativeStringOwnDescriptors(tx, d.own, d.ownDependencies);
  const p = prerequisites(tx, d);
  const order = {
    propEntryType: p.propEntry.typeIndex,
    symbolType: p.symbol.typeIndex,
    arrayIndex: d.own.arrayIndex.handle,
  };
  tx.fillFunction(pack.indexKey, buildStringIndexKeyDefinition(p.flat.typeIndex, p.data.typeIndex));
  tx.fillFunction(pack.entryBefore, buildStringKeyOrderDefinition(order));
  tx.fillFunction(
    pack.ownKeys,
    buildStringOwnKeysDefinition({
      ...order,
      objectType: p.object.typeIndex,
      stringType: p.string.typeIndex,
      propMapType: p.propMap.typeIndex,
      anyStringType: p.any.typeIndex,
      listType: pack.list.typeIndex,
      indexKey: pack.indexKey.handle,
      entryBefore: pack.entryBefore.handle,
    }),
  );
  owner.filled = true;
}
export function requireCompletedNativeStringOwnKeys(
  tx: PhysicalModuleReservations,
  pack: NativeStringOwnKeysReservations,
  expectedDependencies: NativeStringOwnKeysDependencies,
): NativeStringOwnKeysReservations {
  requireNativeStringOwnKeysReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeStringOwnDescriptors(tx, owner.dependencies.own, owner.dependencies.ownDependencies);
  owner.functions.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}
