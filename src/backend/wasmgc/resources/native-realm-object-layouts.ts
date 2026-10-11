// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createRealmIdentityDeclaration,
  createRealmObjectStateDeclaration,
  createRealmObjectPrototypeDeclaration,
  createRealmOrdinaryObjectDeclaration,
  buildRealmSourceStateInitializer,
} from "../../../runtime/wasmgc/values/realm-object-layouts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  requireNativeObjectLayouts,
  type NativeObjectLayoutReservations,
  type NativeObjectLayoutDeclarationPlan,
} from "./native-object-layouts.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeRealmObjectLayoutDependencies {
  readonly objects: NativeObjectLayoutReservations;
  readonly objectPlan: NativeObjectLayoutDeclarationPlan;
}
export interface NativeRealmObjectLayoutReservations {
  readonly types: {
    readonly identity: TypeReservation;
    readonly state: TypeReservation;
    readonly objectPrototype: TypeReservation;
    readonly ordinary: TypeReservation;
  };
  /** Exact slots borrowed by the eventual singleton population owner. */
  readonly anchors: { readonly realm: GlobalReservation; readonly functionPrototype: GlobalReservation };
  readonly sourceInitializer: FunctionReservation;
  readonly completionScope: "realm-carrier-state-only";
}
const typeRoles = ["identity", "state", "objectPrototype", "ordinary"] as const;
const dependencyRoles = ["objects", "objectPlan"] as const;
function fail(detail: string): never {
  throw new Error("native realm object layouts: " + detail);
}
function data(input: unknown, roles: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("dependencies must be plain data");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== roles.length) fail("unexpected dependency roles");
  for (const role of roles)
    if (!Object.hasOwn(fields, role) || !Object.hasOwn(fields[role]!, "value") || !fields[role]!.enumerable)
      fail("dependencies require own enumerable data fields");
  return Object.fromEntries(roles.map((role) => [role, fields[role]!.value]));
}
function dependencies(tx: PhysicalModuleReservations, d: NativeRealmObjectLayoutDependencies) {
  requireNativeObjectLayouts(tx, d.objects, d.objectPlan);
  const object = d.objects.object;
  const declaration = d.objectPlan.declarations.find((row) => row.key === object.key);
  if (
    declaration?.space !== "type" ||
    declaration.shape.kind !== "struct" ||
    declaration.shape.parent?.kind !== "root" ||
    declaration.shape.final !== false
  )
    fail("ordinary storage requires an explicit extensible root");
  return new Map([object, d.objects.propMap].map((token) => [token.key, token]));
}

/** No catalog or source demand is invented to reserve these physical prerequisites. */
export function declareNativeRealmObjectLayouts(key: string, objectKey: string, mapKey: string): NativeResourceRecipe {
  for (const value of [key, objectKey, mapKey])
    if (typeof value !== "string" || !value) fail("invalid declaration key");
  const identity = key + ":identity",
    state = key + ":state";
  const shapes = [
    createRealmIdentityDeclaration(),
    createRealmObjectStateDeclaration(identity),
    createRealmObjectPrototypeDeclaration(objectKey, mapKey),
    createRealmOrdinaryObjectDeclaration(objectKey, mapKey, state),
  ];
  const declarations: NativeResourceRecipe["declarations"] = [
    ...typeRoles.map((role, index) => ({
      key: key + ":" + role,
      role: ["realm-carrier", role],
      space: "type" as const,
      shape: shapes[index]!,
    })),
    {
      key: key + ":realm",
      role: ["realm-carrier", "realm-anchor"],
      space: "global",
      name: "__realm_identity",
      valueType: { kind: "ref_null", typeKey: identity },
      mutable: true,
    },
    {
      key: key + ":functionPrototype",
      role: ["realm-carrier", "function-prototype-anchor"],
      space: "global",
      name: "__realm_function_prototype",
      valueType: { kind: "externref" },
      mutable: true,
    },
    {
      key: key + ":sourceInitializer",
      role: ["realm-carrier", "source-state-initializer"],
      space: "function",
      name: "__realm_source_state",
      signature: { params: [], results: [{ kind: "ref", typeKey: state }] },
    },
  ];
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
  readonly sourceDependencies: NativeRealmObjectLayoutDependencies;
  readonly dependencies: NativeRealmObjectLayoutDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly tokens: readonly (TypeReservation | GlobalReservation | FunctionReservation)[];
  readonly initializerType: number;
  filled: boolean;
}
const owners = new WeakMap<NativeRealmObjectLayoutReservations, Owner>();

export function reserveNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  key: string,
  sourceDependencies: NativeRealmObjectLayoutDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeRealmObjectLayoutReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const captured = Object.freeze(
    data(sourceDependencies, dependencyRoles),
  ) as unknown as NativeRealmObjectLayoutDependencies;
  const prerequisites = dependencies(tx, captured);
  const plan = declareNativeRealmObjectLayouts(key, captured.objects.object.key, captured.objects.propMap.key);
  if (preparedIrDataMismatch(preflightNativeResourceRecipe(expectedPlan, [...prerequisites.keys()]), plan))
    fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, prerequisites);
  const types = Object.freeze(
    Object.fromEntries(
      typeRoles.map((role) => [role, requireNativeDeclaredReservation(records, key + ":" + role, "type")]),
    ),
  ) as NativeRealmObjectLayoutReservations["types"];
  const pack = Object.freeze({
    types,
    anchors: Object.freeze({
      realm: requireNativeDeclaredReservation(records, key + ":realm", "global"),
      functionPrototype: requireNativeDeclaredReservation(records, key + ":functionPrototype", "global"),
    }),
    sourceInitializer: requireNativeDeclaredReservation(records, key + ":sourceInitializer", "function"),
    completionScope: "realm-carrier-state-only" as const,
  });
  owners.set(pack, {
    tx,
    key,
    sourceDependencies,
    dependencies: captured,
    sourcePlan: expectedPlan,
    plan,
    tokens: Object.freeze([
      ...typeRoles.map((role) => types[role]),
      pack.anchors.realm,
      pack.anchors.functionPrototype,
      pack.sourceInitializer,
    ]),
    initializerType: pack.sourceInitializer.object.typeIdx,
    filled: false,
  });
  return pack;
}

export function requireNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
  expectedDependencies?: NativeRealmObjectLayoutDependencies,
): NativeRealmObjectLayoutReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied layout owner");
  if (expectedDependencies !== undefined) {
    const expected = data(expectedDependencies, dependencyRoles);
    if (dependencyRoles.some((role) => expected[role] !== owner.dependencies[role]))
      fail("foreign expected dependencies");
  }
  const current = data(owner.sourceDependencies, dependencyRoles);
  if (dependencyRoles.some((role) => current[role] !== owner.dependencies[role])) fail("changed dependency identity");
  const prerequisites = dependencies(tx, owner.dependencies);
  if (
    preparedIrDataMismatch(preflightNativeResourceRecipe(owner.sourcePlan, [...prerequisites.keys()]), owner.plan) ||
    preparedIrDataMismatch(
      declareNativeRealmObjectLayouts(
        owner.key,
        owner.dependencies.objects.object.key,
        owner.dependencies.objects.propMap.key,
      ),
      owner.plan,
    )
  )
    fail("changed retained declaration plan");
  const tokens = [
    ...typeRoles.map((role) => pack.types[role]),
    pack.anchors.realm,
    pack.anchors.functionPrototype,
    pack.sourceInitializer,
  ];
  if (owner.tokens.some((token, index) => token !== tokens[index])) fail("substituted reservation token");
  const types = new Map([
    ...prerequisites,
    ...typeRoles.map((role) => [pack.types[role].key, pack.types[role]] as const),
  ]);
  owner.tokens.forEach((token, index) => {
    if (tx.state !== "reserving") tx.physicalIndex(token);
    else if (token.kind === "type") tx.assertTypeReservation(token);
    if (token.kind === "function") {
      if (token.object.name !== "__realm_source_state" || token.object.typeIdx !== owner.initializerType)
        fail("changed initializer signature/header");
    } else
      compareNativeResourceDeclarationShape(
        tx,
        owner.plan.declarations[index]!,
        token.kind === "type"
          ? { key: token.key, space: "type", definition: token.object }
          : {
              key: token.key,
              space: "global",
              header: { name: token.object.name, type: token.object.type, mutable: token.object.mutable },
            },
        types,
      );
  });
  return pack;
}

function initializer(tx: PhysicalModuleReservations, pack: NativeRealmObjectLayoutReservations) {
  return buildRealmSourceStateInitializer({
    realmGlobal: tx.physicalIndex(pack.anchors.realm),
    prototypeGlobal: tx.physicalIndex(pack.anchors.functionPrototype),
    stateType: tx.physicalIndex(pack.types.state),
  });
}
export function fillNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
): void {
  requireNativeRealmObjectLayouts(tx, pack);
  const owner = owners.get(pack)!;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  tx.fillGlobal(pack.anchors.realm, [{ op: "ref.null", typeIdx: pack.types.identity.typeIndex }]);
  tx.fillGlobal(pack.anchors.functionPrototype, [{ op: "ref.null.extern" }]);
  tx.fillFunction(pack.sourceInitializer, initializer(tx, pack));
  owner.filled = true;
}

/** Canonical types/initializer only. Runtime anchor values and public population remain unproved. */
export function requireCompletedNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
): NativeRealmObjectLayoutReservations {
  requireNativeRealmObjectLayouts(tx, pack);
  if (!owners.get(pack)!.filled) fail("missing canonical initializer fill");
  for (const token of [pack.anchors.realm, pack.anchors.functionPrototype, pack.sourceInitializer])
    tx.assertCompletedReservation(token);
  if (
    preparedIrDataMismatch(pack.anchors.realm.object.init, [
      { op: "ref.null", typeIdx: pack.types.identity.typeIndex },
    ]) ||
    preparedIrDataMismatch(pack.anchors.functionPrototype.object.init, [{ op: "ref.null.extern" }]) ||
    preparedIrDataMismatch(
      { locals: pack.sourceInitializer.object.locals, body: pack.sourceInitializer.object.body },
      initializer(tx, pack),
    )
  )
    fail("noncanonical anchor or initializer completion");
  return pack;
}

export function nativeRealmObjectLayoutReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
) {
  requireNativeRealmObjectLayouts(tx, pack);
  return Object.freeze({
    plan: owners.get(pack)!.plan,
    types: Object.freeze(typeRoles.map((role) => pack.types[role])),
    globals: Object.freeze([pack.anchors.realm, pack.anchors.functionPrototype]),
    functions: Object.freeze([pack.sourceInitializer]),
  });
}
