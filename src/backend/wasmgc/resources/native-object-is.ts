// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import {
  buildBuiltinFunctionArgument,
  type BuiltinFunctionDefinition,
} from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import {
  requireNativePublicBuiltinFunctionRequests,
  nativePublicBuiltinFunctionRequestDependencies,
  type NativePublicBuiltinFunctionRequests,
} from "./native-builtin-function-requests.js";
import {
  requireNativeObjectSameValueReservations,
  requireCompletedNativeObjectSameValue,
  type NativeObjectSameValueReservations,
  type NativeObjectSameValueDependencies,
} from "./native-object-same-value.js";
import {
  requireNativeBooleanBoxReservations,
  requireCompletedNativeBooleanBoxes,
  type NativeBooleanBoxReservations,
} from "./native-booleans.js";
import {
  requireNativeInvocationSubstrateReservations,
  requireCompletedNativeInvocationSubstrate,
  type NativeInvocationSubstrateReservations,
} from "./native-invocation-substrate.js";
import { requireNativeValueReservationsFor } from "./native-values.js";

export interface NativeObjectIsDependencies {
  readonly requests: NativePublicBuiltinFunctionRequests;
  readonly substrate: NativeInvocationSubstrateReservations;
  readonly sameValue: NativeObjectSameValueReservations;
  readonly sameValueDependencies: NativeObjectSameValueDependencies;
  readonly booleanBoxes: NativeBooleanBoxReservations;
}
export interface NativeObjectIsReservations {
  readonly requests: NativePublicBuiltinFunctionRequests;
  readonly algorithm: FunctionReservation;
  /** Native value ABI only; not foreign-value entry, whole-realm or source-admission authority. */
  readonly completionScope: "native-object-is-algorithm";
}
const roles = ["requests", "substrate", "sameValue", "sameValueDependencies", "booleanBoxes"] as const;
function fail(detail: string): never {
  throw Error("native Object.is: " + detail);
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("plain own-data dependencies required");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length) fail("unexpected dependency roles");
  for (const key of keys)
    if (
      !Object.hasOwn(fields, key) ||
      !Object.hasOwn(fields[key]!, "value") ||
      !fields[key]!.enumerable ||
      fields[key]!.value === undefined
    )
      fail("own enumerable dependency data required");
  return Object.fromEntries(keys.map((key) => [key, fields[key]!.value]));
}
function capture(input: NativeObjectIsDependencies): NativeObjectIsDependencies {
  const d = record(input, roles) as unknown as NativeObjectIsDependencies;
  const v = record(d.sameValueDependencies, [
    "values",
    "valuePlan",
    "valueDependencies",
    "booleans",
    "bigints",
    "bigintPlan",
    "strings",
    "flatten",
    "equality",
  ]);
  const values = record(v.valueDependencies, ["strings"]);
  record(values.strings, ["kind", "stringPack", "scanner"]);
  return d;
}
function dependencies(tx: PhysicalModuleReservations, d: NativeObjectIsDependencies) {
  requireNativePublicBuiltinFunctionRequests(tx, d.requests);
  const request = nativePublicBuiltinFunctionRequestDependencies(tx, d.requests),
    v = d.sameValueDependencies;
  requireNativeInvocationSubstrateReservations(tx, d.substrate);
  if (
    request.arguments !== d.substrate.arguments ||
    request.argumentPlan !== d.substrate.argumentPlan ||
    request.strings !== v.strings ||
    v.valueDependencies.strings.kind !== "native-string" ||
    v.valueDependencies.strings.stringPack !== request.strings
  )
    fail("different shared argument/string owner");
  requireNativeObjectSameValueReservations(tx, d.sameValue, v);
  requireNativeValueReservationsFor(tx, v.values, v.valuePlan, v.valueDependencies, d.requests.realm);
  requireNativeBooleanBoxReservations(tx, d.booleanBoxes, v.values, v.valuePlan, v.valueDependencies);
  const intrinsic = d.requests.intrinsics.find((row) => row.intrinsic.id === "%Object.is%");
  if (!intrinsic || intrinsic.intrinsic.constructible || intrinsic.intrinsic.callable.length !== 2)
    fail("missing actual Object.is catalog request");
  return request;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeObjectIsDependencies;
  readonly dependencies: NativeObjectIsDependencies;
  readonly name: string;
  readonly typeIdx: number;
  filled: boolean;
}
const owners = new WeakMap<NativeObjectIsReservations, Owner>();
function current(tx: PhysicalModuleReservations, pack: NativeObjectIsReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied algorithm owner");
  const d = capture(owner.original);
  if (roles.some((role) => d[role] !== owner.dependencies[role])) fail("changed dependency identity");
  dependencies(tx, d);
  if (
    pack.requests !== d.requests ||
    pack.completionScope !== "native-object-is-algorithm" ||
    pack.algorithm.key !== d.requests.key + ":%Object.is%:algorithm" ||
    pack.algorithm.object.name !== owner.name ||
    pack.algorithm.object.typeIdx !== owner.typeIdx
  )
    fail("changed algorithm header/identity");
  if (tx.state !== "reserving") tx.physicalIndex(pack.algorithm);
  return owner;
}
/** The actual catalog slot, not a raw-handle implementation binder or a public admission grant. */
export function reserveNativeObjectIsAlgorithm(
  tx: PhysicalModuleReservations,
  original: NativeObjectIsDependencies,
): NativeObjectIsReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const d = Object.freeze(capture(original)),
    request = dependencies(tx, d);
  const key = d.requests.key + ":%Object.is%:algorithm";
  tx.assertReservationKeysAvailable([key]);
  const algorithm = tx.reserveFunction(key, key, {
    params: [{ kind: "externref" }, { kind: "ref", typeIdx: request.arguments.carrier.typeIndex }],
    results: [{ kind: "externref" }],
  });
  const pack = Object.freeze({
    requests: d.requests,
    algorithm,
    completionScope: "native-object-is-algorithm" as const,
  });
  owners.set(pack, {
    tx,
    original,
    dependencies: d,
    name: algorithm.object.name,
    typeIdx: algorithm.object.typeIdx,
    filled: false,
  });
  return pack;
}
export function requireNativeObjectIsAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectIsReservations,
  requests: NativePublicBuiltinFunctionRequests,
): NativeObjectIsReservations {
  current(tx, pack);
  if (pack.requests !== requests) fail("different catalog request owner");
  return pack;
}
function completedDependencies(tx: PhysicalModuleReservations, d: NativeObjectIsDependencies) {
  const v = d.sameValueDependencies;
  requireCompletedNativeInvocationSubstrate(tx, d.substrate);
  requireCompletedNativeObjectSameValue(tx, d.sameValue, v);
  requireCompletedNativeBooleanBoxes(tx, d.booleanBoxes, v.values, v.valuePlan, v.valueDependencies);
}
function definition(tx: PhysicalModuleReservations, d: NativeObjectIsDependencies): BuiltinFunctionDefinition {
  const v = d.sameValueDependencies;
  const argumentsLayout = d.substrate.arguments;
  const bindings = {
    vectorTypeIdx: tx.physicalIndex(argumentsLayout.carrier),
    vectorArrayTypeIdx: tx.physicalIndex(argumentsLayout.array),
    undefinedGlobal: tx.physicalIndex(v.values.globals.undefined),
  };
  return {
    locals: [],
    body: [
      ...buildBuiltinFunctionArgument(bindings, 1, 0),
      ...buildBuiltinFunctionArgument(bindings, 1, 1),
      { op: "call", funcIdx: d.sameValue.sameValue.handle },
      { op: "call", funcIdx: d.booleanBoxes.boxBoolean.handle },
    ],
  };
}
export function fillNativeObjectIsAlgorithm(tx: PhysicalModuleReservations, pack: NativeObjectIsReservations): void {
  const owner = current(tx, pack),
    d = owner.dependencies;
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  completedDependencies(tx, d);
  tx.fillFunction(pack.algorithm, definition(tx, d));
  owner.filled = true;
}
export function requireCompletedNativeObjectIsAlgorithm(
  tx: PhysicalModuleReservations,
  pack: NativeObjectIsReservations,
): NativeObjectIsReservations {
  const owner = current(tx, pack);
  if (!owner.filled) fail("missing canonical algorithm fill");
  completedDependencies(tx, owner.dependencies);
  tx.assertCanonicalFunctionDefinition(pack.algorithm, definition(tx, owner.dependencies));
  return pack;
}
