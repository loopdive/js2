// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeObjectRealmDeclarations, NativeObjectRealmEntry } from "./native-object-realm.js";
import {
  requireNativeToObjectKernel,
  requireCompletedNativeToObjectKernel,
  type NativeToObjectKernel,
  type NativeToObjectDependencies,
} from "./native-to-object.js";
import { requireNativeStringLiteral, nativeStringLiteralReservationInventory } from "./native-string-literals.js";
import { planNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import { buildBuiltinFunctionCheckedEntryDefinition } from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import {
  buildNativeObjectToObjectDefinition,
  type NativeObjectToObjectOperation,
} from "../../../runtime/wasmgc/values/native-object-to-object-bodies.js";

export interface NativeObjectToObjectDependencies {
  readonly toObject: NativeToObjectKernel;
  readonly toObjectDependencies: NativeToObjectDependencies;
}
/** Actual catalog slots with a strict private native value ABI; not a complete public realm. */
export interface NativeObjectToObjectAlgorithms {
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly completionScope: "native-object-to-object-calls";
}
const methods: readonly (readonly [string, string, number, NativeObjectToObjectOperation])[] = [
  ["%Object.getPrototypeOf%", "getPrototypeOf", 1, "get-prototype"],
  ["%Object.prototype.valueOf%", "valueOf", 0, "value-of"],
  ["%get Object.prototype.__proto__%", "get __proto__", 0, "prototype-getter"],
];
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeObjectToObjectDependencies;
  readonly dependencies: NativeObjectToObjectDependencies;
  readonly entries: readonly NativeObjectRealmEntry[];
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativeObjectToObjectAlgorithms, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(detail: string): never {
  throw Error("native Object ToObject algorithms: " + detail);
}
function dependencies(tx: PhysicalModuleReservations, input: NativeObjectToObjectDependencies) {
  if (!input || ![null, Object.prototype].includes(Object.getPrototypeOf(input)))
    fail("plain own-data dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input),
    roles = ["toObject", "toObjectDependencies"] as const;
  if (Reflect.ownKeys(fields).length !== roles.length) fail("unexpected dependency roles");
  for (const role of roles)
    if (
      !fields[role] ||
      !Object.hasOwn(fields[role]!, "value") ||
      !fields[role]!.enumerable ||
      fields[role]!.value === undefined
    )
      fail("own enumerable dependency data required");
  const d = Object.fromEntries(
    roles.map((role) => [role, fields[role]!.value]),
  ) as unknown as NativeObjectToObjectDependencies;
  requireNativeToObjectKernel(tx, d.toObject, d.toObjectDependencies);
  return d;
}
function entries(tx: PhysicalModuleReservations, d: NativeObjectToObjectDependencies) {
  const realm = d.toObject.realm,
    m = d.toObjectDependencies.prototypeDependencies.mixedDependencies,
    ext = { kind: "externref" } as const,
    argv = { kind: "ref" as const, typeIdx: m.realmDependencies.substrate.arguments.carrier.typeIndex },
    self = { kind: "ref" as const, typeIdx: m.realmDependencies.closures.root.typeIndex };
  return methods.map(([id, name, length]) => {
    const matches = realm.entries.filter((entry) => entry.request.intrinsic.id === id),
      entry = matches[0];
    if (
      matches.length !== 1 ||
      !entry ||
      entry.construct ||
      entry.request.intrinsic.callable.initialName !== name ||
      entry.request.intrinsic.callable.length !== length
    )
      fail("missing actual fixed catalog entry");
    for (const [role, params] of [
      ["algorithm", [ext, argv]],
      ["lifted", [self, ext, argv]],
    ] as const) {
      const fn = entry[role],
        key = realm.requests.key + ":" + id + ":" + role;
      if (fn.key !== key || fn.object.name !== key || fn.object.typeIdx !== tx.internFunctionType([...params], [ext]))
        fail("changed fixed catalog function declaration");
      if (tx.state !== "reserving") tx.physicalIndex(fn);
    }
    return entry;
  });
}
export function reserveNativeObjectToObjectAlgorithms(
  tx: PhysicalModuleReservations,
  input: NativeObjectToObjectDependencies,
): NativeObjectToObjectAlgorithms {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = Object.freeze(dependencies(tx, input)),
    realm = d.toObject.realm;
  if (realms.has(realm)) fail("realm already has its ToObject catalog owner");
  const selected = Object.freeze(entries(tx, d)),
    pack = Object.freeze({ realm, entries: selected, completionScope: "native-object-to-object-calls" as const });
  owners.set(pack, { tx, original: input, dependencies: d, entries: selected, phase: "reserved" });
  realms.add(realm);
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeObjectToObjectAlgorithms) {
  const o = owners.get(pack);
  if (!o || o.tx !== tx) fail("foreign or copied catalog owner");
  const d = dependencies(tx, o.original);
  if (d.toObject !== o.dependencies.toObject || d.toObjectDependencies !== o.dependencies.toObjectDependencies)
    fail("changed dependency identity");
  if (
    pack.realm !== d.toObject.realm ||
    pack.entries !== o.entries ||
    pack.completionScope !== "native-object-to-object-calls"
  )
    fail("changed scope or issued entries");
  if (entries(tx, d).some((entry, index) => entry !== o.entries[index])) fail("changed actual catalog slots");
  return o;
}
export function requireNativeObjectToObjectAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectToObjectAlgorithms,
  expected: NativeObjectToObjectDependencies,
): NativeObjectToObjectAlgorithms {
  if (current(tx, pack).original !== expected) fail("different expected dependency owner");
  return pack;
}
const message = "TypeError: incompatible native builtin function";
function errorLiteral(tx: PhysicalModuleReservations, o: Owner) {
  const strings = o.dependencies.toObjectDependencies.errorDependencies.strings,
    binding = requireNativeStringLiteral(tx, strings, message),
    inventory = nativeStringLiteralReservationInventory(tx, strings),
    request = inventory.requests.find((row) => row.binding === binding);
  const plan = ([undefined, "ascii", "wtf16", "utf8-guaranteed"] as const)
    .map((encoding) => planNativeStringLiteral(strings.layout, inventory.typePack.utf8Storage, message, encoding))
    .find((row) => row.key === request?.cacheKey);
  if (binding.kind !== "global" || plan?.kind !== "global") fail("missing canonical guarded Call error leaf");
  tx.assertCanonicalGlobalInitializer(binding.global, plan.init);
  return binding.global;
}
function completedDependencies(tx: PhysicalModuleReservations, o: Owner) {
  const d = o.dependencies;
  requireCompletedNativeToObjectKernel(tx, d.toObject, d.toObjectDependencies);
  return errorLiteral(tx, o);
}
function definitions(tx: PhysicalModuleReservations, o: Owner) {
  const d = o.dependencies,
    base = d.toObjectDependencies,
    m = base.prototypeDependencies.mixedDependencies,
    substrate = m.realmDependencies.substrate,
    realm = d.toObject.realm,
    literal = requireNativeStringLiteral(tx, base.errorDependencies.strings, message);
  if (literal.kind !== "global") fail("missing direct guarded Call error leaf");
  return o.entries.map((entry, index) => ({
    algorithm: buildNativeObjectToObjectDefinition({
      operation: methods[index]![3],
      vectorTypeIdx: substrate.arguments.carrier.typeIndex,
      vectorArrayTypeIdx: substrate.arguments.array.typeIndex,
      undefinedGlobal: tx.physicalIndex(m.values.globals.undefined),
      toObject: d.toObject.toObject.handle,
      getPrototypeOf: base.prototypeDependencies.mixed.getPrototypeOf.handle,
    }),
    lifted: buildBuiltinFunctionCheckedEntryDefinition({
      identity: {
        typeIdx: entry.type.typeIndex,
        metadataId: entry.metadata.metadata.id,
        liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
        singleton: tx.physicalIndex(entry.singleton),
        singletonExtern: false,
        realm: tx.physicalIndex(realm.globals.realm),
      },
      failure: [
        { op: "global.get", index: tx.physicalIndex(literal.global) },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: base.errors.newTypeError.handle },
        { op: "throw", tagIdx: tx.physicalIndex(realm.exception.tag) },
      ],
      algorithm: entry.algorithm.handle,
    }),
  }));
}
export function fillNativeObjectToObjectAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectToObjectAlgorithms,
): void {
  const o = current(tx, pack);
  if (tx.state !== "filling" || o.phase !== "reserved") fail("invalid phase or duplicate/failed fill");
  completedDependencies(tx, o);
  const bodies = definitions(tx, o);
  o.phase = "filling";
  try {
    o.entries.forEach((entry, index) => {
      tx.fillFunction(entry.algorithm, bodies[index]!.algorithm);
      tx.fillFunction(entry.lifted, bodies[index]!.lifted);
    });
    o.phase = "complete";
  } catch (error) {
    o.phase = "failed";
    throw error;
  }
}
export function requireCompletedNativeObjectToObjectAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectToObjectAlgorithms,
  expected: NativeObjectToObjectDependencies,
): NativeObjectToObjectAlgorithms {
  const o = current(tx, pack);
  if (o.original !== expected) fail("different expected dependency owner");
  if (o.phase !== "complete") fail("missing canonical algorithm/lifted fill");
  completedDependencies(tx, o);
  const bodies = definitions(tx, o);
  o.entries.forEach((entry, index) => {
    tx.assertCanonicalFunctionDefinition(entry.algorithm, bodies[index]!.algorithm);
    tx.assertCanonicalFunctionDefinition(entry.lifted, bodies[index]!.lifted);
  });
  return pack;
}
