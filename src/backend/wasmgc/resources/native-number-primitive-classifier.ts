// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { buildClosureUndefinedTest } from "../../../runtime/wasmgc/values/closure-receiver-bodies.js";
import {
  requireNativeValueReservations,
  requireCompletedNativeValues,
  type NativeValueReservations,
  type NativeValueDependencies,
} from "./native-values.js";
import {
  requireNativeBooleanReservations,
  requireCompletedNativeBooleans,
  type NativeBooleanReservations,
} from "./native-booleans.js";
import {
  requireNativeBigIntReservations,
  requireCompletedNativeBigInt,
  type NativeBigIntReservations,
} from "./native-bigint.js";
import {
  nativeStringLiteralReservationInventory,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  requireNativeSymbolCarrierReservations,
  requireCompletedNativeSymbolCarrier,
  type NativeSymbolCarrierReservations,
} from "./native-symbol-carrier.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeNumberPrimitiveClassifierDependencies {
  readonly values: NativeValueReservations;
  readonly valuePlan: NativeValueResourcePlan;
  readonly valueDependencies: NativeValueDependencies;
  readonly booleans: NativeBooleanReservations;
  readonly bigints: NativeBigIntReservations;
  readonly bigintPlan: NativeResourceRecipe;
  readonly strings: NativeStringLiteralReservations;
  readonly symbols: NativeSymbolCarrierReservations;
}

/** Only canonical primitive classification; no IsCallable or Number admission. */
export interface NativeNumberPrimitiveClassifierReservations {
  readonly isPrimitive: FunctionReservation;
  readonly isSymbol: FunctionReservation;
  readonly isNullish: FunctionReservation;
  readonly completionScope: "native-number-primitive-classification";
}
const roles = ["is-primitive", "is-symbol", "is-nullish"] as const;
export function declareNativeNumberPrimitiveClassifierResources(key: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  return freezeNativeResourceRecipe({
    declarations: roles.map((role) => ({
      key: key + ":" + role,
      role: ["number-primitive-classifier", role],
      space: "function",
      name: "__number_" + role.replaceAll("-", "_"),
      signature: { params: [{ kind: "externref" }], results: [{ kind: "i32" }] },
    })),
    reservationSteps: roles.map((role) => ({
      phase: "resources",
      kind: "reserve",
      resourceKey: key + ":" + role,
    })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly sourceDependencies: NativeNumberPrimitiveClassifierDependencies;
  readonly dependencies: NativeNumberPrimitiveClassifierDependencies;
  readonly functions: readonly FunctionReservation[];
  readonly functionObjects: readonly FunctionReservation["object"][];
  filledDefinitions?: readonly LiveDefinition[];
  readonly valueStrings: NativeValueDependencies["strings"];
  readonly valueStringFields: Readonly<Record<string, unknown>>;
  definitions?: readonly { locals: LocalDef[]; body: Instr[] }[];
  filled: boolean;
}
const owners = new WeakMap<NativeNumberPrimitiveClassifierReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native number primitive classifier: " + detail);
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

const dependencyKeys = [
  "values",
  "valuePlan",
  "valueDependencies",
  "booleans",
  "bigints",
  "bigintPlan",
  "strings",
  "symbols",
] as const;
function captureDependencies(
  input: NativeNumberPrimitiveClassifierDependencies,
): NativeNumberPrimitiveClassifierDependencies {
  const d = ownData(input, dependencyKeys);
  auditPlan(d.valuePlan);
  auditPlan(d.bigintPlan);
  const valueDependencies = ownData(d.valueDependencies, ["strings"]);
  const strings = ownData(valueDependencies.strings, ["kind", "stringPack", "scanner"]);
  if (strings.kind !== "native-string" || strings.stringPack !== d.strings)
    fail("value/string producer identities differ");
  for (const key of ["values", "booleans", "bigints", "strings", "symbols"] as const) ownData(d[key]);
  ownData(strings.scanner);
  return Object.freeze(d) as unknown as NativeNumberPrimitiveClassifierDependencies;
}

function requireDependencies(tx: PhysicalModuleReservations, d: NativeNumberPrimitiveClassifierDependencies): void {
  requireNativeValueReservations(tx, d.values, d.valuePlan, d.valueDependencies);
  requireNativeBooleanReservations(tx, d.booleans, d.values, d.valuePlan, d.valueDependencies);
  requireNativeBigIntReservations(tx, d.bigints, d.bigintPlan);
  nativeStringLiteralReservationInventory(tx, d.strings);
  requireNativeSymbolCarrierReservations(tx, d.symbols, d.strings);
  if (d.valueDependencies.strings.kind !== "native-string" || d.valueDependencies.strings.stringPack !== d.strings)
    fail("value/string producer identities differ");
}
function requireCompletedDependencies(
  tx: PhysicalModuleReservations,
  d: NativeNumberPrimitiveClassifierDependencies,
): void {
  requireCompletedNativeValues(tx, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeBooleans(tx, d.booleans, d.values, d.valuePlan, d.valueDependencies);
  requireCompletedNativeBigInt(tx, d.bigints, d.bigintPlan);
  requireCompletedNativeStringLiterals(tx, d.strings);
  requireCompletedNativeSymbolCarrier(tx, d.symbols, d.strings);
}

/** Authenticate every existing carrier and the whole declaration before allocating. */
export function reserveNativeNumberPrimitiveClassifierResources(
  tx: PhysicalModuleReservations,
  key: string,
  expectedPlan: NativeResourceRecipe,
  dependencies: NativeNumberPrimitiveClassifierDependencies,
): NativeNumberPrimitiveClassifierReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const plan = declareNativeNumberPrimitiveClassifierResources(key);
  auditPlan(expectedPlan);
  if (preparedIrDataMismatch(plan, expectedPlan)) fail("substituted declaration plan");
  const captured = captureDependencies(dependencies);
  requireDependencies(tx, captured);
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const pack = Object.freeze({
    isPrimitive: requireNativeDeclaredReservation(records, key + ":is-primitive", "function"),
    isSymbol: requireNativeDeclaredReservation(records, key + ":is-symbol", "function"),
    isNullish: requireNativeDeclaredReservation(records, key + ":is-nullish", "function"),
    completionScope: "native-number-primitive-classification" as const,
  });
  const functions = Object.freeze([pack.isPrimitive, pack.isSymbol, pack.isNullish]);
  const functionObjects = captureIssuedFunctions(functions);
  owners.set(pack, {
    tx,
    sourcePlan: expectedPlan,
    plan,
    sourceDependencies: dependencies,
    dependencies: captured,
    functions,
    functionObjects,
    valueStrings: captured.valueDependencies.strings,
    valueStringFields: Object.freeze(ownData(captured.valueDependencies.strings)),
    filled: false,
  });
  return pack;
}

export function requireNativeNumberPrimitiveClassifierReservations(
  tx: PhysicalModuleReservations,
  pack: NativeNumberPrimitiveClassifierReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeNumberPrimitiveClassifierDependencies,
): NativeNumberPrimitiveClassifierReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  captureLiveDefinitions(owner);
  auditPlan(expectedPlan);
  const current = captureDependencies(expectedDependencies);
  if (owner.sourcePlan !== expectedPlan || preparedIrDataMismatch(expectedPlan, owner.plan))
    fail("substituted or changed declaration plan");
  if (
    owner.sourceDependencies !== expectedDependencies ||
    dependencyKeys.some((key) => current[key] !== owner.dependencies[key]) ||
    current.valueDependencies.strings !== owner.valueStrings ||
    Object.entries(owner.valueStringFields).some(
      ([key, value]) => ownData(current.valueDependencies.strings)[key] !== value,
    )
  )
    fail("substituted dependency identity");
  requireDependencies(tx, owner.dependencies);
  if ([pack.isPrimitive, pack.isSymbol, pack.isNullish].some((token, index) => token !== owner.functions[index]))
    fail("substituted function token");
  if (tx.state !== "reserving") owner.functions.forEach((token) => tx.physicalIndex(token));
  return pack;
}

function carrierTest(typeIdx: number): Instr[] {
  return [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx }];
}
export function fillNativeNumberPrimitiveClassifierResources(
  tx: PhysicalModuleReservations,
  pack: NativeNumberPrimitiveClassifierReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  captureLiveDefinitions(owner);
  requireNativeNumberPrimitiveClassifierReservations(tx, pack, owner.sourcePlan, owner.sourceDependencies);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  const d = owner.dependencies;
  requireCompletedDependencies(tx, d);
  const definitions = deriveDefinitions(d, pack);
  const expectedDefinitions = Object.freeze(structuredClone(definitions));
  owner.functions.forEach((token, index) => tx.fillFunction(token, definitions[index]!));
  owner.filledDefinitions = Object.freeze(captureLiveDefinitions(owner));
  owner.definitions = expectedDefinitions;
  owner.filled = true;
}

function deriveDefinitions(
  d: NativeNumberPrimitiveClassifierDependencies,
  pack: NativeNumberPrimitiveClassifierReservations,
): { locals: LocalDef[]; body: Instr[] }[] {
  const isNullish: { locals: LocalDef[]; body: Instr[] } = {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      ...buildClosureUndefinedTest(0, d.values.types.anyValue.typeIndex),
      { op: "i32.or" },
    ],
  };
  const isSymbol = { locals: [], body: carrierTest(d.symbols.types.symbol.typeIndex) };
  const isPrimitive: { locals: LocalDef[]; body: Instr[] } = {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: pack.isNullish.handle },
      ...[d.values.functions.isNumber, d.booleans.isBoolean, d.bigints.isBigInt, pack.isSymbol].flatMap(
        (predicate): Instr[] => [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: predicate.handle },
          { op: "i32.or" },
        ],
      ),
      ...carrierTest(d.strings.layout.anyStrTypeIdx),
      { op: "i32.or" },
    ],
  };
  return [isPrimitive, isSymbol, isNullish];
}

export function requireCompletedNativeNumberPrimitiveClassifier(
  tx: PhysicalModuleReservations,
  pack: NativeNumberPrimitiveClassifierReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeNumberPrimitiveClassifierDependencies,
): NativeNumberPrimitiveClassifierReservations {
  requireNativeNumberPrimitiveClassifierReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedDependencies(tx, owner.dependencies);
  const canonical = deriveDefinitions(owner.dependencies, pack);
  const live = captureLiveDefinitions(owner);
  if (!owner.definitions || !owner.filledDefinitions || preparedIrDataMismatch(owner.definitions, canonical))
    fail("changed canonical definitions");
  const expected = owner.definitions,
    filled = owner.filledDefinitions;
  if (
    live.some(
      (definition, index) =>
        changedLiveFill(definition, filled[index]!) ||
        preparedIrDataMismatch(definition.definition, expected[index]) ||
        preparedIrDataMismatch(definition.definition, canonical[index]),
    )
  )
    fail("changed canonical predicate definition");
  owner.functions.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}

export function nativeNumberPrimitiveClassifierReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeNumberPrimitiveClassifierReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeNumberPrimitiveClassifierDependencies,
) {
  requireNativeNumberPrimitiveClassifierReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, functions: owner.functions });
}
