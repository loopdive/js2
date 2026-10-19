// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  requireNativeMixedObjectAccessReservations,
  requireCompletedNativeMixedObjectAccessStructure,
  type NativeMixedObjectAccessReservations,
  type NativeMixedObjectAccessDependencies,
} from "./native-mixed-object-access.js";
import type { NativeObjectRealmDeclarations, NativeObjectRealmEntry } from "./native-object-realm.js";
import { nativePublicBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import {
  requireNativeNumberPrimitiveClassifierReservations,
  requireCompletedNativeNumberPrimitiveClassifier,
  type NativeNumberPrimitiveClassifierReservations,
  type NativeNumberPrimitiveClassifierDependencies,
} from "./native-number-primitive-classifier.js";
import {
  requireNativeBooleanBoxReservations,
  requireCompletedNativeBooleanBoxes,
  type NativeBooleanBoxReservations,
} from "./native-booleans.js";
import {
  requireNativeErrorReservations,
  requireCompletedNativeErrors,
  type NativeErrorReservations,
  type NativeErrorDependencies,
  type NativeErrorRequirements,
} from "./native-errors.js";
import { requireNativeStringLiteral, nativeStringLiteralReservationInventory } from "./native-string-literals.js";
import { planNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import { buildNativeObjectExtensibilityDefinition } from "../../../runtime/wasmgc/values/native-object-extensibility-bodies.js";
import { buildBoxBooleanBody, buildBooleanBoxInitializer } from "../../../runtime/wasmgc/values/boolean-bodies.js";
import { buildUndefinedInitializer } from "../../../runtime/wasmgc/values/primitive-layouts.js";
import { buildErrorConstructorBody } from "../../../runtime/wasmgc/values/error-bodies.js";
import { buildBuiltinFunctionCheckedEntryDefinition } from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import type { Instr } from "../../../wasm/model/instructions.js";

export interface NativeObjectExtensibilityDependencies {
  readonly mixed: NativeMixedObjectAccessReservations;
  readonly mixedDependencies: NativeMixedObjectAccessDependencies;
  readonly primitives: NativeNumberPrimitiveClassifierReservations;
  readonly primitivePlan: NativeResourceRecipe;
  readonly primitiveDependencies: NativeNumberPrimitiveClassifierDependencies;
  readonly booleanBoxes: NativeBooleanBoxReservations;
  readonly errors: NativeErrorReservations;
  readonly errorRequirements: NativeErrorRequirements;
  readonly errorDependencies: NativeErrorDependencies;
}
export interface NativeObjectExtensibilityAlgorithms {
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly completionScope: "native-object-extensibility-calls";
}
const roles = [
  "mixed",
  "mixedDependencies",
  "primitives",
  "primitivePlan",
  "primitiveDependencies",
  "booleanBoxes",
  "errors",
  "errorRequirements",
  "errorDependencies",
] as const;
const ids = ["%Object.isExtensible%", "%Object.preventExtensions%"] as const;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeObjectExtensibilityDependencies;
  readonly dependencies: NativeObjectExtensibilityDependencies;
  readonly entries: readonly NativeObjectRealmEntry[];
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<NativeObjectExtensibilityAlgorithms, Owner>();
const realms = new WeakSet<NativeObjectRealmDeclarations>();
function fail(detail: string): never {
  throw Error("native Object extensibility: " + detail);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    fail("plain own-data dependencies required");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length) fail("unexpected dependency roles");
  for (const key of keys)
    if (
      !fields[key] ||
      !Object.hasOwn(fields[key]!, "value") ||
      !fields[key]!.enumerable ||
      fields[key]!.value === undefined
    )
      fail("own enumerable dependency data required");
  return Object.fromEntries(keys.map((key) => [key, fields[key]!.value]));
}
function dependencies(tx: PhysicalModuleReservations, input: NativeObjectExtensibilityDependencies) {
  const d = record(input, roles) as unknown as NativeObjectExtensibilityDependencies;
  record(d.mixedDependencies, [
    "realm",
    "realmDependencies",
    "stringOwn",
    "stringOwnDependencies",
    "values",
    "valuePlan",
    "valueDependencies",
  ]);
  record(d.errorDependencies, ["strings", "typeErrorTag"]);
  record(d.errorRequirements, ["key"]);
  record(d.primitiveDependencies, [
    "values",
    "valuePlan",
    "valueDependencies",
    "booleans",
    "bigints",
    "bigintPlan",
    "strings",
    "symbols",
  ]);
  requireNativeMixedObjectAccessReservations(tx, d.mixed, d.mixedDependencies);
  const m = d.mixedDependencies;
  // The mixed owner authenticates this exact realm/dependency pair; do not
  // duplicate its entire graph audit or introduce a reverse realm dependency.
  requireNativeNumberPrimitiveClassifierReservations(tx, d.primitives, d.primitivePlan, d.primitiveDependencies);
  requireNativeBooleanBoxReservations(tx, d.booleanBoxes, m.values, m.valuePlan, m.valueDependencies);
  requireNativeErrorReservations(tx, d.errors, d.errorRequirements, d.errorDependencies);
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, m.realm.requests);
  const p = d.primitiveDependencies;
  if (
    d.errorDependencies.strings !== request.strings ||
    p.strings !== request.strings ||
    p.values !== m.values ||
    p.valuePlan !== m.valuePlan ||
    p.valueDependencies !== m.valueDependencies ||
    p.symbols !== m.stringOwnDependencies.layoutDependencies.symbols
  )
    fail("different primitive/error/string owners");
  return d;
}
function entries(realm: NativeObjectRealmDeclarations) {
  return ids.map((id) => {
    const entry = realm.entries.find((entry) => entry.request.intrinsic.id === id);
    if (!entry || entry.construct || entry.request.intrinsic.callable.length !== 1)
      fail("missing actual extensibility catalog entry");
    return entry;
  });
}
/** Downstream composition of actual reserved slots, never a raw-handle/body binder. */
export function reserveNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  input: NativeObjectExtensibilityDependencies,
): NativeObjectExtensibilityAlgorithms {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = Object.freeze(dependencies(tx, input)),
    realm = d.mixedDependencies.realm;
  if (realms.has(realm)) fail("realm already has an extensibility algorithm owner");
  const selected = Object.freeze(entries(realm));
  const pack = Object.freeze({
    realm,
    entries: selected,
    completionScope: "native-object-extensibility-calls" as const,
  });
  owners.set(pack, { tx, original: input, dependencies: d, entries: selected, phase: "reserved" });
  realms.add(realm);
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeObjectExtensibilityAlgorithms) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied algorithm owner");
  const d = dependencies(tx, owner.original);
  if (roles.some((role) => d[role] !== owner.dependencies[role])) fail("changed dependency identity");
  if (
    pack.realm !== d.mixedDependencies.realm ||
    pack.entries !== owner.entries ||
    pack.completionScope !== "native-object-extensibility-calls"
  )
    fail("changed completion scope/identity");
  const selected = entries(pack.realm);
  if (selected.some((entry, index) => entry !== owner.entries[index])) fail("changed actual catalog entries");
  return owner;
}
export function requireNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectExtensibilityAlgorithms,
  realm: NativeObjectRealmDeclarations,
): NativeObjectExtensibilityAlgorithms {
  current(tx, pack);
  if (pack.realm !== realm) fail("different expected realm");
  return pack;
}
function literal(tx: PhysicalModuleReservations, d: NativeObjectExtensibilityDependencies, text: string): Instr[] {
  const value = requireNativeStringLiteral(tx, d.errorDependencies.strings, text);
  return [
    value.kind === "global"
      ? { op: "global.get", index: tx.physicalIndex(value.global) }
      : { op: "call", funcIdx: value.function.handle },
    { op: "extern.convert_any" },
  ];
}
function canonicalLiteral(tx: PhysicalModuleReservations, d: NativeObjectExtensibilityDependencies, text: string) {
  const strings = d.errorDependencies.strings,
    binding = requireNativeStringLiteral(tx, strings, text);
  const inventory = nativeStringLiteralReservationInventory(tx, strings);
  const request = inventory.requests.find((row) => row.binding === binding)!;
  const plan = ([undefined, "ascii", "wtf16", "utf8-guaranteed"] as const)
    .map((encoding) => planNativeStringLiteral(strings.layout, inventory.typePack.utf8Storage, text, encoding))
    .find((plan) => plan.key === request.cacheKey);
  // These two fixed, short messages always have direct leaf initializers.
  if (binding.kind !== "global" || plan?.kind !== "global") fail("different canonical error literal recipe");
  tx.assertCanonicalGlobalInitializer(binding.global, plan.init);
}
function completedDependencies(tx: PhysicalModuleReservations, d: NativeObjectExtensibilityDependencies) {
  const m = d.mixedDependencies;
  requireCompletedNativeMixedObjectAccessStructure(tx, d.mixed, m);
  requireCompletedNativeNumberPrimitiveClassifier(tx, d.primitives, d.primitivePlan, d.primitiveDependencies);
  requireCompletedNativeBooleanBoxes(tx, d.booleanBoxes, m.values, m.valuePlan, m.valueDependencies);
  requireCompletedNativeErrors(tx, d.errors, d.errorRequirements, d.errorDependencies);
  canonicalLiteral(tx, d, "TypeError");
  canonicalLiteral(tx, d, "TypeError: incompatible native builtin function");
  // Re-derive the executed primitive/error definitions; receipts alone do not prove semantics.
  tx.assertCanonicalGlobalInitializer(
    m.values.globals.undefined,
    buildUndefinedInitializer(m.values.types.anyValue.typeIndex),
  );
  const boxes = d.booleanBoxes;
  for (const [index, global] of boxes.globals.entries())
    tx.assertCanonicalGlobalInitializer(
      global,
      buildBooleanBoxInitializer(m.values.types.boxedBoolean.typeIndex, index === 0 ? 1 : 0),
    );
  tx.assertCanonicalFunctionDefinition(boxes.boxBoolean, {
    locals: [],
    body: buildBoxBooleanBody(
      boxes.mode === "interned"
        ? {
            mode: "interned",
            trueGlobalIndex: tx.physicalIndex(boxes.globals[0]!),
            falseGlobalIndex: tx.physicalIndex(boxes.globals[1]!),
          }
        : { mode: "allocating", typeIndex: m.values.types.boxedBoolean.typeIndex },
    ),
  });
  const name = requireNativeStringLiteral(tx, d.errorDependencies.strings, "TypeError");
  tx.assertCanonicalFunctionDefinition(d.errors.newTypeError, {
    locals: [],
    body: buildErrorConstructorBody(
      d.errors.type.typeIndex,
      d.errorDependencies.typeErrorTag,
      1,
      name.kind === "global"
        ? { kind: "global", index: tx.physicalIndex(name.global), representation: "gc" }
        : { kind: "callable", handle: name.function.handle, representation: "gc" },
    ),
  });
}
function definitions(
  tx: PhysicalModuleReservations,
  d: NativeObjectExtensibilityDependencies,
  entry: NativeObjectRealmEntry,
  prevent: boolean,
) {
  const m = d.mixedDependencies,
    realm = m.realm,
    substrate = m.realmDependencies.substrate;
  const failure = (message: string): Instr[] => [
    ...literal(tx, d, message),
    { op: "call", funcIdx: d.errors.newTypeError.handle },
    { op: "throw", tagIdx: tx.physicalIndex(realm.exception.tag) },
  ];
  const algorithm = buildNativeObjectExtensibilityDefinition(
    {
      vectorTypeIdx: substrate.arguments.carrier.typeIndex,
      vectorArrayTypeIdx: substrate.arguments.array.typeIndex,
      undefinedGlobal: tx.physicalIndex(m.values.globals.undefined),
      undefinedTypeIdx: m.values.types.anyValue.typeIndex,
      isPrimitive: d.primitives.isPrimitive.handle,
      operation: (prevent ? d.mixed.preventExtensions : d.mixed.isExtensible).handle,
      boxBoolean: d.booleanBoxes.boxBoolean.handle,
      throwTypeError: failure("TypeError"),
    },
    prevent,
  );
  const lifted = buildBuiltinFunctionCheckedEntryDefinition({
    identity: {
      typeIdx: entry.type.typeIndex,
      metadataId: entry.metadata.metadata.id,
      liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
      singleton: tx.physicalIndex(entry.singleton),
      singletonExtern: false,
      realm: tx.physicalIndex(realm.globals.realm),
    },
    failure: failure("TypeError: incompatible native builtin function"),
    algorithm: entry.algorithm.handle,
  });
  return { algorithm, lifted };
}
export function fillNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectExtensibilityAlgorithms,
): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.phase !== "reserved") fail("invalid phase or duplicate/failed fill");
  completedDependencies(tx, owner.dependencies);
  const bodies = owner.entries.map((entry, index) => definitions(tx, owner.dependencies, entry, index === 1));
  owner.phase = "filling";
  try {
    owner.entries.forEach((entry, index) => {
      tx.fillFunction(entry.algorithm, bodies[index]!.algorithm);
      tx.fillFunction(entry.lifted, bodies[index]!.lifted);
    });
    owner.phase = "complete";
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
export function requireCompletedNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectExtensibilityAlgorithms,
): NativeObjectExtensibilityAlgorithms {
  const owner = current(tx, pack);
  if (owner.phase !== "complete") fail("missing canonical algorithm/lifted fill");
  completedDependencies(tx, owner.dependencies);
  owner.entries.forEach((entry, index) => {
    const body = definitions(tx, owner.dependencies, entry, index === 1);
    tx.assertCanonicalFunctionDefinition(entry.algorithm, body.algorithm);
    tx.assertCanonicalFunctionDefinition(entry.lifted, body.lifted);
  });
  return pack;
}
