// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  buildStringCreateDefinition,
  checkedStringCreateCapacity,
} from "../../../runtime/wasmgc/values/string-create-body.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import {
  requireNativePrimitiveWrapperLayouts,
  type NativePrimitiveWrapperLayoutReservations,
  type NativePrimitiveWrapperLayoutDependencies,
} from "./native-primitive-wrapper-layouts.js";
import {
  requireNativeObjectStorageReservations,
  requireCompletedNativeObjectStorage,
  type NativeObjectStorageReservations,
  type NativeObjectStorageDependencies,
} from "./native-object-storage.js";
import {
  requireNativeValueReservations,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import {
  requireNativeStringOwnDescriptorReservations,
  requireCompletedNativeStringOwnDescriptors,
  type NativeStringOwnDescriptorReservations,
  type NativeStringOwnDescriptorDependencies,
} from "./native-string-exotic-own-descriptors.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralBinding,
} from "./native-string-literals.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeStringCreateDependencies {
  readonly layouts: NativePrimitiveWrapperLayoutReservations;
  readonly layoutPlan: NativeResourceRecipe;
  readonly layoutDependencies: NativePrimitiveWrapperLayoutDependencies;
  readonly storage: NativeObjectStorageReservations;
  readonly storageDependencies: NativeObjectStorageDependencies;
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
  readonly ownDescriptors: NativeStringOwnDescriptorReservations;
  readonly ownDescriptorDependencies: NativeStringOwnDescriptorDependencies;
}
export interface NativeStringCreatePlan extends NativeResourceRecipe {
  readonly initialCapacity: number;
}
export interface NativeStringCreateReservations {
  readonly create: FunctionReservation;
  /** Explicit prototype construction; canonical realm identity and other exotic methods are separate. */
  readonly completionScope: "string-create-own-length";
}
const dependencyKeys = [
  "layouts",
  "layoutPlan",
  "layoutDependencies",
  "storage",
  "storageDependencies",
  "values",
  "valuePlan",
  "valueDependencies",
  "ownDescriptors",
  "ownDescriptorDependencies",
] as const;
function fail(detail: string): never {
  throw Error("native StringCreate: " + detail);
}
function own(input: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(input, key);
  if (!field || !Object.hasOwn(field, "value")) fail("missing/non-data field " + key);
  return field.value;
}
function capture(input: NativeStringCreateDependencies): NativeStringCreateDependencies {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("data dependencies required");
  if (Reflect.ownKeys(input).some((key) => !dependencyKeys.includes(key as (typeof dependencyKeys)[number])))
    fail("unknown dependency");
  return Object.freeze(
    Object.fromEntries(dependencyKeys.map((key) => [key, own(input, key)])),
  ) as unknown as NativeStringCreateDependencies;
}
function prerequisites(tx: PhysicalModuleReservations, d: NativeStringCreateDependencies) {
  requireNativePrimitiveWrapperLayouts(tx, d.layouts, d.layoutPlan, d.layoutDependencies);
  requireNativeObjectStorageReservations(tx, d.storage, d.storageDependencies);
  requireNativeValueReservations(tx, d.values, d.valuePlan, d.valueDependencies);
  requireNativeStringOwnDescriptorReservations(tx, d.ownDescriptors, d.ownDescriptorDependencies);
  const w = d.layoutDependencies,
    l = d.storageDependencies.lookupDependencies,
    s = d.ownDescriptorDependencies;
  if (
    w.objects !== l.layouts ||
    w.objectPlan !== l.layoutPlan ||
    w.strings !== l.strings ||
    w.symbols !== l.symbols ||
    s.layouts !== d.layouts ||
    s.layoutPlan !== d.layoutPlan ||
    s.layoutDependencies !== d.layoutDependencies ||
    s.lookup !== d.storageDependencies.lookup ||
    s.lookupDependencies !== l
  )
    fail("different layout/lookup/String owners");
  if (
    d.valuePlan.strings !== "native-string" ||
    d.valueDependencies.strings.kind !== "native-string" ||
    d.valueDependencies.strings.stringPack !== w.strings
  )
    fail("different selected native String/value owner");
  const inventory = nativeStringLiteralReservationInventory(tx, w.strings);
  const anyKey = nativeStringTypeKeys(inventory.typePack.key).any;
  const anyString = inventory.typePack.types.find((row) => row.key === anyKey);
  if (!anyString) fail("missing issued AnyString type");
  // Explicit encoding selects the owner's original interned key, not a caller's copied binding.
  const lengthKey = requireNativeStringLiteral(tx, w.strings, "length", "wtf16");
  return { anyString, lengthKey, object: w.objects.object, propMap: w.objects.propMap, string: d.layouts.types.String };
}
export function declareNativeStringCreateResources(
  key: string,
  anyStringKey: string,
  initialCapacity: number,
): NativeStringCreatePlan {
  if (typeof key !== "string" || !key || typeof anyStringKey !== "string" || !anyStringKey)
    fail("invalid declaration key/type");
  checkedStringCreateCapacity(initialCapacity);
  const declaration = {
    key: key + ":create",
    role: ["string-create", "create"],
    space: "function" as const,
    name: "__string_create",
    signature: {
      params: [{ kind: "externref" } as const, { kind: "ref" as const, typeKey: anyStringKey }],
      results: [{ kind: "externref" } as const],
    },
  };
  return freezeNativeResourceRecipe({
    initialCapacity,
    declarations: [declaration],
    reservationSteps: [{ phase: "resources", kind: "reserve", resourceKey: declaration.key }],
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourcePlan: NativeStringCreatePlan;
  readonly plan: NativeStringCreatePlan;
  readonly sourceDependencies: NativeStringCreateDependencies;
  readonly dependencies: NativeStringCreateDependencies;
  readonly create: FunctionReservation;
  readonly lengthKey: NativeStringLiteralBinding;
  filled: boolean;
}
const owners = new WeakMap<NativeStringCreateReservations, Owner>();
function current(tx: PhysicalModuleReservations, pack: NativeStringCreateReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("unissued, copied or foreign owner");
  const fields = capture(owner.sourceDependencies);
  if (dependencyKeys.some((key) => fields[key] !== owner.dependencies[key])) fail("substituted dependency");
  const p = prerequisites(tx, owner.dependencies);
  const plan = declareNativeStringCreateResources(
    owner.key,
    p.anyString.key,
    checkedStringCreateCapacity(own(owner.sourcePlan, "initialCapacity")),
  );
  preflightNativeResourceRecipe(owner.sourcePlan, [p.anyString.key]);
  if (
    preparedIrDataMismatch(plan, owner.plan) !== undefined ||
    preparedIrDataMismatch(owner.sourcePlan, owner.plan) !== undefined
  )
    fail("changed declaration/capacity plan");
  if (
    p.lengthKey !== owner.lengthKey ||
    pack.create !== owner.create ||
    pack.completionScope !== "string-create-own-length"
  )
    fail("substituted literal/reservation/scope");
  if (tx.state !== "reserving") tx.physicalIndex(owner.create);
  return owner;
}
export function reserveNativeStringCreateResources(
  tx: PhysicalModuleReservations,
  key: string,
  sourcePlan: NativeStringCreatePlan,
  sourceDependencies: NativeStringCreateDependencies,
): NativeStringCreateReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const dependencies = capture(sourceDependencies),
    p = prerequisites(tx, dependencies);
  const plan = declareNativeStringCreateResources(
    key,
    p.anyString.key,
    checkedStringCreateCapacity(own(sourcePlan, "initialCapacity")),
  );
  preflightNativeResourceRecipe(sourcePlan, [p.anyString.key]);
  if (preparedIrDataMismatch(plan, sourcePlan) !== undefined) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, new Map([[p.anyString.key, p.anyString]]));
  const create = requireNativeDeclaredReservation(records, key + ":create", "function");
  const pack = Object.freeze({ create, completionScope: "string-create-own-length" as const });
  owners.set(pack, {
    tx,
    key,
    sourcePlan,
    plan,
    sourceDependencies,
    dependencies,
    create,
    lengthKey: p.lengthKey,
    filled: false,
  });
  return pack;
}
export function requireNativeStringCreateReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringCreateReservations,
  expectedDependencies: NativeStringCreateDependencies,
): NativeStringCreateReservations {
  if (current(tx, pack).sourceDependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}
function completed(tx: PhysicalModuleReservations, d: NativeStringCreateDependencies): void {
  requireCompletedNativeStringLiterals(tx, d.layoutDependencies.strings);
  requireCompletedNativeObjectStorage(tx, d.storage, d.storageDependencies);
  requireCompletedNativeValues(tx, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeStringOwnDescriptors(tx, d.ownDescriptors, d.ownDescriptorDependencies);
}
export function fillNativeStringCreateResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringCreateReservations,
): void {
  const owner = current(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  completed(tx, d);
  const p = prerequisites(tx, d);
  tx.fillFunction(
    pack.create,
    buildStringCreateDefinition({
      objectTypeIdx: p.object.typeIndex,
      stringObjectTypeIdx: p.string.typeIndex,
      propMapTypeIdx: p.propMap.typeIndex,
      anyStringTypeIdx: p.anyString.typeIndex,
      insertIdx: d.storage.insert.handle,
      boxNumberIdx: d.values.functions.boxNumber.handle,
      initialCapacity: owner.plan.initialCapacity,
      lengthKey:
        p.lengthKey.kind === "global"
          ? { kind: "global", index: tx.physicalIndex(p.lengthKey.global) }
          : { kind: "function", index: p.lengthKey.function.handle },
    }),
  );
  owner.filled = true;
}
export function requireCompletedNativeStringCreate(
  tx: PhysicalModuleReservations,
  pack: NativeStringCreateReservations,
  expectedDependencies: NativeStringCreateDependencies,
): NativeStringCreateReservations {
  requireNativeStringCreateReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  completed(tx, owner.dependencies);
  tx.assertCompletedReservation(pack.create);
  return pack;
}
