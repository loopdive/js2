// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own:
 *   - `define-data` is the descriptor pack's public define, bound as it is;
 *   - `create-default` and `get` are adapters (`source-object-bodies.ts`) over the storage pack and the builtin-object
 *     kernel.
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
  type SourceObjectDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import type { NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";

const EXTERNREF = { kind: "externref" } as const;
/** One adapter: the contract signature it reserves and its body over the realm's packs. */
interface Adapter {
  readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
  readonly body: (dependencies: NativeSourceObjectDependencies) => SourceObjectDefinition;
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
      const { signature } = ADAPTERS[feature];
      return [
        feature,
        tx.reserveFunction(key, key, { params: [...signature.params], results: [...signature.results] }),
      ] as const;
    }),
  );
  return Object.freeze({ adapters, dependencies });
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  for (const [feature, token] of pack.adapters) tx.fillFunction(token, ADAPTERS[feature].body(pack.dependencies));
}
