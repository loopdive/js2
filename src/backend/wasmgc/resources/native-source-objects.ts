// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own. A row either
 *   - adapts the realm (`create-default`, `get`, (#7354 O3) `set`, (#7354 O2b) `has`, (#7354 F1b) `init-function`,
 *     (#7354 C2) `create-with-prototype`, `inherits`):
 *     a function this module reserves, with the contract's signature and a body (`source-object-bodies.ts`,
 *     `source-function-object-bodies.ts`) over the realm's storage, kernel and descriptor packs; or
 *   - binds a realm function as it is (`define-data`: the descriptor pack's public define; (#7354 O4)
 *     `create-type-error`: the invocation substrate's TypeError constructor; (#7354 O1) `create-null`: the storage's
 *     OrdinaryObjectCreate(null)).
 * A contract without a row here has no native source provider yet. (#7354 O1) An adapter may call helpers, functions
 * this module reserves once for every served row that names one (`HELPERS`): only a program that calls such a contract
 * carries them.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { FuncHandle, Instr, ValType } from "../../../wasm/model/instructions.js";
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectCreateWithPrototypeDefinition,
  buildSourceObjectInheritsDefinition,
  buildSourceObjectGetDefinition,
  buildSourceObjectSetDefinition,
  buildSourceObjectHasDefinition,
  buildSourceObjectIsErrorDefinition,
  buildSourceObjectErrorFieldDefinition,
  sourceObjectCreate,
  type SourceObjectCreateOperands,
  type SourceObjectDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import { buildSourceFunctionInitDefinition } from "../../../runtime/wasmgc/values/source-function-object-bodies.js";
import { buildToBooleanBody, buildToBooleanLocals } from "../../../runtime/wasmgc/values/primitive-layouts.js";
import {
  buildToPropertyDescriptorDefinition,
  DESCRIPTOR_RECORD_LITERALS,
} from "../../../runtime/wasmgc/values/descriptor-record-bodies.js";
import {
  buildDescriptorDefineDefinition,
  buildDescriptorsDefineDefinition,
  buildOwnDescriptorDefinition,
  type ObjectStaticOperands,
} from "../../../runtime/wasmgc/values/object-static-bodies.js";
import { builtinTypeError } from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import { nativeBuiltinFunctionOperands, type NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import { nativeBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import type { NativeErrorReservations } from "./native-errors.js";
import type { NativeObjectDescriptorReservations } from "./native-object-descriptors.js";
import type { NativeObjectLayoutReservations } from "./native-object-layouts.js";
import type { NativeObjectStorageReservations } from "./native-object-storage.js";
import type { NativeValueReservations } from "./native-values.js";

export interface NativeSourceObjectDependencies {
  readonly values: NativeValueReservations;
  readonly layouts: NativeObjectLayoutReservations;
  readonly storage: NativeObjectStorageReservations;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly kernel: NativeBuiltinFunctionReservations;
  readonly errors: NativeErrorReservations;
}
const EXTERNREF = { kind: "externref" } as const;
const I32 = { kind: "i32" } as const;
const F64 = { kind: "f64" } as const;
function createOperands({ layouts, storage, kernel }: NativeSourceObjectDependencies): SourceObjectCreateOperands {
  return {
    objectTypeIdx: layouts.object.typeIndex,
    objectPrototype: kernel.functions.objectPrototype.handle,
    createWithPrototype: storage.createWithPrototype.handle,
  };
}
/** The externref of a realm string literal. */
function literalKey(tx: PhysicalModuleReservations, { kernel }: NativeSourceObjectDependencies) {
  const strings = nativeBuiltinFunctionRequestDependencies(tx, kernel.requests).strings;
  return (text: string): Instr[] => [...nativeStringLiteralInstrs(tx, strings, text), { op: "extern.convert_any" }];
}
type Signature = { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
type Helpers = Readonly<Partial<Record<HelperName, FuncHandle>>>;
type Body = (
  dependencies: NativeSourceObjectDependencies,
  tx: PhysicalModuleReservations,
  helpers: Helpers,
) => SourceObjectDefinition;
/** (#7354 O1) The operands of the `Object` statics' bodies: the kernel's roles, the realm's layouts and the helpers. */
function objectStaticOperands(
  dependencies: NativeSourceObjectDependencies,
  tx: PhysicalModuleReservations,
  helpers: Helpers,
): ObjectStaticOperands {
  const { values, layouts, errors, kernel } = dependencies;
  const k = kernel.functions;
  const d = nativeBuiltinFunctionOperands(tx, kernel);
  const key = literalKey(tx, dependencies);
  return {
    objectTypeIdx: layouts.object.typeIndex,
    errorTypeIdx: errors.type.typeIndex,
    anyValueTypeIdx: values.types.anyValue.typeIndex,
    boxedBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
    match: k.match.handle,
    has: k.has.handle,
    get: k.get.handle,
    defineData: k.defineData.handle,
    defineAccessor: k.defineAccessor.handle,
    ownKeys: k.ownKeys.handle,
    ownDescriptor: k.ownDescriptor.handle,
    newVector: d.newVector,
    push: d.push,
    vectorTypeIdx: d.vectorTypeIdx,
    vectorArrayTypeIdx: d.vectorArrayTypeIdx,
    toBoolean: helpers["to-boolean"]!,
    toPropertyDescriptor: helpers["to-property-descriptor"]!,
    undefinedValue: [{ op: "global.get", index: d.undefinedGlobal }, { op: "extern.convert_any" }],
    key,
    typeError: (message) => builtinTypeError(d, key(message)),
  };
}
/** (#7354 O1) A function the adapters share, and the helpers it calls itself. */
interface Helper {
  readonly signature: Signature;
  readonly helpers: readonly HelperName[];
  readonly body: Body;
}
type HelperName = "to-boolean" | "to-property-descriptor";
const HELPERS: Readonly<Record<HelperName, Helper>> = {
  // ToBoolean over the carriers: the dynamic value's own body (`js.value.to_boolean`) on the realm's types.
  "to-boolean": {
    signature: { params: [EXTERNREF], results: [I32] },
    helpers: [],
    body: ({ values, kernel }, tx) => ({
      locals: buildToBooleanLocals(),
      body: buildToBooleanBody({
        anyValueTypeIdx: values.types.anyValue.typeIndex,
        internalizeOnce: true,
        boxNumberTypeIdx: values.types.boxedNumber.typeIndex,
        boxBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
        bigIntTypeIdx: undefined,
        anyStringTypeIdx: nativeBuiltinFunctionRequestDependencies(tx, kernel.requests).strings.layout.anyStrTypeIdx,
      }),
    }),
  },
  "to-property-descriptor": {
    signature: { params: [EXTERNREF], results: [I32, EXTERNREF, EXTERNREF, EXTERNREF] },
    helpers: ["to-boolean"],
    body: (dependencies, tx, helpers) =>
      buildToPropertyDescriptorDefinition(objectStaticOperands(dependencies, tx, helpers)),
  },
};
/**
 * An adapter (the contract signature it reserves, its body over the realm's packs and the helpers it calls) or a
 * bound realm function.
 */
type Row =
  | {
      readonly signature: Signature;
      readonly body: Body;
      readonly helpers?: readonly HelperName[];
      /** The realm string literals the body reads beyond the catalog's (`native-realm-literals.ts`). */
      readonly literals?: readonly string[];
    }
  | { readonly binds: (dependencies: NativeSourceObjectDependencies) => FunctionReservation };
/** The contracts the realm serves. A new realm-served contract is one row. */
const ROWS = {
  "js.object.create-default": {
    signature: { params: [], results: [EXTERNREF] },
    body: (dependencies) => buildSourceObjectCreateDefinition(createOperands(dependencies)),
  },
  "js.object.create-with-prototype": {
    signature: { params: [EXTERNREF], results: [EXTERNREF] },
    body: (dependencies) => buildSourceObjectCreateWithPrototypeDefinition(createOperands(dependencies)),
  },
  "js.object.create-null": { binds: ({ storage }) => storage.createNull },
  "js.object.define-data": { binds: ({ descriptors }) => descriptors.defineData },
  "js.object.create-type-error": { binds: ({ errors }) => errors.newTypeError },
  "js.object.get": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
  },
  "js.object.set": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ layouts, kernel, descriptors }, tx) =>
      buildSourceObjectSetDefinition({
        entryTypeIdx: layouts.propEntry.typeIndex,
        objectTypeIdx: layouts.object.typeIndex,
        findOwn: nativeBuiltinFunctionOperands(tx, kernel).findOrdinary,
        lookup: kernel.functions.lookup.handle,
        defineData: descriptors.defineData.handle,
        bag: kernel.functions.bag.handle,
      }),
  },
  "js.object.has": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ kernel }) => buildSourceObjectHasDefinition({ has: kernel.functions.has.handle }),
  },
  "js.object.is-error": {
    signature: { params: [EXTERNREF], results: [I32] },
    body: ({ errors }) => buildSourceObjectIsErrorDefinition({ errorTypeIdx: errors.type.typeIndex }),
  },
  "js.object.error-field": {
    signature: { params: [EXTERNREF, I32], results: [EXTERNREF] },
    body: ({ errors }) => buildSourceObjectErrorFieldDefinition({ errorTypeIdx: errors.type.typeIndex }),
  },
  "js.object.init-function": {
    signature: { params: [EXTERNREF, EXTERNREF, F64, I32], results: [] },
    body: (dependencies, tx) => {
      const key = literalKey(tx, dependencies);
      return buildSourceFunctionInitDefinition({
        kernel: nativeBuiltinFunctionOperands(tx, dependencies.kernel),
        create: createOperands(dependencies),
        prototypeKey: key("prototype"),
        constructorKey: key("constructor"),
      });
    },
  },
  "js.object.inherits": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ layouts, kernel }, tx) =>
      buildSourceObjectInheritsDefinition({
        objectTypeIdx: layouts.object.typeIndex,
        sameValue: nativeBuiltinFunctionOperands(tx, kernel).sameValue,
      }),
  },
  "js.object.descriptor-define": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [] },
    helpers: ["to-property-descriptor"],
    literals: DESCRIPTOR_RECORD_LITERALS,
    body: (dependencies, tx, helpers) =>
      buildDescriptorDefineDefinition(objectStaticOperands(dependencies, tx, helpers)),
  },
  "js.object.descriptors-define": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [] },
    helpers: ["to-property-descriptor"],
    literals: DESCRIPTOR_RECORD_LITERALS,
    body: (dependencies, tx, helpers) =>
      buildDescriptorsDefineDefinition(objectStaticOperands(dependencies, tx, helpers)),
  },
  "js.object.own-descriptor": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    literals: DESCRIPTOR_RECORD_LITERALS,
    body: (dependencies, tx, helpers) =>
      buildOwnDescriptorDefinition(
        objectStaticOperands(dependencies, tx, helpers),
        sourceObjectCreate(createOperands(dependencies)),
        dependencies.descriptors.defineData.handle,
      ),
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

const adapterOf = (feature: NativeSourceObjectFeature): Extract<Row, { body: Body }> | undefined => {
  const row: Row = ROWS[feature];
  return "body" in row ? row : undefined;
};
/** (#7354 O1) The realm string literals the served contracts' bodies read. */
export function nativeSourceObjectLiterals(features: readonly OrdinaryObjectRuntimeFeature[]): readonly string[] {
  return [...new Set(features.filter(isServed).flatMap((feature) => adapterOf(feature)?.literals ?? []))];
}
/** The helpers `names` call, themselves included, each once, callees first. */
function helperClosure(names: readonly HelperName[], into: HelperName[] = []): HelperName[] {
  for (const name of names)
    if (!into.includes(name)) {
      helperClosure(HELPERS[name].helpers, into);
      into.push(name);
    }
  return into;
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
  /** The helpers the served adapters call, by name. */
  readonly helpers: ReadonlyMap<HelperName, FunctionReservation>;
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
  const names = helperClosure(served.flatMap(({ feature }) => adapterOf(feature)?.helpers ?? []));
  const helpers = new Map(
    names.map((name) => {
      const key = realmKey + ":source-objects:helper:" + name;
      const { params, results } = HELPERS[name].signature;
      return [name, tx.reserveFunction(key, key, { params: [...params], results: [...results] })] as const;
    }),
  );
  const pack = Object.freeze({ served: Object.freeze(served) });
  owners.set(pack, { tx, helpers, dependencies, identities: Object.freeze({ ...dependencies }), filled: false });
  return pack;
}

/** The functions this pack owns: its adapters and their helpers. A bound function stays in its producer's inventory. */
export function nativeSourceObjectReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): readonly FunctionReservation[] {
  const { helpers } = requireOwner(tx, pack);
  return [...pack.served.filter((row) => adapterOf(row.feature)).map((row) => row.token), ...helpers.values()];
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate canonical fill");
  const handles: Helpers = Object.fromEntries([...owner.helpers].map(([name, token]) => [name, token.handle]));
  for (const [name, token] of owner.helpers)
    tx.fillFunction(token, HELPERS[name].body(owner.dependencies, tx, handles));
  for (const { feature, token } of pack.served) {
    const adapter = adapterOf(feature);
    if (adapter) tx.fillFunction(token, adapter.body(owner.dependencies, tx, handles));
  }
  owner.filled = true;
}

/** The canonical fill ran, and every served function (adapter or bound) is completed. */
export function requireCompletedNativeSourceObjects(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): NativeSourceObjectReservations {
  const owner = requireOwner(tx, pack);
  if (!owner.filled) fail("missing canonical fill");
  for (const token of [...pack.served.map((row) => row.token), ...owner.helpers.values()])
    tx.assertCompletedReservation(token);
  return pack;
}
