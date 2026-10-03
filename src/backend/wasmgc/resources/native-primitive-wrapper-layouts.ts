// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  PRIMITIVE_WRAPPER_KINDS,
  createPrimitiveWrapperDeclaration,
  type PrimitiveWrapperKind,
  type PrimitiveWrapperTypeKeys,
} from "../../../runtime/wasmgc/values/primitive-wrapper-layouts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  requireNativeObjectLayouts,
  type NativeObjectLayoutReservations,
  type NativeObjectLayoutDeclarationPlan,
} from "./native-object-layouts.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  requireNativeSymbolCarrierReservations,
  type NativeSymbolCarrierReservations,
} from "./native-symbol-carrier.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";
import { createRealmPrimitiveWrapperDeclaration } from "../../../runtime/wasmgc/values/realm-object-layouts.js";
import {
  requireNativeRealmObjectLayouts,
  type NativeRealmObjectLayoutReservations,
} from "./native-realm-object-layouts.js";

export interface NativePrimitiveWrapperLayoutDependencies {
  readonly objects: NativeObjectLayoutReservations;
  readonly objectPlan: NativeObjectLayoutDeclarationPlan;
  readonly strings: NativeStringLiteralReservations;
  readonly symbols: NativeSymbolCarrierReservations;
  readonly realmState?: NativeRealmObjectLayoutReservations;
}
export interface NativePrimitiveWrapperLayoutReservations {
  readonly types: Readonly<Record<PrimitiveWrapperKind, TypeReservation>>;
  readonly completionScope: "primitive-wrapper-types-only";
}
const dependencyKeys = ["objects", "objectPlan", "strings", "symbols"] as const;
function fail(detail: string): never {
  throw new Error("native primitive wrapper layouts: " + detail);
}

export function declareNativePrimitiveWrapperLayouts(
  key: string,
  types: PrimitiveWrapperTypeKeys,
  stateKey?: string,
): NativeResourceRecipe {
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  for (const role of ["object", "propMap", "anyString", "symbol"] as const)
    if (typeof types[role] !== "string" || !types[role]) fail("invalid prerequisite key");
  if (stateKey !== undefined && (typeof stateKey !== "string" || !stateKey)) fail("invalid realm state key");
  const declarations = PRIMITIVE_WRAPPER_KINDS.map((kind) => ({
    key: key + ":" + kind,
    role: ["primitive-wrapper", kind],
    space: "type" as const,
    shape:
      stateKey === undefined
        ? createPrimitiveWrapperDeclaration(kind, types)
        : createRealmPrimitiveWrapperDeclaration(kind, types, stateKey),
  }));
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}

function dependencies(tx: PhysicalModuleReservations, d: NativePrimitiveWrapperLayoutDependencies) {
  requireNativeObjectLayouts(tx, d.objects, d.objectPlan);
  const root = d.objectPlan.declarations.find((row) => row.key === d.objects.object.key);
  if (
    root?.space !== "type" ||
    root.shape.kind !== "struct" ||
    root.shape.parent?.kind !== "root" ||
    root.shape.final !== false
  )
    fail("ordinary object prerequisite is not an explicit extensible root");
  const strings = nativeStringLiteralReservationInventory(tx, d.strings);
  requireNativeSymbolCarrierReservations(tx, d.symbols, d.strings);
  const anyStringKey = nativeStringTypeKeys(strings.typePack.key).any;
  const anyString = strings.typePack.types.find((type) => type.key === anyStringKey);
  if (!anyString) fail("missing issued AnyStr type");
  const keys: PrimitiveWrapperTypeKeys = {
    object: d.objects.object.key,
    propMap: d.objects.propMap.key,
    anyString: anyString.key,
    symbol: d.symbols.types.symbol.key,
  };
  const tokens = [d.objects.object, d.objects.propMap, anyString, d.symbols.types.symbol];
  if (d.realmState) {
    requireNativeRealmObjectLayouts(tx, d.realmState, { objects: d.objects, objectPlan: d.objectPlan });
    tokens.push(d.realmState.types.state);
  }
  return { keys, stateKey: d.realmState?.types.state.key, tokens: new Map(tokens.map((token) => [token.key, token])) };
}
function stateRole(input: NativePrimitiveWrapperLayoutDependencies): NativeRealmObjectLayoutReservations | undefined {
  const field = Object.getOwnPropertyDescriptor(input, "realmState");
  if (!field) {
    if ("realmState" in input) fail("inherited realm state dependency");
    return undefined;
  }
  if (!Object.hasOwn(field, "value") || !field.enumerable || !field.value || typeof field.value !== "object")
    fail("realm state requires an issued own data value");
  return field.value;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly sourceDependencies: NativePrimitiveWrapperLayoutDependencies;
  readonly dependencies: NativePrimitiveWrapperLayoutDependencies;
  readonly tokens: readonly TypeReservation[];
}
const owners = new WeakMap<NativePrimitiveWrapperLayoutReservations, Owner>();

/** Issues types only: no constructor, prototype, String exotic or ToObject completion. */
export function reserveNativePrimitiveWrapperLayouts(
  tx: PhysicalModuleReservations,
  key: string,
  expectedPlan: NativeResourceRecipe,
  sourceDependencies: NativePrimitiveWrapperLayoutDependencies,
): NativePrimitiveWrapperLayoutReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const fields = Object.getOwnPropertyDescriptors(sourceDependencies);
  for (const role of dependencyKeys)
    if (!fields[role] || !Object.hasOwn(fields[role], "value")) fail("dependencies require own data fields");
  const realmState = stateRole(sourceDependencies);
  const captured = Object.freeze({
    ...Object.fromEntries(dependencyKeys.map((role) => [role, fields[role]!.value])),
    ...(realmState === undefined ? {} : { realmState }),
  }) as unknown as NativePrimitiveWrapperLayoutDependencies;
  const prerequisite = dependencies(tx, captured);
  const plan = declareNativePrimitiveWrapperLayouts(key, prerequisite.keys, prerequisite.stateKey);
  if (preparedIrDataMismatch(plan, expectedPlan)) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, prerequisite.tokens);
  const types = Object.freeze(
    Object.fromEntries(
      PRIMITIVE_WRAPPER_KINDS.map((kind) => [
        kind,
        requireNativeDeclaredReservation(records, key + ":" + kind, "type"),
      ]),
    ),
  ) as Readonly<Record<PrimitiveWrapperKind, TypeReservation>>;
  const pack = Object.freeze({ types, completionScope: "primitive-wrapper-types-only" as const });
  owners.set(pack, {
    tx,
    key,
    sourcePlan: expectedPlan,
    plan,
    sourceDependencies,
    dependencies: captured,
    tokens: Object.freeze(PRIMITIVE_WRAPPER_KINDS.map((kind) => types[kind])),
  });
  return pack;
}

export function requireNativePrimitiveWrapperLayouts(
  tx: PhysicalModuleReservations,
  pack: NativePrimitiveWrapperLayoutReservations,
  expectedPlan: NativeResourceRecipe,
  expectedDependencies: NativePrimitiveWrapperLayoutDependencies,
): NativePrimitiveWrapperLayoutReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied layout owner");
  if (owner.sourcePlan !== expectedPlan || preparedIrDataMismatch(expectedPlan, owner.plan))
    fail("substituted or changed declaration plan");
  if (owner.sourceDependencies !== expectedDependencies) fail("substituted dependency identity");
  const fields = Object.getOwnPropertyDescriptors(expectedDependencies);
  for (const role of dependencyKeys)
    if (!fields[role] || !Object.hasOwn(fields[role], "value") || fields[role]!.value !== owner.dependencies[role])
      fail("changed dependency identity");
  if (stateRole(expectedDependencies) !== owner.dependencies.realmState) fail("changed realm state identity");
  const prerequisite = dependencies(tx, owner.dependencies);
  if (
    preparedIrDataMismatch(
      declareNativePrimitiveWrapperLayouts(owner.key, prerequisite.keys, prerequisite.stateKey),
      owner.plan,
    )
  )
    fail("stale prerequisite plan");
  const types = new Map([...prerequisite.tokens, ...owner.tokens.map((token) => [token.key, token] as const)]);
  PRIMITIVE_WRAPPER_KINDS.forEach((kind, index) => {
    const token = owner.tokens[index]!;
    if (pack.types[kind] !== token) fail("substituted wrapper token");
    if (tx.state === "reserving") tx.assertTypeReservation(token);
    else tx.physicalIndex(token);
    compareNativeResourceDeclarationShape(
      tx,
      owner.plan.declarations[index]!,
      { key: token.key, space: "type", definition: token.object },
      types,
    );
  });
  return pack;
}
