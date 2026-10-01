// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type {
  NativeDeclaredValType,
  NativeResourceRecipe,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  PRIMITIVE_WRAPPER_KINDS,
  type PrimitiveWrapperKind,
} from "../../../runtime/wasmgc/values/primitive-wrapper-layouts.js";
import {
  buildPrimitiveWrapperAllocationDefinition,
  buildPrimitiveWrapperDataDefinition,
  type PrimitiveWrapperBodyBindings,
} from "../../../runtime/wasmgc/values/primitive-wrapper-bodies.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  requireNativePrimitiveWrapperLayouts,
  type NativePrimitiveWrapperLayoutReservations,
  type NativePrimitiveWrapperLayoutDependencies,
} from "./native-primitive-wrapper-layouts.js";
import { nativeStringLiteralReservationInventory, nativeStringTypeKeys } from "./native-string-literals.js";
import { requireCompletedNativeRealmObjectLayouts } from "./native-realm-object-layouts.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativePrimitiveWrapperStorageDependencies {
  readonly layouts: NativePrimitiveWrapperLayoutReservations;
  readonly layoutPlan: NativeResourceRecipe;
  readonly layoutDependencies: NativePrimitiveWrapperLayoutDependencies;
}
export interface NativePrimitiveWrapperStoragePlan extends NativeResourceRecipe {
  readonly initialCapacity: number;
}
/** Storage only. Prototype selection, primitive payload authority and String exotic behavior remain separate. */
export interface NativePrimitiveWrapperStorageReservations {
  readonly allocation: Readonly<Record<PrimitiveWrapperKind, FunctionReservation>>;
  readonly read: Readonly<Record<PrimitiveWrapperKind, FunctionReservation>>;
  readonly completionScope: "primitive-wrapper-storage";
}
const roles = ["allocation", "read"] as const;
const dependencyKeys = ["layouts", "layoutPlan", "layoutDependencies"] as const;
function fail(detail: string): never {
  throw new Error("native primitive wrapper storage: " + detail);
}
function ownValue(input: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(input, key);
  if (!field || !Object.hasOwn(field, "value")) fail("missing or non-data field " + key);
  return field.value;
}
function capacity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 0x40000000 ||
    (value & (value - 1)) !== 0
  )
    fail("invalid initial capacity");
  return value;
}

export function declareNativePrimitiveWrapperStorageResources(
  key: string,
  types: { readonly anyString: string; readonly symbol: string },
  initialCapacity: number,
): NativePrimitiveWrapperStoragePlan {
  if (typeof key !== "string" || !key) fail("invalid declaration key");
  const anyString = ownValue(types, "anyString"),
    symbol = ownValue(types, "symbol");
  if (typeof anyString !== "string" || !anyString || typeof symbol !== "string" || !symbol || anyString === symbol)
    fail("invalid payload type keys");
  capacity(initialCapacity);
  const ext = { kind: "externref" } as const;
  const payloads: Record<PrimitiveWrapperKind, NativeDeclaredValType> = {
    Boolean: { kind: "i32" },
    Number: { kind: "f64" },
    String: { kind: "ref", typeKey: anyString },
    Symbol: { kind: "ref", typeKey: symbol },
    BigInt: ext,
  };
  const declarations = PRIMITIVE_WRAPPER_KINDS.flatMap((kind) =>
    roles.map((role) => ({
      key: `${key}:${kind}:${role}`,
      role: ["primitive-wrapper-storage", kind, role],
      space: "function" as const,
      name: `__primitive_wrapper_${kind}_${role}`,
      signature: {
        params: role === "allocation" ? [ext, payloads[kind]] : [ext],
        results: role === "allocation" ? [ext] : [payloads[kind]],
      },
    })),
  );
  return freezeNativeResourceRecipe({
    initialCapacity,
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}

function prerequisites(tx: PhysicalModuleReservations, d: NativePrimitiveWrapperStorageDependencies) {
  requireNativePrimitiveWrapperLayouts(tx, d.layouts, d.layoutPlan, d.layoutDependencies);
  const strings = nativeStringLiteralReservationInventory(tx, d.layoutDependencies.strings);
  const anyStringKey = nativeStringTypeKeys(strings.typePack.key).any;
  const anyString = strings.typePack.types.find((token) => token.key === anyStringKey);
  if (!anyString) fail("missing issued AnyStr type");
  const symbol = d.layoutDependencies.symbols.types.symbol;
  return { anyString, symbol, types: new Map([anyString, symbol].map((token) => [token.key, token])) };
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourcePlan: NativePrimitiveWrapperStoragePlan;
  readonly plan: NativePrimitiveWrapperStoragePlan;
  readonly sourceDependencies: NativePrimitiveWrapperStorageDependencies;
  readonly dependencies: NativePrimitiveWrapperStorageDependencies;
  readonly functions: readonly FunctionReservation[];
  readonly headers: readonly { readonly name: string; readonly typeIdx: number }[];
  filled: boolean;
}
const owners = new WeakMap<NativePrimitiveWrapperStorageReservations, Owner>();

export function reserveNativePrimitiveWrapperStorageResources(
  tx: PhysicalModuleReservations,
  key: string,
  expectedPlan: NativePrimitiveWrapperStoragePlan,
  sourceDependencies: NativePrimitiveWrapperStorageDependencies,
): NativePrimitiveWrapperStorageReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const initialCapacity = capacity(ownValue(expectedPlan, "initialCapacity"));
  const dependencies = Object.freeze(
    Object.fromEntries(dependencyKeys.map((role) => [role, ownValue(sourceDependencies, role)])),
  ) as unknown as NativePrimitiveWrapperStorageDependencies;
  const prerequisite = prerequisites(tx, dependencies);
  const plan = declareNativePrimitiveWrapperStorageResources(
    key,
    { anyString: prerequisite.anyString.key, symbol: prerequisite.symbol.key },
    initialCapacity,
  );
  if (preparedIrDataMismatch(plan, expectedPlan)) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan, prerequisite.types);
  const mapping = (role: (typeof roles)[number]) =>
    Object.freeze(
      Object.fromEntries(
        PRIMITIVE_WRAPPER_KINDS.map((kind) => [
          kind,
          requireNativeDeclaredReservation(records, `${key}:${kind}:${role}`, "function"),
        ]),
      ),
    ) as Readonly<Record<PrimitiveWrapperKind, FunctionReservation>>;
  const pack = Object.freeze({
    allocation: mapping("allocation"),
    read: mapping("read"),
    completionScope: "primitive-wrapper-storage" as const,
  });
  const functions = Object.freeze(PRIMITIVE_WRAPPER_KINDS.flatMap((kind) => roles.map((role) => pack[role][kind])));
  owners.set(pack, {
    tx,
    key,
    sourcePlan: expectedPlan,
    plan,
    sourceDependencies,
    dependencies,
    functions,
    headers: Object.freeze(functions.map((fn) => Object.freeze({ name: fn.object.name, typeIdx: fn.object.typeIdx }))),
    filled: false,
  });
  return pack;
}

export function requireNativePrimitiveWrapperStorageReservations(
  tx: PhysicalModuleReservations,
  pack: NativePrimitiveWrapperStorageReservations,
  expectedPlan: NativePrimitiveWrapperStoragePlan,
  expectedDependencies: NativePrimitiveWrapperStorageDependencies,
): NativePrimitiveWrapperStorageReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (owner.sourcePlan !== expectedPlan || preparedIrDataMismatch(expectedPlan, owner.plan))
    fail("substituted or changed declaration plan");
  if (owner.sourceDependencies !== expectedDependencies) fail("substituted dependency identity");
  for (const role of dependencyKeys)
    if (ownValue(expectedDependencies, role) !== owner.dependencies[role]) fail("changed dependency identity");
  prerequisites(tx, owner.dependencies);
  const functions = PRIMITIVE_WRAPPER_KINDS.flatMap((kind) => roles.map((role) => pack[role][kind]));
  owner.functions.forEach((token, index) => {
    if (functions[index] !== token) fail("substituted function token");
    if (token.object.name !== owner.headers[index]!.name || token.object.typeIdx !== owner.headers[index]!.typeIdx)
      fail("changed function descriptor");
    if (tx.state !== "reserving") tx.physicalIndex(token);
  });
  return pack;
}

function definitions(tx: PhysicalModuleReservations, owner: Owner) {
  const d = owner.dependencies,
    prerequisite = prerequisites(tx, d);
  const state = d.layoutDependencies.realmState;
  if (state) requireCompletedNativeRealmObjectLayouts(tx, state);
  const common = {
    objectTypeIdx: tx.physicalIndex(d.layoutDependencies.objects.object),
    propMapTypeIdx: tx.physicalIndex(d.layoutDependencies.objects.propMap),
    initialCapacity: owner.plan.initialCapacity,
    ...(state
      ? {
          realmState: {
            stateTypeIdx: tx.physicalIndex(state.types.state),
            realmGlobalIdx: tx.physicalIndex(state.anchors.realm),
          },
        }
      : {}),
  };
  // Resolve and build the complete set before changing any function body.
  return PRIMITIVE_WRAPPER_KINDS.flatMap((kind) => {
    const bindings: PrimitiveWrapperBodyBindings = {
      ...common,
      wrapperTypeIdx: tx.physicalIndex(d.layouts.types[kind]),
      ...(kind === "String"
        ? { kind, anyStrTypeIdx: tx.physicalIndex(prerequisite.anyString) }
        : kind === "Symbol"
          ? { kind, symbolTypeIdx: tx.physicalIndex(prerequisite.symbol) }
          : { kind }),
    };
    return [buildPrimitiveWrapperAllocationDefinition(bindings), buildPrimitiveWrapperDataDefinition(bindings)];
  });
}
export function fillNativePrimitiveWrapperStorageResources(
  tx: PhysicalModuleReservations,
  pack: NativePrimitiveWrapperStorageReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  requireNativePrimitiveWrapperStorageReservations(tx, pack, owner.sourcePlan, owner.sourceDependencies);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  const bodies = definitions(tx, owner);
  owner.functions.forEach((token, index) => tx.fillFunction(token, bodies[index]!));
  owner.filled = true;
}

/** Revalidates all ten live bodies and their exact type prerequisites; no broader provider grant. */
export function requireCompletedNativePrimitiveWrapperStorage(
  tx: PhysicalModuleReservations,
  pack: NativePrimitiveWrapperStorageReservations,
  expectedPlan: NativePrimitiveWrapperStoragePlan,
  expectedDependencies: NativePrimitiveWrapperStorageDependencies,
): NativePrimitiveWrapperStorageReservations {
  requireNativePrimitiveWrapperStorageReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  owner.functions.forEach((token) => tx.assertCompletedReservation(token));
  if (owner.dependencies.layoutDependencies.realmState) {
    const canonical = definitions(tx, owner);
    owner.functions.forEach((token, index) => {
      const expected = canonical[index]!;
      if (
        preparedIrDataMismatch(
          { locals: token.object.locals, body: token.object.body },
          { locals: expected.locals, body: expected.body },
        )
      )
        fail("noncanonical stateful wrapper body");
    });
  }
  return pack;
}

export function nativePrimitiveWrapperStorageReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativePrimitiveWrapperStorageReservations,
  expectedPlan: NativePrimitiveWrapperStoragePlan,
  expectedDependencies: NativePrimitiveWrapperStorageDependencies,
) {
  requireNativePrimitiveWrapperStorageReservations(tx, pack, expectedPlan, expectedDependencies);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, layouts: owner.dependencies.layouts, functions: owner.functions });
}
