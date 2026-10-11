// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { buildObjectSameValueBody } from "../../../runtime/wasmgc/values/object-same-value-body.js";
import {
  requireNativeValueReservations,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import {
  requireNativeBooleanReservations,
  requireCompletedNativeBooleans,
  type NativeBooleanReservations,
} from "./native-booleans.js";
import {
  requireNativeBigIntReservations,
  requireCompletedNativeBigInt,
  type NativeBigIntReservations,
} from "./native-bigint.js";
import {
  nativeStringLiteralReservationInventory,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  requireNativeStringFlattenReservations,
  type NativeStringFlattenReservations,
} from "./native-string-flatten.js";
import {
  requireNativeStringEqualityReservations,
  requireCompletedNativeStringEquality,
  type NativeStringEqualityReservations,
} from "./native-string-equality.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeObjectSameValueDependencies {
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
  readonly booleans: NativeBooleanReservations;
  readonly bigints: NativeBigIntReservations;
  readonly bigintPlan: NativeResourceRecipe;
  readonly strings: NativeStringLiteralReservations;
  readonly flatten: NativeStringFlattenReservations;
  readonly equality: NativeStringEqualityReservations;
}
export interface NativeObjectSameValueReservations {
  readonly sameValue: FunctionReservation;
}

export function declareNativeObjectSameValueResources(key: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key) throw new Error("native SameValue: invalid declaration key");
  return freezeNativeResourceRecipe({
    declarations: [
      {
        key: key + ":same-value",
        role: ["object", "same-value"],
        space: "function",
        name: "__object_is",
        signature: { params: [{ kind: "externref" }, { kind: "externref" }], results: [{ kind: "i32" }] },
      },
    ],
    reservationSteps: [{ phase: "resources", kind: "reserve", resourceKey: key + ":same-value" }],
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly dependencies: NativeObjectSameValueDependencies;
  readonly identities: NativeObjectSameValueDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly token: FunctionReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeObjectSameValueReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native SameValue: " + detail);
}
function requireDependencies(tx: PhysicalModuleReservations, d: NativeObjectSameValueDependencies): void {
  requireNativeValueReservations(tx, d.values, d.valuePlan, d.valueDependencies);
  requireNativeBooleanReservations(tx, d.booleans, d.values, d.valuePlan, d.valueDependencies);
  requireNativeBigIntReservations(tx, d.bigints, d.bigintPlan);
  nativeStringLiteralReservationInventory(tx, d.strings);
  requireNativeStringFlattenReservations(tx, d.flatten);
  requireNativeStringEqualityReservations(tx, d.equality, d.strings);
  if (d.flatten.stringPack !== d.strings || d.equality.flattenPack !== d.flatten)
    fail("substituted shared string dependency");
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeObjectSameValueReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  for (const key of Object.keys(owner.identities) as (keyof NativeObjectSameValueDependencies)[])
    if (owner.dependencies[key] !== owner.identities[key]) fail("substituted dependency identity");
  requireDependencies(tx, owner.dependencies);
  if (
    preparedIrDataMismatch(owner.sourcePlan, owner.plan) ||
    preparedIrDataMismatch(declareNativeObjectSameValueResources(owner.key), owner.plan)
  )
    fail("changed declaration plan");
  if (pack.sameValue !== owner.token) fail("substituted function token");
  if (tx.state !== "reserving") tx.physicalIndex(owner.token);
  return owner;
}

export function reserveNativeObjectSameValueResources(
  tx: PhysicalModuleReservations,
  key: string,
  dependencies: NativeObjectSameValueDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeObjectSameValueReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  requireDependencies(tx, dependencies);
  const plan = declareNativeObjectSameValueResources(key);
  if (preparedIrDataMismatch(expectedPlan, plan)) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const pack = Object.freeze({ sameValue: requireNativeDeclaredReservation(records, key + ":same-value", "function") });
  owners.set(pack, {
    tx,
    key,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    sourcePlan: expectedPlan,
    plan,
    token: pack.sameValue,
    filled: false,
  });
  return pack;
}

export function requireNativeObjectSameValueReservations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSameValueReservations,
  expectedDependencies: NativeObjectSameValueDependencies,
): NativeObjectSameValueReservations {
  if (requireOwner(tx, pack).dependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}

function requireCompletedDependencies(tx: PhysicalModuleReservations, d: NativeObjectSameValueDependencies): void {
  requireCompletedNativeValues(tx, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeBooleans(tx, d.booleans, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeBigInt(tx, d.bigints, d.bigintPlan);
  requireCompletedNativeStringEquality(tx, d.equality, d.strings);
}
export function fillNativeObjectSameValueResources(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSameValueReservations,
): void {
  const owner = requireOwner(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  requireCompletedDependencies(tx, d);
  tx.fillFunction(pack.sameValue, {
    locals: [
      { name: "aa", type: { kind: "anyref" } },
      { name: "ba", type: { kind: "anyref" } },
    ],
    body: buildObjectSameValueBody({
      typeofNumIdx: d.values.functions.isNumber.handle,
      typeofBoolIdx: d.booleans.isBoolean.handle,
      typeofBigIdx: d.bigints.isBigInt.handle,
      unboxNumIdx: d.values.functions.unboxNumber.handle,
      unboxBoolIdx: d.booleans.unboxBoolean.handle,
      // Both actual brands pass first; exact carrier equality includes all wide limbs.
      bigint: { kind: "carrier", equalIdx: d.bigints.equal.handle },
      anyStrTypeIdx: d.strings.layout.anyStrTypeIdx,
      strFlattenIdx: d.flatten.flatten.handle,
      strEqualsIdx: d.equality.equals.handle,
    }),
  });
  owner.filled = true;
}

export function requireCompletedNativeObjectSameValue(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSameValueReservations,
  expectedDependencies: NativeObjectSameValueDependencies,
): NativeObjectSameValueReservations {
  requireNativeObjectSameValueReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedDependencies(tx, owner.dependencies);
  tx.assertCompletedReservation(pack.sameValue);
  return pack;
}

export function nativeObjectSameValueReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSameValueReservations,
  expectedDependencies: NativeObjectSameValueDependencies,
) {
  requireNativeObjectSameValueReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, functions: Object.freeze([owner.token]) });
}
