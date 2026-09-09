// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  PhysicalModuleReservations,
  FunctionReservation,
  TypeReservation,
  GlobalReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeStringLiteralReservations } from "./native-string-literals.js";
import {
  type NativeStringFlattenReservations,
  requireNativeStringFlattenReservations,
  requireCompletedNativeStringFlatten,
} from "./native-string-flatten.js";
import {
  type NativeValueResourcePlan,
  assertNativeValueResourcePlan,
} from "../../../ir/program/native-value-resources.js";
import {
  buildDecimalPowerArrayType,
  buildDecimalPowerArrayInitializer,
} from "../../../runtime/wasmgc/values/decimal-scale-bodies.js";
import {
  buildStringToNumberPrelude,
  buildStringToNumberResult,
  buildStringToNumberLocals,
} from "../../../runtime/wasmgc/values/string-number-bodies.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  nativeScalarTypeDeclaration,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export function declareNativeStringNumberResources(anchor: NativeValueResourcePlan["anchor"]): NativeResourceRecipe {
  const key = (role: string) => "physical:string-number:" + JSON.stringify(anchor) + ":" + role;
  const declarations: NativeStringValueDeclaration[] = [
    {
      key: key("scanner"),
      role: ["string-number", "scanner"],
      space: "function",
      name: "__str_to_number",
      signature: { params: [{ kind: "externref" }], results: [{ kind: "f64" }] },
    },
    {
      key: key("power-array"),
      role: ["string-number", "power-array"],
      space: "type",
      shape: nativeScalarTypeDeclaration(buildDecimalPowerArrayType()),
    },
    {
      key: key("power-global"),
      role: ["string-number", "power-global"],
      space: "global",
      name: "__pow10_f64",
      valueType: { kind: "ref", typeKey: key("power-array") },
      mutable: false,
    },
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}

export interface NativeStringNumberReservations {
  readonly stringPack: NativeStringLiteralReservations;
  readonly flattenPack: NativeStringFlattenReservations;
  readonly powerArray: TypeReservation;
  readonly powerGlobal: GlobalReservation;
  readonly toNumber: FunctionReservation;
}

interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly plan: NativeValueResourcePlan;
  readonly stringPack: NativeStringLiteralReservations;
  readonly flattenPack: NativeStringFlattenReservations;
  readonly powerArray: TypeReservation;
  readonly powerGlobal: GlobalReservation;
  readonly toNumber: FunctionReservation;
  filled: boolean;
}

// Provenance and successful canonical-fill attestation only. Allocation,
// resource completion and current-content validation belong to the one ledger.
const owners = new WeakMap<NativeStringNumberReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native string number: " + detail);
}

function requireOwner(tx: PhysicalModuleReservations, pack: NativeStringNumberReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or fabricated scanner reservations");
  assertNativeValueResourcePlan(owner.plan);
  if (owner.plan.strings !== "native-string") fail("scanner requires selected native-string representation");
  if (
    pack.stringPack !== owner.stringPack ||
    pack.flattenPack !== owner.flattenPack ||
    pack.powerArray !== owner.powerArray ||
    pack.powerGlobal !== owner.powerGlobal ||
    pack.toNumber !== owner.toNumber
  )
    fail("substituted scanner dependency or resource");
  requireNativeStringFlattenReservations(tx, owner.flattenPack);
  if (owner.flattenPack.stringPack !== owner.stringPack) fail("substituted flatten string owner");
  return owner;
}

function validateTokens(tx: PhysicalModuleReservations, pack: NativeStringNumberReservations): void {
  if (tx.physicalIndex(pack.powerArray) !== pack.powerArray.typeIndex) fail("stale power-array type coordinate");
  // Each call also rechecks the ledger's exact descriptors and completed bytes,
  // including global entries, mutability, function locals and shared identities.
  tx.physicalIndex(pack.powerGlobal);
  tx.physicalIndex(pack.toNumber);
}

/** Authenticate reservation provenance without requiring filled resources. */
export function requireNativeStringNumberReservations(
  tx: PhysicalModuleReservations,
  pack: NativeStringNumberReservations,
  expectedPlan: NativeValueResourcePlan,
  expectedStringPack: NativeStringLiteralReservations,
): NativeStringNumberReservations {
  const owner = requireOwner(tx, pack);
  if (owner.plan !== expectedPlan) fail("foreign expected native-value plan");
  if (owner.stringPack !== expectedStringPack) fail("foreign expected string pack");
  if (tx.state !== "reserving") validateTokens(tx, pack);
  return pack;
}

/** Reserve the exact scanner first, then its immutable power type/global. */
export function reserveNativeStringNumberResources(
  tx: PhysicalModuleReservations,
  nativeValuePlan: NativeValueResourcePlan,
  flattenPack: NativeStringFlattenReservations,
): NativeStringNumberReservations {
  assertNativeValueResourcePlan(nativeValuePlan);
  if (nativeValuePlan.strings !== "native-string") fail("scanner requires selected native-string representation");
  if (tx.state !== "reserving") fail("scanner reservation requires reserving phase");
  requireNativeStringFlattenReservations(tx, flattenPack);
  const stringPack = flattenPack.stringPack;
  const key = (role: string) => "physical:string-number:" + JSON.stringify(nativeValuePlan.anchor) + ":" + role;
  const records = executeNativeResourceRecipe(tx, declareNativeStringNumberResources(nativeValuePlan.anchor));
  const toNumber = requireNativeDeclaredReservation(records, key("scanner"), "function");
  const powerArray = requireNativeDeclaredReservation(records, key("power-array"), "type");
  const powerGlobal = requireNativeDeclaredReservation(records, key("power-global"), "global");
  const pack = Object.freeze({ stringPack, flattenPack, powerArray, powerGlobal, toNumber });
  owners.set(pack, {
    tx,
    plan: nativeValuePlan,
    stringPack,
    flattenPack,
    powerArray,
    powerGlobal,
    toNumber,
    filled: false,
  });
  return pack;
}

/** Fill after the caller's single freeze and completed string/flatten fills. */
export function fillNativeStringNumberResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringNumberReservations,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.filled) fail("duplicate scanner fill");
  requireCompletedNativeStringFlatten(tx, owner.flattenPack, owner.stringPack);
  validateTokens(tx, pack);
  tx.fillGlobal(pack.powerGlobal, buildDecimalPowerArrayInitializer(pack.powerArray.typeIndex));
  const layout = owner.stringPack.layout;
  tx.fillFunction(pack.toNumber, {
    locals: buildStringToNumberLocals(layout),
    body: [
      ...buildStringToNumberPrelude(layout, owner.flattenPack.flatten.handle),
      ...buildStringToNumberResult({
        arrayTypeIndex: pack.powerArray.typeIndex,
        globalIndex: tx.physicalIndex(pack.powerGlobal),
      }),
    ],
  });
  owner.filled = true;
}

/** Never accept name/signature/nonempty-body evidence in place of canonical fill. */
export function requireCompletedNativeStringNumber(
  tx: PhysicalModuleReservations,
  pack: NativeStringNumberReservations,
  expectedPlan: NativeValueResourcePlan,
  expectedStringPack: NativeStringLiteralReservations,
): NativeStringNumberReservations {
  requireNativeStringNumberReservations(tx, pack, expectedPlan, expectedStringPack);
  const owner = requireOwner(tx, pack);
  if (!owner.filled) fail("scanner canonical fill is incomplete");
  requireCompletedNativeStringFlatten(tx, owner.flattenPack, expectedStringPack);
  validateTokens(tx, pack);
  return pack;
}
