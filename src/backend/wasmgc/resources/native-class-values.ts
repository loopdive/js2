// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  FunctionReservation,
  PhysicalModuleReservations,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createClassConstructorDeclaration,
  buildClassConstructorAllocation,
} from "../../../runtime/wasmgc/values/class-constructor-layouts.js";
import {
  nativeSourceClosureRealmState,
  requireNativeSourceClosureTypes,
  type NativeSourceClosureTypes,
} from "./native-source-closures.js";
import {
  requireCompletedNativeRealmObjectLayouts,
  type NativeRealmObjectLayoutReservations,
} from "./native-realm-object-layouts.js";
import {
  assertNativeResourceDataMatches,
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeClassValueReservations {
  readonly type: TypeReservation;
  readonly allocate: FunctionReservation;
  readonly completionScope: "class-value-allocation-only";
}
const allocatorName = "__class_value_new";
function fail(detail: string): never {
  throw Error("native class values: " + detail);
}

export function declareNativeClassValues(key: string, rootKey: string, stateKey: string): NativeResourceRecipe {
  if (![key, rootKey, stateKey].every((value) => typeof value === "string" && value.length > 0))
    fail("invalid declaration key");
  const declarations: NativeResourceRecipe["declarations"] = [
    {
      key: key + ":type",
      role: ["class-value", "carrier"],
      space: "type",
      shape: createClassConstructorDeclaration(rootKey, stateKey),
    },
    {
      key: key + ":allocate",
      role: ["class-value", "allocation"],
      space: "function",
      name: allocatorName,
      signature: {
        params: [
          { kind: "funcref" },
          { kind: "i32" },
          { kind: "externref" },
          { kind: "ref", typeKey: rootKey },
          { kind: "externref" },
        ],
        results: [{ kind: "externref" }],
      },
    },
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly source: NativeSourceClosureTypes;
  readonly realm: NativeRealmObjectLayoutReservations;
  readonly key: string;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly type: TypeReservation;
  readonly allocate: FunctionReservation;
  readonly allocatorType: number;
  filled: boolean;
}
const owners = new WeakMap<NativeClassValueReservations, Owner>();
function prerequisites(tx: PhysicalModuleReservations, source: NativeSourceClosureTypes) {
  requireNativeSourceClosureTypes(tx, source, source.requirements);
  const realm = nativeSourceClosureRealmState(tx, source);
  if (!realm) fail("source closures have no issued realm state owner");
  return { realm, types: new Map([source.closures.root, realm.types.state].map((token) => [token.key, token])) };
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeClassValueReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  const { realm, types } = prerequisites(tx, owner.source);
  if (
    realm !== owner.realm ||
    pack.type !== owner.type ||
    pack.allocate !== owner.allocate ||
    pack.completionScope !== "class-value-allocation-only"
  )
    fail("substituted reservation/dependency");
  const plan = declareNativeClassValues(owner.key, owner.source.closures.root.key, realm.types.state.key);
  assertNativeResourceDataMatches(owner.sourcePlan, owner.plan, "changed declaration plan");
  assertNativeResourceDataMatches(plan, owner.plan, "changed declaration plan");
  if (tx.state === "reserving") tx.assertTypeReservation(pack.type);
  else {
    tx.physicalIndex(pack.type);
    tx.physicalIndex(pack.allocate);
  }
  compareNativeResourceDeclarationShape(
    tx,
    plan.declarations[0]!,
    { key: pack.type.key, space: "type", definition: pack.type.object },
    types,
  );
  if (pack.allocate.object.name !== allocatorName || pack.allocate.object.typeIdx !== owner.allocatorType)
    fail("changed allocator header");
  return owner;
}
export function reserveNativeClassValues(
  tx: PhysicalModuleReservations,
  key: string,
  source: NativeSourceClosureTypes,
  expectedPlan: NativeResourceRecipe,
): NativeClassValueReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const { realm, types } = prerequisites(tx, source);
  const plan = declareNativeClassValues(key, source.closures.root.key, realm.types.state.key);
  assertNativeResourceDataMatches(expectedPlan, plan, "substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, types);
  const pack = Object.freeze({
    type: requireNativeDeclaredReservation(records, key + ":type", "type"),
    allocate: requireNativeDeclaredReservation(records, key + ":allocate", "function"),
    completionScope: "class-value-allocation-only" as const,
  });
  owners.set(pack, {
    tx,
    source,
    realm,
    key,
    sourcePlan: expectedPlan,
    plan,
    type: pack.type,
    allocate: pack.allocate,
    allocatorType: pack.allocate.object.typeIdx,
    filled: false,
  });
  return pack;
}
export function requireNativeClassValues(
  tx: PhysicalModuleReservations,
  pack: NativeClassValueReservations,
): NativeClassValueReservations {
  requireOwner(tx, pack);
  return pack;
}
function allocationBody(tx: PhysicalModuleReservations, pack: NativeClassValueReservations, owner: Owner) {
  return buildClassConstructorAllocation({
    classType: tx.physicalIndex(pack.type),
    initializeState: owner.realm.prototypeInitializer.handle,
  });
}
export function fillNativeClassValues(tx: PhysicalModuleReservations, pack: NativeClassValueReservations): void {
  const owner = requireOwner(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  requireCompletedNativeRealmObjectLayouts(tx, owner.realm);
  tx.fillFunction(pack.allocate, allocationBody(tx, pack, owner));
  owner.filled = true;
}
export function requireCompletedNativeClassValues(
  tx: PhysicalModuleReservations,
  pack: NativeClassValueReservations,
): NativeClassValueReservations {
  const owner = requireOwner(tx, pack);
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeRealmObjectLayouts(tx, owner.realm);
  tx.assertCompletedReservation(pack.allocate);
  assertNativeResourceDataMatches(
    allocationBody(tx, pack, owner),
    { locals: pack.allocate.object.locals, body: pack.allocate.object.body },
    "noncanonical allocator completion",
  );
  return pack;
}
export function nativeClassValueReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeClassValueReservations,
) {
  const owner = requireOwner(tx, pack);
  return Object.freeze({
    plan: owner.plan,
    types: Object.freeze([pack.type]),
    functions: Object.freeze([pack.allocate]),
  });
}
