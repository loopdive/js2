// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  assertNativeValueResourcePlanFor,
  type NativeValueResourcePlan,
} from "../../../ir/program/native-value-resources.js";
import type {
  NativeDeclaredSignature,
  NativeResourceRecipe,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  buildMixedObjectClassify,
  buildMixedObjectOwn,
  buildMixedObjectLookup,
  buildMixedObjectHas,
  buildMixedObjectGetPrototype,
  buildMixedObjectSetPrototype,
  type MixedObjectAccessOperands,
  type MixedObjectCarrier,
  type MixedObjectDefinition,
} from "../../../runtime/wasmgc/values/mixed-object-access-bodies.js";
import {
  buildOrdinaryObjectHashDefinition,
  buildOrdinaryObjectKeyEqualsDefinition,
  buildOrdinaryObjectFindDefinition,
} from "../../../runtime/wasmgc/values/ordinary-object-key-definitions.js";
import {
  buildStringExoticIndexDefinition,
  buildStringVirtualOwnDescriptorDefinition,
  buildStringExoticOwnDescriptorDefinition,
} from "../../../runtime/wasmgc/values/string-exotic-bodies.js";
import {
  buildStringCopyTreeDefinition,
  buildStringFlattenDefinition,
} from "../../../runtime/wasmgc/values/string-flatten-bodies.js";
import { buildStringUtf8ToFlatDefinition } from "../../../runtime/wasmgc/values/string-utf8-decode-bodies.js";
import { buildStringEqualityDefinition } from "../../../runtime/wasmgc/values/string-equality-body.js";
import { planNativeStringLiteral } from "../../../runtime/wasmgc/values/string-literal-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "../../../runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import {
  requireNativeObjectRealmDeclarations,
  type NativeObjectRealmDeclarations,
  type NativeObjectRealmDependencies,
} from "./native-object-realm.js";
import {
  requireNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
} from "./native-realm-object-layouts.js";
import {
  requireNativeStringOwnDescriptorReservations,
  requireCompletedNativeStringOwnDescriptors,
  type NativeStringOwnDescriptorReservations,
  type NativeStringOwnDescriptorDependencies,
} from "./native-string-exotic-own-descriptors.js";
import {
  requireNativeValueReservations,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import { nativePublicBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import { requireCompletedNativeInvocationSubstrate } from "./native-invocation-substrate.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
  preflightNativeResourceRecipe,
} from "./native-resource-declarations.js";

export interface NativeMixedObjectAccessDependencies {
  readonly realm: NativeObjectRealmDeclarations;
  readonly realmDependencies: NativeObjectRealmDependencies;
  readonly stringOwn: NativeStringOwnDescriptorReservations;
  readonly stringOwnDependencies: NativeStringOwnDescriptorDependencies;
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
}
const structuralRoles = ["classify", "own", "lookup", "has", "getPrototypeOf", "setPrototypeOf"] as const;
const roles = [...structuralRoles, "get"] as const;
export interface NativeMixedObjectAccessReservations {
  readonly classify: FunctionReservation;
  readonly own: FunctionReservation;
  readonly lookup: FunctionReservation;
  readonly has: FunctionReservation;
  readonly getPrototypeOf: FunctionReservation;
  readonly setPrototypeOf: FunctionReservation;
  /** Pending until the genuine mixed invocation owner joins; no raw-handle binder. */
  readonly get: FunctionReservation;
  readonly completionScope: "mixed-object-access-structure";
}
const dependencyRoles = [
  "realm",
  "realmDependencies",
  "stringOwn",
  "stringOwnDependencies",
  "values",
  "valuePlan",
  "valueDependencies",
] as const;
function fail(detail: string): never {
  throw Error("native mixed object access: " + detail);
}
function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    fail("plain own-data dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (
      typeof key !== "string" ||
      ![...required, ...optional].includes(key) ||
      !Object.hasOwn(fields[key]!, "value") ||
      !fields[key]!.enumerable
    )
      fail("unknown/hidden/accessor dependency");
  }
  if (required.some((key) => !Object.hasOwn(fields, key))) fail("missing dependency role");
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}
/** Inspect wrappers before older authenticators can read their fields. Capabilities remain opaque. */
function capture(input: NativeMixedObjectAccessDependencies): NativeMixedObjectAccessDependencies {
  const d = record(input, dependencyRoles) as unknown as NativeMixedObjectAccessDependencies;
  record(
    d.realmDependencies,
    ["requests", "closures", "closurePlan", "layouts", "substrate", "vectors", "vectorPlan", "exception"],
    ["source"],
  );
  const own = record(d.stringOwnDependencies, [
    "layouts",
    "layoutPlan",
    "layoutDependencies",
    "lookup",
    "lookupDependencies",
  ]);
  record(own.layoutDependencies, ["objects", "objectPlan", "strings", "symbols", "realmState"]);
  record(own.lookupDependencies, ["layouts", "layoutPlan", "strings", "flatten", "equality", "symbols"]);
  const values = record(d.valueDependencies, ["strings"]);
  const strings = record(values.strings, ["kind"], ["stringPack", "scanner"]);
  if (strings.kind !== "native-string" || !strings.stringPack || !strings.scanner)
    fail("genuine shared String/value dependency required");
  return d;
}
function dependencies(
  tx: PhysicalModuleReservations,
  input: NativeMixedObjectAccessDependencies,
): NativeMixedObjectAccessDependencies {
  const d = capture(input);
  requireNativeObjectRealmDeclarations(tx, d.realm, d.realmDependencies);
  requireNativeStringOwnDescriptorReservations(tx, d.stringOwn, d.stringOwnDependencies);
  requireNativeValueReservations(tx, d.values, d.valuePlan, d.valueDependencies);
  const own = d.stringOwnDependencies,
    layout = own.layoutDependencies,
    lookup = own.lookupDependencies;
  requireNativeRealmObjectLayouts(tx, d.realm.layouts, { objects: layout.objects, objectPlan: layout.objectPlan });
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.realm.requests);
  if (
    layout.realmState !== d.realm.layouts ||
    layout.objects !== lookup.layouts ||
    layout.objectPlan !== lookup.layoutPlan ||
    layout.strings !== request.strings ||
    lookup.strings !== request.strings ||
    layout.symbols !== lookup.symbols ||
    d.valueDependencies.strings.kind !== "native-string" ||
    d.valueDependencies.strings.stringPack !== request.strings
  )
    fail("different shared state/storage/key/value carriers");
  assertNativeValueResourcePlanFor(d.valuePlan, d.realm.realm.program, d.realm.realm.projection, "native-string");
  return d;
}

export function declareNativeMixedObjectAccessResources(key: string, entryTypeKey: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key || typeof entryTypeKey !== "string" || !entryTypeKey)
    fail("nonempty string keys required");
  const ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const descriptor = { params: [ext, ext], results: [i32, { kind: "ref_null" as const, typeKey: entryTypeKey }] };
  const signatures: Record<(typeof roles)[number], NativeDeclaredSignature> = {
    classify: { params: [ext], results: [i32] },
    own: descriptor,
    lookup: descriptor,
    has: { params: [ext, ext], results: [i32] },
    getPrototypeOf: { params: [ext], results: [i32, ext] },
    setPrototypeOf: { params: [ext, ext], results: [i32] },
    get: { params: [ext, ext, ext], results: [i32, ext] },
  };
  const declarations = roles.map((role) => ({
    key: key + ":" + role,
    role: ["mixed-object-access", role],
    space: "function" as const,
    name: "__mixed_object_" + role,
    signature: signatures[role],
  }));
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
  readonly original: NativeMixedObjectAccessDependencies;
  readonly identities: NativeMixedObjectAccessDependencies;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly tokens: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeMixedObjectAccessReservations, Owner>();
function current(tx: PhysicalModuleReservations, pack: NativeMixedObjectAccessReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  const d = dependencies(tx, owner.original);
  if (dependencyRoles.some((role) => d[role] !== owner.identities[role])) fail("changed dependency identity");
  const plan = declareNativeMixedObjectAccessResources(
    owner.key,
    d.stringOwnDependencies.layoutDependencies.objects.propEntry.key,
  );
  same(
    preflightNativeResourceRecipe(owner.sourcePlan, [d.stringOwnDependencies.layoutDependencies.objects.propEntry.key]),
    owner.plan,
    "changed declaration plan",
  );
  same(plan, owner.plan, "stale declaration prerequisites");
  if (roles.some((role, i) => pack[role] !== owner.tokens[i])) fail("substituted function token");
  if (tx.state !== "reserving") tx.physicalIndices(owner.tokens);
  return owner;
}
export function reserveNativeMixedObjectAccessResources(
  tx: PhysicalModuleReservations,
  key: string,
  input: NativeMixedObjectAccessDependencies,
  expectedPlan: NativeResourceRecipe,
): NativeMixedObjectAccessReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = dependencies(tx, input),
    entry = d.stringOwnDependencies.layoutDependencies.objects.propEntry;
  const plan = declareNativeMixedObjectAccessResources(key, entry.key);
  same(preflightNativeResourceRecipe(expectedPlan, [entry.key]), plan, "substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, new Map([[entry.key, entry]]));
  const pack = Object.freeze({
    ...Object.fromEntries(
      roles.map((role) => [role, requireNativeDeclaredReservation(records, key + ":" + role, "function")]),
    ),
    completionScope: "mixed-object-access-structure" as const,
  }) as unknown as NativeMixedObjectAccessReservations;
  owners.set(pack, {
    tx,
    key,
    original: input,
    identities: Object.freeze(d),
    sourcePlan: expectedPlan,
    plan,
    tokens: Object.freeze(roles.map((role) => pack[role])),
    filled: false,
  });
  return pack;
}
export function requireNativeMixedObjectAccessReservations(
  tx: PhysicalModuleReservations,
  pack: NativeMixedObjectAccessReservations,
  expectedDependencies?: NativeMixedObjectAccessDependencies,
): NativeMixedObjectAccessReservations {
  const owner = current(tx, pack);
  if (expectedDependencies !== undefined) {
    const d = capture(expectedDependencies);
    if (dependencyRoles.some((role) => d[role] !== owner.identities[role])) fail("different expected dependencies");
  }
  return pack;
}
function operands(
  tx: PhysicalModuleReservations,
  pack: NativeMixedObjectAccessReservations,
  d: NativeMixedObjectAccessDependencies,
): MixedObjectAccessOperands {
  const own = d.stringOwnDependencies,
    layout = d.realm.layouts;
  const [realm, objectPrototype, ...singletons] = tx.physicalIndices([
    layout.anchors.realm,
    d.realm.objectPrototype.singleton,
    ...d.realm.entries.map((entry) => entry.singleton),
  ]);
  const carriers: MixedObjectCarrier[] = [
    { kind: "string", typeIdx: own.layouts.types.String.typeIndex, stateField: 7 },
    { kind: "ordinary", typeIdx: layout.types.ordinary.typeIndex, stateField: 6 },
    ...(["Boolean", "Number", "Symbol", "BigInt"] as const).map(
      (kind): MixedObjectCarrier => ({ kind: "wrapper", typeIdx: own.layouts.types[kind].typeIndex, stateField: 7 }),
    ),
    { kind: "object-prototype", typeIdx: layout.types.objectPrototype.typeIndex },
    ...d.realm.entries.map(
      (entry, index): MixedObjectCarrier => ({
        kind: "native",
        typeIdx: entry.type.typeIndex,
        native: {
          metadataId: entry.metadata.metadata.id,
          liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
          singleton: singletons[index]!,
          singletonExtern: entry.singleton.object.type.kind === "externref",
        },
      }),
    ),
    ...(d.realmDependencies.source?.shapes.map(
      (shape): MixedObjectCarrier => ({
        kind: "source",
        typeIdx: shape.type.typeIndex,
        stateField:
          3 + d.realmDependencies.source!.requirements.shapes.find((row) => row.id === shape.id)!.captures.length,
      }),
    ) ?? []),
  ];
  return {
    objectTypeIdx: own.layoutDependencies.objects.object.typeIndex,
    entryTypeIdx: own.layoutDependencies.objects.propEntry.typeIndex,
    stateTypeIdx: layout.types.state.typeIndex,
    anyStringTypeIdx: own.layoutDependencies.strings.layout.anyStrTypeIdx,
    symbolTypeIdx: own.layoutDependencies.symbols.types.symbol.typeIndex,
    realm: realm!,
    objectPrototype: objectPrototype!,
    carriers,
    metadataTypes: [...new Set(d.realmDependencies.closures.metadata.map((row) => row.binding.type.typeIndex))],
    classify: pack.classify.handle,
    own: pack.own.handle,
    lookup: pack.lookup.handle,
    getPrototypeOf: pack.getPrototypeOf.handle,
    findOrdinary: own.lookup.findOwn.handle,
    findString: d.stringOwn.findOwn.handle,
  };
}
const builders = {
  classify: buildMixedObjectClassify,
  own: buildMixedObjectOwn,
  lookup: buildMixedObjectLookup,
  has: buildMixedObjectHas,
  getPrototypeOf: buildMixedObjectGetPrototype,
  setPrototypeOf: buildMixedObjectSetPrototype,
};
function canonical(
  tx: PhysicalModuleReservations,
  token: FunctionReservation,
  definition: MixedObjectDefinition,
): void {
  tx.assertCompletedReservation(token);
  same(
    { locals: token.object.locals, body: token.object.body },
    definition,
    "noncanonical executable dependency " + token.key,
  );
}
/** Audit only the executable own/key/String subgraph; the old whole-chain lookup/has are never used. */
function canonicalDependencies(tx: PhysicalModuleReservations, d: NativeMixedObjectAccessDependencies): void {
  const own = d.stringOwnDependencies,
    lookup = own.lookupDependencies,
    layout = lookup.strings.layout,
    flatten = lookup.flatten;
  const decoder = flatten.utf8Decoder
    ? { kind: "present" as const, handle: flatten.utf8Decoder.handle }
    : { kind: "absent" as const };
  canonical(tx, flatten.copyTree, buildStringCopyTreeDefinition(layout, flatten.worklist.typeIndex, decoder));
  if (flatten.utf8Decoder) canonical(tx, flatten.utf8Decoder, buildStringUtf8ToFlatDefinition(layout));
  canonical(
    tx,
    flatten.flatten,
    buildStringFlattenDefinition(layout, {
      copyTree: flatten.copyTree.handle,
      emptyLiteralGlobalIndex: tx.physicalIndex(flatten.emptyLiteral),
      utf8Decoder: decoder,
    }),
  );
  const empty = planNativeStringLiteral(layout, !!flatten.utf8Decoder, "", "wtf16");
  if (empty.kind !== "global") fail("canonical empty literal is not a global");
  tx.assertCompletedReservation(flatten.emptyLiteral);
  same(flatten.emptyLiteral.object.init, empty.init, "noncanonical executable empty literal");
  canonical(
    tx,
    lookup.equality.equals,
    buildStringEqualityDefinition(layout, flatten.flatten.handle, lookup.equality.lazy),
  );
  const keys = {
    anyStrTypeIdx: layout.anyStrTypeIdx,
    nativeStrTypeIdx: layout.nativeStrTypeIdx,
    nativeStrRef: { kind: "ref" as const, typeIdx: layout.nativeStrTypeIdx },
    strDataTypeIdx: layout.nativeStrDataTypeIdx,
    symbolTypeIdx: lookup.symbols.types.symbol.typeIndex,
    symbolKeysEnabled: true,
    strFlattenIdx: flatten.flatten.handle,
    strEqualsIdx: lookup.equality.equals.handle,
  };
  canonical(
    tx,
    own.lookup.hash,
    buildOrdinaryObjectHashDefinition({ ...keys, hashedStrTypeIdx: layout.hashedStrTypeIdx, nativeFirst: true }),
  );
  canonical(tx, own.lookup.keyEquals, buildOrdinaryObjectKeyEqualsDefinition(keys));
  canonical(
    tx,
    own.lookup.findOwn,
    buildOrdinaryObjectFindDefinition({
      ...keys,
      objectTypeIdx: lookup.layouts.object.typeIndex,
      propMapTypeIdx: lookup.layouts.propMap.typeIndex,
      propEntryTypeIdx: lookup.layouts.propEntry.typeIndex,
      keyEqualsIdx: own.lookup.keyEquals.handle,
      objHashIdx: own.lookup.hash.handle,
      tombstoneFlag: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.tombstone,
    }),
  );
  const strings = {
    anyStrTypeIdx: layout.anyStrTypeIdx,
    nativeStrTypeIdx: layout.nativeStrTypeIdx,
    nativeStrDataTypeIdx: layout.nativeStrDataTypeIdx,
    flattenIdx: flatten.flatten.handle,
  };
  canonical(tx, d.stringOwn.arrayIndex, buildStringExoticIndexDefinition(strings));
  canonical(
    tx,
    d.stringOwn.virtualOwn,
    buildStringVirtualOwnDescriptorDefinition({
      ...strings,
      objectTypeIdx: lookup.layouts.object.typeIndex,
      stringObjectTypeIdx: own.layouts.types.String.typeIndex,
      propEntryTypeIdx: lookup.layouts.propEntry.typeIndex,
      indexIdx: d.stringOwn.arrayIndex.handle,
    }),
  );
  canonical(
    tx,
    d.stringOwn.findOwn,
    buildStringExoticOwnDescriptorDefinition({
      propEntryTypeIdx: lookup.layouts.propEntry.typeIndex,
      ordinaryFindIdx: own.lookup.findOwn.handle,
      virtualOwnIdx: d.stringOwn.virtualOwn.handle,
    }),
  );
}
function completedDependencies(tx: PhysicalModuleReservations, d: NativeMixedObjectAccessDependencies): void {
  requireCompletedNativeRealmObjectLayouts(tx, d.realm.layouts);
  requireCompletedNativeStringOwnDescriptors(tx, d.stringOwn, d.stringOwnDependencies);
  requireCompletedNativeValues(tx, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeInvocationSubstrate(tx, d.realmDependencies.substrate);
  canonicalDependencies(tx, d);
}
/** Fills structural algorithms only. Source body authority, complete populations and getter Call remain pending. */
export function fillNativeMixedObjectAccessStructure(
  tx: PhysicalModuleReservations,
  pack: NativeMixedObjectAccessReservations,
): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate structural fill");
  completedDependencies(tx, owner.identities);
  const d = operands(tx, pack, owner.identities);
  const definitions = structuralRoles.map((role) => builders[role](d));
  structuralRoles.forEach((role, i) => tx.fillFunction(pack[role], definitions[i]!));
  owner.filled = true;
}
export function requireCompletedNativeMixedObjectAccessStructure(
  tx: PhysicalModuleReservations,
  pack: NativeMixedObjectAccessReservations,
  expectedDependencies?: NativeMixedObjectAccessDependencies,
): NativeMixedObjectAccessReservations {
  requireNativeMixedObjectAccessReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical structural fill");
  completedDependencies(tx, owner.identities);
  const d = operands(tx, pack, owner.identities);
  for (const role of structuralRoles) {
    tx.assertCompletedReservation(pack[role]);
    same(
      { locals: pack[role].object.locals, body: pack[role].object.body },
      builders[role](d),
      "noncanonical structural body " + role,
    );
  }
  return pack;
}
/** A filled-looking Get token or declaration counters cannot substitute for the genuine missing graph. */
export function requireCompletedNativeMixedObjectAccess(
  tx: PhysicalModuleReservations,
  pack: NativeMixedObjectAccessReservations,
): never {
  requireNativeMixedObjectAccessReservations(tx, pack);
  fail("mixed Call, source lowering/allocation and complete intrinsic populations remain unavailable");
}
export function nativeMixedObjectAccessReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeMixedObjectAccessReservations,
) {
  const owner = current(tx, pack);
  return Object.freeze({
    plan: owner.plan,
    functions: owner.tokens,
    structuralFunctions: Object.freeze(structuralRoles.map((role) => pack[role])),
    pendingGet: pack.get,
    completionScope: pack.completionScope,
  });
}
