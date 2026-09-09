// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../../../wasm/model/instructions.js";
import type { TypeDef, GlobalDef } from "../../../wasm/model/module-records.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
  PhysicalFunctionSignature,
} from "../../../wasm/physical/module-reservations.js";
import type {
  NativeDeclaredValType,
  NativeDeclaredType,
  NativeDeclaredSignature,
  NativeStringValueDeclaration,
  NativeResourceRecipe,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "../../../ir/program/data.js";

export type NativeDeclaredReservation = TypeReservation | GlobalReservation | FunctionReservation;
export type NativeDeclaredTypeTokens = ReadonlyMap<string, TypeReservation>;
const scalarKinds = [
  "i32",
  "i64",
  "f32",
  "f64",
  "i8",
  "i16",
  "v128",
  "funcref",
  "externref",
  "ref_extern",
  "anyref",
  "eqref",
];
function fail(detail: string): never {
  throw new Error("native resource declarations: " + detail);
}
function dense<T>(values: readonly T[], label: string, visit: (value: T) => void): void {
  if (!Array.isArray(values)) fail("invalid " + label);
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) fail("sparse " + label);
    visit(values[index]!);
  }
}
export function freezeNativeResourceRecipe<T extends NativeResourceRecipe>(recipe: T): T {
  return freezePreparedIrValue(recipe) as T;
}
function typeIndex(tx: PhysicalModuleReservations, types: NativeDeclaredTypeTokens, key: string): number {
  const token = types.get(key);
  if (!token || token.key !== key) fail("missing or substituted type key " + key);
  if (tx.state === "reserving") tx.assertTypeReservation(token);
  else tx.physicalIndex(token);
  return token.typeIndex;
}
export function instantiateNativeDeclaredValType(
  tx: PhysicalModuleReservations,
  value: NativeDeclaredValType,
  types: NativeDeclaredTypeTokens,
): ValType {
  if (value.kind === "ref" || value.kind === "ref_null") {
    if (!("typeKey" in value) || "typeIdx" in value) fail("physical or missing reference in symbolic declaration");
    return { kind: value.kind, typeIdx: typeIndex(tx, types, value.typeKey) };
  }
  if (!scalarKinds.includes(value.kind) || "typeKey" in value || "typeIdx" in value)
    fail("unsupported scalar declaration");
  return { ...value };
}
export function instantiateNativeDeclaredSignature(
  tx: PhysicalModuleReservations,
  signature: NativeDeclaredSignature,
  types: NativeDeclaredTypeTokens,
) {
  return {
    params: signature.params.map((value) => instantiateNativeDeclaredValType(tx, value, types)),
    results: signature.results.map((value) => instantiateNativeDeclaredValType(tx, value, types)),
  };
}
export function instantiateNativeDeclaredType(
  tx: PhysicalModuleReservations,
  shape: NativeDeclaredType,
  types: NativeDeclaredTypeTokens,
): TypeDef {
  if (shape.kind === "array")
    return {
      kind: "array",
      name: typeof shape.name === "string" ? shape.name : `__arr_ref_${typeIndex(tx, types, shape.name.typeKey)}`,
      element: instantiateNativeDeclaredValType(tx, shape.element, types),
      mutable: shape.mutable,
    };
  if (shape.kind !== "struct") fail("unsupported declaration shape");
  const { parent, fields, ...rest } = shape;
  return {
    ...rest,
    fields: fields.map((field) => ({ ...field, type: instantiateNativeDeclaredValType(tx, field.type, types) })),
    ...(Object.hasOwn(shape, "parent")
      ? {
          superTypeIdx:
            parent?.kind === "root"
              ? -1
              : parent?.kind === "resource"
                ? typeIndex(tx, types, parent.typeKey)
                : fail("invalid explicit parent"),
        }
      : {}),
  };
}
/** Numeric-free existing constructors may be reused; references require producer-authored keys. */
export function nativeScalarTypeDeclaration(definition: TypeDef): NativeDeclaredType {
  const value = (type: ValType): NativeDeclaredValType => {
    if (type.kind === "ref" || type.kind === "ref_null") fail("numeric reference requires symbolic recipe");
    return { ...type };
  };
  if (definition.kind === "array") return { ...definition, element: value(definition.element) };
  if (definition.kind !== "struct") fail("unsupported declaration shape");
  const { superTypeIdx, fields, ...rest } = definition;
  if (Object.hasOwn(definition, "superTypeIdx") && superTypeIdx !== -1) fail("numeric parent requires symbolic recipe");
  return {
    ...rest,
    fields: fields.map((field) => ({ ...field, type: value(field.type) })),
    ...(Object.hasOwn(definition, "superTypeIdx") ? { parent: { kind: "root" as const } } : {}),
  };
}

/** Preflight the entire recipe without allocation, then execute its exact interleaving. */
export function executeNativeResourceRecipe(
  tx: PhysicalModuleReservations,
  recipe: NativeResourceRecipe,
  prerequisites: NativeDeclaredTypeTokens = new Map(),
): ReadonlyMap<string, NativeDeclaredReservation> {
  const types = new Map(prerequisites);
  for (const [key, token] of types) {
    if (token.key !== key) fail("substituted prerequisite key");
    tx.assertTypeReservation(token);
  }
  const declarations = new Map<string, NativeStringValueDeclaration>();
  dense(recipe.declarations, "declarations", (row) => {
    if (!row.key || declarations.has(row.key) || types.has(row.key)) fail("duplicate declaration key");
    if (!Array.isArray(row.role) || !row.role.length) fail("invalid structural role");
    dense(row.role, "roles", (part) => {
      if (typeof part !== "string") fail("invalid structural role");
    });
    declarations.set(row.key, row);
  });
  const available = new Set(types.keys()),
    reserved = new Set<string>();
  const ref = (value: NativeDeclaredValType) => {
    if (!value || typeof value !== "object") fail("invalid value type");
    if (value.kind === "ref" || value.kind === "ref_null") {
      if (!available.has(value.typeKey) || "typeIdx" in value) fail("missing/forward symbolic type key");
    } else if (!scalarKinds.includes(value.kind) || "typeIdx" in value || "typeKey" in value)
      fail("unsupported declared value type");
  };
  const signature = (sig: NativeDeclaredSignature) => {
    dense(sig.params, "signature params", ref);
    dense(sig.results, "signature results", ref);
  };
  let resourcePhase = false;
  dense(recipe.reservationSteps, "reservation steps", (step) => {
    if (step.phase !== "string-types" && step.phase !== "resources") fail("invalid reservation phase");
    if (step.phase === "resources") resourcePhase = true;
    else if (resourcePhase) fail("reordered string type phase");
    if (step.kind === "intern-signature") {
      signature(step.signature);
      return;
    }
    if (step.kind !== "reserve") fail("unsupported reservation step");
    const row = declarations.get(step.resourceKey);
    if (!row || reserved.has(row.key)) fail("missing or repeated reserve step");
    if (row.space === "type") {
      const shape = row.shape;
      if (shape.kind === "array") {
        ref(shape.element);
        if (
          typeof shape.name !== "string" &&
          (shape.name?.kind !== "array-ref-index" || !available.has(shape.name.typeKey))
        )
          fail("invalid symbolic array name");
      } else if (shape.kind === "struct") {
        dense(shape.fields, "struct fields", (field) => ref(field.type));
        if (
          Object.hasOwn(shape, "parent") &&
          shape.parent?.kind !== "root" &&
          (shape.parent?.kind !== "resource" || !available.has(shape.parent.typeKey))
        )
          fail("invalid symbolic parent");
      } else fail("unsupported declaration shape");
      available.add(row.key);
    } else if (row.space === "global") ref(row.valueType);
    else if (row.space === "function") signature(row.signature);
    else fail("unsupported resource space");
    reserved.add(row.key);
  });
  if (reserved.size !== declarations.size) fail("declaration missing reserve step");
  const result = new Map<string, NativeDeclaredReservation>();
  for (const step of recipe.reservationSteps) {
    if (step.kind === "intern-signature") {
      const sig = instantiateNativeDeclaredSignature(tx, step.signature, types);
      tx.internFunctionType(sig.params, sig.results);
      continue;
    }
    const row = declarations.get(step.resourceKey)!;
    let token: NativeDeclaredReservation;
    if (row.space === "type") {
      token = tx.reserveType(row.key, instantiateNativeDeclaredType(tx, row.shape, types));
      types.set(row.key, token);
    } else if (row.space === "global")
      token = tx.reserveGlobal(
        row.key,
        row.name,
        instantiateNativeDeclaredValType(tx, row.valueType, types),
        row.mutable,
      );
    else token = tx.reserveFunction(row.key, row.name, instantiateNativeDeclaredSignature(tx, row.signature, types));
    result.set(row.key, token);
  }
  return result;
}

export function requireNativeDeclaredReservation<K extends NativeDeclaredReservation["kind"]>(
  records: ReadonlyMap<string, NativeDeclaredReservation>,
  key: string,
  kind: K,
): Extract<NativeDeclaredReservation, { kind: K }> {
  const token = records.get(key);
  if (!token || token.kind !== kind) fail("missing reserved " + kind + " " + key);
  return token as Extract<NativeDeclaredReservation, { kind: K }>;
}
export type NativeResourceDeclarationObservation =
  | { readonly key: string; readonly space: "type"; readonly definition: TypeDef }
  | { readonly key: string; readonly space: "global"; readonly header: Pick<GlobalDef, "name" | "type" | "mutable"> }
  | {
      readonly key: string;
      readonly space: "function";
      readonly name: string;
      readonly signature: PhysicalFunctionSignature;
    };

/** Descriptive comparison only: the caller authenticates inventory and reads actual module signatures. */
export function compareNativeResourceDeclarationShape(
  tx: PhysicalModuleReservations,
  declaration: NativeStringValueDeclaration,
  actual: NativeResourceDeclarationObservation,
  types: NativeDeclaredTypeTokens,
): void {
  if (actual.key !== declaration.key || actual.space !== declaration.space) fail("substituted resource key/space");
  let observed: unknown, expected: unknown;
  if (declaration.space === "type" && actual.space === "type") {
    observed = actual.definition;
    expected = instantiateNativeDeclaredType(tx, declaration.shape, types);
  } else if (declaration.space === "global" && actual.space === "global") {
    observed = actual.header;
    expected = {
      name: declaration.name,
      type: instantiateNativeDeclaredValType(tx, declaration.valueType, types),
      mutable: declaration.mutable,
    };
  } else if (declaration.space === "function" && actual.space === "function") {
    if (!actual.signature) fail("missing actual interned function signature");
    observed = { name: actual.name, signature: actual.signature };
    expected = {
      name: declaration.name,
      signature: instantiateNativeDeclaredSignature(tx, declaration.signature, types),
    };
  }
  if (preparedIrDataMismatch(observed, expected) !== undefined) fail("resource descriptor/signature mismatch");
}
