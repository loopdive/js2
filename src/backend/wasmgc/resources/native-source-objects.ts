// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own:
 *   - `define-data` is the descriptor pack's public define, bound as it is;
 *   - `create-default` and `get` are adapters (`source-object-bodies.ts`) over the storage pack and the builtin-object
 *     kernel;
 *   - (#7352 arrays) `create-array`, `get-index`, `set-index` and `set-length` act on the kernel's Array exotic
 *     object (`array-exotic-bodies.ts`, `array-index-bodies.ts`, `array-length-bodies.ts`) and share the helper
 *     functions of `HELPERS`.
 * A contract without a row here has no native source provider yet.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import { buildArrayCreateDefinition } from "../../../runtime/wasmgc/values/array-exotic-bodies.js";
import {
  buildArrayGetIndexDefinition,
  buildArraySetIndexDefinition,
} from "../../../runtime/wasmgc/values/array-index-bodies.js";
import { buildArraySetLengthDefinition } from "../../../runtime/wasmgc/values/array-length-bodies.js";
import { buildStringIndexKeyDefinition } from "../../../runtime/wasmgc/values/string-index-key-body.js";
import { buildVectorGrowStoreBody } from "../../../runtime/wasmgc/values/vector-grow-store.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
  type SourceObjectDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import { nativeBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import {
  nativeBuiltinFunctionArrayOperands,
  type NativeBuiltinFunctionReservations,
} from "./native-builtin-functions.js";
import { buildNativeErrorValue, type NativeErrorKind, type NativeErrorReservations } from "./native-errors.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";

const EXTERNREF = { kind: "externref" } as const;
const I32 = { kind: "i32" } as const;
/** An index or a length: an f64. */
const NUMBER = { kind: "f64" } as const;
interface Signature {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}
/** (#7352 arrays) The kernel's array operands; present whenever an array contract reserved the `$Array` layout. */
const arrayOperands = ({ kernel }: NativeSourceObjectDependencies, tx: PhysicalModuleReservations) =>
  nativeBuiltinFunctionArrayOperands(tx, kernel) ?? fail("array contract without the realm's array layout");

/** A function several adapters call: its signature over the element vector's type, and its body. */
interface Helper {
  readonly signature: (vectorTypeIdx: number) => Signature;
  readonly body: (
    dependencies: NativeSourceObjectDependencies,
    tx: PhysicalModuleReservations,
  ) => SourceObjectDefinition;
}
/** (#7352 arrays) The helpers of the array adapters. One is reserved when an adapter that lists it is. */
const HELPERS = {
  /** (vector, index, value): the shared vector grow/store helper over the element vector, gaps filled with holes. */
  "element-store": {
    signature: (vectorTypeIdx) => ({
      params: [{ kind: "ref_null", typeIdx: vectorTypeIdx }, I32, EXTERNREF],
      results: [],
    }),
    body: (d, tx) => {
      const { vectorTypeIdx, vectorArrayTypeIdx, hole } = arrayOperands(d, tx);
      return buildVectorGrowStoreBody({
        carrierTypeIndex: vectorTypeIdx,
        arrayTypeIndex: vectorArrayTypeIdx,
        exceptionTagIndex: tx.physicalIndex(d.kernel.exception),
        gapFill: { kind: "hole-global", globalIndex: hole },
      });
    },
  },
  /**
   * (u32) -> String: the canonical string of an array index, built by the String exotic objects' index-key body
   * (`string-index-key-body.ts`); the realm does not hold that pack, so it reserves its own instance.
   */
  "index-key": {
    signature: () => ({ params: [I32], results: [EXTERNREF] }),
    body: ({ kernel }, tx) => {
      const { layout } = nativeBuiltinFunctionRequestDependencies(tx, kernel.requests).strings;
      return buildStringIndexKeyDefinition(layout.nativeStrTypeIdx, layout.nativeStrDataTypeIdx);
    },
  },
} as const satisfies Readonly<Record<string, Helper>>;
type HelperName = keyof typeof HELPERS;

/**
 * (#7352 arrays) The RangeError of ArraySetLength. The tag is RangeError's in the builtin tag catalog
 * (`BUILTIN_TYPE_TAGS`), an ABI invariant like the invocation substrate's TypeError tag.
 */
const INVALID_ARRAY_LENGTH: NativeErrorKind = { name: "RangeError", tag: -12, message: "Invalid array length" };

/** What a body reads at fill time beyond the packs: the transaction and the helpers its row lists. */
interface AdapterFill {
  readonly tx: PhysicalModuleReservations;
  readonly helper: (name: HelperName) => number;
}
/** One adapter: the contract signature it reserves, its body over the realm's packs, and what else it needs. */
interface Adapter {
  readonly signature: Signature;
  readonly body: (dependencies: NativeSourceObjectDependencies, fill: AdapterFill) => SourceObjectDefinition;
  /** (#7352 arrays) The body acts on an `$Array`: the realm declares that layout when the contract is used. */
  readonly array?: true;
  readonly helpers?: readonly HelperName[];
  /** String literals the body reads; the realm's literal plan declares them with the contract. */
  readonly literals?: readonly string[];
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
  "js.object.create-array": {
    signature: { params: [NUMBER], results: [EXTERNREF] },
    array: true,
    body: (d, { tx }) => buildArrayCreateDefinition(arrayOperands(d, tx)),
  },
  "js.object.get-index": {
    signature: { params: [EXTERNREF, NUMBER, EXTERNREF], results: [EXTERNREF] },
    array: true,
    helpers: ["index-key"],
    body: (d, { tx, helper }) =>
      buildArrayGetIndexDefinition({
        ...arrayOperands(d, tx),
        indexKey: helper("index-key"),
        get: d.kernel.functions.get.handle,
      }),
  },
  "js.object.set-index": {
    signature: { params: [EXTERNREF, NUMBER, EXTERNREF], results: [] },
    array: true,
    helpers: ["element-store", "index-key"],
    body: (d, { tx, helper }) =>
      buildArraySetIndexDefinition({
        ...arrayOperands(d, tx),
        indexKey: helper("index-key"),
        elementStore: helper("element-store"),
        defineData: d.descriptors.defineData.handle,
      }),
  },
  "js.object.set-length": {
    signature: { params: [EXTERNREF, NUMBER], results: [] },
    array: true,
    literals: [INVALID_ARRAY_LENGTH.name, INVALID_ARRAY_LENGTH.message],
    body: (d, { tx }) =>
      buildArraySetLengthDefinition({
        ...arrayOperands(d, tx),
        invalidLength: [
          ...buildNativeErrorValue(tx, d.errors, INVALID_ARRAY_LENGTH),
          { op: "throw", tagIdx: tx.physicalIndex(d.kernel.exception) },
        ],
      }),
  },
} as const satisfies Readonly<Record<string, Adapter>>;
type Adapted = keyof typeof ADAPTERS;
const isAdapted = (feature: OrdinaryObjectRuntimeFeature): feature is Adapted => Object.hasOwn(ADAPTERS, feature);
const adapter = (feature: Adapted): Adapter => ADAPTERS[feature];

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
/** (#7352 arrays) Whether a contract of `features` acts on an `$Array`. */
export function nativeSourceObjectsUseArrays(features: readonly OrdinaryObjectRuntimeFeature[]): boolean {
  return features.some((feature) => isAdapted(feature) && adapter(feature).array === true);
}
/** The string literals the adapters of `features` read. */
export function nativeSourceObjectLiterals(features: readonly OrdinaryObjectRuntimeFeature[]): readonly string[] {
  return features.filter(isAdapted).flatMap((feature) => adapter(feature).literals ?? []);
}

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  readonly errors: NativeErrorReservations;
}
export interface NativeSourceObjectReservations {
  readonly adapters: ReadonlyMap<Adapted, FunctionReservation>;
  readonly helpers: ReadonlyMap<HelperName, FunctionReservation>;
  readonly dependencies: NativeSourceObjectDependencies;
}

/** One adapter per adapted contract the program calls, and the helpers those list; `define-data` needs none. */
export function reserveNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  realmKey: string,
  features: readonly OrdinaryObjectRuntimeFeature[],
  dependencies: NativeSourceObjectDependencies,
): NativeSourceObjectReservations {
  const reserve = (key: string, name: string, { params, results }: Signature) =>
    tx.reserveFunction(key, name, { params: [...params], results: [...results] });
  const adapted = [...new Set(features)].filter(isAdapted).sort();
  const adapters = new Map(
    adapted.map((feature) => {
      const key = nativeSourceObjectResourceKey(realmKey, feature)!;
      return [feature, reserve(key, key, adapter(feature).signature)] as const;
    }),
  );
  const vector = nativeBuiltinFunctionRequestDependencies(tx, dependencies.kernel.requests).arguments.carrier;
  const used = [...new Set(adapted.flatMap((feature) => adapter(feature).helpers ?? []))].sort();
  const helpers = new Map(
    used.map((name) => {
      const signature = HELPERS[name].signature(vector.typeIndex);
      return [name, reserve(realmKey + ":source-objects:" + name, realmKey + ":" + name, signature)] as const;
    }),
  );
  return Object.freeze({ adapters, helpers, dependencies });
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const fill: AdapterFill = { tx, helper: (name) => pack.helpers.get(name)!.handle };
  for (const [feature, token] of pack.adapters) tx.fillFunction(token, adapter(feature).body(pack.dependencies, fill));
  for (const [name, token] of pack.helpers) tx.fillFunction(token, HELPERS[name].body(pack.dependencies, tx));
}
function fail(detail: string): never {
  throw new Error("native source objects: " + detail);
}
