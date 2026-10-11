// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { createVectorBaseType } from "../../../runtime/wasmgc/values/vector-grow-store.js";
import {
  buildArgumentVectorNewBody,
  buildArgumentVectorPushBody,
  buildArgumentVectorPushLocals,
} from "../../../runtime/wasmgc/values/argument-vector-bodies.js";
import { requireNativeVectorTypeReservations, type NativeVectorTypeReservations } from "./native-vectors.js";
import {
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
  nativeArgumentVectorReservationInventory,
  fillNativeArgumentVectorResources,
  type NativeArgumentVectorDeclarationPlan,
  type NativeArgumentVectorReservations,
} from "./native-argument-vectors.js";
import {
  reserveNativeErrorResources,
  requireNativeErrorReservations,
  fillNativeErrorResources,
  requireCompletedNativeErrors,
  type NativeErrorReservations,
  type NativeErrorRequirements,
  type NativeErrorDependencies,
} from "./native-errors.js";

export interface NativeInvocationSubstrateRequirements {
  readonly key: string;
}
export interface NativeInvocationSubstrateDependencies {
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly strings: NativeStringLiteralReservations;
}
export interface NativeInvocationSubstratePlan {
  readonly key: string;
  readonly ownedBaseKey?: string;
  readonly argumentPlan: NativeArgumentVectorDeclarationPlan;
  readonly errorRequirements: NativeErrorRequirements;
  readonly reservationKeys: readonly string[];
}
export interface NativeInvocationSubstrateReservations {
  readonly arguments: NativeArgumentVectorReservations;
  readonly argumentPlan: NativeArgumentVectorDeclarationPlan;
  readonly errors: NativeErrorReservations;
  readonly errorRequirements: NativeErrorRequirements;
  readonly errorDependencies: NativeErrorDependencies;
  readonly completionScope: "invocation-substrate";
}
const roles = ["vectors", "vectorPlan", "strings"] as const;
function fail(detail: string): never {
  throw Error("native invocation substrate: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}
/** Validate descriptors before reading caller data, including optional fields. */
function record(input: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("plain data record required");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) fail("plain data record required");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== "string" || !allowed.includes(key)) fail("unknown data field");
    if (!Object.hasOwn(fields[key]!, "value") || !fields[key]!.enumerable) fail("non-data or hidden field " + key);
  }
  for (const key of required) if (!Object.hasOwn(fields, key)) fail("missing data field " + key);
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
function dataTree(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "function" || typeof value === "symbol") fail("non-data declaration value");
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("cyclic declaration data");
  seen.add(value);
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && !(array && prototype === Array.prototype))
    fail("non-data declaration prototype");
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !Object.hasOwn(field, "value") ||
      (!field.enumerable && !(array && key === "length"))
    )
      fail("non-data declaration field");
    dataTree(field.value, seen);
  }
  seen.delete(value);
}
export function declareNativeInvocationSubstrateResources(
  requirements: NativeInvocationSubstrateRequirements,
  types: { readonly vectorBaseKey?: string } = {},
): NativeInvocationSubstratePlan {
  const { key } = record(requirements, ["key"]),
    external = record(types, ["vectorBaseKey"], []);
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  if (
    Object.hasOwn(external, "vectorBaseKey") &&
    (typeof external.vectorBaseKey !== "string" || !external.vectorBaseKey)
  )
    fail("invalid vector base key");
  const ownedBaseKey = Object.hasOwn(external, "vectorBaseKey") ? undefined : key + ":vector-base";
  const argumentPlan = declareNativeArgumentVectorResources(
    { key: key + ":arguments" },
    { vectorBaseKey: ownedBaseKey ?? (external.vectorBaseKey as string) },
  );
  const errorRequirements = Object.freeze({ key: key + ":errors" });
  return Object.freeze({
    key,
    ...(ownedBaseKey ? { ownedBaseKey } : {}),
    argumentPlan,
    errorRequirements,
    reservationKeys: Object.freeze([
      ...(ownedBaseKey ? [ownedBaseKey] : []),
      ...argumentPlan.declarations.map((row) => row.key),
      errorRequirements.key + ":type",
      errorRequirements.key + ":new-TypeError",
    ]),
  });
}
function dependencies(tx: PhysicalModuleReservations, input: NativeInvocationSubstrateDependencies) {
  const d = record(input, roles) as unknown as NativeInvocationSubstrateDependencies;
  requireNativeVectorTypeReservations(tx, d.vectors, d.vectorPlan);
  const name = requireNativeStringLiteral(tx, d.strings, "TypeError");
  return { d, name };
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeInvocationSubstrateRequirements;
  readonly sourceDependencies: NativeInvocationSubstrateDependencies;
  readonly dependencies: NativeInvocationSubstrateDependencies;
  readonly sourcePlan: NativeInvocationSubstratePlan;
  readonly plan: NativeInvocationSubstratePlan;
  readonly name: ReturnType<typeof requireNativeStringLiteral>;
  readonly types: readonly TypeReservation[];
  readonly functions: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeInvocationSubstrateReservations, Owner>();
export function reserveNativeInvocationSubstrateResources(
  tx: PhysicalModuleReservations,
  requirements: NativeInvocationSubstrateRequirements,
  input: NativeInvocationSubstrateDependencies,
  expectedPlan: NativeInvocationSubstratePlan,
): NativeInvocationSubstrateReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const { d, name } = dependencies(tx, input);
  const plan = declareNativeInvocationSubstrateResources(
    requirements,
    d.vectors.base ? { vectorBaseKey: d.vectors.base.key } : {},
  );
  dataTree(expectedPlan);
  same(expectedPlan, plan, "substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.reservationKeys);
  const base = plan.ownedBaseKey ? tx.reserveType(plan.ownedBaseKey, createVectorBaseType()) : undefined;
  const args = reserveNativeArgumentVectorResources(
    tx,
    { key: plan.key + ":arguments" },
    { vectorBase: d.vectors.base ?? base! },
    plan.argumentPlan,
  );
  const errorDependencies = Object.freeze({ strings: d.strings, typeErrorTag: -11 });
  const errors = reserveNativeErrorResources(tx, plan.errorRequirements, errorDependencies);
  const pack = Object.freeze({
    arguments: args,
    argumentPlan: plan.argumentPlan,
    errors,
    errorRequirements: plan.errorRequirements,
    errorDependencies,
    completionScope: "invocation-substrate" as const,
  });
  owners.set(pack, {
    tx,
    requirements,
    sourceDependencies: input,
    dependencies: Object.freeze(d),
    sourcePlan: expectedPlan,
    plan,
    name,
    types: Object.freeze([...(base ? [base] : []), args.array, args.carrier, errors.type]),
    functions: Object.freeze([args.newVector, args.push, errors.newTypeError]),
    filled: false,
  });
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeInvocationSubstrateReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied substrate owner");
  const { d, name } = dependencies(tx, owner.sourceDependencies);
  if (roles.some((role) => d[role] !== owner.dependencies[role]) || name !== owner.name)
    fail("substituted dependency identity");
  const plan = declareNativeInvocationSubstrateResources(
    owner.requirements,
    d.vectors.base ? { vectorBaseKey: d.vectors.base.key } : {},
  );
  dataTree(owner.sourcePlan);
  same(plan, owner.plan, "stale substrate requirements");
  same(owner.sourcePlan, owner.plan, "changed declaration plan");
  nativeArgumentVectorReservationInventory(tx, pack.arguments, pack.argumentPlan);
  requireNativeErrorReservations(tx, pack.errors, pack.errorRequirements, pack.errorDependencies);
  return owner;
}
/** Expected dependency wrappers are comparison data; exact producer identities carry authority. */
export function requireNativeInvocationSubstrateReservations(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationSubstrateReservations,
  expectedDependencies?: NativeInvocationSubstrateDependencies,
): NativeInvocationSubstrateReservations {
  const owner = current(tx, pack);
  if (expectedDependencies !== undefined) {
    const expected = record(expectedDependencies, roles) as unknown as NativeInvocationSubstrateDependencies;
    if (roles.some((role) => expected[role] !== owner.dependencies[role])) fail("foreign expected dependencies");
  }
  return pack;
}
function completedBodies(tx: PhysicalModuleReservations, pack: NativeInvocationSubstrateReservations): void {
  const v = pack.arguments;
  for (const token of [v.newVector, v.push]) tx.assertCompletedReservation(token);
  same(
    { locals: v.newVector.object.locals, body: v.newVector.object.body },
    { locals: [], body: buildArgumentVectorNewBody(v.layout) },
    "noncanonical argument-vector new definition",
  );
  same(
    { locals: v.push.object.locals, body: v.push.object.body },
    { locals: buildArgumentVectorPushLocals(v.layout), body: buildArgumentVectorPushBody(v.layout) },
    "noncanonical argument-vector push definition",
  );
  requireCompletedNativeErrors(tx, pack.errors, pack.errorRequirements, pack.errorDependencies);
}
export function fillNativeInvocationSubstrateResources(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationSubstrateReservations,
): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  requireCompletedNativeStringLiterals(tx, owner.dependencies.strings);
  fillNativeArgumentVectorResources(tx, pack.arguments);
  fillNativeErrorResources(tx, pack.errors);
  completedBodies(tx, pack);
  owner.filled = true;
}
export function requireCompletedNativeInvocationSubstrate(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationSubstrateReservations,
  expectedDependencies?: NativeInvocationSubstrateDependencies,
): NativeInvocationSubstrateReservations {
  requireNativeInvocationSubstrateReservations(tx, pack, expectedDependencies);
  if (!owners.get(pack)!.filled) fail("incomplete substrate; missing canonical fill");
  completedBodies(tx, pack);
  return pack;
}
export function nativeInvocationSubstrateReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeInvocationSubstrateReservations,
) {
  const owner = current(tx, pack);
  return Object.freeze({
    keys: owner.plan.reservationKeys,
    types: owner.types,
    functions: owner.functions,
    completionScope: pack.completionScope,
  });
}
