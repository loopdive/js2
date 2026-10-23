// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  buildRealmSourceStateInitializer,
  buildRealmObjectStateInitializer,
} from "../../../runtime/wasmgc/values/realm-object-layouts.js";
import { buildRealmOrdinaryObjectAllocation } from "../../../runtime/wasmgc/values/realm-object-allocation.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  requireNativeObjectLayouts,
  type NativeObjectLayoutReservations,
  type NativeObjectLayoutDeclarationPlan,
} from "./native-object-layouts.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

import {
  declareNativeRealmObjectState,
  declareNativeRealmObjectLayouts,
  declareNativeRealmObjectLayoutExtension,
} from "./native-realm-object-layout-declarations.js";
export {
  declareNativeRealmObjectState,
  declareNativeRealmObjectLayouts,
} from "./native-realm-object-layout-declarations.js";

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
  /** Internal allocation; public prototype admission belongs to the semantic provider. */
  readonly allocateOrdinary: FunctionReservation;
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

interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourceDependencies: NativeRealmObjectLayoutDependencies | undefined;
  readonly dependencies: NativeRealmObjectLayoutDependencies | undefined;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly tokens: readonly (TypeReservation | GlobalReservation | FunctionReservation)[];
  readonly initializerHeaders: ReadonlyMap<FunctionReservation, { readonly name: string; readonly typeIdx: number }>;
  readonly borrowed?: NativeRealmObjectStateReservations;
  bootstrap?: FunctionReservation;
  filled: boolean;
}
const owners = new WeakMap<NativeRealmObjectStateReservations, Owner>();
const extensions = new WeakMap<NativeRealmObjectStateReservations, NativeRealmObjectStateReservations>();

function layoutPlan(
  key: string,
  storage: NativeRealmObjectLayoutDependencies | undefined,
  borrowed: NativeRealmObjectStateReservations | undefined,
): NativeResourceRecipe {
  if (!storage) return declareNativeRealmObjectState(key);
  return borrowed
    ? declareNativeRealmObjectLayoutExtension(
        key,
        storage.objects.object.key,
        storage.objects.propMap.key,
        borrowed.types.state.key,
      )
    : declareNativeRealmObjectLayouts(key, storage.objects.object.key, storage.objects.propMap.key);
}
function layoutPrerequisites(
  tx: PhysicalModuleReservations,
  storage: NativeRealmObjectLayoutDependencies | undefined,
  borrowed: NativeRealmObjectStateReservations | undefined,
) {
  const prerequisites = storage ? dependencies(tx, storage) : new Map<string, TypeReservation>();
  if (borrowed) {
    requireNativeRealmObjectState(tx, borrowed);
    for (const token of Object.values(borrowed.types)) prerequisites.set(token.key, token);
  }
  return prerequisites;
}
function selectedTypeRoles(owner: Pick<Owner, "dependencies" | "borrowed">) {
  return typeRoles.slice(owner.borrowed ? 2 : 0, owner.dependencies ? 4 : 2);
}

function reserveRealmLayouts(
  tx: PhysicalModuleReservations,
  key: string,
  sourceDependencies: NativeRealmObjectLayoutDependencies | undefined,
  expectedPlan: NativeResourceRecipe | undefined,
  borrowed?: NativeRealmObjectStateReservations,
): NativeRealmObjectStateReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const captured = sourceDependencies
    ? (Object.freeze(data(sourceDependencies, dependencyRoles)) as unknown as NativeRealmObjectLayoutDependencies)
    : undefined;
  const prerequisites = layoutPrerequisites(tx, captured, borrowed);
  const plan = layoutPlan(key, captured, borrowed);
  const selectedTypes = selectedTypeRoles({ dependencies: captured, borrowed });
  const sourcePlan = expectedPlan ?? plan;
  if (preparedIrDataMismatch(preflightNativeResourceRecipe(sourcePlan, [...prerequisites.keys()]), plan))
    fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, prerequisites);
  const type = (role: (typeof typeRoles)[number]) =>
    requireNativeDeclaredReservation(records, key + ":" + role, "type");
  const types = Object.freeze({
    identity: borrowed?.types.identity ?? type("identity"),
    state: borrowed?.types.state ?? type("state"),
    ...(captured ? { objectPrototype: type("objectPrototype"), ordinary: type("ordinary") } : {}),
  });
  const allocateOrdinary = captured
    ? requireNativeDeclaredReservation(records, key + ":allocateOrdinary", "function")
    : undefined;
  const pack = Object.freeze({
    ...(allocateOrdinary ? { allocateOrdinary } : {}),
    types,
    anchors:
      borrowed?.anchors ??
      Object.freeze({
        realm: requireNativeDeclaredReservation(records, key + ":realm", "global"),
        functionPrototype: requireNativeDeclaredReservation(records, key + ":functionPrototype", "global"),
      }),
    prototypeInitializer:
      borrowed?.prototypeInitializer ??
      requireNativeDeclaredReservation(records, key + ":prototypeInitializer", "function"),
    sourceInitializer:
      borrowed?.sourceInitializer ?? requireNativeDeclaredReservation(records, key + ":sourceInitializer", "function"),
    completionScope: "realm-carrier-state-only" as const,
  });
  owners.set(pack, {
    tx,
    key,
    sourceDependencies,
    dependencies: captured,
    sourcePlan,
    plan,
    ...(borrowed ? { borrowed } : {}),
    tokens: Object.freeze([
      ...selectedTypes.map((role) => types[role]!),
      ...(borrowed
        ? []
        : [pack.anchors.realm, pack.anchors.functionPrototype, ...initializerRoles.map((role) => pack[role])]),
      ...(allocateOrdinary ? [allocateOrdinary] : []),
    ]),
    initializerHeaders: new Map<FunctionReservation, { name: string; typeIdx: number }>([
      ...initializerRoles.map(
        (role) => [pack[role], { name: initializerNames[role], typeIdx: pack[role].object.typeIdx }] as const,
      ),
      ...(allocateOrdinary
        ? [
            [
              allocateOrdinary,
              { name: "__realm_ordinary_object_new", typeIdx: allocateOrdinary.object.typeIdx },
            ] as const,
          ]
        : []),
    ]),
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

/** The original state keeps sole ownership of anchors, initializers and bootstrap. */
export function extendNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  key: string,
  state: NativeRealmObjectStateReservations,
  storage: NativeRealmObjectLayoutDependencies,
  plan?: NativeResourceRecipe,
): NativeRealmObjectLayoutReservations {
  requireNativeRealmObjectState(tx, state);
  if (owners.get(state)!.dependencies || extensions.has(state)) fail("state already has ordinary object layouts");
  const pack = reserveRealmLayouts(tx, key, storage, plan, state) as NativeRealmObjectLayoutReservations;
  extensions.set(state, pack);
  return pack;
}

/** Issued identity of the common owner, never inferred from matching type coordinates. */
export function nativeRealmObjectStateOwner(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectStateReservations,
): NativeRealmObjectStateReservations {
  requireNativeRealmObjectState(tx, pack);
  return owners.get(pack)!.borrowed ?? pack;
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
  const prerequisites = layoutPrerequisites(tx, owner.dependencies, owner.borrowed);
  const selectedTypes = selectedTypeRoles(owner);
  const actualTypes = pack.types as Partial<NativeRealmObjectLayoutReservations["types"]>;
  if (
    preparedIrDataMismatch(preflightNativeResourceRecipe(owner.sourcePlan, [...prerequisites.keys()]), owner.plan) ||
    preparedIrDataMismatch(layoutPlan(owner.key, owner.dependencies, owner.borrowed), owner.plan)
  )
    fail("changed retained declaration plan");
  const tokens = [
    ...selectedTypes.map((role) => actualTypes[role]!),
    ...(owner.borrowed
      ? []
      : [pack.anchors.realm, pack.anchors.functionPrototype, ...initializerRoles.map((role) => pack[role])]),
    ...(owner.dependencies && "allocateOrdinary" in pack ? [pack.allocateOrdinary] : []),
  ];
  if (
    owner.borrowed &&
    (extensions.get(owner.borrowed) !== pack ||
      pack.types.identity !== owner.borrowed.types.identity ||
      pack.types.state !== owner.borrowed.types.state ||
      pack.anchors !== owner.borrowed.anchors ||
      initializerRoles.some((role) => pack[role] !== owner.borrowed![role]))
  )
    fail("substituted borrowed state owner");
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
  const owner = owners.get(nativeRealmObjectStateOwner(tx, pack))!;
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
  if (owners.get(nativeRealmObjectStateOwner(tx, pack))!.bootstrap !== initialize) fail("foreign realm bootstrap");
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
  if (owner.borrowed) fail("borrowed state must be filled by its original owner");
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  tx.fillGlobal(pack.anchors.realm, [{ op: "ref.null", typeIdx: pack.types.identity.typeIndex }]);
  tx.fillGlobal(pack.anchors.functionPrototype, [{ op: "ref.null.extern" }]);
  const bodies = initializers(tx, pack);
  for (const role of initializerRoles) tx.fillFunction(pack[role], bodies[role]);
  if (owner.dependencies) fillOrdinaryAllocation(tx, pack as NativeRealmObjectLayoutReservations);
  owner.filled = true;
}

function ordinaryAllocation(tx: PhysicalModuleReservations, pack: NativeRealmObjectLayoutReservations) {
  const storage = owners.get(pack)!.dependencies!.objects;
  return buildRealmOrdinaryObjectAllocation(
    {
      objectTypeIdx: tx.physicalIndex(storage.object),
      propMapTypeIdx: tx.physicalIndex(storage.propMap),
      initialCapacity: 8,
    },
    tx.physicalIndex(pack.types.ordinary),
    pack.prototypeInitializer.handle,
  );
}
function fillOrdinaryAllocation(tx: PhysicalModuleReservations, pack: NativeRealmObjectLayoutReservations): void {
  tx.fillFunction(pack.allocateOrdinary, ordinaryAllocation(tx, pack));
}
function checkOrdinaryAllocation(tx: PhysicalModuleReservations, pack: NativeRealmObjectStateReservations): void {
  if (!owners.get(pack)!.dependencies) return;
  const full = pack as NativeRealmObjectLayoutReservations;
  tx.assertCompletedReservation(full.allocateOrdinary);
  if (
    preparedIrDataMismatch(
      { locals: full.allocateOrdinary.object.locals, body: full.allocateOrdinary.object.body },
      ordinaryAllocation(tx, full),
    )
  )
    fail("noncanonical ordinary allocation completion");
}

/** Canonical types/initializer only. Runtime anchor values and public population remain unproved. */
export function requireCompletedNativeRealmObjectState<T extends NativeRealmObjectStateReservations>(
  tx: PhysicalModuleReservations,
  pack: T,
): T {
  requireNativeRealmObjectState(tx, pack);
  const owner = owners.get(pack)!;
  if (owner.borrowed) {
    if (!owner.filled) fail("missing canonical layout extension fill");
    requireCompletedNativeRealmObjectState(tx, owner.borrowed);
    checkOrdinaryAllocation(tx, pack);
    return pack;
  }
  if (!owner.filled) fail("missing canonical initializer fill");
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
  checkOrdinaryAllocation(tx, pack);
  return pack;
}

export function fillNativeRealmObjectLayouts(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
): void {
  requireNativeRealmObjectLayouts(tx, pack);
  const owner = owners.get(pack)!;
  if (owner.borrowed) {
    if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
    requireCompletedNativeRealmObjectState(tx, owner.borrowed);
    fillOrdinaryAllocation(tx, pack);
    owner.filled = true;
  } else fillNativeRealmObjectState(tx, pack);
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
    types: Object.freeze(
      selectedTypeRoles(owners.get(pack)!).map(
        (role) => (pack.types as NativeRealmObjectLayoutReservations["types"])[role],
      ),
    ),
    globals: Object.freeze(owners.get(pack)!.borrowed ? [] : [pack.anchors.realm, pack.anchors.functionPrototype]),
    functions: Object.freeze(
      owners.get(pack)!.tokens.filter((token): token is FunctionReservation => token.kind === "function"),
    ),
  });
}

export function nativeRealmObjectLayoutReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeRealmObjectLayoutReservations,
) {
  requireNativeRealmObjectLayouts(tx, pack);
  return nativeRealmObjectStateReservationInventory(tx, pack);
}
