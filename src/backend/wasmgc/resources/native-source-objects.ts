// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own. A row either
 *   - adapts the realm (`create-default`, `get`; (#7368) the own-property contracts over the storage pack's
 *     own-entry lookup): a function this module reserves, with the contract's signature and a body
 *     (`source-object-bodies.ts`) over the storage pack and the builtin-object kernel; or
 *   - binds a realm function as it is (the `define-*` contracts: the descriptor pack's public defines; (#7354 O4)
 *     `create-type-error`: the invocation substrate's TypeError constructor).
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import { descriptorTypeError } from "../../../runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
  buildSourceObjectOwnDescriptorDefinition,
  buildSourceObjectOwnTestDefinition,
  type SourceObjectDefinition,
  type SourceObjectOwnOperands,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import type { NativeBooleanReservations } from "./native-booleans.js";
import type { NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import type { NativeErrorReservations } from "./native-errors.js";
import type { NativeObjectLookupReservations } from "./native-object-access.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";
import { nativeStringLiteralOperand, type NativeStringLiteralReservations } from "./native-string-literals.js";
import type { NativeValueReservations } from "./native-values.js";

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly lookup: NativeObjectLookupReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  readonly errors: NativeErrorReservations;
  readonly values: NativeValueReservations;
  readonly booleans: NativeBooleanReservations;
  readonly strings: NativeStringLiteralReservations;
}
const EXTERNREF = { kind: "externref" } as const;
const OWN_TEST = { params: [EXTERNREF, EXTERNREF], results: [{ kind: "i32" }] } as const;
/** FromPropertyDescriptor's field names (§6.2.5.4). */
const DESCRIPTOR_FIELDS = ["value", "writable", "get", "set", "enumerable", "configurable"] as const;
const NOT_COERCIBLE = "Cannot convert undefined or null to object";
/** An adapter (the contract signature it reserves, its body over the realm's packs) or a bound realm function. */
type Row =
  | {
      readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
      /** The realm string literals the body reads; the realm's literal plan reserves them (`nativeSourceObjectLiterals`). */
      readonly literals?: readonly string[];
      readonly body: (
        dependencies: NativeSourceObjectDependencies,
        tx: PhysicalModuleReservations,
      ) => SourceObjectDefinition;
    }
  | { readonly binds: (dependencies: NativeSourceObjectDependencies) => FunctionReservation };
const createDefault = ({ layouts, storage, kernel }: NativeSourceObjectDependencies) =>
  buildSourceObjectCreateDefinition({
    objectTypeIdx: layouts.object.typeIndex,
    objectPrototype: kernel.functions.objectPrototype.handle,
    createWithPrototype: storage.createWithPrototype.handle,
  });
const ownOperands = (d: NativeSourceObjectDependencies): SourceObjectOwnOperands => ({
  objectTypeIdx: d.layouts.object.typeIndex,
  entryTypeIdx: d.layouts.propEntry.typeIndex,
  findOwn: d.lookup.findOwn.handle,
  isOwnlessPrimitive: [d.values.functions.isNumber.handle, d.booleans.isBoolean.handle],
});
/** `get-own-property`: FromPropertyDescriptor over the own-entry lookup, its descriptor built by the pack's define. */
function getOwnPropertyAdapter(d: NativeSourceObjectDependencies, tx: PhysicalModuleReservations) {
  const literal = (text: string) => nativeStringLiteralOperand(tx, d.strings, text);
  return buildSourceObjectOwnDescriptorDefinition({
    ...ownOperands(d),
    create: createDefault(d).body,
    defineData: d.descriptors.defineData.handle,
    anyValueTypeIdx: d.values.types.anyValue.typeIndex,
    boxedBooleanTypeIdx: d.values.types.boxedBoolean.typeIndex,
    undefinedValue: [
      { op: "global.get", index: tx.physicalIndex(d.values.globals.undefined) },
      { op: "extern.convert_any" },
    ],
    notCoercible: descriptorTypeError(
      {
        constructorIdx: d.errors.newTypeError.handle,
        tagIdx: tx.physicalIndex(d.kernel.exception),
        messages: [literal(NOT_COERCIBLE)],
      },
      0,
    ),
    keys: (name) => literal(name),
  });
}
/** The contracts the realm serves. A new realm-served contract is one row. */
const ROWS = {
  "js.object.create-default": { signature: { params: [], results: [EXTERNREF] }, body: createDefault },
  "js.object.define-data": { binds: ({ descriptors }) => descriptors.defineData },
  "js.object.define-accessor": { binds: ({ descriptors }) => descriptors.defineAccessor },
  "js.object.define-attributes": { binds: ({ descriptors }) => descriptors.defineAttributes },
  "js.object.create-type-error": { binds: ({ errors }) => errors.newTypeError },
  "js.object.get": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
  },
  "js.object.has-own": { signature: OWN_TEST, body: (d) => buildSourceObjectOwnTestDefinition(ownOperands(d), false) },
  "js.object.property-is-enumerable": {
    signature: OWN_TEST,
    body: (d) => buildSourceObjectOwnTestDefinition(ownOperands(d), true),
  },
  "js.object.get-own-property": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    literals: [...DESCRIPTOR_FIELDS, NOT_COERCIBLE],
    body: getOwnPropertyAdapter,
  },
} as const satisfies Readonly<Partial<Record<OrdinaryObjectRuntimeFeature, Row>>>;
/** A contract the realm serves. */
export type NativeSourceObjectFeature = keyof typeof ROWS;
const isServed = (feature: OrdinaryObjectRuntimeFeature): feature is NativeSourceObjectFeature =>
  Object.hasOwn(ROWS, feature);
const servedKey = (realmKey: string, feature: NativeSourceObjectFeature) => realmKey + ":source-objects:" + feature;

/** The realm string literals the adapters of `features` read. */
export function nativeSourceObjectLiterals(features: readonly OrdinaryObjectRuntimeFeature[]): readonly string[] {
  return features.flatMap((feature) => {
    const row: Row | undefined = isServed(feature) ? ROWS[feature] : undefined;
    return row !== undefined && "literals" in row ? (row.literals ?? []) : [];
  });
}

/**
 * The key the program's call rows bind for `feature` in the realm keyed `realmKey`, or `undefined` when the contract
 * has no native source provider.
 */
export function nativeSourceObjectResourceKey(
  realmKey: string,
  feature: OrdinaryObjectRuntimeFeature,
): string | undefined {
  return isServed(feature) ? servedKey(realmKey, feature) : undefined;
}

/** The function serving one called contract, under the key its call rows bind. */
export interface NativeSourceObjectFunction {
  readonly feature: NativeSourceObjectFeature;
  readonly key: string;
  readonly token: FunctionReservation;
}
export interface NativeSourceObjectReservations {
  /** One row per contract the program calls, in contract order. */
  readonly served: readonly NativeSourceObjectFunction[];
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly dependencies: NativeSourceObjectDependencies;
  readonly identities: NativeSourceObjectDependencies;
  filled: boolean;
}
const owners = new WeakMap<NativeSourceObjectReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native source objects: " + detail);
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeSourceObjectReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  for (const key of Object.keys(owner.identities) as (keyof NativeSourceObjectDependencies)[])
    if (owner.dependencies[key] !== owner.identities[key]) fail("substituted dependency identity");
  return owner;
}

/** A function per served contract the program calls: an adapter reserved here, or the realm function a row binds. */
export function reserveNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  realmKey: string,
  features: readonly OrdinaryObjectRuntimeFeature[],
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const served = [...new Set(features)]
    .filter(isServed)
    .sort()
    .map((feature) => {
      const key = servedKey(realmKey, feature);
      const row: Row = ROWS[feature];
      const token =
        "binds" in row
          ? row.binds(dependencies)
          : tx.reserveFunction(key, key, { params: [...row.signature.params], results: [...row.signature.results] });
      return Object.freeze({ feature, key, token });
    });
  const pack = Object.freeze({ served: Object.freeze(served) });
  owners.set(pack, { tx, dependencies, identities: Object.freeze({ ...dependencies }), filled: false });
  return pack;
}

/** The functions this pack owns: its adapters. A bound function stays in its producer's inventory. */
export function nativeSourceObjectReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): readonly FunctionReservation[] {
  requireOwner(tx, pack);
  return pack.served.filter((row) => "body" in ROWS[row.feature]).map((row) => row.token);
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate canonical fill");
  for (const { feature, token } of pack.served) {
    const row: Row = ROWS[feature];
    if ("body" in row) tx.fillFunction(token, row.body(owner.dependencies, tx));
  }
  owner.filled = true;
}

/** The canonical fill ran, and every served function (adapter or bound) is completed. */
export function requireCompletedNativeSourceObjects(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): NativeSourceObjectReservations {
  if (!requireOwner(tx, pack).filled) fail("missing canonical fill");
  for (const { token } of pack.served) tx.assertCompletedReservation(token);
  return pack;
}
