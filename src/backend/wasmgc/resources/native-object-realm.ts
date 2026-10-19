// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
  GlobalReservation,
  TagReservation,
  TagImportReservation,
} from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  assertNativeRealmRequirementsCurrent,
  type NativeRealmRequirements,
} from "../../../ir/program/native-realm-requirements.js";
import type { NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import { createBuiltinFunctionType } from "../../../runtime/wasmgc/values/builtin-function-layouts.js";
import {
  requireNativePublicBuiltinFunctionRequests,
  nativePublicBuiltinFunctionRequestDependencies,
  type NativePublicBuiltinFunctionRequests,
  type NativePublicBuiltinFunctionRequest,
} from "./native-builtin-function-requests.js";
import {
  nativeClosureReservationInventory,
  type NativeClosureReservations,
  type NativeClosureDeclarationPlan,
  type NativeClosureMetadataBinding,
} from "./native-closures.js";
import {
  requireNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
  type NativeRealmObjectLayoutReservations,
} from "./native-realm-object-layouts.js";
import {
  requireNativeInvocationSubstrateReservations,
  type NativeInvocationSubstrateReservations,
} from "./native-invocation-substrate.js";
import { nativeStringLiteralReservationInventory } from "./native-string-literals.js";
import {
  requireNativeSourceClosureTypes,
  nativeSourceClosureRealmState,
  type NativeSourceClosureTypes,
} from "./native-source-closures.js";
import type { NativeVectorTypeReservations } from "./native-vectors.js";
import {
  requireNativeObjectIsAlgorithm,
  requireCompletedNativeObjectIsAlgorithm,
  type NativeObjectIsReservations,
} from "./native-object-is.js";
import {
  builtinUndefined,
  buildBuiltinFunctionThrowTypeErrorDefinition,
  buildBuiltinFunctionCheckedEntryDefinition,
  type BuiltinFunctionDefinition,
} from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import {
  requireNativeValueReservationsFor,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import {
  requireNativeErrorReservations,
  requireCompletedNativeErrors,
  type NativeErrorReservations,
  type NativeErrorRequirements,
  type NativeErrorDependencies,
} from "./native-errors.js";
import { requireCompletedNativeInvocationSubstrate } from "./native-invocation-substrate.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";

const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
function fail(detail: string): never {
  throw Error("native object realm: " + detail);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) fail(detail);
}
function data(input: unknown, roles: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("plain data record required");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== "string" || (!roles.includes(key) && !optional.includes(key)))
      fail("unexpected dependency role");
    if (!Object.hasOwn(fields[key]!, "value") || !fields[key]!.enumerable || fields[key]!.value === undefined)
      fail("own enumerable dependency value required");
  }
  if (roles.some((role) => !Object.hasOwn(fields, role))) fail("missing dependency role");
  if (optional.some((role) => !Object.hasOwn(fields, role) && role in input))
    fail("inherited optional dependency role");
  return Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(fields).map(([role, field]) => [role, field.value])),
  );
}

export interface NativeObjectRealmExceptionSelection {
  readonly required: true;
  readonly shared: boolean;
}
export interface NativeObjectRealmException {
  readonly realm: NativeRealmRequirements;
  readonly selection: NativeObjectRealmExceptionSelection;
  readonly tag: TagReservation | TagImportReservation;
}
interface ExceptionOwner {
  readonly tx: PhysicalModuleReservations;
  readonly realm: NativeRealmRequirements;
  readonly original: NativeObjectRealmExceptionSelection;
}
const exceptions = new WeakMap<NativeObjectRealmException, ExceptionOwner>();
const exceptionBindings = new WeakMap<PhysicalModuleReservations, NativeObjectRealmException>();
function exceptionSelection(input: NativeObjectRealmExceptionSelection): NativeObjectRealmExceptionSelection {
  const selection = data(input, ["required", "shared"]);
  if (selection.required !== true || typeof selection.shared !== "boolean")
    fail("public exception selection must be required with an explicit linkage policy");
  return Object.freeze({ required: true, shared: selection.shared });
}
/** The public consumer replaces its early tag reservation with this producer, before foundation closes imports. */
export function reserveNativeObjectRealmException(
  tx: PhysicalModuleReservations,
  realm: NativeRealmRequirements,
  original: NativeObjectRealmExceptionSelection,
): NativeObjectRealmException {
  if (tx.state !== "reserving") fail("exception requires reservation phase");
  assertNativeRealmRequirementsCurrent(realm);
  const selection = exceptionSelection(original);
  if (exceptionBindings.has(tx)) fail("public exception already has an owner");
  tx.assertReservationKeysAvailable(["physical:exception-tag"]);
  const tag = tx.reserveTag(
    "physical:exception-tag",
    { params: [ext], results: [] },
    selection.shared ? { kind: "import", module: "env", name: "__exn" } : { kind: "defined", name: "__exn" },
  );
  const pack = Object.freeze({ realm, selection, tag });
  exceptions.set(pack, { tx, realm, original });
  exceptionBindings.set(tx, pack);
  return pack;
}
export function requireNativeObjectRealmException(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmException,
  expectedRealm: NativeRealmRequirements,
): NativeObjectRealmException {
  const owner = exceptions.get(pack);
  if (!owner || owner.tx !== tx || owner.realm !== expectedRealm || exceptionBindings.get(tx) !== pack)
    fail("foreign, copied or substituted public exception owner");
  assertNativeRealmRequirementsCurrent(owner.realm);
  same(exceptionSelection(owner.original), pack.selection, "changed checked exception linkage selection");
  if (tx.state === "reserving") tx.assertReservationKeysAvailable([]);
  else tx.physicalIndex(pack.tag);
  return pack;
}

export interface NativeObjectRealmDependencies {
  readonly requests: NativePublicBuiltinFunctionRequests;
  readonly closures: NativeClosureReservations;
  readonly closurePlan: NativeClosureDeclarationPlan;
  readonly layouts: NativeRealmObjectLayoutReservations;
  readonly substrate: NativeInvocationSubstrateReservations;
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly exception: NativeObjectRealmException;
  readonly source?: NativeSourceClosureTypes;
  readonly objectIs?: NativeObjectIsReservations;
  readonly baseAlgorithms?: NativeRealmBaseAlgorithms;
}
export interface NativeObjectRealmEntry {
  readonly request: NativePublicBuiltinFunctionRequest;
  readonly metadata: NativeClosureMetadataBinding;
  readonly type: TypeReservation;
  readonly singleton: GlobalReservation;
  readonly algorithm: FunctionReservation;
  readonly lifted: FunctionReservation;
  /** Explicit newTarget; never encoded in user arguments or public .length. */
  readonly construct?: FunctionReservation;
}
export interface NativeObjectRealmDeclarations {
  readonly realm: NativeRealmRequirements;
  readonly requests: NativePublicBuiltinFunctionRequests;
  readonly layouts: NativeRealmObjectLayoutReservations;
  readonly exception: NativeObjectRealmException;
  readonly objectPrototype: { readonly type: TypeReservation; readonly singleton: GlobalReservation };
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly initialize: FunctionReservation;
  readonly globals: {
    readonly realm: GlobalReservation;
    readonly functionPrototype: GlobalReservation;
    readonly state: GlobalReservation;
    readonly wholeRealmReady: GlobalReservation;
  };
  readonly completionScope: "public-realm-declarations-only";
}
const roles = [
  "requests",
  "closures",
  "closurePlan",
  "layouts",
  "substrate",
  "vectors",
  "vectorPlan",
  "exception",
] as const;
const optionalRoles = ["source", "objectIs", "baseAlgorithms"] as const;
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeObjectRealmDependencies;
  readonly dependencies: NativeObjectRealmDependencies;
  readonly keys: readonly string[];
  readonly globals: readonly GlobalReservation[];
  readonly functions: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeObjectRealmDeclarations, Owner>();
const populations = new WeakSet<NativeRealmObjectLayoutReservations>();

function dependencies(
  tx: PhysicalModuleReservations,
  realm: NativeRealmRequirements,
  input: NativeObjectRealmDependencies,
) {
  const d = data(input, roles, optionalRoles) as unknown as NativeObjectRealmDependencies;
  if (Object.hasOwn(d, "source") && !d.source) fail("present source must be an issued owner");
  if (Object.hasOwn(d, "objectIs") && !d.objectIs) fail("present Object.is must be an issued owner");
  if (Object.hasOwn(d, "baseAlgorithms") && !d.baseAlgorithms) fail("present base algorithms must be an issued owner");
  requireNativePublicBuiltinFunctionRequests(tx, d.requests, realm);
  if (d.objectIs) requireNativeObjectIsAlgorithm(tx, d.objectIs, d.requests);
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.requests);
  requireNativeRealmObjectLayouts(tx, d.layouts);
  requireNativeInvocationSubstrateReservations(tx, d.substrate, {
    vectors: d.vectors,
    vectorPlan: d.vectorPlan,
    strings: request.strings,
  });
  if (d.substrate.arguments !== request.arguments || d.substrate.argumentPlan !== request.argumentPlan)
    fail("different shared argument owner");
  requireNativeObjectRealmException(tx, d.exception, realm);
  if (d.baseAlgorithms) requireNativeRealmBaseAlgorithms(tx, d.baseAlgorithms, d.requests, d.exception, d.substrate);
  nativeClosureReservationInventory(tx, d.closures, d.closurePlan);
  const source = realm.source;
  const needsSource =
    !!source &&
    !!(source.units.length || source.shapes.length || source.signatures.length || source.allocations.length);
  if (needsSource) {
    if (!d.source) fail("missing genuine source owner");
    const strings = nativeStringLiteralReservationInventory(tx, request.strings).typePack;
    requireNativeSourceClosureTypes(tx, d.source, source, d.requests, {
      vectors: d.vectors,
      vectorPlan: d.vectorPlan,
      strings: { types: strings, key: strings.key, utf8Storage: strings.utf8Storage },
    });
    if (nativeSourceClosureRealmState(tx, d.source) !== d.layouts) fail("missing or substituted source realm state");
    if (d.source.closures !== d.closures || d.source.closurePlan !== d.closurePlan)
      fail("different source closure population");
  } else {
    if (d.source) fail("unexpected source owner");
    same(
      d.closurePlan.requirements.requests,
      d.requests.requests,
      "no-source closure population is not the public catalog",
    );
    same(
      d.closurePlan.requirements.referenceTypeKeys,
      d.requests.referenceTypes.map((row) => row.key),
      "different no-source reference prerequisites",
    );
  }
  same(
    d.closurePlan.requirements.requests.slice(-d.requests.requests.length),
    d.requests.requests,
    "public requests are not the shared closure suffix",
  );
  for (const row of d.requests.intrinsics) {
    const metadata = d.closures.metadata.find((entry) => entry.id === row.metadataId)?.binding;
    const signature = d.closures.signatures.find((entry) => entry.id === row.signatureId)?.binding;
    if (
      !metadata ||
      !signature ||
      metadata.signature !== signature ||
      signature.liftedSelfTypeIndex !== d.closures.root.typeIndex
    )
      fail("missing actual public metadata/signature binding");
    same(
      signature.info.paramTypes,
      [ext, { kind: "ref", typeIdx: request.arguments.carrier.typeIndex }],
      "different Call argument transport",
    );
    same(signature.info.returnType, ext, "different Call result");
    same(
      metadata.metadata,
      {
        key: d.requests.key + ":intrinsic:" + row.intrinsic.id,
        name: row.intrinsic.callable.initialName,
        length: row.intrinsic.callable.length,
        id: metadata.type.typeIndex,
      },
      "different public metadata identity",
    );
  }
  return d;
}
function resourceKeys(d: NativeObjectRealmDependencies): readonly string[] {
  const key = d.requests.key;
  return [
    key + ":object-prototype",
    key + ":state",
    key + ":whole-realm-ready",
    key + ":initialize",
    ...d.requests.intrinsics.flatMap((row) => [
      ...["type", "algorithm", "lifted"].map((role) => key + ":" + row.intrinsic.id + ":" + role),
      ...(row.intrinsic.id === "%Function.prototype%" ? [] : [key + ":" + row.intrinsic.id + ":singleton"]),
      ...(row.intrinsic.constructible ? [key + ":" + row.intrinsic.id + ":construct"] : []),
    ]),
  ];
}

/** Reserve one catalog population against the genuine shared roots. No algorithm body is fabricated. */
export function reserveNativeObjectRealmDeclarations(
  tx: PhysicalModuleReservations,
  realm: NativeRealmRequirements,
  input: NativeObjectRealmDependencies,
): NativeObjectRealmDeclarations {
  if (tx.state !== "reserving") fail("declarations require reservation phase");
  const d = dependencies(tx, realm, input);
  if (populations.has(d.layouts)) fail("realm anchors already have a public population owner");
  const keys = Object.freeze(resourceKeys(d));
  const borrowed = [d.objectIs?.algorithm, ...(d.baseAlgorithms ? Object.values(d.baseAlgorithms.algorithms) : [])];
  tx.assertReservationKeysAvailable(keys.filter((key) => !borrowed.some((token) => token?.key === key)));
  populations.add(d.layouts);
  const key = d.requests.key,
    request = nativePublicBuiltinFunctionRequestDependencies(tx, d.requests);
  const objectPrototype = Object.freeze({
    type: d.layouts.types.objectPrototype,
    singleton: tx.reserveGlobal(
      key + ":object-prototype",
      "__realm_object_prototype",
      { kind: "ref_null", typeIdx: d.layouts.types.objectPrototype.typeIndex },
      true,
    ),
  });
  const state = tx.reserveGlobal(key + ":state", "__realm_initialization_state", i32, true);
  const wholeRealmReady = tx.reserveGlobal(key + ":whole-realm-ready", "__whole_realm_ready", i32, false);
  const initialize = tx.reserveFunction(key + ":initialize", "__initialize_object_function_realm", {
    params: [],
    results: [],
  });
  const root = { kind: "ref" as const, typeIdx: d.closures.root.typeIndex },
    argv = { kind: "ref" as const, typeIdx: request.arguments.carrier.typeIndex };
  const entries = Object.freeze(
    d.requests.intrinsics.map((row) => {
      const metadata = d.closures.metadata.find((entry) => entry.id === row.metadataId)!.binding;
      const prefix = key + ":" + row.intrinsic.id;
      const type = tx.reserveType(
        prefix + ":type",
        createBuiltinFunctionType(
          prefix,
          metadata.type.typeIndex,
          d.layouts.types.identity.typeIndex,
          request.strings.layout.anyStrTypeIdx,
        ),
      );
      const singleton =
        row.intrinsic.id === "%Function.prototype%"
          ? d.layouts.anchors.functionPrototype
          : tx.reserveGlobal(prefix + ":singleton", prefix, { kind: "ref_null", typeIdx: type.typeIndex }, true);
      const base = d.baseAlgorithms?.algorithms;
      const algorithm =
        row.intrinsic.id === "%Object.is%" && d.objectIs
          ? d.objectIs.algorithm
          : base && (row.intrinsic.id === "%Function.prototype%" || row.intrinsic.id === "%ThrowTypeError%")
            ? base[row.intrinsic.id]
            : tx.reserveFunction(prefix + ":algorithm", prefix + ":algorithm", {
                params: [ext, argv],
                results: [ext],
              });
      const lifted = tx.reserveFunction(prefix + ":lifted", prefix + ":lifted", {
        params: [root, ext, argv],
        results: [ext],
      });
      if (lifted.object.typeIdx !== metadata.signature.liftedFuncTypeIndex)
        fail("different actual lifted Call signature");
      const construct = row.intrinsic.constructible
        ? tx.reserveFunction(prefix + ":construct", prefix + ":construct", {
            params: [root, argv, ext],
            results: [ext],
          })
        : undefined;
      return Object.freeze({
        request: row,
        metadata,
        type,
        singleton,
        algorithm,
        lifted,
        ...(construct ? { construct } : {}),
      });
    }),
  );
  const pack = Object.freeze({
    realm,
    requests: d.requests,
    layouts: d.layouts,
    exception: d.exception,
    objectPrototype,
    entries,
    initialize,
    globals: Object.freeze({ ...d.layouts.anchors, state, wholeRealmReady }),
    completionScope: "public-realm-declarations-only" as const,
  });
  owners.set(pack, {
    tx,
    original: input,
    dependencies: Object.freeze(d),
    keys,
    globals: Object.freeze([
      objectPrototype.singleton,
      state,
      wholeRealmReady,
      ...entries.filter((row) => row.singleton !== d.layouts.anchors.functionPrototype).map((row) => row.singleton),
    ]),
    functions: Object.freeze([
      initialize,
      ...entries.flatMap((row) => [row.algorithm, row.lifted, ...(row.construct ? [row.construct] : [])]),
    ]),
    filled: false,
  });
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeObjectRealmDeclarations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied public declarations");
  const d = dependencies(tx, pack.realm, owner.original);
  for (const role of [...roles, ...optionalRoles] as const)
    if (d[role] !== owner.dependencies[role]) fail("changed public dependency identity");
  if (tx.state === "reserving") pack.entries.forEach((row) => tx.assertTypeReservation(row.type));
  else
    tx.physicalIndices([
      pack.objectPrototype.type,
      pack.exception.tag,
      ...pack.entries.map((row) => row.type),
      ...owner.globals,
      ...owner.functions,
    ]);
  return owner;
}
export function requireNativeObjectRealmDeclarations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmDeclarations,
  expectedDependencies?: NativeObjectRealmDependencies,
): NativeObjectRealmDeclarations {
  const owner = current(tx, pack);
  if (expectedDependencies !== undefined) {
    const expected = data(expectedDependencies, roles, optionalRoles);
    if (
      [...roles, ...optionalRoles].some(
        (role) => expected[role] !== owner.dependencies[role as keyof NativeObjectRealmDependencies],
      )
    )
      fail("foreign expected public dependencies");
  }
  return pack;
}
/** Canonical module null/zero initializers only; runtime population and every algorithm slot remain pending. */
export function fillNativeObjectRealmDeclarations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmDeclarations,
): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate declaration fill");
  requireCompletedNativeRealmObjectLayouts(tx, pack.layouts);
  for (const token of owner.globals) {
    const type = token.object.type;
    tx.fillGlobal(
      token,
      type.kind === "i32"
        ? [{ op: "i32.const", value: 0 }]
        : type.kind === "ref_null"
          ? [{ op: "ref.null", typeIdx: type.typeIdx }]
          : [{ op: "ref.null.extern" }],
    );
  }
  owner.filled = true;
}
export function requireCompletedNativeObjectRealmDeclarations(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmDeclarations,
): NativeObjectRealmDeclarations {
  const owner = current(tx, pack);
  if (!owner.filled) fail("missing canonical declaration fill");
  requireCompletedNativeRealmObjectLayouts(tx, pack.layouts);
  for (const token of owner.globals) tx.assertCompletedReservation(token);
  return pack;
}
/** No count of reserved or caller-filled slots can certify algorithms/population that this owner has not implemented. */
export function requireCompletedNativeObjectRealm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmDeclarations,
): never {
  requireCompletedNativeObjectRealmDeclarations(tx, pack);
  return fail("full Object/Function algorithms and runtime population remain incomplete");
}
export function nativeObjectRealmDeclarationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmDeclarations,
) {
  const owner = current(tx, pack);
  return Object.freeze({
    keys: owner.keys,
    types: Object.freeze(pack.entries.map((row) => row.type)),
    globals: owner.globals,
    functions: owner.functions,
    completionScope: pack.completionScope,
  });
}

export interface NativeRealmBaseAlgorithmDependencies {
  readonly requests: NativePublicBuiltinFunctionRequests;
  readonly substrate: NativeInvocationSubstrateReservations;
  readonly exception: NativeObjectRealmException;
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
  readonly errors: NativeErrorReservations;
  readonly errorRequirements: NativeErrorRequirements;
  readonly errorDependencies: NativeErrorDependencies;
}
const baseRoles = [
  "requests",
  "substrate",
  "exception",
  "values",
  "valuePlan",
  "valueDependencies",
  "errors",
  "errorRequirements",
  "errorDependencies",
] as const;
const baseIds = ["%Function.prototype%", "%ThrowTypeError%"] as const;
export interface NativeRealmBaseAlgorithms {
  readonly requests: NativePublicBuiltinFunctionRequests;
  readonly exception: NativeObjectRealmException;
  readonly algorithms: Readonly<Record<(typeof baseIds)[number], FunctionReservation>>;
  readonly completionScope: "base-catalog-algorithms-only";
}
interface BaseOwner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeRealmBaseAlgorithmDependencies;
  readonly dependencies: NativeRealmBaseAlgorithmDependencies;
  readonly headers: readonly { readonly token: FunctionReservation; readonly name: string; readonly type: number }[];
  filled: boolean;
}
const baseOwners = new WeakMap<NativeRealmBaseAlgorithms, BaseOwner>();
function baseDependencies(tx: PhysicalModuleReservations, original: NativeRealmBaseAlgorithmDependencies) {
  const d = data(original, baseRoles) as unknown as NativeRealmBaseAlgorithmDependencies;
  const value = data(d.valueDependencies, ["strings"]);
  data(value.strings, ["kind", "stringPack", "scanner"]);
  data(d.errorDependencies, ["strings", "typeErrorTag"]);
  data(d.errorRequirements, ["key"]);
  requireNativePublicBuiltinFunctionRequests(tx, d.requests);
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.requests);
  requireNativeInvocationSubstrateReservations(tx, d.substrate);
  requireNativeObjectRealmException(tx, d.exception, d.requests.realm);
  requireNativeValueReservationsFor(tx, d.values, d.valuePlan, d.valueDependencies, d.requests.realm);
  requireNativeErrorReservations(tx, d.errors, d.errorRequirements, d.errorDependencies);
  if (
    request.arguments !== d.substrate.arguments ||
    request.argumentPlan !== d.substrate.argumentPlan ||
    d.valueDependencies.strings.kind !== "native-string" ||
    d.valueDependencies.strings.stringPack !== request.strings ||
    d.errorDependencies.strings !== request.strings
  )
    fail("different base algorithm argument/string owners");
  for (const [index, id] of baseIds.entries()) {
    const row = d.requests.intrinsics.find((row) => row.intrinsic.id === id)?.intrinsic;
    if (
      !row ||
      row.constructible ||
      row.callable.length !== 0 ||
      row.callable.implementation !== (index === 0 ? "function-prototype" : "throw-type-error")
    )
      fail("missing actual base catalog algorithm request");
  }
  return d;
}
function currentBase(tx: PhysicalModuleReservations, pack: NativeRealmBaseAlgorithms): BaseOwner {
  const owner = baseOwners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied base algorithm owner");
  const d = baseDependencies(tx, owner.original);
  if (baseRoles.some((role) => d[role] !== owner.dependencies[role]))
    fail("changed base algorithm dependency identity");
  if (
    pack.requests !== d.requests ||
    pack.exception !== d.exception ||
    pack.completionScope !== "base-catalog-algorithms-only"
  )
    fail("changed base algorithm scope/owner");
  for (const [index, id] of baseIds.entries()) {
    const h = owner.headers[index]!,
      token = pack.algorithms[id];
    if (
      token !== h.token ||
      token.key !== d.requests.key + ":" + id + ":algorithm" ||
      token.object.name !== h.name ||
      token.object.typeIdx !== h.type
    )
      fail("changed base algorithm header");
    if (tx.state !== "reserving") tx.physicalIndex(token);
  }
  return owner;
}
/** Actual shared catalog slots. Neither singleton publication nor whole-realm completion is implied. */
export function reserveNativeRealmBaseAlgorithms(
  tx: PhysicalModuleReservations,
  original: NativeRealmBaseAlgorithmDependencies,
): NativeRealmBaseAlgorithms {
  if (tx.state !== "reserving") fail("base algorithms require reservation phase");
  const d = Object.freeze(baseDependencies(tx, original));
  const keys = baseIds.map((id) => d.requests.key + ":" + id + ":algorithm");
  tx.assertReservationKeysAvailable(keys);
  const algorithms = Object.freeze(
    Object.fromEntries(
      baseIds.map((id, index) => [
        id,
        tx.reserveFunction(keys[index]!, keys[index]!, {
          params: [ext, { kind: "ref", typeIdx: d.substrate.arguments.carrier.typeIndex }],
          results: [ext],
        }),
      ]),
    ),
  ) as NativeRealmBaseAlgorithms["algorithms"];
  const pack = Object.freeze({
    requests: d.requests,
    exception: d.exception,
    algorithms,
    completionScope: "base-catalog-algorithms-only" as const,
  });
  baseOwners.set(pack, {
    tx,
    original,
    dependencies: d,
    filled: false,
    headers: baseIds.map((id) => ({
      token: algorithms[id],
      name: algorithms[id].object.name,
      type: algorithms[id].object.typeIdx,
    })),
  });
  return pack;
}
export function requireNativeRealmBaseAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeRealmBaseAlgorithms,
  requests: NativePublicBuiltinFunctionRequests,
  exception: NativeObjectRealmException,
  substrate: NativeInvocationSubstrateReservations,
): NativeRealmBaseAlgorithms {
  const owner = currentBase(tx, pack);
  if (pack.requests !== requests || pack.exception !== exception || owner.dependencies.substrate !== substrate)
    fail("different base algorithm catalog/exception/transport owner");
  return pack;
}
function completedBaseDependencies(tx: PhysicalModuleReservations, d: NativeRealmBaseAlgorithmDependencies) {
  requireCompletedNativeInvocationSubstrate(tx, d.substrate);
  requireCompletedNativeValues(tx, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeErrors(tx, d.errors, d.errorRequirements, d.errorDependencies);
}
function baseDefinitions(
  tx: PhysicalModuleReservations,
  d: NativeRealmBaseAlgorithmDependencies,
): Record<(typeof baseIds)[number], BuiltinFunctionDefinition> {
  const message = requireNativeStringLiteral(
    tx,
    d.errorDependencies.strings,
    "TypeError: restricted function property",
  );
  const literal =
    message.kind === "global"
      ? { op: "global.get" as const, index: tx.physicalIndex(message.global) }
      : { op: "call" as const, funcIdx: message.function.handle };
  const throwing = buildBuiltinFunctionThrowTypeErrorDefinition({
    message: [literal, { op: "extern.convert_any" }],
    typeError: d.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(d.exception.tag),
  });
  return {
    "%Function.prototype%": {
      locals: [],
      body: builtinUndefined({ undefinedGlobal: tx.physicalIndex(d.values.globals.undefined) }),
    },
    "%ThrowTypeError%": throwing,
  };
}
export function fillNativeRealmBaseAlgorithms(tx: PhysicalModuleReservations, pack: NativeRealmBaseAlgorithms): void {
  const owner = currentBase(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate base algorithm fill");
  completedBaseDependencies(tx, d);
  const definitions = baseDefinitions(tx, d);
  for (const id of baseIds) tx.fillFunction(pack.algorithms[id], definitions[id]);
  owner.filled = true;
}
export function requireCompletedNativeRealmBaseAlgorithms(
  tx: PhysicalModuleReservations,
  pack: NativeRealmBaseAlgorithms,
): NativeRealmBaseAlgorithms {
  const owner = currentBase(tx, pack);
  if (!owner.filled) fail("missing canonical base algorithm fill");
  completedBaseDependencies(tx, owner.dependencies);
  const definitions = baseDefinitions(tx, owner.dependencies);
  for (const id of baseIds) {
    const token = pack.algorithms[id];
    tx.assertCanonicalFunctionDefinition(token, definitions[id]);
  }
  return pack;
}

/** Actual reserved entries whose algorithms have canonical semantic owners; never the whole catalog. */
export interface NativeRealmLiftedCalls {
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  readonly completionScope: "owned-catalog-lifted-calls";
}
interface LiftedOwner {
  readonly tx: PhysicalModuleReservations;
  readonly realm: NativeObjectRealmDeclarations;
  readonly entries: readonly NativeObjectRealmEntry[];
  phase: "reserved" | "filling" | "complete" | "failed";
}
const liftedOwners = new WeakMap<NativeRealmLiftedCalls, LiftedOwner>();
const liftedRealms = new WeakSet<NativeObjectRealmDeclarations>();
function liftedEntries(tx: PhysicalModuleReservations, realm: NativeObjectRealmDeclarations) {
  const owner = current(tx, realm),
    d = owner.dependencies;
  if (!d.baseAlgorithms) fail("lifted calls require the genuine base algorithm/error owner");
  const algorithms = [...Object.values(d.baseAlgorithms.algorithms), ...(d.objectIs ? [d.objectIs.algorithm] : [])];
  const entries = realm.entries.filter((entry) => algorithms.includes(entry.algorithm));
  if (entries.length !== algorithms.length || entries.some((entry) => entry.construct))
    fail("different owned catalog Call slots");
  return entries;
}
/** Associate real realm slots only. No function handle, body callback or caller-selected subset is accepted. */
export function reserveNativeRealmLiftedCalls(
  tx: PhysicalModuleReservations,
  realm: NativeObjectRealmDeclarations,
): NativeRealmLiftedCalls {
  if (tx.state !== "reserving") fail("lifted calls require reservation phase");
  const entries = Object.freeze(liftedEntries(tx, realm));
  if (liftedRealms.has(realm)) fail("realm already has an owned lifted Call producer");
  const pack = Object.freeze({ realm, entries, completionScope: "owned-catalog-lifted-calls" as const });
  liftedOwners.set(pack, { tx, realm, entries, phase: "reserved" });
  liftedRealms.add(realm);
  return pack;
}
function currentLifted(tx: PhysicalModuleReservations, pack: NativeRealmLiftedCalls): LiftedOwner {
  const owner = liftedOwners.get(pack);
  if (
    !owner ||
    owner.tx !== tx ||
    pack.realm !== owner.realm ||
    pack.entries !== owner.entries ||
    pack.completionScope !== "owned-catalog-lifted-calls"
  )
    fail("foreign or copied lifted Call owner");
  const entries = liftedEntries(tx, owner.realm);
  if (entries.length !== owner.entries.length || entries.some((entry, index) => entry !== owner.entries[index]))
    fail("changed owned lifted Call entries");
  return owner;
}
export function requireNativeRealmLiftedCalls(
  tx: PhysicalModuleReservations,
  pack: NativeRealmLiftedCalls,
  realm: NativeObjectRealmDeclarations,
): NativeRealmLiftedCalls {
  if (currentLifted(tx, pack).realm !== realm) fail("different expected lifted Call realm");
  return pack;
}
function completedLiftedAlgorithms(tx: PhysicalModuleReservations, realm: NativeObjectRealmDeclarations) {
  const d = current(tx, realm).dependencies;
  requireCompletedNativeRealmBaseAlgorithms(tx, d.baseAlgorithms!);
  if (d.objectIs) requireCompletedNativeObjectIsAlgorithm(tx, d.objectIs);
}
function liftedDefinition(
  tx: PhysicalModuleReservations,
  realm: NativeObjectRealmDeclarations,
  entry: NativeObjectRealmEntry,
): BuiltinFunctionDefinition {
  const d = baseOwners.get(current(tx, realm).dependencies.baseAlgorithms!)!.dependencies;
  const singletonExtern = entry.singleton.object.type.kind === "externref";
  const identity = {
    typeIdx: entry.type.typeIndex,
    metadataId: entry.metadata.metadata.id,
    liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
    singleton: tx.physicalIndex(entry.singleton),
    singletonExtern,
    realm: tx.physicalIndex(realm.globals.realm),
  };
  const message = requireNativeStringLiteral(
    tx,
    d.errorDependencies.strings,
    "TypeError: incompatible native builtin function",
  );
  return buildBuiltinFunctionCheckedEntryDefinition({
    identity,
    failure: [
      message.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(message.global) }
        : { op: "call", funcIdx: message.function.handle },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: d.errors.newTypeError.handle },
      { op: "throw", tagIdx: tx.physicalIndex(d.exception.tag) },
    ],
    algorithm: entry.algorithm.handle,
  });
}
export function fillNativeRealmLiftedCalls(tx: PhysicalModuleReservations, pack: NativeRealmLiftedCalls): void {
  const owner = currentLifted(tx, pack);
  if (tx.state !== "filling" || owner.phase !== "reserved") fail("invalid phase or duplicate/failed lifted Call fill");
  completedLiftedAlgorithms(tx, owner.realm);
  const definitions = owner.entries.map((entry) => liftedDefinition(tx, owner.realm, entry));
  owner.phase = "filling";
  try {
    owner.entries.forEach((entry, index) => tx.fillFunction(entry.lifted, definitions[index]!));
    owner.phase = "complete";
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
export function requireCompletedNativeRealmLiftedCalls(
  tx: PhysicalModuleReservations,
  pack: NativeRealmLiftedCalls,
): NativeRealmLiftedCalls {
  const owner = currentLifted(tx, pack);
  if (owner.phase !== "complete") fail("missing canonical lifted Call fill");
  completedLiftedAlgorithms(tx, owner.realm);
  for (const entry of owner.entries) {
    tx.assertCanonicalFunctionDefinition(entry.lifted, liftedDefinition(tx, owner.realm, entry));
  }
  return pack;
}
