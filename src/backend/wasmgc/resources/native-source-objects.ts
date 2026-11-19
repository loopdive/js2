// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own:
 *   - the three `define-*` contracts are the descriptor pack's public defines, bound as they are;
 *   - `create-default` and `get` are adapters (`source-object-bodies.ts`) over the storage pack and the builtin-object
 *     kernel; (#7368) the own-property contracts are adapters over the storage pack's own-entry lookup.
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

const EXTERNREF = { kind: "externref" } as const;
const OWN_TEST = { params: [EXTERNREF, EXTERNREF], results: [{ kind: "i32" }] } as const;
/** FromPropertyDescriptor's field names (§6.2.5.4). */
const DESCRIPTOR_FIELDS = ["value", "writable", "get", "set", "enumerable", "configurable"] as const;
const NOT_COERCIBLE = "Cannot convert undefined or null to object";
/** One adapter: the contract signature it reserves and its body over the realm's packs. */
interface Adapter {
  readonly signature: { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
  /** The realm string literals the body reads; the realm's literal plan reserves them (`nativeSourceObjectLiterals`). */
  readonly literals?: readonly string[];
  readonly body: (
    dependencies: NativeSourceObjectDependencies,
    tx: PhysicalModuleReservations,
  ) => SourceObjectDefinition;
}
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
/** The adapters this module owns. A new realm-served contract is one row. */
const ADAPTERS = {
  "js.object.create-default": { signature: { params: [], results: [EXTERNREF] }, body: createDefault },
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
} as const satisfies Readonly<Record<string, Adapter>>;
type Adapted = keyof typeof ADAPTERS;
const isAdapted = (feature: OrdinaryObjectRuntimeFeature): feature is Adapted => Object.hasOwn(ADAPTERS, feature);
/** The contracts the descriptor pack's public functions serve as they are, by the role each is reserved under. */
const DESCRIPTOR_ROLE: Partial<Record<OrdinaryObjectRuntimeFeature, string>> = {
  "js.object.define-data": "define-data",
  "js.object.define-accessor": "define-accessor",
  "js.object.define-attributes": "define-attributes",
};

/** The realm string literals the adapters of `features` read. */
export function nativeSourceObjectLiterals(features: readonly OrdinaryObjectRuntimeFeature[]): readonly string[] {
  return features.flatMap((feature) => (isAdapted(feature) ? ((ADAPTERS[feature] as Adapter).literals ?? []) : []));
}

/**
 * The reservation key of the function that serves `feature` in the realm keyed `realmKey`, or `undefined` when the
 * contract has no native source provider. The physical plan's binding rows and the reservations below both use it.
 */
export function nativeSourceObjectResourceKey(
  realmKey: string,
  feature: OrdinaryObjectRuntimeFeature,
): string | undefined {
  const role = DESCRIPTOR_ROLE[feature];
  if (role !== undefined) return realmKey + ":descriptors:" + role;
  return isAdapted(feature) ? realmKey + ":source-objects:" + feature : undefined;
}

export interface NativeSourceObjectDependencies {
  readonly layouts: NativeObjectLayoutReservations;
  readonly lookup: NativeObjectLookupReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  readonly values: NativeValueReservations;
  readonly booleans: NativeBooleanReservations;
  readonly errors: NativeErrorReservations;
  readonly strings: NativeStringLiteralReservations;
}
export interface NativeSourceObjectReservations {
  readonly adapters: ReadonlyMap<Adapted, FunctionReservation>;
  readonly dependencies: NativeSourceObjectDependencies;
}

/** One adapter per adapted contract the program calls; a `define-*` contract needs none. */
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
  for (const [feature, token] of pack.adapters) tx.fillFunction(token, ADAPTERS[feature].body(pack.dependencies, tx));
}
