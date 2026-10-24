// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import { requireCanonicalNativeFunction } from "./native-resource-declarations.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import {
  requireNativeObjectRealmDeclarations,
  requireCompletedNativeObjectRealm,
  type NativeObjectRealmDeclarations,
  type NativeObjectRealmDependencies,
} from "./native-object-realm.js";
import {
  requireNativeValueReservations,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import {
  requireNativeBooleanReservations,
  requireCompletedNativeBooleans,
  type NativeBooleanReservations,
} from "./native-booleans.js";
import { nativePublicBuiltinFunctionRequestDependencies } from "./native-builtin-function-requests.js";
import { requireCompletedNativeInvocationSubstrate } from "./native-invocation-substrate.js";
import { requireNativeStringLiteral, requireCompletedNativeStringLiterals } from "./native-string-literals.js";
import {
  buildBuiltinFunctionMatchDefinition,
  buildBuiltinFunctionCallDefinition,
  buildBuiltinFunctionLiftedDefinition,
  type BuiltinFunctionDispatchOperands,
} from "../../../runtime/wasmgc/values/builtin-function-bodies.js";

export interface NativeObjectRealmCallDependencies {
  readonly realm: NativeObjectRealmDeclarations;
  readonly realmDependencies: NativeObjectRealmDependencies;
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
  readonly booleans: NativeBooleanReservations;
}
export interface NativeObjectRealmCalls {
  readonly match: FunctionReservation;
  readonly call: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly input: NativeObjectRealmCallDependencies;
  readonly dependencies: NativeObjectRealmCallDependencies;
  filled: boolean;
}
const owners = new WeakMap<NativeObjectRealmCalls, Owner>();
const populations = new WeakSet<NativeObjectRealmDeclarations>();
const roles = ["realm", "realmDependencies", "values", "valuePlan", "valueDependencies", "booleans"] as const;
function fail(message: string): never {
  throw Error("native object realm calls: " + message);
}
function capture(input: NativeObjectRealmCallDependencies): NativeObjectRealmCallDependencies {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("plain dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(fields).length !== roles.length ||
    roles.some((role) => !fields[role]?.enumerable || !Object.hasOwn(fields[role]!, "value"))
  )
    fail("exact own data dependencies required");
  return Object.freeze(
    Object.fromEntries(roles.map((role) => [role, fields[role]!.value])),
  ) as unknown as NativeObjectRealmCallDependencies;
}
function authenticate(tx: PhysicalModuleReservations, d: NativeObjectRealmCallDependencies) {
  requireNativeObjectRealmDeclarations(tx, d.realm, d.realmDependencies);
  requireNativeValueReservations(tx, d.values, d.valuePlan, d.valueDependencies, d.realm.realm);
  requireNativeBooleanReservations(tx, d.booleans, d.values, d.valuePlan, d.valueDependencies);
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.realm.requests);
  if (
    d.valueDependencies.strings.kind !== "native-string" ||
    d.valueDependencies.strings.stringPack !== request.strings
  )
    fail("different shared String/value producers");
  requireNativeStringLiteral(tx, request.strings, "Value is not callable");
  return request;
}
function current(tx: PhysicalModuleReservations, pack: NativeObjectRealmCalls) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  const d = capture(owner.input);
  if (roles.some((role) => d[role] !== owner.dependencies[role])) fail("changed dependency identity");
  authenticate(tx, d);
  return owner;
}
export function reserveNativeObjectRealmCalls(
  tx: PhysicalModuleReservations,
  key: string,
  input: NativeObjectRealmCallDependencies,
): NativeObjectRealmCalls {
  if (tx.state !== "reserving" || !key) fail("invalid reservation phase/key");
  const d = capture(input),
    request = authenticate(tx, d);
  if (populations.has(d.realm)) fail("realm already has a Call owner");
  tx.assertReservationKeysAvailable([key + ":match", key + ":call"]);
  const ext = { kind: "externref" } as const;
  const pack = Object.freeze({
    match: tx.reserveFunction(key + ":match", "__public_realm_match", { params: [ext], results: [{ kind: "i32" }] }),
    call: tx.reserveFunction(key + ":call", "__public_realm_call", {
      params: [ext, ext, { kind: "ref", typeIdx: request.arguments.carrier.typeIndex }],
      results: [ext],
    }),
  });
  owners.set(pack, { tx, input, dependencies: d, filled: false });
  populations.add(d.realm);
  return pack;
}
function operands(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmCalls,
  d: NativeObjectRealmCallDependencies,
): BuiltinFunctionDispatchOperands {
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.realm.requests);
  const message = requireNativeStringLiteral(tx, request.strings, "Value is not callable");
  return {
    rootTypeIdx: d.realmDependencies.closures.root.typeIndex,
    realm: tx.physicalIndex(d.realm.globals.realm),
    initializer: d.realm.initialize.handle,
    match: pack.match.handle,
    typeError: d.realmDependencies.substrate.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(d.realm.exception.tag),
    errors: [
      message.kind === "global"
        ? [{ op: "global.get", index: tx.physicalIndex(message.global) }, { op: "extern.convert_any" }]
        : [{ op: "call", funcIdx: message.function.handle }, { op: "extern.convert_any" }],
    ],
    entries: d.realm.entries.map((entry) => ({
      typeIdx: entry.type.typeIndex,
      metadataId: entry.metadata.metadata.id,
      liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
      singleton: tx.physicalIndex(entry.singleton),
      singletonExtern: entry.singleton.object.type.kind === "externref",
      algorithm: entry.algorithm.handle,
    })),
  };
}
function definitions(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmCalls,
  d: NativeObjectRealmCallDependencies,
) {
  const input = operands(tx, pack, d);
  return [
    { token: pack.match, definition: buildBuiltinFunctionMatchDefinition(input) },
    { token: pack.call, definition: buildBuiltinFunctionCallDefinition(input) },
    ...d.realm.entries.map((entry, index) => ({
      token: entry.lifted,
      definition: buildBuiltinFunctionLiftedDefinition(input, input.entries[index]!, index),
    })),
  ];
}
/** Canonical dispatch and lifted adapters only; the cyclic algorithm/population owner fills its own slots. */
export function fillNativeObjectRealmCalls(tx: PhysicalModuleReservations, pack: NativeObjectRealmCalls): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate fill");
  const rows = definitions(tx, pack, owner.dependencies);
  for (const entry of owner.dependencies.realm.entries) tx.declareFunctionReference(entry.lifted);
  for (const row of rows) tx.fillFunction(row.token, row.definition);
  owner.filled = true;
}
/** Reservation joins break the dependency cycle; completion still requires real full-realm algorithms. */
export function nativeObjectRealmInvocationBinding(
  tx: PhysicalModuleReservations,
  pack: NativeObjectRealmCalls,
  completed = false,
) {
  const owner = current(tx, pack),
    d = owner.dependencies;
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.realm.requests);
  if (completed) {
    if (!owner.filled) fail("missing canonical dispatcher fill");
    for (const row of definitions(tx, pack, d)) requireCanonicalNativeFunction(tx, row.token, row.definition);
    requireCompletedNativeBooleans(tx, d.booleans, d.values, d.valuePlan, d.valueDependencies);
    requireCompletedNativeStringLiterals(tx, request.strings);
    requireCompletedNativeInvocationSubstrate(tx, d.realmDependencies.substrate);
    requireCompletedNativeObjectRealm(tx, d.realm);
  }
  return Object.freeze({
    realm: d.realm,
    source: d.realmDependencies.source,
    closures: d.realmDependencies.closures,
    closurePlan: d.realmDependencies.closurePlan,
    arguments: request.arguments,
    strings: request.strings,
    values: d.values,
    errors: d.realmDependencies.substrate.errors,
    booleans: d.booleans,
    exception: d.realm.exception.tag,
    match: pack.match,
    call: pack.call,
    carriers: Object.freeze(d.realm.entries.map((entry) => entry.type)),
  });
}
