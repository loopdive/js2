// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own. A row either
 *   - adapts the realm (`create-default`, `get`, (#7354 O3) `set`, (#7350 B2b) `global`): a function this module
 *     reserves, with the contract's signature and a body (`source-object-bodies.ts`) over the realm's storage, kernel
 *     and descriptor packs; or
 *   - binds a realm function as it is (`define-data`: the descriptor pack's public define; (#7354 O4)
 *     `create-type-error`: the invocation substrate's TypeError constructor).
 * A contract without a row here has no native source provider yet.
 */
import type {
  FunctionReservation,
  GlobalReservation,
  PhysicalModuleReservations,
} from "../../../wasm/physical/module-reservations.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
  buildSourceObjectGlobalDefinition,
  buildSourceObjectSetDefinition,
  type SourceObjectDefinition,
  type SourceObjectGlobalProperty,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "../../../runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import { nativeRealmGlobal, type NativeRealmGlobal } from "../../../runtime/contracts/native-realm-globals.js";
import type { NativeRealmDescription } from "../../../ir/program/native-realm-requirements.js";
import {
  nativeBuiltinFunctionSingletonBinding,
  type NativeBuiltinFunctionReservations,
} from "./native-builtin-functions.js";
import { nativeBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";
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
/** What an adapter's body is built from: the realm's packs, and (#7350 B2b) the global object's population. */
interface AdapterContext extends NativeSourceObjectDependencies {
  readonly tx: PhysicalModuleReservations;
  readonly globals: readonly NativeRealmGlobal[];
  /** The realm global a `cache` adapter keeps its answer in. */
  readonly cache?: GlobalReservation;
}
const I32 = { kind: "i32" } as const;
/** An adapter (the contract signature it reserves, its body over the realm's packs) or a bound realm function. */
type Row =
  | {
      readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
      /** (#7350 B2b) The answer is built once, on the first call, and kept in a realm global. */
      readonly cache?: true;
      readonly body: (context: AdapterContext) => SourceObjectDefinition;
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
  "js.object.set": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ layouts, kernel, descriptors }) =>
      buildSourceObjectSetDefinition({
        entryTypeIdx: layouts.propEntry.typeIndex,
        lookup: kernel.functions.lookup.handle,
        defineData: descriptors.defineData.handle,
      }),
  },
  "js.object.global": {
    signature: { params: [], results: [EXTERNREF] },
    cache: true,
    body: (context) =>
      buildSourceObjectGlobalDefinition({
        cache: context.tx.physicalIndex(context.cache!),
        objectTypeIdx: context.layouts.object.typeIndex,
        objectPrototype: context.kernel.functions.objectPrototype.handle,
        createWithPrototype: context.storage.createWithPrototype.handle,
        defineData: context.descriptors.defineData.handle,
        properties: context.globals.map((row) => globalProperty(context, row)),
      }),
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
  /** (#7350 B2b) The realm global of each `cache` adapter. */
  readonly caches: ReadonlyMap<NativeSourceObjectFeature, GlobalReservation>;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly dependencies: NativeSourceObjectDependencies;
  readonly identities: NativeSourceObjectDependencies;
  /** (#7350 B2b) The global object's population. */
  readonly globals: readonly NativeRealmGlobal[];
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
  realm: NativeRealmDescription,
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const served = [...new Set(realm.objectUses.map((use) => use.feature))]
    .filter(isServed)
    .sort()
    .map((feature) => {
      const key = servedKey(realm.key, feature);
      const row: Row = ROWS[feature];
      const token =
        "binds" in row
          ? row.binds(dependencies)
          : tx.reserveFunction(key, key, { params: [...row.signature.params], results: [...row.signature.results] });
      return Object.freeze({ feature, key, token });
    });
  const caches = new Map(
    served.flatMap(({ feature, key }) =>
      "cache" in ROWS[feature]
        ? [[feature, tx.reserveGlobal(key + ":cache", key + ":cache", EXTERNREF, true)] as const]
        : [],
    ),
  );
  const pack = Object.freeze({ served: Object.freeze(served), caches });
  const globals = realm.globalKeys.map((name) => nativeRealmGlobal(name)!);
  owners.set(pack, { tx, dependencies, identities: Object.freeze({ ...dependencies }), globals, filled: false });
  return pack;
}

/** The functions and globals this pack owns: its adapters and their caches. A bound function stays with its producer. */
export function nativeSourceObjectReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): { readonly functions: readonly FunctionReservation[]; readonly globals: readonly GlobalReservation[] } {
  requireOwner(tx, pack);
  return {
    functions: pack.served.filter((row) => "body" in ROWS[row.feature]).map((row) => row.token),
    globals: [...pack.caches.values()],
  };
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate canonical fill");
  for (const cache of pack.caches.values()) tx.fillGlobal(cache, [{ op: "ref.null.extern" }]);
  for (const { feature, token } of pack.served) {
    const row: Row = ROWS[feature];
    const cache = pack.caches.get(feature);
    const context = { ...owner.dependencies, tx, globals: owner.globals, ...(cache ? { cache } : {}) };
    if ("body" in row) tx.fillFunction(token, row.body(context));
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
  for (const cache of pack.caches.values()) tx.assertCompletedReservation(cache);
  return pack;
}

/**
 * (#7350 B2b) One own data property of the global object, with B2a's attributes (never enumerable): a callable is
 * the kernel's identity function object, a namespace a fresh identity-only object.
 */
function globalProperty(context: AdapterContext, row: NativeRealmGlobal): SourceObjectGlobalProperty {
  const { strings } = nativeBuiltinFunctionRequestDependencies(context.tx, context.kernel.requests);
  const token = requireNativeStringLiteral(context.tx, strings, row.name);
  const flags = ORDINARY_OBJECT_DESCRIPTOR_ENCODING;
  return {
    key: [
      token.kind === "global"
        ? { op: "global.get", index: context.tx.physicalIndex(token.global) }
        : { op: "call", funcIdx: token.function.handle },
      { op: "extern.convert_any" },
    ],
    value:
      row.value.kind === "function"
        ? {
            kind: "intrinsic",
            getter: nativeBuiltinFunctionSingletonBinding(context.tx, context.kernel, row.value.id).getter.handle,
          }
        : { kind: "namespace" },
    descriptor:
      (row.writable ? flags.writable : 0) |
      (row.configurable ? flags.configurable : 0) |
      flags.writableSpecified |
      flags.enumerableSpecified |
      flags.configurableSpecified |
      flags.hasValue,
  };
}
