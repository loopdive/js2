// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own:
 *   - `define-data` is the descriptor pack's public define, bound as it is, and (#7354 O4) `create-type-error` the
 *     invocation substrate's TypeError constructor;
 *   - `create-default` and `get` are adapters (`source-object-bodies.ts`) over the storage pack and the builtin-object
 *     kernel.
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
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";

const EXTERNREF = { kind: "externref" } as const;
/** What an adapter's body is built from: the realm's packs, and (#7350 B2b) the global object's population. */
interface AdapterContext extends NativeSourceObjectDependencies {
  readonly tx: PhysicalModuleReservations;
  readonly globals: readonly NativeRealmGlobal[];
  /** The realm global a `cache` adapter keeps its answer in. */
  readonly cache?: GlobalReservation;
}
/** One adapter: the contract signature it reserves and its body over the realm's packs. */
interface Adapter {
  readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
  /** (#7350 B2b) The answer is built once, on the first call, and kept in a realm global. */
  readonly cache?: true;
  readonly body: (context: AdapterContext) => SourceObjectDefinition;
}
/** The adapters this module owns. A new realm-served contract is one row. */
const ADAPTERS = {
  "js.object.create-default": {
    signature: { params: [], results: [EXTERNREF] },
    body: ({ layouts, storage, kernel }) =>
      buildSourceObjectCreateDefinition({
        objectTypeIdx: layouts.object.typeIndex,
        objectPrototype: kernel.functions.objectPrototype.handle,
        createWithPrototype: storage.createWithPrototype.handle,
      }),
  },
  "js.object.get": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
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
} as const satisfies Readonly<Record<string, Adapter>>;
type Adapted = keyof typeof ADAPTERS;
const isAdapted = (feature: OrdinaryObjectRuntimeFeature): feature is Adapted => Object.hasOwn(ADAPTERS, feature);

/**
 * The reservation key of the function that serves `feature` in the realm keyed `realmKey`, or `undefined` when the
 * contract has no native source provider. The physical plan's binding rows and the reservations below both use it.
 */
export function nativeSourceObjectResourceKey(
  realmKey: string,
  feature: OrdinaryObjectRuntimeFeature,
): string | undefined {
  if (feature === "js.object.define-data") return realmKey + ":descriptors:define-data";
  // (#7354 O4) The invocation substrate's errors pack builds the realm's TypeError.
  if (feature === "js.object.create-type-error") return realmKey + ":invocation-substrate:errors:new-TypeError";
  return isAdapted(feature) ? realmKey + ":source-objects:" + feature : undefined;
}

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
}
export interface NativeSourceObjectReservations {
  readonly adapters: ReadonlyMap<Adapted, FunctionReservation>;
  /** (#7350 B2b) The realm globals of the `cache` adapters. */
  readonly caches: ReadonlyMap<Adapted, GlobalReservation>;
  readonly dependencies: NativeSourceObjectDependencies;
  readonly globals: readonly NativeRealmGlobal[];
}

/** One adapter per adapted contract the program calls; `define-data` needs none. */
export function reserveNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  realm: NativeRealmDescription,
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const adapted = [...new Set(realm.objectUses.map((use) => use.feature))].filter(isAdapted).sort();
  const adapters = new Map(
    adapted.map((feature) => {
      const key = nativeSourceObjectResourceKey(realm.key, feature)!;
      const { signature } = ADAPTERS[feature];
      return [
        feature,
        tx.reserveFunction(key, key, { params: [...signature.params], results: [...signature.results] }),
      ] as const;
    }),
  );
  const caches = new Map(
    adapted
      .filter((feature) => (ADAPTERS[feature] as Adapter).cache)
      .map((feature) => {
        const key = nativeSourceObjectResourceKey(realm.key, feature)! + ":cache";
        return [feature, tx.reserveGlobal(key, key, EXTERNREF, true)] as const;
      }),
  );
  const globals = realm.globalKeys.map((name) => nativeRealmGlobal(name)!);
  return Object.freeze({ adapters, caches, dependencies, globals });
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  for (const cache of pack.caches.values()) tx.fillGlobal(cache, [{ op: "ref.null.extern" }]);
  for (const [feature, token] of pack.adapters) {
    const cache = pack.caches.get(feature);
    const context = { ...pack.dependencies, tx, globals: pack.globals, ...(cache ? { cache } : {}) };
    tx.fillFunction(token, ADAPTERS[feature].body(context));
  }
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
