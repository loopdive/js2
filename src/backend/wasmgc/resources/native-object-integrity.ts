// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import type { NativeObjectRealmDeclarations, NativeObjectRealmEntry } from "./native-object-realm.js";
import {
  requireNativeObjectAlgorithmDependencies,
  requireCompletedNativeObjectAlgorithmDependencies,
  type NativeObjectExtensibilityDependencies,
} from "./native-object-structural-algorithms.js";
import { nativeMixedObjectAccessOperands } from "./native-mixed-object-access.js";
import {
  nativeRealmPopulationDependencies,
  requireCompletedNativeRealmPopulation,
  type NativeRealmPopulation,
} from "./native-realm-population.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
import { buildBuiltinFunctionCheckedEntryDefinition } from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import { buildNativeObjectExtensibilityDefinition } from "../../../runtime/wasmgc/values/native-object-extensibility-bodies.js";
import {
  buildNativeIntegrityDefinition,
  buildNativeIntegrityStorageDefinition,
} from "../../../runtime/wasmgc/values/native-object-integrity-bodies.js";

const methods = [
  { id: "%Object.freeze%", mutate: true, frozen: true },
  { id: "%Object.seal%", mutate: true, frozen: false },
  { id: "%Object.isFrozen%", mutate: false, frozen: true },
  { id: "%Object.isSealed%", mutate: false, frozen: false },
] as const;
export interface NativeObjectIntegrityAlgorithms {
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly storage: FunctionReservation;
  readonly operations: readonly FunctionReservation[];
  readonly intrinsicPopulation?: NativeRealmPopulation;
  /** Source descriptor populations and foreign admission remain gaps. */
  readonly completionScope: "selected-native-integrity-calls";
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeObjectExtensibilityDependencies;
  readonly captured: NativeObjectExtensibilityDependencies;
  readonly pack: NativeObjectIntegrityAlgorithms;
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativeObjectIntegrityAlgorithms, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(detail: string): never {
  throw Error("native Object integrity: " + detail);
}
function population(
  tx: PhysicalModuleReservations,
  d: NativeObjectExtensibilityDependencies,
  selected: NativeRealmPopulation | undefined,
): void {
  if (selected === undefined) return;
  const p = nativeRealmPopulationDependencies(tx, selected);
  const m = d.mixedDependencies;
  const descriptors = p.descriptorDependencies;
  const values = descriptors.sameValueDependencies;
  if (
    p.realm !== m.realm ||
    p.realmDependencies !== m.realmDependencies ||
    descriptors.closures !== m.realmDependencies.closures ||
    descriptors.storageDependencies.lookup !== m.stringOwnDependencies.lookup ||
    descriptors.storageDependencies.lookupDependencies !== m.stringOwnDependencies.lookupDependencies ||
    descriptors.errors !== d.errors ||
    descriptors.errorRequirements !== d.errorRequirements ||
    descriptors.errorDependencies !== d.errorDependencies ||
    values.values !== m.values ||
    values.valuePlan !== m.valuePlan ||
    values.valueDependencies !== m.valueDependencies ||
    values.booleans !== d.primitiveDependencies.booleans ||
    values.bigints !== d.primitiveDependencies.bigints ||
    values.bigintPlan !== d.primitiveDependencies.bigintPlan ||
    values.strings !== d.primitiveDependencies.strings ||
    values.flatten !== m.stringOwnDependencies.lookupDependencies.flatten ||
    values.equality !== m.stringOwnDependencies.lookupDependencies.equality
  )
    fail("population does not share the original realm/value/descriptor owners");
}
function current(tx: PhysicalModuleReservations, pack: NativeObjectIntegrityAlgorithms): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.pack !== pack) fail("foreign or copied algorithm owner");
  const captured = requireNativeObjectAlgorithmDependencies(tx, owner.original);
  population(tx, captured, pack.intrinsicPopulation);
  for (const key of Object.keys(owner.captured) as (keyof NativeObjectExtensibilityDependencies)[])
    if (owner.captured[key] !== captured[key]) fail("changed dependency identity");
  if (pack.realm !== captured.mixedDependencies.realm) fail("different original realm");
  if (pack.entries.some((entry, i) => entry !== entries(pack.realm)[i])) fail("changed catalog slots");
  return owner;
}
function entries(realm: NativeObjectRealmDeclarations) {
  return methods.map(({ id }) => {
    const selected = realm.entries.filter((entry) => entry.request.intrinsic.id === id);
    const entry = selected[0];
    if (selected.length !== 1 || !entry || entry.construct || entry.request.intrinsic.callable.length !== 1)
      fail("missing actual non-constructor catalog slot");
    return entry;
  });
}
export function reserveNativeObjectIntegrityAlgorithms(
  tx: PhysicalModuleReservations,
  original: NativeObjectExtensibilityDependencies,
  intrinsicPopulation?: NativeRealmPopulation,
): NativeObjectIntegrityAlgorithms {
  if (tx.state !== "reserving") fail("reservation phase required");
  const captured = Object.freeze(requireNativeObjectAlgorithmDependencies(tx, original));
  population(tx, captured, intrinsicPopulation);
  const realm = captured.mixedDependencies.realm;
  if (realms.has(realm)) fail("realm already has its integrity algorithm owner");
  const selected = Object.freeze(entries(realm));
  const layout = captured.mixedDependencies.stringOwnDependencies.layoutDependencies.objects;
  const key = realm.requests.key + ":integrity";
  tx.assertReservationKeysAvailable([key + ":storage", ...methods.map(({ id }) => key + ":" + id)]);
  const storage = tx.reserveFunction(key + ":storage", key + ":storage", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }, { kind: "ref_null", typeIdx: layout.object.typeIndex }],
  });
  const operations = Object.freeze(
    methods.map(({ id }) =>
      tx.reserveFunction(key + ":" + id, key + ":" + id, {
        params: [{ kind: "externref" }],
        results: [{ kind: "i32" }],
      }),
    ),
  );
  const pack = Object.freeze({
    realm,
    entries: selected,
    storage,
    operations,
    ...(intrinsicPopulation === undefined ? {} : { intrinsicPopulation }),
    completionScope: "selected-native-integrity-calls" as const,
  });
  owners.set(pack, { tx, original, captured, pack, phase: "reserved" });
  realms.add(realm);
  return pack;
}
export function requireNativeObjectIntegrityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectIntegrityAlgorithms,
  expected: NativeObjectExtensibilityDependencies,
): NativeObjectIntegrityAlgorithms {
  if (current(tx, pack).original !== expected) fail("different original dependencies");
  return pack;
}
function definitions(tx: PhysicalModuleReservations, owner: Owner) {
  const d = owner.captured,
    m = d.mixedDependencies,
    pack = owner.pack;
  const layout = m.stringOwnDependencies.layoutDependencies.objects;
  const mixed = nativeMixedObjectAccessOperands(tx, d.mixed, m);
  const populationState =
    pack.intrinsicPopulation === undefined ? undefined : tx.physicalIndex(pack.realm.globals.state);
  const failure = (text: string): Instr[] => {
    const literal = requireNativeStringLiteral(tx, d.errorDependencies.strings, text);
    return [
      literal.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(literal.global) }
        : { op: "call", funcIdx: literal.function.handle },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: d.errors.newTypeError.handle },
      { op: "throw", tagIdx: tx.physicalIndex(pack.realm.exception.tag) },
    ];
  };
  return {
    storage: buildNativeIntegrityStorageDefinition(mixed, populationState),
    methods: methods.map((method, index) => {
      const entry = pack.entries[index]!;
      return {
        operation: buildNativeIntegrityDefinition(
          {
            objectTypeIdx: layout.object.typeIndex,
            mapTypeIdx: layout.propMap.typeIndex,
            entryTypeIdx: layout.propEntry.typeIndex,
            storage: pack.storage.handle,
          },
          method.mutate,
          method.frozen,
        ),
        algorithm: buildNativeObjectExtensibilityDefinition(
          {
            vectorTypeIdx: m.realmDependencies.substrate.arguments.carrier.typeIndex,
            vectorArrayTypeIdx: m.realmDependencies.substrate.arguments.array.typeIndex,
            undefinedGlobal: tx.physicalIndex(m.values.globals.undefined),
            undefinedTypeIdx: m.values.types.anyValue.typeIndex,
            isPrimitive: d.primitives.isPrimitive.handle,
            operation: pack.operations[index]!.handle,
            boxBoolean: d.booleanBoxes.boxBoolean.handle,
            primitiveResult: 1,
            throwTypeError: failure("TypeError"),
          },
          method.mutate,
        ),
        lifted: buildBuiltinFunctionCheckedEntryDefinition({
          identity: {
            typeIdx: entry.type.typeIndex,
            metadataId: entry.metadata.metadata.id,
            liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
            singleton: tx.physicalIndex(entry.singleton),
            singletonExtern: false,
            realm: tx.physicalIndex(pack.realm.globals.realm),
          },
          failure: failure("TypeError: incompatible native builtin function"),
          algorithm: entry.algorithm.handle,
        }),
      };
    }),
  };
}
export function fillNativeObjectIntegrityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectIntegrityAlgorithms,
): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.phase !== "reserved") fail("invalid phase or duplicate/failed fill");
  requireCompletedNativeObjectAlgorithmDependencies(tx, owner.captured);
  if (pack.intrinsicPopulation) requireCompletedNativeRealmPopulation(tx, pack.intrinsicPopulation);
  const bodies = definitions(tx, owner);
  owner.phase = "filling";
  try {
    tx.fillFunction(pack.storage, bodies.storage);
    pack.entries.forEach((entry, i) => {
      tx.fillFunction(pack.operations[i]!, bodies.methods[i]!.operation);
      tx.fillFunction(entry.algorithm, bodies.methods[i]!.algorithm);
      tx.fillFunction(entry.lifted, bodies.methods[i]!.lifted);
    });
    owner.phase = "complete";
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
export function requireCompletedNativeObjectIntegrityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectIntegrityAlgorithms,
  expected: NativeObjectExtensibilityDependencies,
): NativeObjectIntegrityAlgorithms {
  requireNativeObjectIntegrityAlgorithms(tx, pack, expected);
  const owner = current(tx, pack);
  if (owner.phase !== "complete") fail("missing canonical algorithm fill");
  requireCompletedNativeObjectAlgorithmDependencies(tx, owner.captured);
  if (pack.intrinsicPopulation) requireCompletedNativeRealmPopulation(tx, pack.intrinsicPopulation);
  const bodies = definitions(tx, owner);
  tx.assertCanonicalFunctionDefinition(pack.storage, bodies.storage);
  pack.entries.forEach((entry, i) => {
    tx.assertCanonicalFunctionDefinition(pack.operations[i]!, bodies.methods[i]!.operation);
    tx.assertCanonicalFunctionDefinition(entry.algorithm, bodies.methods[i]!.algorithm);
    tx.assertCanonicalFunctionDefinition(entry.lifted, bodies.methods[i]!.lifted);
  });
  return pack;
}
