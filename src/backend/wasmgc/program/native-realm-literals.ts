// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { REALM_ARRAY_LITERALS } from "../../../runtime/wasmgc/values/realm-array-bodies.js";
import {
  assertNativeRealmRequirementsIssued,
  heldCatalogRows,
  type NativeRealmRequirements,
} from "../../../ir/program/native-realm-requirements.js";
import type { IrStringEncoding } from "../../../ir/core/string-types.js";
import type { NativeRealmProperty } from "../../../runtime/contracts/native-realm-catalog.js";
import { NATIVE_BUILTIN_FUNCTION_LITERALS } from "../resources/native-builtin-function-requests.js";
import { NATIVE_OBJECT_DESCRIPTOR_LITERALS } from "../resources/native-object-descriptors.js";
import { nativeSourceObjectLiterals } from "../resources/native-source-objects.js";

export interface NativeRealmLiteralPlan {
  readonly requirements: NativeRealmRequirements;
  readonly utf8Storage: boolean;
  readonly literals: readonly { readonly value: string; readonly encoding: IrStringEncoding }[];
}
const owners = new WeakMap<
  NativeRealmLiteralPlan,
  { readonly requirements: NativeRealmRequirements; readonly utf8Storage: boolean }
>();
const cache = new WeakMap<NativeRealmRequirements, Map<boolean, NativeRealmLiteralPlan>>();
function fail(detail: string): never {
  throw Error("native realm literals: " + detail);
}
/** Authenticate before a cache hit; the cache does not grant currentness. */
export function planNativeRealmLiterals(
  requirements: NativeRealmRequirements,
  utf8Storage: boolean,
): NativeRealmLiteralPlan {
  assertNativeRealmRequirementsIssued(requirements);
  if (typeof utf8Storage !== "boolean") fail("invalid encoding selection");
  const prior = cache.get(requirements)?.get(utf8Storage);
  if (prior) return prior;
  const heldRows = heldCatalogRows(requirements.description);
  const heldIds = new Set(heldRows.map((row) => row.id));
  const unheldMember = (property: NativeRealmProperty): boolean =>
    property.kind === "data" && property.value.kind === "intrinsic" && !heldIds.has(property.value.id);
  const texts = [
    ...new Set([
      "TypeError",
      "Value is not callable",
      ...NATIVE_BUILTIN_FUNCTION_LITERALS,
      ...NATIVE_OBJECT_DESCRIPTOR_LITERALS,
      ...nativeSourceObjectLiterals(requirements.description.objectUses.map((use) => use.feature)),
      // (#7354 A1) The array define's messages, where the realm holds arrays.
      ...(heldRows.some((row) => row.array) ? REALM_ARRAY_LITERALS : []),
      // (#7354 G1) Only the rows the realm holds: a family the program never reaches adds no string to it.
      ...heldRows.flatMap((row) => [
        ...(row.callable ? [row.callable.initialName] : []),
        // (#7354 A1) A key whose value the realm does not hold is no property it seeds (`Array.prototype.map`).
        ...row.properties
          .filter((property) => !unheldMember(property))
          .flatMap((property) => [
            ...(property.key.kind === "string" ? [property.key.value] : []),
            ...(property.kind === "data" && property.value.kind === "string" ? [property.value.value] : []),
          ]),
      ]),
    ]),
  ];
  const selected = texts.map((value) =>
    Object.freeze({ value, encoding: utf8Storage ? ("utf8-guaranteed" as const) : ("wtf16" as const) }),
  );
  // Flattening and String creation require these canonical carriers even with
  // UTF8 primary storage. Retain selected UTF8 literals alongside prerequisites.
  for (const value of ["", "length"])
    if (!selected.some((row) => row.value === value && row.encoding === "wtf16"))
      selected.push(Object.freeze({ value, encoding: "wtf16" as const }));
  const pack = Object.freeze({
    requirements,
    utf8Storage,
    literals: Object.freeze(selected),
  });
  owners.set(pack, { requirements, utf8Storage });
  let encodings = cache.get(requirements);
  if (!encodings) cache.set(requirements, (encodings = new Map()));
  encodings.set(utf8Storage, pack);
  return pack;
}
export function requireNativeRealmLiteralPlan(
  pack: NativeRealmLiteralPlan,
  requirements: NativeRealmRequirements,
  utf8Storage: boolean,
): NativeRealmLiteralPlan {
  const owner = owners.get(pack);
  if (!owner || owner.requirements !== requirements || owner.utf8Storage !== utf8Storage)
    fail("foreign, copied or substituted literal plan");
  if (planNativeRealmLiterals(requirements, utf8Storage) !== pack) fail("detached literal plan");
  return pack;
}
export interface NativeRealmLiteralInput {
  readonly realmRequirements?: NativeRealmRequirements;
  readonly realmLiterals?: NativeRealmLiteralPlan;
}
/** Both absent, or the exact issued pair in visible data fields. No getter is evaluated. */
export function readNativeRealmLiteralInput(input: NativeRealmLiteralInput, utf8Storage: boolean) {
  const requirements = Object.getOwnPropertyDescriptor(input, "realmRequirements"),
    literals = Object.getOwnPropertyDescriptor(input, "realmLiterals");
  if (!requirements && !literals) {
    if ("realmRequirements" in input || "realmLiterals" in input) fail("inherited realm input");
    return undefined;
  }
  for (const field of [requirements, literals])
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable || !field.value)
      fail("realm requirements/literals must be a complete own enumerable data pair");
  const realmRequirements = requirements!.value as NativeRealmRequirements;
  const realmLiterals = requireNativeRealmLiteralPlan(literals!.value, realmRequirements, utf8Storage);
  return { realmRequirements, realmLiterals };
}
