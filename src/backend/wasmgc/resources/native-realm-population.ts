// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  buildRealmPopulationInitializer,
  type RealmPopulationOperands,
} from "../../../runtime/wasmgc/values/realm-population-bodies.js";
import { nativeObjectRealmInvocationBinding, type NativeObjectRealmCalls } from "./native-object-realm-calls.js";
import {
  requireCompletedNativeObjectRealmDeclarations,
  type NativeObjectRealmDeclarations,
} from "./native-object-realm.js";
import {
  nativeObjectDescriptorReservationInventory,
  requireCompletedNativeObjectDescriptors,
  type NativeObjectDescriptorReservations,
  type NativeObjectDescriptorDependencies,
} from "./native-object-descriptors.js";
import {
  nativeWellKnownSymbolProducer,
  requireCompletedNativeWellKnownSymbols,
  type NativeWellKnownSymbolReservations,
  type NativeWellKnownSymbolDependencies,
} from "./native-well-known-symbols.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";

export interface NativeRealmPopulationDependencies {
  readonly calls: NativeObjectRealmCalls;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly descriptorDependencies: NativeObjectDescriptorDependencies;
  readonly symbols: NativeWellKnownSymbolReservations;
  readonly symbolPlan: NativeResourceRecipe;
  readonly symbolDependencies: NativeWellKnownSymbolDependencies;
}
export interface NativeRealmPopulation {
  readonly realm: NativeObjectRealmDeclarations;
  readonly completionScope: "intrinsic-identities-and-descriptors";
}
const roles = [
  "calls",
  "descriptors",
  "descriptorDependencies",
  "symbols",
  "symbolPlan",
  "symbolDependencies",
] as const;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly input: NativeRealmPopulationDependencies;
  readonly dependencies: NativeRealmPopulationDependencies;
  filled: boolean;
}
const owners = new WeakMap<NativeRealmPopulation, Owner>();
const populations = new WeakSet<NativeObjectRealmDeclarations>();
function fail(message: string): never {
  throw Error("native realm population: " + message);
}
function capture(input: NativeRealmPopulationDependencies): NativeRealmPopulationDependencies {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("plain dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(fields).length !== roles.length ||
    roles.some((role) => !fields[role]?.enumerable || !Object.hasOwn(fields[role]!, "value"))
  )
    fail("exact own data dependencies required");
  return Object.freeze(
    Object.fromEntries(roles.map((role) => [role, fields[role]!.value])),
  ) as unknown as NativeRealmPopulationDependencies;
}
function authenticate(tx: PhysicalModuleReservations, d: NativeRealmPopulationDependencies) {
  const binding = nativeObjectRealmInvocationBinding(tx, d.calls),
    dd = d.descriptorDependencies;
  const descriptors = nativeObjectDescriptorReservationInventory(tx, d.descriptors, dd);
  const symbols = nativeWellKnownSymbolProducer(tx, d.symbols, "hasInstance", d.symbolPlan, d.symbolDependencies);
  const storage = dd.storageDependencies.lookupDependencies,
    sameValue = dd.sameValueDependencies;
  if (
    dd.closures !== binding.closures ||
    dd.errors !== binding.errors ||
    sameValue.values !== binding.values ||
    sameValue.booleans !== binding.booleans ||
    storage.strings !== binding.strings ||
    binding.realm.objectPrototype.type.object.kind !== "struct" ||
    storage.layouts.object.typeIndex !== binding.realm.objectPrototype.type.object.superTypeIdx ||
    d.symbolDependencies.strings !== binding.strings ||
    d.symbolDependencies.symbols !== storage.symbols ||
    dd.access.demands.program !== binding.realm.realm.program ||
    dd.access.demands.projection !== binding.realm.realm.projection
  )
    fail("different shared realm/descriptor/value/Symbol producers");
  if (binding.realm.entries[0]?.request.intrinsic.id !== "%Function.prototype%")
    fail("missing first Function.prototype allocation");
  return { binding, descriptors, symbols };
}
function current(tx: PhysicalModuleReservations, pack: NativeRealmPopulation) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  const d = capture(owner.input);
  if (roles.some((role) => d[role] !== owner.dependencies[role])) fail("changed dependency identity");
  const binding = authenticate(tx, d);
  if (binding.binding.realm !== pack.realm) fail("substituted realm");
  return { owner, ...binding };
}
/** Acquire the existing initializer slot once; no second realm anchor or closure population is reserved. */
export function reserveNativeRealmPopulation(
  tx: PhysicalModuleReservations,
  input: NativeRealmPopulationDependencies,
): NativeRealmPopulation {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const dependencies = capture(input),
    { binding } = authenticate(tx, dependencies);
  if (populations.has(binding.realm)) fail("realm already has a population owner");
  populations.add(binding.realm);
  const pack = Object.freeze({
    realm: binding.realm,
    completionScope: "intrinsic-identities-and-descriptors" as const,
  });
  owners.set(pack, { tx, input, dependencies, filled: false });
  return pack;
}
function operands(tx: PhysicalModuleReservations, pack: NativeRealmPopulation): RealmPopulationOperands {
  const { owner, binding, descriptors, symbols } = current(tx, pack),
    d = owner.dependencies;
  const lookup = d.descriptorDependencies.storageDependencies.lookupDependencies;
  const literal = (text: string, external = true): Instr[] => {
    const token = requireNativeStringLiteral(tx, binding.strings, text);
    return [
      token.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(token.global) }
        : { op: "call", funcIdx: token.function.handle },
      ...(external ? [{ op: "extern.convert_any" } as Instr] : []),
    ];
  };
  const realm = pack.realm;
  const objectIntrinsic = realm.realm.description.catalog.intrinsics.find((entry) => entry.id === "%Object.prototype%");
  if (!objectIntrinsic) fail("missing Object.prototype catalog entry");
  return {
    entries: realm.entries.map((entry) => ({
      intrinsic: entry.request.intrinsic,
      lifted: entry.lifted.handle,
      userFormalCount: entry.request.intrinsic.callable.length,
      metadataId: entry.metadata.metadata.id,
      initialName: literal(entry.request.intrinsic.callable.initialName, false),
      typeIdx: entry.type.typeIndex,
      singleton: tx.physicalIndex(entry.singleton),
      singletonExtern: entry.singleton.object.type.kind === "externref",
    })),
    objectPrototype: tx.physicalIndex(realm.objectPrototype.singleton),
    objectPrototypeType: realm.objectPrototype.type.typeIndex,
    objectIntrinsic,
    objectType: lookup.layouts.object.typeIndex,
    propMapType: lookup.layouts.propMap.typeIndex,
    realm: tx.physicalIndex(realm.globals.realm),
    realmType: realm.layouts.types.identity.typeIndex,
    state: tx.physicalIndex(realm.globals.state),
    createNull: d.descriptorDependencies.storage.createNull.handle,
    boxNumber: binding.values.functions.boxNumber.handle,
    defineData: descriptors.functions[0]!.handle,
    defineAccessor: descriptors.functions[1]!.handle,
    hasInstance: symbols.handle,
    literal,
    failure: [
      ...literal("TypeError: native builtin initialization failed"),
      { op: "call", funcIdx: binding.errors.newTypeError.handle },
      { op: "throw", tagIdx: tx.physicalIndex(binding.exception) },
    ],
  };
}
function completedDependencies(tx: PhysicalModuleReservations, pack: NativeRealmPopulation) {
  const { owner, binding, descriptors } = current(tx, pack),
    d = owner.dependencies;
  requireCompletedNativeObjectRealmDeclarations(tx, pack.realm);
  requireCompletedNativeObjectDescriptors(tx, d.descriptors, d.descriptorDependencies);
  requireCompletedNativeWellKnownSymbols(tx, d.symbols, d.symbolPlan, d.symbolDependencies);
  // The descriptor owner's retained exception must be the same physical exception as common Call.
  const tag = tx.physicalIndex(binding.exception);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("op" in value && value.op === "throw" && "tagIdx" in value && value.tagIdx !== tag)
      fail("descriptor owner uses another exception tag");
    Object.values(value).forEach(visit);
  };
  descriptors.functions.forEach((token) => visit(token.object.body));
  return owner;
}
export function fillNativeRealmPopulation(tx: PhysicalModuleReservations, pack: NativeRealmPopulation): void {
  const { owner } = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  completedDependencies(tx, pack);
  tx.fillFunction(pack.realm.initialize, buildRealmPopulationInitializer(operands(tx, pack)));
  owner.filled = true;
}
/** Canonical descriptor construction; consumers must still check runtime initialization and actual misses. */
export function requireCompletedNativeRealmPopulation(
  tx: PhysicalModuleReservations,
  pack: NativeRealmPopulation,
): NativeRealmPopulation {
  const owner = completedDependencies(tx, pack);
  if (!owner.filled) fail("missing canonical population fill");
  requireCanonicalNativeFunction(tx, pack.realm.initialize, buildRealmPopulationInitializer(operands(tx, pack)));
  return pack;
}

/** Issued descriptor population identity, independent of algorithm completion. */
export function nativeRealmPopulationBinding(
  tx: PhysicalModuleReservations,
  pack: NativeRealmPopulation,
  completed = false,
): NativeObjectRealmDeclarations {
  current(tx, pack);
  if (completed) requireCompletedNativeRealmPopulation(tx, pack);
  return pack.realm;
}
