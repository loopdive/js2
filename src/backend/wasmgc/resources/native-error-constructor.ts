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
import { BUILTIN_TYPE_TAGS } from "../../../runtime/contracts/builtin-type-tags.js";
import type {
  NativeResourceRecipe,
  NativeDeclaredValType,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { freezeNativeResourceRecipe, assertNativeResourceDataMatches } from "./native-resource-declarations.js";

export type NativeErrorKind = "TypeError" | "ReferenceError";

export interface NativeErrorConstructorDependencies {
  readonly strings: NativeStringLiteralReservations;
  /** Supplied from the existing tag authority; no second builtin catalog. */
  readonly tag: number;
}
export interface NativeErrorConstructorReservations {
  readonly type: TypeReservation;
  readonly construct: FunctionReservation;
}
export interface NativeErrorConstructorRequirements {
  readonly key: string;
  readonly kind: NativeErrorKind;
}
/** The same canonical carrier/body serves native language errors of either kind. */
export function declareNativeErrorConstructor(requirements: NativeErrorConstructorRequirements): NativeResourceRecipe {
  const kind = requirements.kind;
  if (!requirements.key || (kind !== "TypeError" && kind !== "ReferenceError"))
    throw new Error("native errors: invalid declaration key/kind");
  const shape = createErrorStructType();
  if (shape.kind !== "struct") throw new Error("native errors: canonical Error layout is not a struct");
  const fields = shape.fields.map((field) => {
    if (field.type.kind === "ref" || field.type.kind === "ref_null")
      throw new Error("native errors: Error carrier acquired an undeclared type dependency");
    return { ...field, type: field.type as NativeDeclaredValType };
  });
  const signature = { params: [{ kind: "externref" as const }], results: [{ kind: "externref" as const }] };
  return freezeNativeResourceRecipe({
    declarations: [
      {
        key: requirements.key + ":type",
        role: ["error", kind, "carrier"],
        space: "type",
        shape: { kind: "struct", name: shape.name!, fields },
      },
      {
        key: requirements.key + ":new-" + kind,
        role: ["error", kind, "construct"],
        space: "function",
        name: "__new_" + kind,
        signature,
      },
    ],
    reservationSteps: [
      { phase: "resources", kind: "reserve", resourceKey: requirements.key + ":type" },
      { phase: "resources", kind: "intern-signature", signature, name: "__new_" + kind + "_type" },
      { phase: "resources", kind: "reserve", resourceKey: requirements.key + ":new-" + kind },
    ],
  });
}
const owners = new WeakMap<
  NativeErrorConstructorReservations,
  {
    tx: PhysicalModuleReservations;
    requirements: NativeErrorConstructorRequirements;
    key: string;
    kind: NativeErrorKind;
    functionType: number;
    sourceDependencies: NativeErrorConstructorDependencies;
    dependencies: NativeErrorConstructorDependencies;
    filled: boolean;
  }
>();

export function reserveNativeErrorConstructor(
  tx: PhysicalModuleReservations,
  requirements: NativeErrorConstructorRequirements,
  dependencies: NativeErrorConstructorDependencies,
): NativeErrorConstructorReservations {
  if (!requirements.key || tx.state !== "reserving") throw new Error("native errors: invalid reservation phase/key");
  const kind = requirements.kind;
  declareNativeErrorConstructor(requirements);
  if (dependencies.tag !== BUILTIN_TYPE_TAGS[kind]) throw new Error(`native errors: incorrect ${kind} tag`);
  requireNativeStringLiteral(tx, dependencies.strings, kind);
  tx.assertReservationKeysAvailable([`${requirements.key}:type`, `${requirements.key}:new-${kind}`]);
  const type = tx.reserveType(`${requirements.key}:type`, createErrorStructType());
  tx.internFunctionType([{ kind: "externref" }], [{ kind: "externref" }], `__new_${kind}_type`);
  const construct = tx.reserveFunction(`${requirements.key}:new-${kind}`, `__new_${kind}`, {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const pack = Object.freeze({ type, construct });
  owners.set(pack, {
    tx,
    requirements,
    key: requirements.key,
    kind,
    functionType: construct.object.typeIdx,
    sourceDependencies: dependencies,
    dependencies: Object.freeze({ ...dependencies }),
    filled: false,
  });
  return pack;
}

/** Read-only cycle join: original producer inputs plus the live ledger layout. */
export function requireNativeErrorConstructor(
  tx: PhysicalModuleReservations,
  pack: NativeErrorConstructorReservations,
  expectedRequirements: NativeErrorConstructorRequirements,
  expectedDependencies: NativeErrorConstructorDependencies,
): NativeErrorConstructorReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  if (
    owner.requirements !== expectedRequirements ||
    owner.key !== expectedRequirements.key ||
    owner.kind !== expectedRequirements.kind ||
    owner.sourceDependencies !== expectedDependencies ||
    owner.dependencies.strings !== expectedDependencies.strings ||
    owner.dependencies.tag !== expectedDependencies.tag
  )
    throw new Error("native errors: substituted or stale producer inputs");
  requireNativeStringLiteral(tx, expectedDependencies.strings, owner.kind);
  if (pack.construct.object.name !== "__new_" + owner.kind || pack.construct.object.typeIdx !== owner.functionType)
    throw new Error("native errors: altered constructor header");
  if (tx.state === "reserving") {
    tx.assertTypeReservation(pack.type);
    tx.assertFunctionReservation(pack.construct);
  } else {
    if (tx.physicalIndex(pack.type) !== pack.type.typeIndex)
      throw new Error("native errors: stale error layout coordinate");
    tx.physicalIndex(pack.construct);
  }
  assertNativeResourceDataMatches(pack.type.object, createErrorStructType(), "native errors: altered error layout");
  return pack;
}

export function requireCompletedNativeErrorConstructor(
  tx: PhysicalModuleReservations,
  pack: NativeErrorConstructorReservations,
  expectedRequirements: NativeErrorConstructorRequirements,
  expectedDependencies: NativeErrorConstructorDependencies,
): NativeErrorConstructorReservations {
  requireNativeErrorConstructor(tx, pack, expectedRequirements, expectedDependencies);
  if (!owners.get(pack)!.filled) throw new Error("native errors: incomplete producer; missing canonical fill");
  tx.assertCompletedReservation(pack.construct);
  requireCompletedNativeStringLiterals(tx, expectedDependencies.strings);
  return pack;
}

export function fillNativeErrorConstructor(
  tx: PhysicalModuleReservations,
  pack: NativeErrorConstructorReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) throw new Error("native errors: foreign or forged resource owner");
  requireNativeErrorConstructor(tx, pack, owner.requirements, owner.sourceDependencies);
  if (owner.filled) throw new Error("native errors: duplicate fill");
  tx.physicalIndex(pack.type);
  const name = requireNativeStringLiteral(tx, owner.dependencies.strings, owner.kind);
  tx.fillFunction(pack.construct, {
    locals: [],
    body: buildErrorConstructorBody(
      pack.type.typeIndex,
      owner.dependencies.tag,
      1,
      name.kind === "global"
        ? { kind: "global", index: tx.physicalIndex(name.global), representation: "gc" }
        : { kind: "callable", handle: name.function.handle, representation: "gc" },
    ),
  });
  owner.filled = true;
}
