// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The public source-object functions on the realm. A source program reaches an ordinary object only
 * through the `js.object.*` contracts (`ordinary-object-callables.ts`); each contract it calls binds one function
 * here, whose signature is the contract's and whose algorithm is the realm's own. A row either
 *   - adapts the realm (`create-default`, `get`, (#7354 O3) `set`, (#7354 O2b) `has`, (#7354 F1b) `init-function`,
 *     (#7354 C2) `create-with-prototype`, `inherits`):
 *     a function this module reserves, with the contract's signature and a body (`source-object-bodies.ts`,
 *     `source-function-object-bodies.ts`) over the realm's storage, kernel and descriptor packs; or
 *   - binds a realm function as it is (`define-data`, (#7354 O2) `define-accessor`: the descriptor pack's public
 *     defines; (#7354 O4)
 *     `create-type-error`: the invocation substrate's TypeError constructor; (#7354 O1) `create-null`: the storage's
 *     OrdinaryObjectCreate(null)).
 * A contract without a row here has no native source provider yet. (#7354 O1) An adapter that reads descriptors calls
 * the record helpers (`RecordHelpers`), reserved once and only for a program that calls such a contract.
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
  buildSourceObjectIntrinsicDefinition,
  buildSourceObjectIsIntrinsicDefinition,
  buildSourceObjectIsOneOfDefinition,
  buildSourceObjectHasOwnDefinition,
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
import {
  nativeBuiltinFunctionOperands,
  nativeBuiltinFunctionSingletonBinding,
  type NativeBuiltinFunctionReservations,
} from "./native-builtin-functions.js";
import {
  NATIVE_REALM_CATALOG,
  NATIVE_VALUE_INTRINSICS,
  NATIVE_WRAPPER_CONSTRUCTORS,
  realmMethodId,
} from "../../../runtime/contracts/native-realm-catalog.js";
import { lacksCatalogProperty } from "../program/native-realm-families.js";
import {
  buildWrapperCreateDefinition,
  buildWrapperDataDefinition,
} from "../../../runtime/wasmgc/values/realm-wrapper-bodies.js";
import { realmWrapperKinds, type NativeRealmWrappers } from "./native-realm-wrappers.js";
import type { NativeStringFlattenReservations } from "./native-string-flatten.js";
import {
  buildErrorToStringDefinition,
  buildHasBrandDefinition,
} from "../../../runtime/wasmgc/values/realm-family-bodies.js";
import type { NativeRealmArrays } from "./native-realm-arrays.js";
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
  /** (#7354 W2) Where the realm holds a wrapper family: its wrappers and the string flattener. */
  readonly wrappers?: NativeRealmWrappers & { readonly flatten: NativeStringFlattenReservations };
  /** (#7354 A1) Where the realm holds the Array family: its array creation and define. */
  readonly arrays?: NativeRealmArrays;
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
/** (#7354 W2) A wrapper prototype method's wrong-receiver message (V8's text). */
const wrapperMethodMessage = (kind: string, method: string) =>
  `${kind}.prototype.${method} requires that 'this' be a ${kind}`;
/** The prototype methods `wrapper-data` answers, in `WRAPPER_DATA` order. */
const WRAPPER_METHODS = ["valueOf", "toString"] as const;
const WRAPPER_METHOD_MESSAGES: readonly string[] = NATIVE_WRAPPER_CONSTRUCTORS.flatMap((kind) =>
  WRAPPER_METHODS.map((method) => wrapperMethodMessage(kind, method)),
);
/** (#7354 W2) How the realm represents the primitives a wrapper holds. */
function wrapperRepresentation({ values, kernel }: NativeSourceObjectDependencies, tx: PhysicalModuleReservations) {
  return {
    anyStrTypeIdx: nativeBuiltinFunctionRequestDependencies(tx, kernel.requests).strings.layout.anyStrTypeIdx,
    boxedBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
    boxNumber: values.functions.boxNumber.handle,
    unboxNumber: values.functions.unboxNumber.handle,
    isNumber: values.functions.isNumber.handle,
  };
}
/**
 * (#7354 W2) `wrapper-data`'s operands: no kind where the realm holds no wrapper family (a program may ask whether an
 * object is a wrapper, or a method a wrapper's, where none can exist).
 */
function wrapperDataOperands(dependencies: NativeSourceObjectDependencies, tx: PhysicalModuleReservations) {
  const { kernel, wrappers } = dependencies;
  const d = nativeBuiltinFunctionOperands(tx, kernel);
  const key = literalKey(tx, dependencies);
  const method = (kind: string, name: (typeof WRAPPER_METHODS)[number]) => ({
    value: [
      {
        op: "call",
        funcIdx: nativeBuiltinFunctionSingletonBinding(tx, kernel, realmMethodId(`${kind}.prototype`, name)).getter
          .handle,
      } as Instr,
    ],
    throwTypeError: builtinTypeError(d, key(wrapperMethodMessage(kind, name))),
  });
  return {
    ...wrapperRepresentation(dependencies, tx),
    kinds: wrappers
      ? realmWrapperKinds(tx, wrappers).map((kind) => ({
          ...kind,
          methods: WRAPPER_METHODS.map((name) => method(kind.kind, name)),
        }))
      : [],
    undefinedGlobal: d.undefinedGlobal,
    sameValue: d.sameValue,
  };
}
/** The built-in function objects the realm holds, by their `NATIVE_VALUE_INTRINSICS` selector: each through its getter. */
function heldFunctionIntrinsics(tx: PhysicalModuleReservations, kernel: NativeSourceObjectDependencies["kernel"]) {
  return NATIVE_VALUE_INTRINSICS.flatMap((id, selector) =>
    kernel.entries.some((entry) => entry.id === id)
      ? [
          {
            selector,
            value: [
              { op: "call", funcIdx: nativeBuiltinFunctionSingletonBinding(tx, kernel, id).getter.handle },
            ] as readonly Instr[],
          },
        ]
      : [],
  );
}
/** (#7557) The built-in function objects the realm holds that are no constructors: each through its getter. */
function heldNonConstructors(kernel: NativeSourceObjectDependencies["kernel"]): readonly (readonly Instr[])[] {
  return kernel.entries.flatMap((entry, index) =>
    kernel.requests.requirements.intrinsics[index]!.constructible
      ? []
      : [[{ op: "call", funcIdx: entry.getter.handle } as Instr]],
  );
}
/** The realm's objects by id, each as its externref: Object.prototype, and the families' objects it holds. */
function realmObjects(tx: PhysicalModuleReservations, kernel: NativeSourceObjectDependencies["kernel"]) {
  const d = nativeBuiltinFunctionOperands(tx, kernel);
  return new Map<string, readonly Instr[]>([
    ["%Object.prototype%", [{ op: "call", funcIdx: kernel.functions.objectPrototype.handle }]],
    ...d.objects.map(({ id, global }): [string, readonly Instr[]] => [
      id,
      [
        { op: "call", funcIdx: d.initializer },
        { op: "global.get", index: global },
      ],
    ]),
  ]);
}
/**
 * (#7557) The objects the realm holds without every property the catalog gives them (`lacksCatalogProperty`), each as
 * its externref: Object.prototype always (its `toString`, `valueOf`).
 */
function partialObjects(
  tx: PhysicalModuleReservations,
  kernel: NativeSourceObjectDependencies["kernel"],
): readonly (readonly Instr[])[] {
  const { intrinsics, objects = [] } = kernel.requests.requirements;
  const catalogRow = (aliases: readonly string[]) =>
    NATIVE_REALM_CATALOG.intrinsics.find((row) => aliases.includes(row.id))!;
  const entries = kernel.entries.flatMap((entry, index) => {
    const row = intrinsics[index]!;
    return lacksCatalogProperty(catalogRow(row.aliases), row.properties ?? [])
      ? [[{ op: "call", funcIdx: entry.getter.handle } as Instr]]
      : [];
  });
  const byId = realmObjects(tx, kernel);
  const families = objects.flatMap(({ id, properties }) =>
    lacksCatalogProperty(catalogRow([id]), properties) ? [byId.get(id)!] : [],
  );
  return [byId.get("%Object.prototype%")!, ...entries, ...families];
}
/** Creation's operands: a program creates a wrapper only of a family the realm then holds (`create-wrapper`'s selector). */
function wrapperCreateOperands(dependencies: NativeSourceObjectDependencies, tx: PhysicalModuleReservations) {
  const wrappers = dependencies.wrappers!;
  const d = nativeBuiltinFunctionOperands(tx, dependencies.kernel);
  return {
    ...wrapperRepresentation(dependencies, tx),
    kinds: realmWrapperKinds(tx, wrappers),
    initializer: d.initializer,
    nativeStrTypeIdx: nativeBuiltinFunctionRequestDependencies(tx, dependencies.kernel.requests).strings.layout
      .nativeStrTypeIdx,
    flatten: wrappers.flatten.flatten.handle,
    indexKey: wrappers.indexKey.handle,
    defineDataBody: d.defineDataBody,
    lengthKey: d.lengthKey,
  };
}
type Signature = { readonly params: readonly ValType[]; readonly results: readonly ValType[] };
/** (#7354 O1) ToBoolean and ToPropertyDescriptor: one function each, reserved once for every adapter that reads descriptors. */
interface RecordHelpers {
  readonly toBoolean: FuncHandle;
  readonly toPropertyDescriptor: FuncHandle;
}
type Helpers = RecordHelpers | undefined;
type Body = (
  dependencies: NativeSourceObjectDependencies,
  tx: PhysicalModuleReservations,
  helpers: Helpers,
) => SourceObjectDefinition;
/** (#7354 O1) The operands of the `Object` statics' bodies: the kernel's roles and the realm's layouts. */
function objectStaticOperands(
  dependencies: NativeSourceObjectDependencies,
  tx: PhysicalModuleReservations,
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
    undefinedValue: [{ op: "global.get", index: d.undefinedGlobal }, { op: "extern.convert_any" }],
    key,
    typeError: (message) => builtinTypeError(d, key(message)),
  };
}
const RECORD_SIGNATURES = {
  toBoolean: { params: [EXTERNREF], results: [I32] },
  toPropertyDescriptor: { params: [EXTERNREF], results: [I32, EXTERNREF, EXTERNREF, EXTERNREF] },
} as const;
/** ToBoolean over the carriers: the dynamic value's own body (`js.value.to_boolean`) on the realm's types. */
function toBooleanDefinition(
  { values, kernel }: NativeSourceObjectDependencies,
  tx: PhysicalModuleReservations,
): SourceObjectDefinition {
  return {
    locals: buildToBooleanLocals(),
    body: buildToBooleanBody({
      anyValueTypeIdx: values.types.anyValue.typeIndex,
      internalizeOnce: true,
      boxNumberTypeIdx: values.types.boxedNumber.typeIndex,
      boxBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
      bigIntTypeIdx: undefined,
      anyStringTypeIdx: nativeBuiltinFunctionRequestDependencies(tx, kernel.requests).strings.layout.anyStrTypeIdx,
    }),
  };
}
/**
 * An adapter (the contract signature it reserves, its body over the realm's packs and the helpers it calls) or a
 * bound realm function.
 */
type Row =
  | {
      readonly signature: Signature;
      readonly body: Body;
      /** The body calls ToPropertyDescriptor (`RecordHelpers`). */
      readonly readsDescriptors?: true;
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
  "js.object.define-accessor": { binds: ({ descriptors }) => descriptors.defineAccessor },
  "js.object.create-type-error": { binds: ({ errors }) => errors.newTypeError },
  "js.object.get": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
  },
  "js.object.set": {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ kernel, arrays }, tx) =>
      buildSourceObjectSetDefinition(nativeBuiltinFunctionOperands(tx, kernel), arrays?.define.handle),
  },
  "js.object.has": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [I32] },
    body: ({ kernel }) => buildSourceObjectHasDefinition({ has: kernel.functions.has.handle }),
  },
  "js.object.has-brand": {
    signature: { params: [EXTERNREF, I32], results: [I32] },
    body: ({ layouts }) => buildHasBrandDefinition({ objectTypeIdx: layouts.object.typeIndex }),
  },
  // (#7354 G1) Only a realm that holds the Error family has its error creation, and only it serves the contract.
  "js.object.create-error": { binds: ({ kernel }) => kernel.errorCreate! },
  "js.object.error-to-string": {
    signature: { params: [EXTERNREF], results: [EXTERNREF] },
    literals: [": "],
    body: (dependencies, tx) => {
      const d = nativeBuiltinFunctionOperands(tx, dependencies.kernel);
      const strings = nativeBuiltinFunctionRequestDependencies(tx, dependencies.kernel.requests).strings.layout;
      return buildErrorToStringDefinition({
        get: dependencies.kernel.functions.get.handle,
        undefinedGlobal: d.undefinedGlobal,
        anyValueTypeIdx: dependencies.values.types.anyValue.typeIndex,
        anyStrTypeIdx: strings.anyStrTypeIdx,
        consStrTypeIdx: strings.consStrTypeIdx,
        text: literalKey(tx, dependencies),
      });
    },
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
    readsDescriptors: true,
    literals: DESCRIPTOR_RECORD_LITERALS,
    body: (dependencies, tx, helpers) =>
      buildDescriptorDefineDefinition(objectStaticOperands(dependencies, tx), helpers!.toPropertyDescriptor),
  },
  "js.object.descriptors-define": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [] },
    readsDescriptors: true,
    literals: DESCRIPTOR_RECORD_LITERALS,
    body: (dependencies, tx, helpers) =>
      buildDescriptorsDefineDefinition(objectStaticOperands(dependencies, tx), helpers!.toPropertyDescriptor),
  },
  "js.object.own-descriptor": {
    signature: { params: [EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    literals: DESCRIPTOR_RECORD_LITERALS,
    body: (dependencies, tx) =>
      buildOwnDescriptorDefinition(
        objectStaticOperands(dependencies, tx),
        sourceObjectCreate(createOperands(dependencies)),
        dependencies.descriptors.defineData.handle,
      ),
  },
  "js.object.intrinsic": {
    signature: { params: [I32], results: [EXTERNREF] },
    body: ({ kernel }, tx) => {
      const objects = realmObjects(tx, kernel);
      const functions = new Map(heldFunctionIntrinsics(tx, kernel).map((row) => [row.selector, row.value]));
      return buildSourceObjectIntrinsicDefinition({
        values: NATIVE_VALUE_INTRINSICS.flatMap((id, selector) => {
          const value = functions.get(selector) ?? objects.get(id);
          return value === undefined ? [] : [{ selector, value }];
        }),
      });
    },
  },
  "js.object.is-intrinsic": {
    signature: { params: [EXTERNREF, I32], results: [I32] },
    body: ({ kernel }, tx) =>
      buildSourceObjectIsIntrinsicDefinition({
        functions: heldFunctionIntrinsics(tx, kernel),
        sameValue: nativeBuiltinFunctionOperands(tx, kernel).sameValue,
      }),
  },
  "js.object.is-non-constructor": {
    signature: { params: [EXTERNREF], results: [I32] },
    body: ({ kernel }, tx) =>
      buildSourceObjectIsOneOfDefinition({
        values: heldNonConstructors(kernel),
        sameValue: nativeBuiltinFunctionOperands(tx, kernel).sameValue,
      }),
  },
  "js.object.is-partial": {
    signature: { params: [EXTERNREF], results: [I32] },
    body: ({ kernel }, tx) =>
      buildSourceObjectIsOneOfDefinition({
        values: partialObjects(tx, kernel),
        sameValue: nativeBuiltinFunctionOperands(tx, kernel).sameValue,
      }),
  },
  "js.object.create-wrapper": {
    signature: { params: [EXTERNREF, I32], results: [EXTERNREF] },
    body: (dependencies, tx) => {
      const d = nativeBuiltinFunctionOperands(tx, dependencies.kernel);
      return buildWrapperCreateDefinition(
        wrapperCreateOperands(dependencies, tx),
        new Map(
          d.objects.flatMap(({ id, global }) => {
            const selector = NATIVE_WRAPPER_CONSTRUCTORS.findIndex((name) => id === `%${name}.prototype%`);
            return selector < 0 ? [] : [[selector, [{ op: "global.get", index: global } as Instr]] as const];
          }),
        ),
      );
    },
  },
  "js.object.wrapper-data": {
    signature: { params: [EXTERNREF, EXTERNREF, I32], results: [EXTERNREF] },
    literals: WRAPPER_METHOD_MESSAGES,
    body: (dependencies, tx) => buildWrapperDataDefinition(wrapperDataOperands(dependencies, tx)),
  },
  // (#7354 A1) Only a realm that holds the Array family creates arrays, and only it serves the contract.
  "js.object.create-array": { binds: ({ arrays }) => arrays!.create },
  "js.object.has-own": {
    signature: { params: [EXTERNREF, EXTERNREF, I32], results: [I32] },
    body: ({ layouts, kernel }) =>
      buildSourceObjectHasOwnDefinition({
        entryTypeIdx: layouts.propEntry.typeIndex,
        findOwn: kernel.functions.findOwn.handle,
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

const adapterOf = (feature: NativeSourceObjectFeature): Extract<Row, { body: Body }> | undefined => {
  const row: Row = ROWS[feature];
  return "body" in row ? row : undefined;
};
/** (#7354 O1) The realm string literals the served contracts' bodies read. */
export function nativeSourceObjectLiterals(features: readonly OrdinaryObjectRuntimeFeature[]): readonly string[] {
  return [...new Set(features.filter(isServed).flatMap((feature) => adapterOf(feature)?.literals ?? []))];
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
  /** The record helpers, when a served adapter reads descriptors. */
  readonly helpers?: { readonly toBoolean: FunctionReservation; readonly toPropertyDescriptor: FunctionReservation };
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
  const reserveHelper = (name: keyof typeof RECORD_SIGNATURES) => {
    const key = realmKey + ":source-objects:helper:" + name;
    const { params, results } = RECORD_SIGNATURES[name];
    return tx.reserveFunction(key, key, { params: [...params], results: [...results] });
  };
  const helpers = served.some(({ feature }) => adapterOf(feature)?.readsDescriptors)
    ? { toBoolean: reserveHelper("toBoolean"), toPropertyDescriptor: reserveHelper("toPropertyDescriptor") }
    : undefined;
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
  return [
    ...pack.served.filter((row) => adapterOf(row.feature)).map((row) => row.token),
    ...(helpers ? [helpers.toBoolean, helpers.toPropertyDescriptor] : []),
  ];
}

export function fillNativeSourceObjectResources(
  tx: PhysicalModuleReservations,
  pack: NativeSourceObjectReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate canonical fill");
  const { helpers } = owner;
  const handles: Helpers = helpers && {
    toBoolean: helpers.toBoolean.handle,
    toPropertyDescriptor: helpers.toPropertyDescriptor.handle,
  };
  if (helpers) {
    tx.fillFunction(helpers.toBoolean, toBooleanDefinition(owner.dependencies, tx));
    tx.fillFunction(
      helpers.toPropertyDescriptor,
      buildToPropertyDescriptorDefinition(objectStaticOperands(owner.dependencies, tx), handles!.toBoolean),
    );
  }
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
  const { helpers } = owner;
  for (const token of [
    ...pack.served.map((row) => row.token),
    ...(helpers ? [helpers.toBoolean, helpers.toPropertyDescriptor] : []),
  ])
    tx.assertCompletedReservation(token);
  return pack;
}
