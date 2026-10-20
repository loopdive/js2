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
import {
  buildNativeObjectSetPrototypeDefinition,
  buildNativeObjectPrototypeSetterDefinition,
} from "../../../runtime/wasmgc/values/native-object-prototype-bodies.js";
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
export interface NativeObjectSetPrototypeAlgorithm {
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly completionScope: "native-object-set-prototype-call";
}
export interface NativeObjectPrototypeSetterAlgorithm {
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly completionScope: "native-object-prototype-setter-call";
}
type Algorithms =
  | NativeObjectExtensibilityAlgorithms
  | NativeObjectSetPrototypeAlgorithm
  | NativeObjectPrototypeSetterAlgorithm;
type Kind = "extensibility" | "set-prototype" | "prototype-setter";
const scopes = {
  extensibility: "native-object-extensibility-calls",
  "set-prototype": "native-object-set-prototype-call",
  "prototype-setter": "native-object-prototype-setter-call",
} as const;
const scope = (kind: Kind) => scopes[kind];
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
const ids = {
  extensibility: ["%Object.isExtensible%", "%Object.preventExtensions%"],
  "set-prototype": ["%Object.setPrototypeOf%"],
  "prototype-setter": ["%set Object.prototype.__proto__%"],
} as const;
interface Owner {
  readonly kind: Kind;
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeObjectExtensibilityDependencies;
  readonly dependencies: NativeObjectExtensibilityDependencies;
  readonly entries: readonly NativeObjectRealmEntry[];
  phase: "reserved" | "filling" | "complete" | "failed";
}
const owners = new WeakMap<Algorithms, Owner>();
const realms = new WeakMap<NativeObjectRealmDeclarations, Set<Kind>>();
function fail(detail: string): never {
  throw Error("native Object structural algorithms: " + detail);
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
function entries(realm: NativeObjectRealmDeclarations, kind: Kind) {
  return ids[kind].map((id) => {
    const entry = realm.entries.find((entry) => entry.request.intrinsic.id === id);
    if (!entry || entry.construct || entry.request.intrinsic.callable.length !== (kind === "set-prototype" ? 2 : 1))
      fail("missing actual structural catalog entry");
    return entry;
  });
}
/** Downstream composition of actual reserved slots, never a raw-handle/body binder. */
function reserve(tx: PhysicalModuleReservations, input: NativeObjectExtensibilityDependencies, kind: Kind): Algorithms {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = Object.freeze(dependencies(tx, input)),
    realm = d.mixedDependencies.realm;
  const issued = realms.get(realm) ?? new Set<Kind>();
  if (issued.has(kind)) fail("realm already has this structural algorithm owner");
  const selected = Object.freeze(entries(realm, kind));
  const pack = Object.freeze({
    realm,
    entries: selected,
    completionScope: scope(kind),
  });
  owners.set(pack, { tx, kind, original: input, dependencies: d, entries: selected, phase: "reserved" });
  issued.add(kind);
  realms.set(realm, issued);
  return pack;
}
export function reserveNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  input: NativeObjectExtensibilityDependencies,
): NativeObjectExtensibilityAlgorithms {
  return reserve(tx, input, "extensibility") as NativeObjectExtensibilityAlgorithms;
}
export function reserveNativeObjectSetPrototypeAlgorithm(
  tx: PhysicalModuleReservations,
  input: NativeObjectExtensibilityDependencies,
): NativeObjectSetPrototypeAlgorithm {
  return reserve(tx, input, "set-prototype") as NativeObjectSetPrototypeAlgorithm;
}
export function reserveNativeObjectPrototypeSetterAlgorithm(
  tx: PhysicalModuleReservations,
  input: NativeObjectExtensibilityDependencies,
): NativeObjectPrototypeSetterAlgorithm {
  return reserve(tx, input, "prototype-setter") as NativeObjectPrototypeSetterAlgorithm;
}
function current(tx: PhysicalModuleReservations, pack: Algorithms, kind: Kind) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || owner.kind !== kind) fail("foreign, copied or wrong-scope algorithm owner");
  const d = dependencies(tx, owner.original);
  if (roles.some((role) => d[role] !== owner.dependencies[role])) fail("changed dependency identity");
  if (
    pack.realm !== d.mixedDependencies.realm ||
    pack.entries !== owner.entries ||
    pack.completionScope !== scope(kind)
  )
    fail("changed completion scope/identity");
  const selected = entries(pack.realm, kind);
  if (selected.some((entry, index) => entry !== owner.entries[index])) fail("changed actual catalog entries");
  return owner;
}
export function requireNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectExtensibilityAlgorithms,
  realm: NativeObjectRealmDeclarations,
): NativeObjectExtensibilityAlgorithms {
  current(tx, pack, "extensibility");
  if (pack.realm !== realm) fail("different expected realm");
  return pack;
}
export function requireNativeObjectSetPrototypeAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSetPrototypeAlgorithm,
  realm: NativeObjectRealmDeclarations,
): NativeObjectSetPrototypeAlgorithm {
  current(tx, pack, "set-prototype");
  if (pack.realm !== realm) fail("different expected realm");
  return pack;
}
export function requireNativeObjectPrototypeSetterAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectPrototypeSetterAlgorithm,
  realm: NativeObjectRealmDeclarations,
): NativeObjectPrototypeSetterAlgorithm {
  current(tx, pack, "prototype-setter");
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
) {
  const m = d.mixedDependencies,
    realm = m.realm,
    substrate = m.realmDependencies.substrate;
  const failure = (message: string): Instr[] => [
    ...literal(tx, d, message),
    { op: "call", funcIdx: d.errors.newTypeError.handle },
    { op: "throw", tagIdx: tx.physicalIndex(realm.exception.tag) },
  ];
  const prevent = entry.request.intrinsic.id === "%Object.preventExtensions%";
  const setter = entry.request.intrinsic.id === "%set Object.prototype.__proto__%";
  const prototypeBuilder = setter
    ? buildNativeObjectPrototypeSetterDefinition
    : buildNativeObjectSetPrototypeDefinition;
  const algorithm =
    setter || entry.request.intrinsic.id === "%Object.setPrototypeOf%"
      ? prototypeBuilder({
          vectorTypeIdx: substrate.arguments.carrier.typeIndex,
          vectorArrayTypeIdx: substrate.arguments.array.typeIndex,
          undefinedGlobal: tx.physicalIndex(m.values.globals.undefined),
          undefinedTypeIdx: m.values.types.anyValue.typeIndex,
          isPrimitive: d.primitives.isPrimitive.handle,
          classify: d.mixed.classify.handle,
          setPrototypeOf: d.mixed.setPrototypeOf.handle,
          throwTypeError: failure("TypeError"),
        })
      : buildNativeObjectExtensibilityDefinition(
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
function fill(tx: PhysicalModuleReservations, pack: Algorithms, kind: Kind): void {
  const owner = current(tx, pack, kind);
  if (tx.state !== "filling" || owner.phase !== "reserved") fail("invalid phase or duplicate/failed fill");
  completedDependencies(tx, owner.dependencies);
  const bodies = owner.entries.map((entry) => definitions(tx, owner.dependencies, entry));
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
function completed(tx: PhysicalModuleReservations, pack: Algorithms, kind: Kind): void {
  const owner = current(tx, pack, kind);
  if (owner.phase !== "complete") fail("missing canonical algorithm/lifted fill");
  completedDependencies(tx, owner.dependencies);
  owner.entries.forEach((entry) => {
    const body = definitions(tx, owner.dependencies, entry);
    tx.assertCanonicalFunctionDefinition(entry.algorithm, body.algorithm);
    tx.assertCanonicalFunctionDefinition(entry.lifted, body.lifted);
  });
}
export function fillNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectExtensibilityAlgorithms,
): void {
  fill(tx, pack, "extensibility");
}
export function fillNativeObjectSetPrototypeAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSetPrototypeAlgorithm,
): void {
  fill(tx, pack, "set-prototype");
}
export function fillNativeObjectPrototypeSetterAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectPrototypeSetterAlgorithm,
): void {
  fill(tx, pack, "prototype-setter");
}
export function requireCompletedNativeObjectExtensibilityAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeObjectExtensibilityAlgorithms,
): NativeObjectExtensibilityAlgorithms {
  completed(tx, pack, "extensibility");
  return pack;
}
export function requireCompletedNativeObjectSetPrototypeAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectSetPrototypeAlgorithm,
): NativeObjectSetPrototypeAlgorithm {
  completed(tx, pack, "set-prototype");
  return pack;
}
export function requireCompletedNativeObjectPrototypeSetterAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectPrototypeSetterAlgorithm,
): NativeObjectPrototypeSetterAlgorithm {
  completed(tx, pack, "prototype-setter");
  return pack;
}
