// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  FunctionReservation,
  PhysicalModuleReservations,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeResourceRecipe } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { buildBoxBigIntBody, buildTypeofBigIntBody } from "../../../runtime/wasmgc/values/bigint-primitive-bodies.js";
import {
  buildReadBigIntCarrierBody,
  buildBigIntCarrierEqualityDefinition,
} from "../../../runtime/wasmgc/values/bigint-carrier-body.js";
import { buildOpenBigIntType, buildBigIntLimbsType } from "../../../runtime/wasmgc/values/bigint-carrier-layouts.js";
import {
  buildFinalizedWideBigIntType,
  declareFinalizedWideBigIntType,
} from "../../../runtime/wasmgc/values/bigint-finalized-layouts.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  nativeScalarTypeDeclaration,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeBigIntReservations {
  readonly type: TypeReservation;
  readonly limbs: TypeReservation;
  readonly wide: TypeReservation;
  /** Boxes a signed-i64 payload; this is not a general BigInt constructor. */
  readonly box: FunctionReservation;
  readonly isBigInt: FunctionReservation;
  /** The carrier's low signed 64 bits. Never use this truncating view for value equality. */
  readonly read: FunctionReservation;
  /** Exact equality of canonical narrow or wide carriers, (anyref, anyref) -> i32. */
  readonly equal: FunctionReservation;
}

/** Standalone's emitted carrier graph and equality. Arithmetic and ToBigInt are separate obligations. */
export function declareNativeBigIntResources(key: string): NativeResourceRecipe {
  if (typeof key !== "string" || !key) throw new Error("native BigInt: invalid declaration key");
  const ext = { kind: "externref" } as const;
  const i64 = { kind: "i64", bigint: true } as const;
  const declarations: NativeResourceRecipe["declarations"][number][] = [
    {
      key: key + ":type",
      role: ["bigint", "type"],
      space: "type",
      shape: nativeScalarTypeDeclaration(buildOpenBigIntType()),
    },
    {
      key: key + ":limbs",
      role: ["bigint", "limbs"],
      space: "type",
      shape: nativeScalarTypeDeclaration(buildBigIntLimbsType()),
    },
    {
      key: key + ":wide",
      role: ["bigint", "wide"],
      space: "type",
      shape: declareFinalizedWideBigIntType(key + ":type", key + ":limbs"),
    },
    {
      key: key + ":box",
      role: ["bigint", "box"],
      space: "function",
      name: "__box_bigint",
      signature: { params: [i64], results: [ext] },
    },
    {
      key: key + ":is-bigint",
      role: ["bigint", "is-bigint"],
      space: "function",
      name: "__typeof_bigint",
      signature: { params: [ext], results: [{ kind: "i32" }] },
    },
    {
      key: key + ":read",
      role: ["bigint", "read"],
      space: "function",
      name: "__read_bigint_carrier",
      signature: { params: [ext], results: [i64] },
    },
    {
      key: key + ":equal",
      role: ["bigint", "equal"],
      space: "function",
      name: "__bigint_carrier_eq",
      signature: { params: [{ kind: "anyref" }, { kind: "anyref" }], results: [{ kind: "i32" }] },
    },
  ];
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly key: string;
  readonly sourcePlan: NativeResourceRecipe;
  readonly plan: NativeResourceRecipe;
  readonly types: readonly TypeReservation[];
  readonly tokens: readonly FunctionReservation[];
  filled: boolean;
}
const owners = new WeakMap<NativeBigIntReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native BigInt: " + detail);
}

export function reserveNativeBigIntResources(
  tx: PhysicalModuleReservations,
  key: string,
  expectedPlan: NativeResourceRecipe,
): NativeBigIntReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const plan = declareNativeBigIntResources(key);
  if (preparedIrDataMismatch(plan, expectedPlan)) fail("substituted declaration plan");
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const records = executeNativeResourceRecipe(tx, plan);
  const pack = Object.freeze({
    type: requireNativeDeclaredReservation(records, key + ":type", "type"),
    limbs: requireNativeDeclaredReservation(records, key + ":limbs", "type"),
    wide: requireNativeDeclaredReservation(records, key + ":wide", "type"),
    box: requireNativeDeclaredReservation(records, key + ":box", "function"),
    isBigInt: requireNativeDeclaredReservation(records, key + ":is-bigint", "function"),
    read: requireNativeDeclaredReservation(records, key + ":read", "function"),
    equal: requireNativeDeclaredReservation(records, key + ":equal", "function"),
  });
  owners.set(pack, {
    tx,
    key,
    sourcePlan: expectedPlan,
    plan,
    types: Object.freeze([pack.type, pack.limbs, pack.wide]),
    tokens: Object.freeze([pack.box, pack.isBigInt, pack.read, pack.equal]),
    filled: false,
  });
  return pack;
}

export function requireNativeBigIntReservations(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntReservations,
  expectedPlan: NativeResourceRecipe,
): NativeBigIntReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  if (
    owner.sourcePlan !== expectedPlan ||
    preparedIrDataMismatch(expectedPlan, owner.plan) ||
    preparedIrDataMismatch(declareNativeBigIntResources(owner.key), owner.plan)
  )
    fail("substituted or changed declaration plan");
  const types = [pack.type, pack.limbs, pack.wide];
  const layouts = [
    buildOpenBigIntType(),
    buildBigIntLimbsType(),
    buildFinalizedWideBigIntType(pack.type.typeIndex, pack.limbs.typeIndex),
  ];
  if (owner.types.some((token, i) => token !== types[i])) fail("substituted type token");
  if (types.some((token, i) => preparedIrDataMismatch(token.object, layouts[i]))) fail("altered carrier layout");
  if (owner.tokens.some((token, i) => token !== [pack.box, pack.isBigInt, pack.read, pack.equal][i]))
    fail("substituted function token");
  for (const token of types) {
    if (tx.state === "reserving") tx.assertTypeReservation(token);
    else if (tx.physicalIndex(token) !== token.typeIndex) fail("stale carrier coordinate");
  }
  if (tx.state !== "reserving") owner.tokens.forEach((token) => tx.physicalIndex(token));
  return pack;
}

export function fillNativeBigIntResources(tx: PhysicalModuleReservations, pack: NativeBigIntReservations): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied owner");
  requireNativeBigIntReservations(tx, pack, owner.sourcePlan);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  tx.fillFunction(pack.box, { locals: [], body: buildBoxBigIntBody(pack.type.typeIndex) });
  tx.fillFunction(pack.isBigInt, { locals: [], body: buildTypeofBigIntBody(pack.type.typeIndex) });
  tx.fillFunction(pack.read, { locals: [], body: buildReadBigIntCarrierBody(pack.type.typeIndex) });
  tx.fillFunction(
    pack.equal,
    buildBigIntCarrierEqualityDefinition({
      narrow: pack.type.typeIndex,
      limbs: pack.limbs.typeIndex,
      wide: pack.wide.typeIndex,
    }),
  );
  owner.filled = true;
}

export function requireCompletedNativeBigInt(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntReservations,
  expectedPlan: NativeResourceRecipe,
): NativeBigIntReservations {
  requireNativeBigIntReservations(tx, pack, expectedPlan);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  owner.tokens.forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}

export function nativeBigIntReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntReservations,
  expectedPlan: NativeResourceRecipe,
) {
  requireNativeBigIntReservations(tx, pack, expectedPlan);
  const owner = owners.get(pack)!;
  return Object.freeze({ plan: owner.plan, type: pack.type, types: owner.types, functions: owner.tokens });
}
