// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type {
  NativeDeclaredSignature,
  NativeResourceRecipe,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  buildOrdinaryObjectCreateDefinition,
  buildOrdinaryObjectInsertDefinition,
  buildOrdinaryObjectGrowDefinition,
} from "../../../runtime/wasmgc/values/ordinary-object-storage-definitions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as encoding } from "../../../runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import {
  requireNativeObjectLookupReservations,
  requireCompletedNativeObjectLookup,
  type NativeObjectLookupDependencies,
  type NativeObjectLookupReservations,
} from "./native-object-access.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeObjectStorageDependencies {
  readonly lookup: NativeObjectLookupReservations;
  readonly lookupDependencies: NativeObjectLookupDependencies;
}
export interface NativeObjectStorageReservations {
  readonly createDefault: FunctionReservation;
  readonly createNull: FunctionReservation;
  readonly createWithPrototype: FunctionReservation;
  readonly insert: FunctionReservation;
  readonly grow: FunctionReservation;
}
const roles = ["createDefault", "createNull", "createWithPrototype", "insert", "grow"] as const;

/** Internal ordinary storage ABI; generic receiver/prototype admission belongs to the parent. */
export function declareNativeObjectStorageResources(key: string, objectTypeKey: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key || typeof objectTypeKey !== "string" || !objectTypeKey)
    throw new Error("native object storage: invalid declaration key/type");
  const signatures: Record<(typeof roles)[number], NativeDeclaredSignature> = {
    createDefault: { params: [], results: [{ kind: "externref" }] },
    createNull: { params: [], results: [{ kind: "externref" }] },
    createWithPrototype: {
      params: [{ kind: "ref_null", typeKey: objectTypeKey }],
      results: [{ kind: "externref" }],
    },
    insert: {
      params: [
        { kind: "ref", typeKey: objectTypeKey },
        { kind: "externref" },
        { kind: "anyref" },
        { kind: "i32" },
        { kind: "i32" },
      ],
      results: [],
    },
    grow: { params: [{ kind: "ref", typeKey: objectTypeKey }], results: [] },
  };
  const declarations = roles.map((role) => ({
    key: key + ":" + role,
    role: ["ordinary-object-storage", role],
    space: "function" as const,
    name: "__ordinary_object_" + role,
    signature: signatures[role],
  }));
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly dependencies: NativeObjectStorageDependencies;
  readonly identities: NativeObjectStorageDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly recipe: NativeResourceRecipe;
  readonly tokens: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeObjectStorageReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native object storage: " + detail);
}
function requireDependencies(tx: PhysicalModuleReservations, d: NativeObjectStorageDependencies): void {
  requireNativeObjectLookupReservations(tx, d.lookup, d.lookupDependencies);
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeObjectStorageReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (
    owner.dependencies.lookup !== owner.identities.lookup ||
    owner.dependencies.lookupDependencies !== owner.identities.lookupDependencies
  )
    fail("substituted dependency identity");
  requireDependencies(tx, owner.dependencies);
  const currentPlan = declareNativeObjectStorageResources(
    owner.key,
    owner.dependencies.lookupDependencies.layouts.object.key,
  );
  if (
    preparedIrDataMismatch(owner.sourcePlan, owner.recipe) !== undefined ||
    preparedIrDataMismatch(currentPlan, owner.recipe) !== undefined
  )
    fail("changed declaration plan");
  if (roles.some((role, index) => pack[role] !== owner.tokens[index])) fail("substituted function token");
  if (tx.state !== "reserving") owner.tokens.forEach((token) => tx.physicalIndex(token));
  return owner;
}

export function reserveNativeObjectStorageResources(
  tx: PhysicalModuleReservations,
  key: string,
  dependencies: NativeObjectStorageDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeObjectStorageReservations {
  if (tx.state !== "reserving" || typeof key !== "string" || !key) fail("invalid reservation phase/key");
  requireDependencies(tx, dependencies);
  const recipe = declareNativeObjectStorageResources(key, dependencies.lookupDependencies.layouts.object.key);
  if (preparedIrDataMismatch(expectedPlan, recipe) !== undefined) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(recipe.declarations.map((row) => row.key));
  const object = dependencies.lookupDependencies.layouts.object;
  const records = executeNativeResourceRecipe(tx, recipe, new Map([[object.key, object]]));
  const pack = Object.freeze({
    createDefault: requireNativeDeclaredReservation(records, key + ":createDefault", "function"),
    createNull: requireNativeDeclaredReservation(records, key + ":createNull", "function"),
    createWithPrototype: requireNativeDeclaredReservation(records, key + ":createWithPrototype", "function"),
    insert: requireNativeDeclaredReservation(records, key + ":insert", "function"),
    grow: requireNativeDeclaredReservation(records, key + ":grow", "function"),
  });
  owners.set(pack, {
    tx,
    key,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    sourcePlan: expectedPlan,
    recipe,
    tokens: Object.freeze(roles.map((role) => pack[role])),
    filled: false,
  });
  return pack;
}

export function requireNativeObjectStorageReservations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectStorageReservations,
  expectedDependencies: NativeObjectStorageDependencies,
): NativeObjectStorageReservations {
  if (requireOwner(tx, pack).dependencies !== expectedDependencies) fail("foreign expected dependencies");
  return pack;
}

export function fillNativeObjectStorageResources(
  tx: PhysicalModuleReservations,
  pack: NativeObjectStorageReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  const d = owner.dependencies.lookupDependencies,
    lookup = owner.dependencies.lookup;
  requireCompletedNativeObjectLookup(tx, lookup, d);
  const types = {
    objectTypeIdx: d.layouts.object.typeIndex,
    propMapTypeIdx: d.layouts.propMap.typeIndex,
    propEntryTypeIdx: d.layouts.propEntry.typeIndex,
  };
  const create = { ...types, initialCapacity: 8 };
  tx.fillFunction(pack.createDefault, buildOrdinaryObjectCreateDefinition(create, "default"));
  tx.fillFunction(pack.createNull, buildOrdinaryObjectCreateDefinition(create, "null"));
  tx.fillFunction(pack.createWithPrototype, buildOrdinaryObjectCreateDefinition(create, "argument"));
  tx.fillFunction(
    pack.insert,
    buildOrdinaryObjectInsertDefinition({
      ...types,
      anyStrTypeIdx: d.strings.layout.anyStrTypeIdx,
      nativeStrTypeIdx: d.strings.layout.nativeStrTypeIdx,
      nativeStrRef: { kind: "ref", typeIdx: d.strings.layout.nativeStrTypeIdx },
      strDataTypeIdx: d.strings.layout.nativeStrDataTypeIdx,
      symbolTypeIdx: d.symbols.types.symbol.typeIndex,
      symbolKeysEnabled: true,
      strFlattenIdx: d.flatten.flatten.handle,
      strEqualsIdx: d.equality.equals.handle,
      keyEqualsIdx: lookup.keyEquals.handle,
      objHashIdx: lookup.hash.handle,
      tombstoneFlag: encoding.tombstone,
      noneHeap: encoding.noneHeap,
      nonExtensibleFlag: encoding.nonExtensible,
    }),
  );
  tx.fillFunction(
    pack.grow,
    buildOrdinaryObjectGrowDefinition({
      ...types,
      objInsertIdx: pack.insert.handle,
      objFindIdx: lookup.findOwn.handle,
      tombstoneFlag: encoding.tombstone,
      accessorFlag: encoding.accessor,
    }),
  );
  owner.filled = true;
}

export function requireCompletedNativeObjectStorage(
  tx: PhysicalModuleReservations,
  pack: NativeObjectStorageReservations,
  expectedDependencies: NativeObjectStorageDependencies,
): NativeObjectStorageReservations {
  requireNativeObjectStorageReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeObjectLookup(tx, owner.dependencies.lookup, owner.dependencies.lookupDependencies);
  owner.tokens.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}

export function nativeObjectStorageReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeObjectStorageReservations,
) {
  const owner = requireOwner(tx, pack);
  return Object.freeze({ key: owner.key, plan: owner.recipe, functions: owner.tokens });
}
