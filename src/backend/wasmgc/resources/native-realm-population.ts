// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import { buildRealmPopulationDefinition } from "../../../runtime/wasmgc/values/realm-population-bodies.js";
import { planNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import { buildBoxNumberBody, buildBoxNumberLocals } from "../../../runtime/wasmgc/values/number-bodies.js";
import { buildSymbolBoxDefinition } from "../../../runtime/wasmgc/values/symbol-carrier-bodies.js";
import {
  requireNativeObjectRealmDeclarations,
  requireCompletedNativeObjectRealmDeclarations,
  type NativeObjectRealmDeclarations,
  type NativeObjectRealmDependencies,
} from "./native-object-realm.js";
import { requireNativeRealmObjectLayouts } from "./native-realm-object-layouts.js";
import { nativePublicBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import {
  requireNativeObjectDescriptorReservations,
  requireCompletedNativeObjectDescriptors,
  type NativeObjectDescriptorReservations,
  type NativeObjectDescriptorDependencies,
} from "./native-object-descriptors.js";
import { nativeStringLiteralReservationInventory } from "./native-string-literals.js";
import { requireCompletedNativeSymbolCarrier } from "./native-symbol-carrier.js";
import { requireCompletedNativeValues } from "./native-values.js";

export interface NativeRealmPopulationDependencies {
  readonly realm: NativeObjectRealmDeclarations;
  readonly realmDependencies: NativeObjectRealmDependencies;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly descriptorDependencies: NativeObjectDescriptorDependencies;
}
export interface NativeRealmPopulation {
  readonly realm: NativeObjectRealmDeclarations;
  readonly initialize: NativeObjectRealmDeclarations["initialize"];
  /** Only the initializer definition; missing algorithms still prohibit a sealed public realm. */
  readonly completionScope: "realm-population-initializer-only";
}
const roles = ["realm", "realmDependencies", "descriptors", "descriptorDependencies"] as const;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeRealmPopulationDependencies;
  readonly captured: NativeRealmPopulationDependencies;
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativeRealmPopulation, Owner>();
const bindings = new WeakMap<NativeObjectRealmDeclarations, NativeRealmPopulation>();
function fail(detail: string): never {
  throw Error("native realm population: " + detail);
}
function capture(input: NativeRealmPopulationDependencies): NativeRealmPopulationDependencies {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("plain dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== roles.length) fail("exact dependency roles required");
  for (const role of roles) {
    const field = fields[role];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable || !field.value)
      fail("own dependency data fields required");
  }
  return Object.freeze(
    Object.fromEntries(roles.map((role) => [role, fields[role]!.value])),
  ) as unknown as NativeRealmPopulationDependencies;
}
function dependencies(tx: PhysicalModuleReservations, d: NativeRealmPopulationDependencies): void {
  requireNativeObjectRealmDeclarations(tx, d.realm, d.realmDependencies);
  requireNativeObjectDescriptorReservations(tx, d.descriptors, d.descriptorDependencies);
  const descriptor = d.descriptorDependencies;
  const lookup = descriptor.storageDependencies.lookupDependencies;
  const requests = nativePublicBuiltinFunctionRequestDependencies(tx, d.realm.requests);
  if (descriptor.closures !== d.realmDependencies.closures) fail("different actual closure owner");
  if (
    descriptor.access.demands.program !== d.realm.realm.program ||
    descriptor.access.demands.projection !== d.realm.realm.projection
  )
    fail("different original program/projection");
  if (lookup.strings !== requests.strings) fail("different actual string owner");
  requireNativeRealmObjectLayouts(tx, d.realm.layouts, { objects: lookup.layouts, objectPlan: lookup.layoutPlan });
}
function owned(tx: PhysicalModuleReservations, pack: NativeRealmPopulation): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || bindings.get(pack.realm) !== pack) fail("foreign or copied population owner");
  return owner;
}
function current(tx: PhysicalModuleReservations, pack: NativeRealmPopulation): Owner {
  const owner = owned(tx, pack);
  const now = capture(owner.original);
  if (roles.some((role) => now[role] !== owner.captured[role])) fail("substituted dependency identity");
  dependencies(tx, owner.captured);
  return owner;
}

/** Original dependency data, not population completion or a caller-selected body binding. */
export function nativeRealmPopulationDependencies(
  tx: PhysicalModuleReservations,
  pack: NativeRealmPopulation,
): NativeRealmPopulationDependencies {
  return current(tx, pack).captured;
}

/** Claims the existing real initialize slot, with no caller-selected catalog or function handles. */
export function reserveNativeRealmPopulation(
  tx: PhysicalModuleReservations,
  original: NativeRealmPopulationDependencies,
): NativeRealmPopulation {
  if (tx.state !== "reserving") fail("reservation phase required");
  const captured = capture(original);
  dependencies(tx, captured);
  if (bindings.has(captured.realm)) fail("public realm already has a population owner");
  const pack = Object.freeze({
    realm: captured.realm,
    initialize: captured.realm.initialize,
    completionScope: "realm-population-initializer-only" as const,
  });
  owners.set(pack, { tx, original, captured, phase: "reserved" });
  bindings.set(captured.realm, pack);
  return pack;
}

function definition(tx: PhysicalModuleReservations, d: NativeRealmPopulationDependencies) {
  const realm = d.realm,
    descriptor = d.descriptorDependencies;
  requireCompletedNativeObjectRealmDeclarations(tx, realm);
  requireCompletedNativeObjectDescriptors(tx, d.descriptors, descriptor, realm.exception.tag);
  tx.assertFunctionSignature(realm.initialize, { params: [], results: [] });
  // Independently derive module state: a receipt-valid state=2 or singleton substitution must not bypass initialization.
  for (const token of [
    realm.globals.realm,
    realm.globals.functionPrototype,
    realm.objectPrototype.singleton,
    realm.globals.state,
    realm.globals.wholeRealmReady,
    ...realm.entries.map((entry) => entry.singleton),
  ]) {
    const type = token.object.type;
    const init: Instr[] =
      type.kind === "i32"
        ? [{ op: "i32.const", value: 0 }]
        : type.kind === "ref_null"
          ? [{ op: "ref.null", typeIdx: type.typeIdx }]
          : [{ op: "ref.null.extern" }];
    tx.assertCanonicalGlobalInitializer(token, init);
  }
  const lookup = descriptor.storageDependencies.lookupDependencies;
  const values = descriptor.sameValueDependencies;
  requireCompletedNativeValues(tx, values.values, values.valuePlan, values.valueDependencies);
  tx.assertCanonicalFunctionDefinition(values.values.functions.boxNumber, {
    locals: buildBoxNumberLocals(),
    body: buildBoxNumberBody(values.values.types.boxedNumber.typeIndex),
  });
  const symbols = lookup.symbols;
  requireCompletedNativeSymbolCarrier(tx, symbols, lookup.strings);
  tx.assertCanonicalGlobalInitializer(symbols.globals.internTable, [
    { op: "ref.null", typeIdx: symbols.types.internArray.typeIndex },
  ]);
  tx.assertCanonicalFunctionDefinition(
    symbols.functions.box,
    buildSymbolBoxDefinition({
      symIdx: symbols.types.symbol.typeIndex,
      anyStrTypeIdx: lookup.strings.layout.anyStrTypeIdx,
      internArrTypeIdx: symbols.types.internArray.typeIndex,
      internGlobalIdx: tx.physicalIndex(symbols.globals.internTable),
    }),
  );
  const inventory = nativeStringLiteralReservationInventory(tx, lookup.strings);
  const checkedLiterals = new Map<string, Instr[]>();
  const literal = (text: string): Instr[] => {
    const checked = checkedLiterals.get(text);
    if (checked) return structuredClone(checked);
    const request = inventory.requests.find((row) => row.binding.text === text);
    if (!request || request.binding.kind !== "global") return fail("catalog requires an original short native literal");
    const binding = request.binding;
    const plan = [undefined, "ascii", "wtf16", "utf8-guaranteed"]
      .map((encoding) =>
        planNativeStringLiteral(
          lookup.strings.layout,
          inventory.typePack.utf8Storage,
          text,
          encoding as "ascii" | "wtf16" | "utf8-guaranteed" | undefined,
        ),
      )
      .find((candidate) => candidate.key === request.cacheKey);
    if (!plan || plan.kind !== "global") return fail("different original literal selection");
    tx.assertCanonicalGlobalInitializer(binding.global, plan.init);
    const operand: Instr[] = [{ op: "global.get", index: tx.physicalIndex(binding.global) }];
    checkedLiterals.set(text, operand);
    return structuredClone(operand);
  };
  return buildRealmPopulationDefinition({
    identityType: realm.layouts.types.identity.typeIndex,
    objectPrototypeType: realm.objectPrototype.type.typeIndex,
    objectType: lookup.layouts.object.typeIndex,
    propMapType: lookup.layouts.propMap.typeIndex,
    realmGlobal: tx.physicalIndex(realm.globals.realm),
    objectPrototypeGlobal: tx.physicalIndex(realm.objectPrototype.singleton),
    stateGlobal: tx.physicalIndex(realm.globals.state),
    functions: realm.entries.map((entry) => ({
      id: entry.request.intrinsic.id,
      type: entry.type.typeIndex,
      lifted: entry.lifted.handle,
      metadataId: entry.metadata.metadata.id,
      singleton: tx.physicalIndex(entry.singleton),
    })),
    createNull: descriptor.storage.createNull.handle,
    defineData: d.descriptors.defineData.handle,
    defineAccessor: d.descriptors.defineAccessor.handle,
    boxNumber: values.values.functions.boxNumber.handle,
    boxSymbol: symbols.functions.box.handle,
    literal,
    failure: [
      ...literal("TypeError: native builtin initialization failed"),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: descriptor.errors.newTypeError.handle },
      { op: "throw", tagIdx: tx.physicalIndex(realm.exception.tag) },
    ],
  });
}
export function fillNativeRealmPopulation(tx: PhysicalModuleReservations, pack: NativeRealmPopulation): void {
  const owner = owned(tx, pack);
  if (tx.state !== "filling" || owner.phase !== "reserved") fail("invalid phase or duplicate/interrupted fill");
  current(tx, pack);
  const expected = definition(tx, owner.captured);
  owner.phase = "filling";
  try {
    for (const entry of pack.realm.entries) tx.declareFunctionReference(entry.lifted);
    tx.fillFunction(pack.initialize, expected);
    owner.phase = "complete";
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
/** Definition completion only. requireCompletedNativeObjectRealm continues to reject this incomplete realm. */
export function requireCompletedNativeRealmPopulation(
  tx: PhysicalModuleReservations,
  pack: NativeRealmPopulation,
): NativeRealmPopulation {
  const owner = owned(tx, pack);
  if (owner.phase !== "complete") fail("missing canonical population initializer fill");
  current(tx, pack);
  tx.assertCanonicalFunctionDefinition(pack.initialize, definition(tx, owner.captured));
  return pack;
}
