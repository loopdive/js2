// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import { createErrorStructType } from "../../../runtime/wasmgc/values/string-layouts.js";
import { buildErrorConstructorBody } from "../../../runtime/wasmgc/values/error-bodies.js";
import {
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import { preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";

export interface LinearReferenceErrorRequirements {
  readonly key: string;
}
export interface LinearReferenceErrorDependencies {
  readonly strings: NativeStringLiteralReservations;
  /** Canonical builtin tag supplied by the existing runtime authority. */
  readonly referenceErrorTag: number;
}
export interface LinearReferenceErrorReservations {
  readonly type: TypeReservation;
  readonly newReferenceError: FunctionReservation;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: LinearReferenceErrorRequirements;
  readonly key: string;
  readonly dependencies: LinearReferenceErrorDependencies;
  readonly strings: NativeStringLiteralReservations;
  readonly tag: number;
  readonly assertEmissionActive: () => void;
  state: "reserved" | "filled" | "failed";
}
const owners = new WeakMap<LinearReferenceErrorReservations, Owner>();
const attempts = new WeakSet<LinearReferenceErrorRequirements>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `Linear ReferenceError: ${detail}`);
}
function use<T>(
  tx: PhysicalModuleReservations,
  pack: LinearReferenceErrorReservations,
  action: (owner: Owner) => T,
): T {
  const owner = owners.get(pack);
  if (!owner) invalid("foreign or forged pack");
  try {
    if (owner.tx !== tx || owner.state === "failed") invalid("foreign or failed pack");
    owner.assertEmissionActive();
    if (
      owner.requirements.key !== owner.key ||
      owner.dependencies.strings !== owner.strings ||
      owner.dependencies.referenceErrorTag !== owner.tag
    )
      invalid("stale producer inputs");
    if (tx.state !== "reserving" && tx.state !== "filling")
      invalid("resource use requires a live reservation/fill phase");
    requireNativeStringLiteral(tx, owner.strings, "ReferenceError");
    if (tx.state === "reserving") tx.assertTypeReservation(pack.type);
    else {
      if (tx.physicalIndex(pack.type) !== pack.type.typeIndex) invalid("stale Error layout coordinate");
      tx.physicalIndex(pack.newReferenceError);
    }
    if (
      preparedIrDataMismatch(pack.type.object, createErrorStructType()) !== undefined ||
      pack.type.key !== `${owner.key}:type` ||
      pack.newReferenceError.key !== `${owner.key}:new-ReferenceError` ||
      pack.newReferenceError.object.name !== "__new_ReferenceError"
    )
      invalid("altered canonical Error resources");
    return action(owner);
  } catch (error) {
    owner.state = "failed";
    throw error;
  }
}

/** Reserve actual shared Error/literal resources without constructing any executable body. */
export function reserveLinearReferenceErrorResources(
  tx: PhysicalModuleReservations,
  requirements: LinearReferenceErrorRequirements,
  dependencies: LinearReferenceErrorDependencies,
  assertEmissionActive: () => void,
): LinearReferenceErrorReservations {
  if (!requirements || typeof requirements.key !== "string" || !requirements.key || attempts.has(requirements))
    invalid("invalid or consumed requirements");
  attempts.add(requirements);
  assertEmissionActive();
  if (tx.state !== "reserving") invalid("reservation requires reserving phase");
  if (dependencies.referenceErrorTag !== -16) invalid("incorrect ReferenceError tag");
  requireNativeStringLiteral(tx, dependencies.strings, "ReferenceError");
  tx.assertReservationKeysAvailable([`${requirements.key}:type`, `${requirements.key}:new-ReferenceError`]);
  const type = tx.reserveType(`${requirements.key}:type`, createErrorStructType());
  // reserveFunction owns signature interning. No duplicate type or invented TypeReservation.
  const newReferenceError = tx.reserveFunction(`${requirements.key}:new-ReferenceError`, "__new_ReferenceError", {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const pack = Object.freeze({ type, newReferenceError });
  owners.set(pack, {
    tx,
    requirements,
    key: requirements.key,
    dependencies,
    strings: dependencies.strings,
    tag: dependencies.referenceErrorTag,
    assertEmissionActive,
    state: "reserved",
  });
  return pack;
}

export function requireLinearReferenceErrorResources(
  tx: PhysicalModuleReservations,
  pack: LinearReferenceErrorReservations,
  requirements: LinearReferenceErrorRequirements,
  dependencies: LinearReferenceErrorDependencies,
): LinearReferenceErrorReservations {
  return use(tx, pack, (owner) => {
    if (owner.requirements !== requirements || owner.dependencies !== dependencies)
      invalid("substituted producer inputs");
    return pack;
  });
}

/** Resolve the real constructor only within the exact still-live emission attempt. */
export function linearReferenceErrorConstructorIndex(
  tx: PhysicalModuleReservations,
  pack: LinearReferenceErrorReservations,
): number {
  return use(tx, pack, () => {
    if (tx.state !== "filling") invalid("constructor binding requires frozen reservations");
    return tx.physicalIndex(pack.newReferenceError);
  });
}

export function fillLinearReferenceErrorResources(
  tx: PhysicalModuleReservations,
  pack: LinearReferenceErrorReservations,
): void {
  use(tx, pack, (owner) => {
    if (tx.state !== "filling" || owner.state !== "reserved")
      invalid("fill requires frozen reservations and a single unfilled pack");
    requireCompletedNativeStringLiterals(tx, owner.strings);
    const name = requireNativeStringLiteral(tx, owner.strings, "ReferenceError");
    tx.fillFunction(pack.newReferenceError, {
      locals: [],
      body: buildErrorConstructorBody(
        tx.physicalIndex(pack.type),
        owner.tag,
        1,
        name.kind === "global"
          ? { kind: "global", index: tx.physicalIndex(name.global), representation: "gc" }
          : { kind: "callable", handle: tx.physicalIndex(name.function), representation: "gc" },
      ),
    });
    tx.assertCompletedReservation(pack.newReferenceError);
    owner.state = "filled";
  });
}

export function requireCompletedLinearReferenceErrorResources(
  tx: PhysicalModuleReservations,
  pack: LinearReferenceErrorReservations,
): LinearReferenceErrorReservations {
  return use(tx, pack, (owner) => {
    if (tx.state !== "filling" || owner.state !== "filled") invalid("incomplete canonical constructor");
    requireCompletedNativeStringLiterals(tx, owner.strings);
    tx.assertCompletedReservation(pack.newReferenceError);
    return pack;
  });
}

/** Canonical recipe proof stays with the producer that owns and fills this body. */
export function linearReferenceErrorConstructorBodyMatches(
  tx: PhysicalModuleReservations,
  pack: LinearReferenceErrorReservations,
): boolean {
  return use(tx, pack, (owner) => {
    requireCompletedLinearReferenceErrorResources(tx, pack);
    const name = requireNativeStringLiteral(tx, owner.strings, "ReferenceError");
    if (name.kind !== "global") return false;
    const canonicalBody = buildErrorConstructorBody(tx.physicalIndex(pack.type), owner.tag, 1, {
      kind: "global",
      index: tx.physicalIndex(name.global),
      representation: "gc",
    });
    return (
      !pack.newReferenceError.object.locals.length &&
      preparedIrDataMismatch(pack.newReferenceError.object.body, canonicalBody) === undefined
    );
  });
}
