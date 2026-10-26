// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { buildBigIntToNumberDefinition } from "../../../runtime/wasmgc/values/bigint-to-number-body.js";
import {
  requireNativeBigIntReservations,
  requireCompletedNativeBigInt,
  type NativeBigIntReservations,
} from "./native-bigint.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeBigIntNumberDependencies {
  readonly bigint: NativeBigIntReservations;
  readonly bigintPlan: NativeResourceRecipe;
}

/** Conversion of canonical BigInt carriers only; no general Number/ToNumber admission. */
export interface NativeBigIntNumberReservations {
  readonly number: FunctionReservation;
  readonly completionScope: "canonical-bigint-number";
}

export function declareNativeBigIntNumberResources(key: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  return freezeNativeResourceRecipe({
    declarations: [
      {
        key: key + ":number",
        role: ["bigint", "number"],
        space: "function",
        name: "__bigint_to_number",
        signature: { params: [{ kind: "externref" }], results: [{ kind: "f64" }] },
      },
    ],
    reservationSteps: [{ phase: "resources", kind: "reserve", resourceKey: key + ":number" }],
  });
}

interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly sourceDependencies: NativeBigIntNumberDependencies;
  readonly dependencies: NativeBigIntNumberDependencies;
  readonly functions: readonly FunctionReservation[];
  readonly functionObjects: readonly FunctionReservation["object"][];
  filledDefinitions?: readonly LiveDefinition[];
  definitions?: readonly ReturnType<typeof buildBigIntToNumberDefinition>[];
  filled: boolean;
}
const owners = new WeakMap<NativeBigIntNumberReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native BigInt number: " + detail);
}

interface LiveDefinition {
  readonly object: FunctionReservation["object"];
  readonly localsIdentity: unknown[];
  readonly bodyIdentity: unknown[];
  readonly attributes: readonly { path: string[]; enumerable: boolean; configurable: boolean; writable: boolean }[];
  readonly definition: { locals: FunctionReservation["object"]["locals"]; body: FunctionReservation["object"]["body"] };
}

/** Capture only these owned instruction graphs, before any producer or ledger reads them. */
function captureLiveDefinitions(
  owner: Pick<Owner, "functions" | "functionObjects" | "filledDefinitions">,
): LiveDefinition[] {
  const live = owner.functions.map((token, index) => {
    const objectField = Object.getOwnPropertyDescriptor(token, "object");
    if (!objectField || !Object.hasOwn(objectField, "value") || objectField.value !== owner.functionObjects[index])
      fail("changed live function identity");
    const object = owner.functionObjects[index]!;
    const fields = Object.getOwnPropertyDescriptors(object);
    const keys = ["name", "typeIdx", "locals", "body", "exported"];
    if (Object.getPrototypeOf(object) !== Object.prototype || Reflect.ownKeys(fields).length !== keys.length)
      fail("invalid live function shape");
    const attributes: LiveDefinition["attributes"][number][] = [];
    const attribute = (path: string[], field: PropertyDescriptor) => {
      attributes.push({
        path,
        enumerable: !!field.enumerable,
        configurable: !!field.configurable,
        writable: !!field.writable,
      });
    };
    for (const key of keys) {
      const field = fields[key];
      if (!field || !Object.hasOwn(field, "value") || !field.enumerable) fail("non-data live function field " + key);
      attribute([key], field);
    }
    const localsIdentity: unknown = fields.locals!.value;
    const bodyIdentity: unknown = fields.body!.value;
    if (!Array.isArray(localsIdentity) || !Array.isArray(bodyIdentity)) fail("invalid live definition arrays");
    const active = new Set<object>();
    const capture = (input: unknown, path: string[]): unknown => {
      if (input === null || input === undefined || ["string", "number", "boolean", "bigint"].includes(typeof input))
        return input;
      if (typeof input !== "object" || active.has(input)) fail("invalid live definition data");
      const proto = Object.getPrototypeOf(input);
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const ownKeys = Reflect.ownKeys(descriptors);
      active.add(input);
      let output: unknown;
      if (Array.isArray(input)) {
        const length = descriptors.length;
        if (
          proto !== Array.prototype ||
          !length ||
          !Object.hasOwn(length, "value") ||
          length.enumerable ||
          length.configurable ||
          !Number.isInteger(length.value) ||
          length.value < 0 ||
          length.value > 0xffffffff ||
          ownKeys.length !== length.value + 1
        )
          fail("invalid live definition array");
        attribute([...path, "length"], length);
        // Authenticate the whole node before visiting any child.
        for (let i = 0; i < length.value; i++) {
          const field = descriptors[String(i)];
          if (!field || !Object.hasOwn(field, "value") || !field.enumerable) fail("non-data live array element");
        }
        const array: unknown[] = [];
        for (let i = 0; i < length.value; i++) {
          const field = descriptors[String(i)]!;
          attribute([...path, String(i)], field);
          array.push(capture(field.value, [...path, String(i)]));
        }
        output = array;
      } else {
        if (proto !== Object.prototype && proto !== null) fail("non-plain live definition record");
        for (const key of ownKeys) {
          if (typeof key !== "string") fail("symbol live definition field");
          const field = descriptors[key]!;
          if (!Object.hasOwn(field, "value") || !field.enumerable || key === "toJSON")
            fail("non-data live definition field");
        }
        const record: Record<string, unknown> = Object.create(proto);
        for (const key of ownKeys) {
          if (typeof key !== "string") fail("symbol live definition field");
          const field = descriptors[key]!;
          attribute([...path, key], field);
          Object.defineProperty(record, key, { value: capture(field.value, [...path, key]), enumerable: true });
        }
        output = record;
      }
      active.delete(input);
      return output;
    };
    return {
      object,
      localsIdentity,
      bodyIdentity,
      attributes,
      definition: {
        locals: capture(localsIdentity, ["locals"]) as LiveDefinition["definition"]["locals"],
        body: capture(bodyIdentity, ["body"]) as LiveDefinition["definition"]["body"],
      },
    };
  });
  const filled = owner.filledDefinitions;
  if (filled && live.some((definition, index) => changedLiveFill(definition, filled[index]!)))
    fail("altered completed function: changed successful-fill identity or descriptors");
  return live;
}

function captureIssuedFunctions(functions: readonly FunctionReservation[]): readonly FunctionReservation["object"][] {
  const functionObjects = Object.freeze(
    functions.map((token) => {
      const field = Object.getOwnPropertyDescriptor(token, "object");
      if (!field || !Object.hasOwn(field, "value")) fail("invalid issued function");
      return field.value as FunctionReservation["object"];
    }),
  );
  captureLiveDefinitions({ functions, functionObjects });
  return functionObjects;
}

function changedLiveFill(live: LiveDefinition, filled: LiveDefinition): boolean {
  return (
    live.object !== filled.object ||
    live.localsIdentity !== filled.localsIdentity ||
    live.bodyIdentity !== filled.bodyIdentity ||
    !!preparedIrDataMismatch(live.attributes, filled.attributes)
  );
}

/** Configuration records are inspected before any producer can consume them. */
function ownData(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid own-data configuration");
  const proto = Object.getPrototypeOf(input);
  const fields = Object.getOwnPropertyDescriptors(input);
  if (proto !== Object.prototype && proto !== null) fail("non-plain configuration");
  if (keys && (Reflect.ownKeys(fields).length !== keys.length || keys.some((key) => !Object.hasOwn(fields, key))))
    fail("wrong configuration fields");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== "string") fail("symbol configuration field");
    const field = fields[key]!;
    if (!Object.hasOwn(field, "value") || !field.enumerable || field.value === undefined || field.value === null)
      fail("non-data or absent configuration field " + key);
    Object.defineProperty(result, key, { value: field.value, enumerable: true });
  }
  return result;
}
function auditPlan(input: unknown, active = new Set<object>()): void {
  if (input === null || ["string", "number", "boolean", "bigint"].includes(typeof input)) return;
  if (!input || typeof input !== "object" || active.has(input)) fail("invalid plan data");
  active.add(input);
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype) fail("non-plain plan array");
    const fields = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(fields).length !== input.length + 1) fail("sparse or extra plan array fields");
    for (let i = 0; i < input.length; i++) {
      const field = fields[String(i)];
      if (!field || !Object.hasOwn(field, "value") || !field.enumerable) fail("non-data plan array");
      auditPlan(field.value, active);
    }
  } else {
    for (const value of Object.values(ownData(input))) auditPlan(value, active);
  }
  active.delete(input);
}

function captureDependencies(input: NativeBigIntNumberDependencies): NativeBigIntNumberDependencies {
  const d = ownData(input, ["bigint", "bigintPlan"]);
  ownData(d.bigint);
  auditPlan(d.bigintPlan);
  return Object.freeze(d) as unknown as NativeBigIntNumberDependencies;
}
function deriveDefinition(d: NativeBigIntNumberDependencies) {
  return buildBigIntToNumberDefinition({
    narrow: d.bigint.type.typeIndex,
    limbs: d.bigint.limbs.typeIndex,
    wide: d.bigint.wide.typeIndex,
  });
}

/** Authenticate the existing carrier issuer and full plan before allocating any slot. */
export function reserveNativeBigIntNumberResources(
  tx: PhysicalModuleReservations,
  key: string,
  expectedPlan: NativeResourceRecipe,
  dependencies: NativeBigIntNumberDependencies,
): NativeBigIntNumberReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const plan = declareNativeBigIntNumberResources(key);
  auditPlan(expectedPlan);
  if (preparedIrDataMismatch(plan, expectedPlan)) fail("substituted declaration plan");
  const captured = captureDependencies(dependencies);
  requireNativeBigIntReservations(tx, captured.bigint, captured.bigintPlan);
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const pack = Object.freeze({
    number: requireNativeDeclaredReservation(records, key + ":number", "function"),
    completionScope: "canonical-bigint-number" as const,
  });
  const functions = Object.freeze([pack.number]);
  const functionObjects = captureIssuedFunctions(functions);
  owners.set(pack, {
    tx,
    sourcePlan: expectedPlan,
    plan,
    sourceDependencies: dependencies,
    dependencies: captured,
    functions,
    functionObjects,
    filled: false,
  });
  return pack;
}

export function requireNativeBigIntNumberReservations(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntNumberReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeBigIntNumberDependencies,
): NativeBigIntNumberReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  captureLiveDefinitions(owner);
  auditPlan(expectedPlan);
  const current = captureDependencies(expectedDependencies);
  if (owner.sourcePlan !== expectedPlan || preparedIrDataMismatch(expectedPlan, owner.plan))
    fail("substituted or changed declaration plan");
  if (
    owner.sourceDependencies !== expectedDependencies ||
    current.bigint !== owner.dependencies.bigint ||
    current.bigintPlan !== owner.dependencies.bigintPlan
  )
    fail("substituted dependency identity");
  requireNativeBigIntReservations(tx, owner.dependencies.bigint, owner.dependencies.bigintPlan);
  if (pack.number !== owner.functions[0]) fail("substituted function token");
  if (tx.state !== "reserving") tx.physicalIndex(pack.number);
  return pack;
}

export function fillNativeBigIntNumberResources(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntNumberReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  captureLiveDefinitions(owner);
  requireNativeBigIntNumberReservations(tx, pack, owner.sourcePlan, owner.sourceDependencies);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  const { bigint, bigintPlan } = owner.dependencies;
  requireCompletedNativeBigInt(tx, bigint, bigintPlan);
  const definition = deriveDefinition(owner.dependencies);
  const definitions = Object.freeze([structuredClone(definition)]);
  tx.fillFunction(owner.functions[0]!, definition);
  owner.filledDefinitions = Object.freeze(captureLiveDefinitions(owner));
  owner.definitions = definitions;
  owner.filled = true;
}

export function requireCompletedNativeBigIntNumber(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntNumberReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeBigIntNumberDependencies,
): NativeBigIntNumberReservations {
  requireNativeBigIntNumberReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeBigInt(tx, owner.dependencies.bigint, owner.dependencies.bigintPlan);
  const canonical = deriveDefinition(owner.dependencies);
  const live = captureLiveDefinitions(owner)[0]!;
  if (
    !owner.definitions ||
    !owner.filledDefinitions ||
    changedLiveFill(live, owner.filledDefinitions[0]!) ||
    preparedIrDataMismatch(owner.definitions[0], canonical) ||
    preparedIrDataMismatch(live.definition, owner.definitions[0]) ||
    preparedIrDataMismatch(live.definition, canonical)
  )
    fail("changed canonical conversion definition");
  tx.assertCompletedReservation(pack.number);
  return pack;
}

export function nativeBigIntNumberReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntNumberReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeBigIntNumberDependencies,
) {
  requireNativeBigIntNumberReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, bigint: owner.dependencies.bigint, functions: owner.functions });
}
