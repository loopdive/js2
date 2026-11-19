// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own. A row either
 *   - adapts the realm (`create-default`, `get`, (#7354 O2b) `has`, `uncatchable-type-error`): a function this
 *     module reserves, with the contract's signature and a body (`source-object-bodies.ts`) over the storage pack
 *     and the builtin-object kernel; or
 *   - binds a realm function as it is (`define-data`: the descriptor pack's public define; (#7354 O4)
 *     `create-type-error`: the invocation substrate's TypeError constructor).
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectUncatchableTypeErrorDefinition,
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
  buildSourceObjectHasDefinition,
  type SourceObjectDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import type { NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import type { NativeErrorReservations } from "./native-errors.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  readonly errors: NativeErrorReservations;
}
const EXTERNREF = { kind: "externref" } as const;
const I32 = { kind: "i32" } as const;
/** An adapter (the contract signature it reserves, its body over the realm's packs) or a bound realm function. */
type Row =
  | {
      readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
      readonly body: (dependencies: NativeSourceObjectDependencies) => SourceObjectDefinition;
    }
  | { readonly binds: (dependencies: NativeSourceObjectDependencies) => FunctionReservation };
/** The contracts the realm serves. A new realm-served contract is one row. */
const ROWS = {
  "js.object.create-default": {
    signature: { params: [], results: [EXTERNREF] },
    body: ({ layouts, storage, kernel }) =>
      buildSourceObjectCreateDefinition({
        objectTypeIdx: layouts.object.typeIndex,
        objectPrototype: kernel.functions.objectPrototype.handle,
        createWithPrototype: storage.createWithPrototype.handle,
      }),
  },
  "js.object.define-data": { binds: ({ descriptors }) => descriptors.defineData },
  "js.object.create-type-error": { binds: ({ errors }) => errors.newTypeError },
  "js.object.get": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
  },
  "js.object.has": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ kernel }) => buildSourceObjectHasDefinition({ has: kernel.functions.has.handle }),
  },
  "js.object.uncatchable-type-error": {
    signature: { params: [], results: [] },
    body: buildSourceObjectUncatchableTypeErrorDefinition,
  },
} as const satisfies Readonly<Partial<Record<OrdinaryObjectRuntimeFeature, Row>>>;
/** A contract the realm serves. */
export type NativeSourceObjectFeature = keyof typeof ROWS;
const isServed = (feature: OrdinaryObjectRuntimeFeature): feature is NativeSourceObjectFeature =>
  Object.hasOwn(ROWS, feature);
const servedKey = (realmKey: string, feature: NativeSourceObjectFeature) => realmKey + ":source-objects:" + feature;

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
    if ("body" in row) tx.fillFunction(token, row.body(owner.dependencies));
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
