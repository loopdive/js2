// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { wellKnownSymbolId, type WellKnownSymbolName } from "../../../runtime/contracts/well-known-symbols.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
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

export interface NativeWellKnownSymbolDependencies {
  readonly symbols: NativeSymbolCarrierReservations;
  readonly strings: NativeStringLiteralReservations;
}
interface Producer {
  readonly name: WellKnownSymbolName;
  readonly function: FunctionReservation;
}
/** Canonical named Symbol production only; no source-binding or Number admission. */
export interface NativeWellKnownSymbolReservations {
  readonly producers: readonly Producer[];
  readonly completionScope: "canonical-well-known-symbol-producers";
}

function fail(detail: string): never {
  throw new Error("native well-known symbols: " + detail);
}
function copyNames(names: readonly WellKnownSymbolName[]): readonly WellKnownSymbolName[] {
  if (!Array.isArray(names) || names.length === 0) fail("empty or invalid name selection");
  const copied: WellKnownSymbolName[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < names.length; index++) {
    const field = Object.getOwnPropertyDescriptor(names, index);
    if (!field || !Object.hasOwn(field, "value")) fail("name selection requires own data entries");
    const name: unknown = field.value;
    if (typeof name !== "string" || wellKnownSymbolId(name) === undefined) fail("unknown canonical name");
    if (seen.has(name)) fail("duplicate canonical name");
    seen.add(name);
    copied.push(name as WellKnownSymbolName);
  }
  return Object.freeze(copied);
}
export function declareNativeWellKnownSymbolResources(
  key: string,
  names: readonly WellKnownSymbolName[],
): NativeResourceRecipe {
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  const selected = copyNames(names);
  return freezeNativeResourceRecipe({
    declarations: selected.map((name) => ({
      key: key + ":" + name,
      role: ["well-known-symbol", name],
      space: "function",
      name: "__symbol_well_known_" + name,
      signature: { params: [], results: [{ kind: "externref" }] },
    })),
    reservationSteps: selected.map((name) => ({
      phase: "resources",
      kind: "reserve",
      resourceKey: key + ":" + name,
    })),
  });
}

interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly sourceDependencies: NativeWellKnownSymbolDependencies;
  readonly dependencies: NativeWellKnownSymbolDependencies;
  readonly producers: readonly Producer[];
  filled: boolean;
}
const owners = new WeakMap<NativeWellKnownSymbolReservations, Owner>();
/** Inspect dependency descriptors without invoking borrowed accessors. */
function captureDependencies(input: NativeWellKnownSymbolDependencies): NativeWellKnownSymbolDependencies {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("plain dependency data record required");
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (key !== "symbols" && key !== "strings") fail("unexpected dependency role");
    const field = fields[key]!;
    if (!Object.hasOwn(field, "value") || !field.enumerable || field.value === undefined)
      fail("own enumerable dependency data required");
  }
  if (!Object.hasOwn(fields, "symbols") || !Object.hasOwn(fields, "strings")) fail("missing dependency role");
  return Object.freeze({ symbols: fields.symbols!.value!, strings: fields.strings!.value! });
}
function requireDependencies(tx: PhysicalModuleReservations, dependencies: NativeWellKnownSymbolDependencies): void {
  nativeStringLiteralReservationInventory(tx, dependencies.strings);
  requireNativeSymbolCarrierReservations(tx, dependencies.symbols, dependencies.strings);
}

/** Copy and validate all names, dependencies and keys before any dependent allocation. */
export function reserveNativeWellKnownSymbolResources(
  tx: PhysicalModuleReservations,
  key: string,
  names: readonly WellKnownSymbolName[],
  expectedPlan: NativeResourceRecipe,
  dependencies: NativeWellKnownSymbolDependencies,
): NativeWellKnownSymbolReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const selected = copyNames(names);
  const plan = declareNativeWellKnownSymbolResources(key, selected);
  if (preparedIrDataMismatch(plan, expectedPlan)) fail("substituted declaration plan");
  const captured = captureDependencies(dependencies);
  requireDependencies(tx, captured);
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const producers = Object.freeze(
    selected.map((name) =>
      Object.freeze({ name, function: requireNativeDeclaredReservation(records, key + ":" + name, "function") }),
    ),
  );
  const pack = Object.freeze({ producers, completionScope: "canonical-well-known-symbol-producers" as const });
  owners.set(pack, {
    tx,
    sourcePlan: expectedPlan,
    plan,
    sourceDependencies: dependencies,
    dependencies: captured,
    producers,
    filled: false,
  });
  return pack;
}

export function requireNativeWellKnownSymbolReservations(
  tx: PhysicalModuleReservations,
  pack: NativeWellKnownSymbolReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeWellKnownSymbolDependencies,
): NativeWellKnownSymbolReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (owner.sourcePlan !== expectedPlan || preparedIrDataMismatch(expectedPlan, owner.plan))
    fail("substituted or changed declaration plan");
  if (owner.sourceDependencies !== expectedDependencies) fail("substituted dependency identity");
  const currentDependencies = captureDependencies(expectedDependencies);
  if (
    currentDependencies.symbols !== owner.dependencies.symbols ||
    currentDependencies.strings !== owner.dependencies.strings
  )
    fail("substituted dependency identity");
  requireDependencies(tx, owner.dependencies);
  if (pack.producers !== owner.producers) fail("substituted producer census");
  if (tx.state !== "reserving") owner.producers.forEach((row) => tx.physicalIndex(row.function));
  return pack;
}

/** Exact owned reservation only; callers must separately require canonical completion. */
export function nativeWellKnownSymbolProducer(
  tx: PhysicalModuleReservations,
  pack: NativeWellKnownSymbolReservations,
  name: WellKnownSymbolName,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeWellKnownSymbolDependencies,
): FunctionReservation {
  requireNativeWellKnownSymbolReservations(tx, pack, expectedPlan, expectedDependencies);
  const selected = pack.producers.find((row) => row.name === name);
  if (!selected) fail("canonical name was not selected");
  return selected.function;
}

export function fillNativeWellKnownSymbolResources(
  tx: PhysicalModuleReservations,
  pack: NativeWellKnownSymbolReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  requireNativeWellKnownSymbolReservations(tx, pack, owner.sourcePlan, owner.sourceDependencies);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  requireCompletedNativeSymbolCarrier(tx, owner.dependencies.symbols, owner.dependencies.strings);
  for (const producer of owner.producers) {
    tx.fillFunction(producer.function, {
      locals: [],
      body: [
        { op: "i32.const", value: wellKnownSymbolId(producer.name)! },
        { op: "call", funcIdx: owner.dependencies.symbols.functions.box.handle },
      ],
    });
  }
  owner.filled = true;
}

export function requireCompletedNativeWellKnownSymbols(
  tx: PhysicalModuleReservations,
  pack: NativeWellKnownSymbolReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeWellKnownSymbolDependencies,
): NativeWellKnownSymbolReservations {
  requireNativeWellKnownSymbolReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeStringLiterals(tx, owner.dependencies.strings);
  requireCompletedNativeSymbolCarrier(tx, owner.dependencies.symbols, owner.dependencies.strings);
  owner.producers.forEach((row) => tx.assertCompletedReservation(row.function));
  return pack;
}

export function nativeWellKnownSymbolReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeWellKnownSymbolReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativeWellKnownSymbolDependencies,
) {
  requireNativeWellKnownSymbolReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, dependencies: owner.dependencies, producers: owner.producers });
}
