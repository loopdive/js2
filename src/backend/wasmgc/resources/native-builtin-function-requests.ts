// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import type { NativeClosureDeclarationRequirements } from "./native-closures.js";
import {
  nativeArgumentVectorReservationInventory,
  type NativeArgumentVectorReservations,
  type NativeArgumentVectorDeclarationPlan,
} from "./native-argument-vectors.js";
import { requireNativeStringLiteral, type NativeStringLiteralReservations } from "./native-string-literals.js";

export interface NativeBuiltinFunctionRequirement {
  readonly id: string;
  readonly behavior: "function-prototype" | "throw-type-error";
  readonly signatureId: string;
  readonly metadataId: string;
  readonly initialName: string;
  readonly initialLength: number;
  readonly userFormalCount: number;
  readonly prototype: "object-prototype" | "function-prototype";
  readonly constructible: false;
  readonly aliases: readonly string[];
}
export interface NativeBuiltinFunctionRequirements {
  readonly key: string;
  readonly intrinsics: readonly NativeBuiltinFunctionRequirement[];
}
export interface NativeBuiltinFunctionRequestDependencies {
  readonly arguments: NativeArgumentVectorReservations;
  readonly argumentPlan: NativeArgumentVectorDeclarationPlan;
  readonly strings: NativeStringLiteralReservations;
}
/** Symbolic extension of the sole closure issuer, not a parallel closure pack. */
export interface NativeBuiltinFunctionRequests {
  readonly requirements: NativeBuiltinFunctionRequirements;
  readonly requests: NativeClosureDeclarationRequirements["requests"];
  readonly referenceTypes: readonly TypeReservation[];
}
export const NATIVE_BUILTIN_FUNCTION_LITERALS = Object.freeze([
  "",
  "length",
  "name",
  "TypeError: incompatible native builtin function",
  "TypeError: native builtin is not a constructor",
  "TypeError: restricted function property",
  "TypeError: native builtin initialization failed",
  "TypeError: read only native builtin property",
]);
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly original: NativeBuiltinFunctionRequirements;
  readonly dependencies: NativeBuiltinFunctionRequestDependencies;
  readonly identities: NativeBuiltinFunctionRequestDependencies;
  readonly literals: readonly ReturnType<typeof requireNativeStringLiteral>[];
}
const owners = new WeakMap<NativeBuiltinFunctionRequests, Owner>();
function fail(detail: string): never {
  throw new Error("native builtin function requests: " + detail);
}

/** Inspect descriptors before reading caller input: getters must never run during authentication. */
export function assertBuiltinFunctionDataRecord(value: object): void {
  if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    fail("non-plain input record");
  for (const key of Reflect.ownKeys(value))
    if (
      typeof key !== "string" ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value") ||
      !Object.getOwnPropertyDescriptor(value, key)!.enumerable
    )
      fail("non-data input record");
}
function dataTree(value: unknown): void {
  if (typeof value === "function" || typeof value === "symbol") fail("non-data requirement value");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
      fail("noncanonical input array");
    for (let index = 0; index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      if (!field || !Object.hasOwn(field, "value")) fail("non-data input array");
      dataTree(field.value);
    }
  } else {
    assertBuiltinFunctionDataRecord(value);
    Object.values(value).forEach(dataTree);
  }
}
function validateRequirements(input: NativeBuiltinFunctionRequirements): void {
  dataTree(input);
  if (typeof input.key !== "string" || !input.key || !Array.isArray(input.intrinsics) || !input.intrinsics.length)
    fail("invalid key or empty intrinsic population");
  if (Object.keys(input).some((key) => key !== "key" && key !== "intrinsics")) fail("unknown requirement field");
  const ids = new Set<string>(),
    aliases = new Set<string>(),
    behaviors = new Set<string>();
  for (const row of input.intrinsics) {
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "id",
            "behavior",
            "signatureId",
            "metadataId",
            "initialName",
            "initialLength",
            "userFormalCount",
            "prototype",
            "constructible",
            "aliases",
          ].includes(key),
      )
    )
      fail("unsupported dynamic naming, async, or constructor requirement");
    if (!["function-prototype", "throw-type-error"].includes(row.behavior) || behaviors.has(row.behavior))
      fail("unavailable or duplicate intrinsic behavior");
    behaviors.add(row.behavior);
    if (
      typeof row.initialName !== "string" ||
      row.initialName !== "" ||
      !Number.isSafeInteger(row.initialLength) ||
      row.initialLength !== 0 ||
      row.userFormalCount !== 0
    )
      fail("unsupported intrinsic name/length/formal metadata (dynamic and infinite lengths require another owner)");
    if (
      row.constructible !== false ||
      row.prototype !== (row.behavior === "function-prototype" ? "object-prototype" : "function-prototype")
    )
      fail("unsupported prototype role or construct capability");
    for (const id of [row.id, row.signatureId, row.metadataId]) {
      if (typeof id !== "string" || !id || ids.has(id)) fail("missing or duplicate request identity");
      ids.add(id);
    }
    if (!Array.isArray(row.aliases) || !row.aliases.length) fail("empty singleton alias population");
    for (const alias of row.aliases) {
      if (typeof alias !== "string" || !alias || aliases.has(alias)) fail("conflicting singleton alias");
      aliases.add(alias);
    }
  }
  if (input.intrinsics[0]?.behavior !== "function-prototype")
    fail("Function.prototype must establish the realm anchor");
}
function freezeData<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}
function authenticate(tx: PhysicalModuleReservations, dependencies: NativeBuiltinFunctionRequestDependencies) {
  assertBuiltinFunctionDataRecord(dependencies);
  if (
    Object.keys(dependencies).length !== 3 ||
    Object.keys(dependencies).some((key) => !["arguments", "argumentPlan", "strings"].includes(key))
  )
    fail("missing or unexpected dependency role");
  nativeArgumentVectorReservationInventory(tx, dependencies.arguments, dependencies.argumentPlan);
  return NATIVE_BUILTIN_FUNCTION_LITERALS.map((text) => requireNativeStringLiteral(tx, dependencies.strings, text));
}
export function declareNativeBuiltinFunctionRequests(
  tx: PhysicalModuleReservations,
  requirements: NativeBuiltinFunctionRequirements,
  dependencies: NativeBuiltinFunctionRequestDependencies,
): NativeBuiltinFunctionRequests {
  if (tx.state !== "reserving") fail("declaration requires reservation phase");
  validateRequirements(requirements);
  const literals = authenticate(tx, dependencies);
  const snapshot = freezeData(structuredClone(requirements));
  const requests: NativeClosureDeclarationRequirements["requests"] = freezeData(
    snapshot.intrinsics.flatMap((row) => [
      {
        kind: "signature" as const,
        id: row.signatureId,
        allocationMode: "support" as const,
        params: [{ kind: "externref" as const }, { kind: "ref" as const, typeKey: dependencies.arguments.carrier.key }],
        results: [{ kind: "externref" as const }],
      },
      {
        kind: "metadata" as const,
        id: row.metadataId,
        signatureId: row.signatureId,
        key: requirements.key + ":intrinsic:" + row.id,
        name: row.initialName,
        length: row.initialLength,
      },
    ]),
  );
  const pack = Object.freeze({
    requirements: snapshot,
    requests,
    referenceTypes: Object.freeze([dependencies.arguments.carrier]),
  });
  owners.set(pack, {
    tx,
    original: requirements,
    dependencies,
    identities: Object.freeze({ ...dependencies }),
    literals,
  });
  return pack;
}
export function requireNativeBuiltinFunctionRequests(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionRequests,
): NativeBuiltinFunctionRequests {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied request issuer");
  validateRequirements(owner.original);
  assertBuiltinFunctionDataRecord(owner.dependencies);
  if (
    Object.keys(owner.dependencies).length !== Object.keys(owner.identities).length ||
    Object.keys(owner.identities).some(
      (key) =>
        owner.dependencies[key as keyof NativeBuiltinFunctionRequestDependencies] !==
        owner.identities[key as keyof NativeBuiltinFunctionRequestDependencies],
    )
  )
    fail("changed dependency identities");
  if (preparedIrDataMismatch(owner.original, pack.requirements)) fail("stale builtin requirements");
  const literals = authenticate(tx, owner.dependencies);
  if (
    literals.some((binding, index) => {
      const original = owner.literals[index]!;
      return (
        binding.kind !== original.kind ||
        (binding.kind === "global"
          ? original.kind !== "global" || binding.global !== original.global
          : original.kind !== "callable" || binding.function !== original.function)
      );
    })
  )
    fail("changed literal tokens");
  return pack;
}
export function nativeBuiltinFunctionRequestDependencies(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionRequests,
): NativeBuiltinFunctionRequestDependencies {
  requireNativeBuiltinFunctionRequests(tx, pack);
  return owners.get(pack)!.dependencies;
}
