// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
} from "../../../ir/program/native-object-access-requirements.js";
import type { NativeInvocationRequirements } from "../../../ir/program/native-invocation-requirements.js";
import { assertNativeValueResourcePlanFor } from "../../../ir/program/native-value-resources.js";
import { buildOrdinaryObjectGetDefinition } from "../../../runtime/wasmgc/values/ordinary-object-access-bodies.js";
import {
  declareNativeObjectAccessResources,
  type NativeObjectAccessTypeKeys,
} from "./native-object-access-declarations.js";
import {
  requireNativeObjectLookupReservations,
  requireCompletedNativeObjectLookup,
  type NativeObjectLookupDependencies,
  type NativeObjectLookupReservations,
} from "./native-object-access.js";
import {
  requireNativeInvocationReservations,
  nativeInvocationGetterDispatch,
  requireCompletedNativeInvocation,
  type NativeInvocationDependencies,
  type NativeInvocationReservations,
} from "./native-invocation.js";
import { requireCompletedNativeValues } from "./native-values.js";
import { nativeStringLiteralReservationInventory, nativeStringTypeKeys } from "./native-string-literals.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeObjectGetDependencies {
  readonly access: NativeObjectAccessRequirements;
  readonly lookup: NativeObjectLookupReservations;
  readonly lookupDependencies: NativeObjectLookupDependencies;
  readonly invocation: NativeInvocationReservations;
  readonly invocationRequirements: NativeInvocationRequirements;
  readonly invocationDependencies: NativeInvocationDependencies;
}
export interface NativeObjectGetReservations {
  readonly get: FunctionReservation;
  readonly requirements: NativeObjectAccessRequirements;
  readonly gaps: NativeObjectAccessRequirements["gaps"];
  readonly completionScope: "ordinary-object-get-prerequisite";
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly dependencies: NativeObjectGetDependencies;
  readonly identities: NativeObjectGetDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly get: FunctionReservation;
  readonly dispatch: FunctionReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeObjectGetReservations, Owner>();
const dependencyRoles = [
  "access",
  "lookup",
  "lookupDependencies",
  "invocation",
  "invocationRequirements",
  "invocationDependencies",
] as const;
function fail(detail: string): never {
  throw new Error("native object get: " + detail);
}
function dependencyData(value: NativeObjectGetDependencies): NativeObjectGetDependencies {
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const role of dependencyRoles)
    if (!fields[role] || !Object.hasOwn(fields[role], "value")) fail("dependencies require own data fields");
  return Object.freeze(
    Object.fromEntries(dependencyRoles.map((role) => [role, fields[role]!.value])),
  ) as unknown as NativeObjectGetDependencies;
}

/** The canonical internal Get returns status AND value; it is not the public scalar intrinsic ABI. */
export function declareNativeObjectGetResources(key: string, types: NativeObjectAccessTypeKeys): NativeResourceRecipe {
  const plan = declareNativeObjectAccessResources(key, types);
  return freezeNativeResourceRecipe({
    declarations: plan.declarations.filter((row) => row.key === plan.functions.get),
    reservationSteps: plan.reservationSteps.filter(
      (row) => row.kind === "reserve" && row.resourceKey === plan.functions.get,
    ),
  });
}
function declaration(key: string, tx: PhysicalModuleReservations, d: NativeObjectGetDependencies) {
  const lookup = d.lookupDependencies;
  const { typePack } = nativeStringLiteralReservationInventory(tx, lookup.strings);
  return declareNativeObjectGetResources(key, {
    object: lookup.layouts.object.key,
    propEntry: lookup.layouts.propEntry.key,
    nativeString: nativeStringTypeKeys(typePack.key).flat,
  });
}
function requireDependencies(tx: PhysicalModuleReservations, d: NativeObjectGetDependencies): FunctionReservation {
  assertNativeObjectAccessRequirementsCurrent(d.access);
  requireNativeObjectLookupReservations(tx, d.lookup, d.lookupDependencies);
  requireNativeInvocationReservations(tx, d.invocation, d.invocationRequirements, d.invocationDependencies);
  if (d.lookupDependencies.strings !== d.invocationDependencies.strings) fail("different shared string owner");
  const { valuePlan } = d.invocationDependencies;
  assertNativeValueResourcePlanFor(valuePlan, d.access.demands.program, d.access.demands.projection, valuePlan.strings);
  // This authenticates the exact C1 association, not a caller-supplied signature or function handle.
  return nativeInvocationGetterDispatch(tx, d.invocation, d.access);
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeObjectGetReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  const current = dependencyData(owner.dependencies);
  if (dependencyRoles.some((role) => current[role] !== owner.identities[role])) fail("substituted dependency identity");
  const sourcePlan = preflightNativeResourceRecipe(owner.sourcePlan, [
    owner.identities.lookupDependencies.layouts.object.key,
  ]);
  if (requireDependencies(tx, owner.identities) !== owner.dispatch) fail("substituted getter dispatch");
  if (
    preparedIrDataMismatch(sourcePlan, owner.plan) !== undefined ||
    preparedIrDataMismatch(declaration(owner.key, tx, owner.identities), owner.plan) !== undefined
  )
    fail("changed declaration plan");
  if (
    pack.get !== owner.get ||
    pack.requirements !== owner.identities.access ||
    pack.gaps !== owner.identities.access.gaps
  )
    fail("substituted reservation or requirements");
  if (tx.state !== "reserving") tx.physicalIndex(owner.get);
  return owner;
}

/** Reserve alongside C2 and source units. No body or implicit-prototype completion is implied. */
export function reserveNativeObjectGetResources(
  tx: PhysicalModuleReservations,
  key: string,
  dependencies: NativeObjectGetDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeObjectGetReservations {
  if (tx.state !== "reserving" || typeof key !== "string" || !key) fail("invalid reservation phase/key");
  const identities = dependencyData(dependencies);
  const object = identities.lookupDependencies.layouts.object;
  const sourcePlan = preflightNativeResourceRecipe(expectedPlan, [object.key]);
  const dispatch = requireDependencies(tx, identities);
  const plan = declaration(key, tx, identities);
  if (preparedIrDataMismatch(sourcePlan, plan) !== undefined) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, new Map([[object.key, object]]));
  const get = requireNativeDeclaredReservation(records, key + ":get", "function");
  const pack = Object.freeze({
    get,
    requirements: identities.access,
    gaps: identities.access.gaps,
    completionScope: "ordinary-object-get-prerequisite" as const,
  });
  owners.set(pack, { tx, key, dependencies, identities, sourcePlan: expectedPlan, plan, get, dispatch, filled: false });
  return pack;
}

export function requireNativeObjectGetReservations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectGetReservations,
  expectedDependencies: NativeObjectGetDependencies,
): NativeObjectGetReservations {
  if (requireOwner(tx, pack).dependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}

/** Emit the real lookup/accessor branch. Completion of cyclic source calls is checked separately. */
export function fillNativeObjectGetResources(tx: PhysicalModuleReservations, pack: NativeObjectGetReservations): void {
  const owner = requireOwner(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  const d = owner.identities,
    v = d.invocationDependencies;
  requireCompletedNativeObjectLookup(tx, d.lookup, d.lookupDependencies);
  requireCompletedNativeValues(tx, v.values, v.valuePlan, v.valueDependencies);
  tx.fillFunction(
    pack.get,
    buildOrdinaryObjectGetDefinition({
      propEntryTypeIdx: d.lookupDependencies.layouts.propEntry.typeIndex,
      lookupIdx: d.lookup.lookup.handle,
      getterDispatchIdx: owner.dispatch.handle,
      undefinedGlobalIdx: tx.physicalIndex(v.values.globals.undefined),
    }),
  );
  owner.filled = true;
}

/** Certifies only this internal three-state graph; unresolved prototype gaps remain visible. */
export function requireCompletedNativeObjectGet(
  tx: PhysicalModuleReservations,
  pack: NativeObjectGetReservations,
  expectedDependencies: NativeObjectGetDependencies,
): NativeObjectGetReservations {
  requireNativeObjectGetReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  const d = owner.identities,
    v = d.invocationDependencies;
  requireCompletedNativeObjectLookup(tx, d.lookup, d.lookupDependencies);
  requireCompletedNativeValues(tx, v.values, v.valuePlan, v.valueDependencies);
  requireCompletedNativeInvocation(tx, d.invocation);
  tx.assertCompletedReservation(owner.get);
  return pack;
}
