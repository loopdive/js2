// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own:
 *   - `define-data` is the descriptor pack's public define, bound as it is;
 *   - `create-default` and `get` are adapters (`source-object-bodies.ts`) over the storage pack and the builtin-object
 *     kernel;
 *   - (#7352 arrays) `create-array`, `get-index` and `set-index` act on the kernel's Array exotic object
 *     (`array-exotic-bodies.ts`); `set-index` stores through the shared vector grow/store helper.
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  buildArrayCreateDefinition,
  buildArrayGetIndexDefinition,
  buildArraySetIndexDefinition,
} from "../../../runtime/wasmgc/values/array-exotic-bodies.js";
import { buildVectorGrowStoreBody } from "../../../runtime/wasmgc/values/vector-grow-store.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import {
  nativeBuiltinFunctionArrayOperands,
  type NativeBuiltinFunctionReservations,
} from "./native-builtin-functions.js";
import { nativeBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";

const EXTERNREF = { kind: "externref" } as const;
const INDEX = { kind: "f64" } as const;
/** The adapters this module owns, with the contract signature each reserves. */
const ADAPTERS = {
  "js.object.create-default": { params: [], results: [EXTERNREF] },
  "js.object.get": { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
  "js.object.create-array": { params: [INDEX], results: [EXTERNREF] },
  "js.object.get-index": { params: [EXTERNREF, INDEX, EXTERNREF], results: [EXTERNREF] },
  "js.object.set-index": { params: [EXTERNREF, INDEX, EXTERNREF], results: [] },
} as const;
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
  /** The array element store `set-index` calls; absent without it. */
  readonly elementStore?: FunctionReservation;
  readonly dependencies: NativeSourceObjectDependencies;
}

/** One adapter per adapted contract the program calls; `define-data` needs none. */
export function reserveNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  realmKey: string,
  features: readonly OrdinaryObjectRuntimeFeature[],
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const adapted = [...new Set(features)].filter(isAdapted).sort();
  const adapters = new Map(
    adapted.map((feature) => {
      const key = nativeSourceObjectResourceKey(realmKey, feature)!;
      const signature = ADAPTERS[feature];
      return [
        feature,
        tx.reserveFunction(key, key, { params: [...signature.params], results: [...signature.results] }),
      ] as const;
    }),
  );
  const elementStore = adapters.has("js.object.set-index")
    ? tx.reserveFunction(realmKey + ":source-objects:element-store", realmKey + ":element-store", {
        params: [
          {
            kind: "ref_null",
            typeIdx: nativeBuiltinFunctionRequestDependencies(tx, dependencies.kernel.requests).arguments.carrier
              .typeIndex,
          },
          { kind: "i32" },
          EXTERNREF,
        ],
        results: [],
      })
    : undefined;
  return Object.freeze({ adapters, dependencies, ...(elementStore ? { elementStore } : {}) });
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const { layouts, storage, kernel } = pack.dependencies;
  const array = () =>
    nativeBuiltinFunctionArrayOperands(tx, kernel) ?? fail("array contract without the realm's array layout");
  const definition = (feature: Adapted) => {
    switch (feature) {
      case "js.object.create-default":
        return buildSourceObjectCreateDefinition({
          objectTypeIdx: layouts.object.typeIndex,
          objectPrototype: kernel.functions.objectPrototype.handle,
          createWithPrototype: storage.createWithPrototype.handle,
        });
      case "js.object.get":
        return buildSourceObjectGetDefinition({ get: kernel.functions.get.handle });
      case "js.object.create-array":
        return buildArrayCreateDefinition(array());
      case "js.object.get-index":
        return buildArrayGetIndexDefinition(array());
      case "js.object.set-index":
        return buildArraySetIndexDefinition(array(), pack.elementStore!.handle);
    }
  };
  for (const [feature, token] of pack.adapters) tx.fillFunction(token, definition(feature));
  if (pack.elementStore) {
    const { vectorTypeIdx, vectorArrayTypeIdx, hole } = array();
    tx.fillFunction(
      pack.elementStore,
      buildVectorGrowStoreBody({
        carrierTypeIndex: vectorTypeIdx,
        arrayTypeIndex: vectorArrayTypeIdx,
        exceptionTagIndex: tx.physicalIndex(kernel.exception),
        gapFill: { kind: "hole-global", globalIndex: hole },
      }),
    );
  }
}
function fail(detail: string): never {
  throw new Error("native source objects: " + detail);
}
