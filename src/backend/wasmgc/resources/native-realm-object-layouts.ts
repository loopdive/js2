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
  buildRealmObjectStateInitializer,
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
export interface NativeRealmObjectStateReservations {
  readonly types: {
    readonly identity: TypeReservation;
    readonly state: TypeReservation;
  };
  /** Exact slots borrowed by the eventual singleton population owner. */
  readonly anchors: { readonly realm: GlobalReservation; readonly functionPrototype: GlobalReservation };
  readonly prototypeInitializer: FunctionReservation;
  readonly sourceInitializer: FunctionReservation;
  readonly completionScope: "realm-carrier-state-only";
}
export interface NativeRealmObjectLayoutReservations extends NativeRealmObjectStateReservations {
  readonly types: NativeRealmObjectStateReservations["types"] & {
    readonly objectPrototype: TypeReservation;
    readonly ordinary: TypeReservation;
  };
}
const initializerNames = {
  prototypeInitializer: "__realm_object_state",
  sourceInitializer: "__realm_source_state",
} as const;
const initializerRoles = ["prototypeInitializer", "sourceInitializer"] as const;
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
function declareRealmLayouts(
  key: string,
  storage?: { readonly objectKey: string; readonly mapKey: string },
): NativeResourceRecipe {
  const { objectKey, mapKey } = storage ?? {};
  for (const value of [key, ...(storage ? [objectKey, mapKey] : [])])
    if (typeof value !== "string" || !value) fail("invalid declaration key");
  const identity = key + ":identity",
    state = key + ":state";
  const shapes = [
    createRealmIdentityDeclaration(),
    createRealmObjectStateDeclaration(identity),
    ...(storage
      ? [
          createRealmObjectPrototypeDeclaration(storage.objectKey, storage.mapKey),
          createRealmOrdinaryObjectDeclaration(storage.objectKey, storage.mapKey, state),
        ]
      : []),
  ];
  const declarations: NativeResourceRecipe["declarations"] = [
    ...typeRoles.slice(0, shapes.length).map((role, index) => ({
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
      key: key + ":prototypeInitializer",
      role: ["realm-carrier", "prototype-state-initializer"],
      space: "function",
      name: initializerNames.prototypeInitializer,
      signature: { params: [{ kind: "externref" }], results: [{ kind: "ref", typeKey: state }] },
    },
    {
      key: key + ":sourceInitializer",
      role: ["realm-carrier", "source-state-initializer"],
      space: "function",
      name: initializerNames.sourceInitializer,
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
export function declareNativeRealmObjectState(key: string): NativeResourceRecipe {
  return declareRealmLayouts(key);
}
export function declareNativeRealmObjectLayouts(key: string, objectKey: string, mapKey: string): NativeResourceRecipe {
  return declareRealmLayouts(key, { objectKey, mapKey });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourceDependencies: NativeRealmObjectLayoutDependencies | undefined;
  readonly dependencies: NativeRealmObjectLayoutDependencies | undefined;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly tokens: readonly (TypeReservation | GlobalReservation | FunctionReservation)[];
  readonly initializerHeaders: ReadonlyMap<FunctionReservation, { readonly name: string; readonly typeIdx: number }>;
  bootstrap?: FunctionReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeRealmObjectStateReservations, Owner>();

function reserveRealmLayouts(
  tx: PhysicalModuleReservations,
  key: string,
  sourceDependencies: NativeRealmObjectLayoutDependencies | undefined,
  expectedPlan: NativeResourceRecipe,
): NativeRealmObjectStateReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const captured = sourceDependencies
    ? (Object.freeze(data(sourceDependencies, dependencyRoles)) as unknown as NativeRealmObjectLayoutDependencies)
    : undefined;
  const prerequisites = captured ? dependencies(tx, captured) : new Map<string, TypeReservation>();
  const plan = captured
    ? declareNativeRealmObjectLayouts(key, captured.objects.object.key, captured.objects.propMap.key)
    : declareNativeRealmObjectState(key);
  const selectedTypes = typeRoles.slice(0, captured ? 4 : 2);
  if (preparedIrDataMismatch(preflightNativeResourceRecipe(expectedPlan, [...prerequisites.keys()]), plan))
    fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, prerequisites);
  const type = (role: (typeof typeRoles)[number]) =>
    requireNativeDeclaredReservation(records, key + ":" + role, "type");
  const types = Object.freeze({
    identity: type("identity"),
    state: type("state"),
    ...(captured ? { objectPrototype: type("objectPrototype"), ordinary: type("ordinary") } : {}),
  });
  const pack = Object.freeze({
    types,
    anchors: Object.freeze({
      realm: requireNativeDeclaredReservation(records, key + ":realm", "global"),
      functionPrototype: requireNativeDeclaredReservation(records, key + ":functionPrototype", "global"),
    }),
    prototypeInitializer: requireNativeDeclaredReservation(records, key + ":prototypeInitializer", "function"),
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
      ...selectedTypes.map((role) => types[role]!),
      pack.anchors.realm,
      pack.anchors.functionPrototype,
      ...initializerRoles.map((role) => pack[role]),
    ]),
    initializerHeaders: new Map(
      initializerRoles.map((role) => [
        pack[role],
        { name: initializerNames[role], typeIdx: pack[role].object.typeIdx },
      ]),
    ),
    filled: false,
  });
  return pack;
}

export function reserveNativeRealmObjectState(
  tx: PhysicalModuleReservations,
  key: string,
  plan = declareNativeRealmObjectState(key),
): NativeRealmObjectStateReservations {
  return reserveRealmLayouts(tx, key, undefined, plan);
}
export function reserveNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  key: string,
  storage: NativeRealmObjectLayoutDependencies,
  plan: NativeResourceRecipe,
): NativeRealmObjectLayoutReservations {
  const pack = reserveRealmLayouts(tx, key, storage, plan);
  if (!("objectPrototype" in pack.types) || !("ordinary" in pack.types)) fail("missing full object layout types");
  return pack as NativeRealmObjectLayoutReservations;
}

export function requireNativeRealmObjectState<T extends NativeRealmObjectStateReservations>(
  tx: PhysicalModuleReservations,
  pack: T,
  expectedDependencies?: NativeRealmObjectLayoutDependencies,
): T {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied layout owner");
  if (expectedDependencies !== undefined) {
    const expected = data(expectedDependencies, dependencyRoles);
    if (dependencyRoles.some((role) => expected[role] !== owner.dependencies?.[role]))
      fail("foreign expected dependencies");
  }
  if (owner.sourceDependencies) {
    const current = data(owner.sourceDependencies, dependencyRoles);
    if (dependencyRoles.some((role) => current[role] !== owner.dependencies?.[role]))
      fail("changed dependency identity");
  }
  const prerequisites = owner.dependencies ? dependencies(tx, owner.dependencies) : new Map<string, TypeReservation>();
  const selectedTypes = typeRoles.slice(0, owner.dependencies ? 4 : 2);
  const actualTypes = pack.types as Partial<NativeRealmObjectLayoutReservations["types"]>;
  if (
    preparedIrDataMismatch(preflightNativeResourceRecipe(owner.sourcePlan, [...prerequisites.keys()]), owner.plan) ||
    preparedIrDataMismatch(
      owner.dependencies
        ? declareNativeRealmObjectLayouts(
            owner.key,
            owner.dependencies.objects.object.key,
            owner.dependencies.objects.propMap.key,
          )
        : declareNativeRealmObjectState(owner.key),
      owner.plan,
    )
  )
    fail("changed retained declaration plan");
  const tokens = [
    ...selectedTypes.map((role) => actualTypes[role]!),
    pack.anchors.realm,
    pack.anchors.functionPrototype,
    ...initializerRoles.map((role) => pack[role]),
  ];
  if (owner.tokens.some((token, index) => token !== tokens[index])) fail("substituted reservation token");
  const types = new Map([
    ...prerequisites,
    ...selectedTypes.map((role) => [actualTypes[role]!.key, actualTypes[role]!] as const),
  ]);
  owner.tokens.forEach((token, index) => {
    if (tx.state !== "reserving") tx.physicalIndex(token);
    else if (token.kind === "type") tx.assertTypeReservation(token);
    if (token.kind === "function") {
      const expected = owner.initializerHeaders.get(token);
      if (!expected || token.object.name !== expected.name || token.object.typeIdx !== expected.typeIdx)
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

export function requireNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
  expected?: NativeRealmObjectLayoutDependencies,
): NativeRealmObjectLayoutReservations {
  requireNativeRealmObjectState(tx, pack, expected);
  if (!owners.get(pack)!.dependencies) fail("state-only owner cannot certify ordinary object layouts");
  return pack;
}

/** The composition owner supplies its actual bootstrap; this does not certify the standard realm graph. */
export function bindNativeRealmObjectBootstrap(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectStateReservations,
  initialize: FunctionReservation,
): void {
  requireNativeRealmObjectState(tx, pack);
  const owner = owners.get(pack)!;
  if (tx.state !== "reserving" || owner.filled || owner.bootstrap) fail("invalid or duplicate bootstrap binding");
  tx.assertFunctionReservation(initialize);
  if (initialize.object.typeIdx !== tx.internFunctionType([], [])) fail("bootstrap requires () -> ()");
  owner.bootstrap = initialize;
}
export function requireNativeRealmObjectBootstrap(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectStateReservations,
  initialize: FunctionReservation,
): void {
  requireNativeRealmObjectState(tx, pack);
  if (owners.get(pack)!.bootstrap !== initialize) fail("foreign realm bootstrap");
  if (tx.state === "reserving") tx.assertFunctionReservation(initialize);
  else tx.physicalIndex(initialize);
}

function initializers(tx: PhysicalModuleReservations, pack: NativeRealmObjectStateReservations) {
  return {
    prototypeInitializer: buildRealmObjectStateInitializer({
      ...(owners.get(pack)!.bootstrap ? { initializeRealm: owners.get(pack)!.bootstrap!.handle } : {}),
      realmGlobal: tx.physicalIndex(pack.anchors.realm),
      stateType: tx.physicalIndex(pack.types.state),
    }),
    sourceInitializer: buildRealmSourceStateInitializer({
      ...(owners.get(pack)!.bootstrap ? { initializeRealm: owners.get(pack)!.bootstrap!.handle } : {}),
      prototypeGlobal: tx.physicalIndex(pack.anchors.functionPrototype),
      initializeState: pack.prototypeInitializer.handle,
    }),
  };
}
export function fillNativeRealmObjectState(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectStateReservations,
): void {
  requireNativeRealmObjectState(tx, pack);
  const owner = owners.get(pack)!;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  tx.fillGlobal(pack.anchors.realm, [{ op: "ref.null", typeIdx: pack.types.identity.typeIndex }]);
  tx.fillGlobal(pack.anchors.functionPrototype, [{ op: "ref.null.extern" }]);
  const bodies = initializers(tx, pack);
  for (const role of initializerRoles) tx.fillFunction(pack[role], bodies[role]);
  owner.filled = true;
}

/** Canonical types/initializer only. Runtime anchor values and public population remain unproved. */
export function requireCompletedNativeRealmObjectState<T extends NativeRealmObjectStateReservations>(
  tx: PhysicalModuleReservations,
  pack: T,
): T {
  requireNativeRealmObjectState(tx, pack);
  if (!owners.get(pack)!.filled) fail("missing canonical initializer fill");
  for (const token of [
    pack.anchors.realm,
    pack.anchors.functionPrototype,
    ...initializerRoles.map((role) => pack[role]),
  ])
    tx.assertCompletedReservation(token);
  const bodies = initializers(tx, pack);
  if (
    preparedIrDataMismatch(pack.anchors.realm.object.init, [
      { op: "ref.null", typeIdx: pack.types.identity.typeIndex },
    ]) ||
    preparedIrDataMismatch(pack.anchors.functionPrototype.object.init, [{ op: "ref.null.extern" }]) ||
    initializerRoles.some(
      (role) =>
        preparedIrDataMismatch({ locals: pack[role].object.locals, body: pack[role].object.body }, bodies[role]) !==
        undefined,
    )
  )
    fail("noncanonical anchor or initializer completion");
  return pack;
}

export function fillNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
): void {
  requireNativeRealmObjectLayouts(tx, pack);
  fillNativeRealmObjectState(tx, pack);
}
export function requireCompletedNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
): NativeRealmObjectLayoutReservations {
  requireNativeRealmObjectLayouts(tx, pack);
  return requireCompletedNativeRealmObjectState(tx, pack);
}

export function nativeRealmObjectStateReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectStateReservations,
) {
  requireNativeRealmObjectState(tx, pack);
  return Object.freeze({
    plan: owners.get(pack)!.plan,
    types: Object.freeze(Object.values(pack.types)),
    globals: Object.freeze([pack.anchors.realm, pack.anchors.functionPrototype]),
    functions: Object.freeze(initializerRoles.map((role) => pack[role])),
  });
}

export function nativeRealmObjectLayoutReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
) {
  requireNativeRealmObjectLayouts(tx, pack);
  return nativeRealmObjectStateReservationInventory(tx, pack);
}
