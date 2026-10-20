// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES,
  type NativePrimitivePrototypeKind,
} from "../../../runtime/contracts/native-primitive-prototype-identities.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { NativeObjectRealmDeclarations } from "./native-object-realm.js";
import {
  requireNativeMixedObjectAccessReservations,
  requireCompletedNativeMixedObjectAccessStructure,
  type NativeMixedObjectAccessReservations,
  type NativeMixedObjectAccessDependencies,
} from "./native-mixed-object-access.js";
import {
  requireNativePrimitiveWrapperStorageReservations,
  requireCompletedNativePrimitiveWrapperStorage,
  type NativePrimitiveWrapperStorageReservations,
  type NativePrimitiveWrapperStoragePlan,
  type NativePrimitiveWrapperStorageDependencies,
} from "./native-primitive-wrapper-storage.js";
import {
  requireNativeStringCreateReservations,
  requireCompletedNativeStringCreate,
  type NativeStringCreateReservations,
  type NativeStringCreateDependencies,
} from "./native-string-create.js";
import { requireNativeStringLiteral, nativeStringLiteralReservationInventory } from "./native-string-literals.js";
import { planNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import { buildRealmObjectConstructionAllocation } from "../../../runtime/wasmgc/values/object-construction-definition.js";
import {
  primitivePrototypeIdentityDeclaration,
  buildPrimitivePrototypeIdentityInitializer,
  buildPrimitivePrototypeIdentityRead,
  type PrimitivePrototypeIdentityOperands,
} from "../../../runtime/wasmgc/values/primitive-prototype-identity-bodies.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
  compareNativeResourceDeclarationShape,
  instantiateNativeDeclaredSignature,
} from "./native-resource-declarations.js";

export interface NativePrimitivePrototypeIdentityDependencies {
  readonly mixed: NativeMixedObjectAccessReservations;
  readonly mixedDependencies: NativeMixedObjectAccessDependencies;
  readonly wrappers: NativePrimitiveWrapperStorageReservations;
  readonly wrapperPlan: NativePrimitiveWrapperStoragePlan;
  readonly wrapperDependencies: NativePrimitiveWrapperStorageDependencies;
  readonly stringCreate: NativeStringCreateReservations;
  readonly stringCreateDependencies: NativeStringCreateDependencies;
}
/** Actual bootstrap identities/payloads, NOT constructor/member or public provider completion. */
export interface NativePrimitivePrototypeIdentities {
  readonly realm: NativeObjectRealmDeclarations;
  readonly catalog: typeof NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES;
  readonly initialize: FunctionReservation;
  readonly read: Readonly<Record<NativePrimitivePrototypeKind, FunctionReservation>>;
  readonly completionScope: "primitive-prototype-identities-only";
}
const roles = [
  "mixed",
  "mixedDependencies",
  "wrappers",
  "wrapperPlan",
  "wrapperDependencies",
  "stringCreate",
  "stringCreateDependencies",
] as const;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativePrimitivePrototypeIdentityDependencies;
  readonly dependencies: NativePrimitivePrototypeIdentityDependencies;
  readonly plan: NativeResourceRecipe;
  readonly capsule: TypeReservation;
  readonly state: GlobalReservation;
  readonly ordinary: FunctionReservation;
  readonly functions: readonly FunctionReservation[];
  readonly read: NativePrimitivePrototypeIdentities["read"];
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativePrimitivePrototypeIdentities, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(detail: string): never {
  throw Error("native primitive prototype identities: " + detail);
}
function dependencies(tx: PhysicalModuleReservations, input: NativePrimitivePrototypeIdentityDependencies) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("plain dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== roles.length) fail("unexpected dependency roles");
  for (const role of roles)
    if (!fields[role] || !Object.hasOwn(fields[role]!, "value") || !fields[role]!.enumerable)
      fail("own dependency data required");
  const d = Object.fromEntries(
    roles.map((role) => [role, fields[role]!.value]),
  ) as unknown as NativePrimitivePrototypeIdentityDependencies;
  requireNativeMixedObjectAccessReservations(tx, d.mixed, d.mixedDependencies);
  requireNativePrimitiveWrapperStorageReservations(tx, d.wrappers, d.wrapperPlan, d.wrapperDependencies);
  requireNativeStringCreateReservations(tx, d.stringCreate, d.stringCreateDependencies);
  const m = d.mixedDependencies,
    w = d.wrapperDependencies,
    s = d.stringCreateDependencies,
    own = m.stringOwnDependencies;
  if (
    w.layouts !== own.layouts ||
    w.layoutPlan !== own.layoutPlan ||
    w.layoutDependencies !== own.layoutDependencies ||
    w.layoutDependencies.realmState !== m.realm.layouts ||
    s.layouts !== w.layouts ||
    s.layoutPlan !== w.layoutPlan ||
    s.layoutDependencies !== w.layoutDependencies ||
    s.ownDescriptors !== m.stringOwn ||
    s.ownDescriptorDependencies !== own ||
    s.values !== m.values ||
    s.valuePlan !== m.valuePlan ||
    s.valueDependencies !== m.valueDependencies ||
    s.storageDependencies.lookup !== own.lookup ||
    s.storageDependencies.lookupDependencies !== own.lookupDependencies
  )
    fail("different realm/layout/value/string/storage owners");
  requireNativeStringLiteral(tx, w.layoutDependencies.strings, "");
  return d;
}
function recipe(d: NativePrimitivePrototypeIdentityDependencies): NativeResourceRecipe {
  const realm = d.mixedDependencies.realm,
    key = realm.realm.description.key + ":primitive-prototypes",
    capsule = key + ":capsule";
  const functions = [
    "ordinary-allocation",
    "initialize",
    ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => row.kind + ":read"),
  ];
  const declarations: NativeResourceRecipe["declarations"] = [
    {
      key: capsule,
      role: ["primitive-prototypes", "capsule"],
      space: "type",
      shape: primitivePrototypeIdentityDeclaration(realm.layouts.types.identity.key, realm.objectPrototype.type.key),
    },
    {
      key: key + ":state",
      role: ["primitive-prototypes", "state"],
      space: "global",
      name: "__primitive_prototype_state",
      valueType: { kind: "ref_null", typeKey: capsule },
      mutable: true,
    },
    ...functions.map((name, index) => ({
      key: key + ":" + name,
      role: ["primitive-prototypes", name],
      space: "function" as const,
      name: "__primitive_prototypes_" + name.replace(":", "_"),
      signature: {
        params: index === 0 ? [{ kind: "externref" as const }] : [],
        results: index === 1 ? [] : [{ kind: "externref" as const }],
      },
    })),
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
function types(d: NativePrimitivePrototypeIdentityDependencies, capsule?: TypeReservation) {
  const realm = d.mixedDependencies.realm;
  return new Map(
    [realm.layouts.types.identity, realm.objectPrototype.type, ...(capsule ? [capsule] : [])].map((t) => [t.key, t]),
  );
}
function current(tx: PhysicalModuleReservations, pack: NativePrimitivePrototypeIdentities): Owner {
  const o = owners.get(pack);
  if (!o || o.tx !== tx) fail("foreign or copied owner");
  const d = dependencies(tx, o.original);
  if (roles.some((role) => d[role] !== o.dependencies[role])) fail("changed dependency identity");
  if (
    pack.realm !== d.mixedDependencies.realm ||
    pack.catalog !== NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES ||
    pack.read !== o.read ||
    pack.initialize !== o.functions[1] ||
    pack.completionScope !== "primitive-prototype-identities-only"
  )
    fail("changed scope or issued tokens");
  const actual = [
    { key: o.capsule.key, space: "type" as const, definition: o.capsule.object },
    {
      key: o.state.key,
      space: "global" as const,
      header: { name: o.state.object.name, type: o.state.object.type, mutable: o.state.object.mutable },
    },
  ];
  const expected = recipe(d);
  expected.declarations
    .slice(0, 2)
    .forEach((row, index) => compareNativeResourceDeclarationShape(tx, row, actual[index]!, types(d, o.capsule)));
  o.functions.forEach((fn, index) => {
    const declaration = expected.declarations[index + 2]!;
    if (declaration.space !== "function") fail("missing fixed function declaration");
    const signature = instantiateNativeDeclaredSignature(tx, declaration.signature, types(d, o.capsule));
    if (
      fn.key !== declaration.key ||
      fn.object.name !== declaration.name ||
      fn.object.typeIdx !== tx.internFunctionType(signature.params, signature.results)
    )
      fail("changed fixed function declaration");
    if (tx.state !== "reserving") tx.physicalIndex(fn);
  });
  return o;
}
export function reserveNativePrimitivePrototypeIdentities(
  tx: PhysicalModuleReservations,
  input: NativePrimitivePrototypeIdentityDependencies,
): NativePrimitivePrototypeIdentities {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = Object.freeze(dependencies(tx, input)),
    realm = d.mixedDependencies.realm;
  if (realms.has(realm)) fail("realm already owns its primitive identities");
  const plan = recipe(d);
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, types(d));
  const capsule = requireNativeDeclaredReservation(records, plan.declarations[0]!.key, "type"),
    state = requireNativeDeclaredReservation(records, plan.declarations[1]!.key, "global"),
    functions = Object.freeze(
      plan.declarations.slice(2).map((row) => requireNativeDeclaredReservation(records, row.key, "function")),
    ),
    read = Object.freeze(
      Object.fromEntries(
        NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row, index) => [row.kind, functions[index + 2]!]),
      ) as Record<NativePrimitivePrototypeKind, FunctionReservation>,
    );
  const pack = Object.freeze({
    realm,
    catalog: NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES,
    initialize: functions[1]!,
    read,
    completionScope: "primitive-prototype-identities-only" as const,
  });
  owners.set(pack, {
    tx,
    original: input,
    dependencies: d,
    plan,
    capsule,
    state,
    ordinary: functions[0]!,
    functions,
    read,
    phase: "reserved",
  });
  realms.add(realm);
  return pack;
}
export function requireNativePrimitivePrototypeIdentities(
  tx: PhysicalModuleReservations,
  pack: NativePrimitivePrototypeIdentities,
  expected: NativePrimitivePrototypeIdentityDependencies,
): NativePrimitivePrototypeIdentities {
  const o = current(tx, pack);
  if (o.original !== expected) fail("different expected dependency owner");
  return pack;
}
function completedDependencies(tx: PhysicalModuleReservations, o: Owner) {
  const d = o.dependencies;
  requireCompletedNativeMixedObjectAccessStructure(tx, d.mixed, d.mixedDependencies);
  requireCompletedNativePrimitiveWrapperStorage(tx, d.wrappers, d.wrapperPlan, d.wrapperDependencies);
  requireCompletedNativeStringCreate(tx, d.stringCreate, d.stringCreateDependencies);
  const strings = d.wrapperDependencies.layoutDependencies.strings,
    binding = requireNativeStringLiteral(tx, strings, ""),
    inventory = nativeStringLiteralReservationInventory(tx, strings),
    request = inventory.requests.find((row) => row.binding === binding),
    canonical = ([undefined, "ascii", "wtf16", "utf8-guaranteed"] as const)
      .map((encoding) => planNativeStringLiteral(strings.layout, inventory.typePack.utf8Storage, "", encoding))
      .find((plan) => plan.key === request?.cacheKey);
  // Empty literals always have a direct leaf initializer, in either retained encoding.
  if (binding.kind !== "global" || canonical?.kind !== "global") fail("missing canonical empty-string leaf");
  tx.assertCanonicalGlobalInitializer(binding.global, canonical.init);
  return binding;
}
function definitions(tx: PhysicalModuleReservations, o: Owner, pack: NativePrimitivePrototypeIdentities) {
  const d = o.dependencies,
    realm = pack.realm,
    layout = realm.layouts,
    strings = d.wrapperDependencies.layoutDependencies.strings,
    empty = requireNativeStringLiteral(tx, strings, "");
  if (empty.kind !== "global") fail("missing direct empty-string leaf");
  const operands: PrimitivePrototypeIdentityOperands = {
    capsuleType: o.capsule.typeIndex,
    capsuleGlobal: tx.physicalIndex(o.state),
    realmGlobal: tx.physicalIndex(realm.globals.realm),
    objectPrototypeGlobal: tx.physicalIndex(realm.objectPrototype.singleton),
    classify: d.mixed.classify.handle,
    booleanAllocation: d.wrappers.allocation.Boolean.handle,
    numberAllocation: d.wrappers.allocation.Number.handle,
    stringCreate: d.stringCreate.create.handle,
    ordinaryAllocation: o.ordinary.handle,
    emptyString: [{ op: "global.get", index: tx.physicalIndex(empty.global) }],
  };
  return [
    buildRealmObjectConstructionAllocation({
      objectTypeIdx: d.wrapperDependencies.layoutDependencies.objects.object.typeIndex,
      propMapTypeIdx: d.wrapperDependencies.layoutDependencies.objects.propMap.typeIndex,
      ordinaryTypeIdx: layout.types.ordinary.typeIndex,
      stateTypeIdx: layout.types.state.typeIndex,
      realmGlobalIdx: tx.physicalIndex(realm.globals.realm),
    }),
    buildPrimitivePrototypeIdentityInitializer(operands),
    ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => buildPrimitivePrototypeIdentityRead(operands, row.kind)),
  ];
}
export function fillNativePrimitivePrototypeIdentities(
  tx: PhysicalModuleReservations,
  pack: NativePrimitivePrototypeIdentities,
): void {
  const o = current(tx, pack);
  if (tx.state !== "filling" || o.phase !== "reserved") fail("invalid phase or duplicate/failed fill");
  completedDependencies(tx, o);
  const bodies = definitions(tx, o, pack);
  o.phase = "filling";
  try {
    tx.fillGlobal(o.state, [{ op: "ref.null", typeIdx: o.capsule.typeIndex }]);
    o.functions.forEach((fn, index) => tx.fillFunction(fn, bodies[index]!));
    o.phase = "complete";
  } catch (error) {
    o.phase = "failed";
    throw error;
  }
}
export function requireCompletedNativePrimitivePrototypeIdentities(
  tx: PhysicalModuleReservations,
  pack: NativePrimitivePrototypeIdentities,
  expected: NativePrimitivePrototypeIdentityDependencies,
): NativePrimitivePrototypeIdentities {
  const o = current(tx, pack);
  if (o.original !== expected) fail("different expected dependency owner");
  if (o.phase !== "complete") fail("missing canonical identity bootstrap fill");
  completedDependencies(tx, o);
  tx.assertCanonicalGlobalInitializer(o.state, [{ op: "ref.null", typeIdx: o.capsule.typeIndex }]);
  const bodies = definitions(tx, o, pack);
  o.functions.forEach((fn, index) => tx.assertCanonicalFunctionDefinition(fn, bodies[index]!));
  return pack;
}
