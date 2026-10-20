// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  FunctionReservation,
  GlobalReservation,
  PhysicalModuleReservations,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativeRealmRequirements } from "../../../ir/program/native-realm-requirements.js";
import type { NativeSourceClosureRequirements } from "../../../ir/program/native-source-closure-requirements.js";
import {
  requireNativeRealmObjectLayouts,
  type NativeRealmObjectLayoutReservations,
} from "./native-realm-object-layouts.js";
import { createNativeSourceCodeIdentityType } from "../../../runtime/wasmgc/values/source-code-identity-bodies.js";
import { compareNativeResourceDeclarationShape, nativeScalarTypeDeclaration } from "./native-resource-declarations.js";

/** Physical description only. The IR producer authenticates the opaque semantic owners. */
export interface NativeSourceCodeIdentityPlan {
  readonly key: string;
  readonly realm: NativeRealmRequirements;
  readonly source: NativeSourceClosureRequirements;
  readonly units: readonly NativeSourceClosureRequirements["units"][number]["unitId"][];
}

export interface NativeSourceCodeIdentityReservations {
  readonly key: string;
  readonly realm: NativeRealmRequirements;
  readonly source: NativeSourceClosureRequirements;
  readonly layouts: NativeRealmObjectLayoutReservations;
  readonly type: TypeReservation;
  readonly entries: readonly {
    readonly unitId: NativeSourceClosureRequirements["units"][number]["unitId"];
    readonly identity: GlobalReservation;
  }[];
  readonly match: FunctionReservation;
  readonly completionScope: "source-code-declarations";
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly realm: NativeRealmRequirements;
  readonly layouts: NativeRealmObjectLayoutReservations;
  readonly key: string;
  readonly source: NativeSourceClosureRequirements;
  readonly units: NativeSourceCodeIdentityPlan["units"];
}
const owners = new WeakMap<NativeSourceCodeIdentityReservations, Owner>();
function fail(detail: string): never {
  throw Error("native source code identities: " + detail);
}
/** Declaration only. The genuine IR body-custody producer must fill and attest every target. */
export function reserveNativeSourceCodeIdentityResources(
  tx: PhysicalModuleReservations,
  plan: NativeSourceCodeIdentityPlan,
  layouts: NativeRealmObjectLayoutReservations,
): NativeSourceCodeIdentityReservations {
  if (tx.state !== "reserving") fail("reservation phase required");
  requireNativeRealmObjectLayouts(tx, layouts);
  if (!plan || typeof plan !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(plan)))
    fail("plain own-data code plan required");
  const fields = Object.getOwnPropertyDescriptors(plan);
  const roles = ["key", "realm", "source", "units"];
  if (
    Reflect.ownKeys(fields).length !== roles.length ||
    roles.some(
      (role) => !Object.hasOwn(fields, role) || !Object.hasOwn(fields[role]!, "value") || !fields[role]!.enumerable,
    )
  )
    fail("plain own-data code plan required");
  const { key, realm, source, units } = Object.fromEntries(
    roles.map((role) => [role, fields[role]!.value]),
  ) as unknown as NativeSourceCodeIdentityPlan;
  if (
    typeof key !== "string" ||
    !key ||
    !Array.isArray(units) ||
    Object.getPrototypeOf(units) !== Array.prototype ||
    !units.length ||
    !realm ||
    typeof realm !== "object" ||
    !source ||
    typeof source !== "object"
  )
    fail("nonempty code keys and units required");
  const ids = Array.from({ length: units.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(units, index);
    if (
      !field ||
      !Object.hasOwn(field, "value") ||
      !field.enumerable ||
      typeof field.value !== "string" ||
      !field.value
    )
      fail("dense own-data code units required");
    return field.value as NativeSourceCodeIdentityPlan["units"][number];
  });
  if (Reflect.ownKeys(units).length !== units.length + 1) fail("extended code unit list");
  const keys = [key + ":type", key + ":match", ...ids.map((id) => key + ":" + id)];
  tx.assertReservationKeysAvailable(keys);
  const type = tx.reserveType(key + ":type", createNativeSourceCodeIdentityType(key));
  const entries = ids.map((id) =>
    Object.freeze({
      unitId: id,
      identity: tx.reserveGlobal(
        key + ":" + id,
        "__source_code_" + id,
        { kind: "ref", typeIdx: type.typeIndex },
        false,
      ),
    }),
  );
  const match = tx.reserveFunction(key + ":match", "__source_code_match", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const pack = Object.freeze({
    key,
    realm,
    source,
    layouts,
    type,
    entries: Object.freeze(entries),
    match,
    completionScope: "source-code-declarations" as const,
  });
  owners.set(pack, { tx, realm, layouts, key, source, units: Object.freeze(ids) });
  return pack;
}
export function requireNativeSourceCodeIdentityReservations(
  tx: PhysicalModuleReservations,
  pack: NativeSourceCodeIdentityReservations,
  expectedSource?: NativeSourceClosureRequirements,
  expectedLayouts?: NativeRealmObjectLayoutReservations,
): NativeSourceCodeIdentityReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied code declarations");
  if (
    (expectedSource !== undefined && expectedSource !== owner.source) ||
    (expectedLayouts !== undefined && expectedLayouts !== owner.layouts)
  )
    fail("different source/realm layout owner");
  requireNativeRealmObjectLayouts(tx, owner.layouts);
  compareNativeResourceDeclarationShape(
    tx,
    {
      key: pack.type.key,
      role: ["source-code", "type"],
      space: "type",
      shape: nativeScalarTypeDeclaration(createNativeSourceCodeIdentityType(owner.key)),
    },
    { key: pack.type.key, space: "type", definition: pack.type.object },
    new Map(),
  );
  if (tx.state === "reserving") tx.assertTypeReservation(pack.type);
  else tx.physicalIndex(pack.type);
  if (pack.entries.length !== owner.units.length) fail("changed code population");
  for (const [index, row] of pack.entries.entries()) {
    if (row.unitId !== owner.units[index]) fail("changed code unit identity");
    compareNativeResourceDeclarationShape(
      tx,
      {
        key: row.identity.key,
        role: ["source-code", row.unitId],
        space: "global",
        name: "__source_code_" + row.unitId,
        valueType: { kind: "ref", typeKey: pack.type.key },
        mutable: false,
      },
      {
        key: row.identity.key,
        space: "global",
        header: {
          name: row.identity.object.name,
          type: row.identity.object.type,
          mutable: row.identity.object.mutable,
        },
      },
      new Map([[pack.type.key, pack.type]]),
    );
    if (tx.state !== "reserving") tx.physicalIndex(row.identity);
  }
  if (tx.state !== "reserving") tx.physicalIndex(pack.match);
  return pack;
}
