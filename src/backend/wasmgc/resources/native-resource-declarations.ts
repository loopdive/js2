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
  NativeDeclaredName,
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
  self?: { readonly key: string; readonly typeIndex: number },
): TypeDef {
  const name = (value: NativeDeclaredName): string => {
    if (typeof value === "string") return value;
    if (value.kind === "array-ref-index") return `__arr_ref_${typeIndex(tx, types, value.typeKey)}`;
    if (value.kind !== "builtin-function-metadata-index") fail("invalid indexed name");
    const index = self?.key === value.typeKey ? self.typeIndex : typeIndex(tx, types, value.typeKey);
    if (!Number.isSafeInteger(index) || index < 0) fail("invalid self coordinate");
    return `__builtinfn_meta_${index}_struct`;
  };
  if (shape.kind === "array")
    return {
      kind: "array",
      name: name(shape.name),
      element: instantiateNativeDeclaredValType(tx, shape.element, types),
      mutable: shape.mutable,
    };
  if (shape.kind !== "struct") fail("unsupported declaration shape");
  const { parent, fields, ...rest } = shape;
  return {
    ...rest,
    name: name(shape.name),
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

/** Validate the complete symbolic operation population without a module or ledger. */
export function preflightNativeResourceRecipe(
  recipe: NativeResourceRecipe,
  prerequisiteKeys: readonly string[] = [],
): void {
  const types = new Set<string>();
  dense(prerequisiteKeys, "prerequisites", (key) => {
    if (typeof key !== "string" || !key || types.has(key)) fail("invalid prerequisite key");
    types.add(key);
  });
  const declarations = new Map<string, NativeStringValueDeclaration>();
  dense(recipe.declarations, "declarations", (row) => {
    if (!row.key || declarations.has(row.key) || types.has(row.key)) fail("duplicate declaration key");
    if (!Array.isArray(row.role) || !row.role.length) fail("invalid structural role");
    dense(row.role, "roles", (part) => {
      if (typeof part !== "string") fail("invalid structural role");
    });
    declarations.set(row.key, row);
  });
  const available = new Set(types),
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
  const signatureKeys = new Set<string>();
  dense(recipe.reservationSteps, "reservation steps", (step) => {
    if (step.phase !== "string-types" && step.phase !== "resources") fail("invalid reservation phase");
    if (step.phase === "resources") resourcePhase = true;
    else if (resourcePhase) fail("reordered string type phase");
    if (step.kind === "intern-signature") {
      if (Object.hasOwn(step, "key")) {
        if (
          typeof step.key !== "string" ||
          !step.key ||
          signatureKeys.has(step.key) ||
          declarations.has(step.key) ||
          types.has(step.key)
        )
          fail("invalid signature observation key");
        signatureKeys.add(step.key);
      }
      if (Object.hasOwn(step, "name") && typeof step.name !== "string") fail("invalid signature name");
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
        if (
          typeof shape.name !== "string" &&
          (shape.name?.kind !== "builtin-function-metadata-index" || shape.name.typeKey !== row.key)
        )
          fail("invalid symbolic struct name");
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
}

/** Both public execution APIs share these exact reservation/interner operations. */
export function executeNativeResourceRecipeWithSignatures(
  tx: PhysicalModuleReservations,
  recipe: NativeResourceRecipe,
  prerequisites: NativeDeclaredTypeTokens = new Map(),
): {
  readonly reservations: ReadonlyMap<string, NativeDeclaredReservation>;
  readonly signatures: ReadonlyMap<string, number>;
} {
  preflightNativeResourceRecipe(recipe, [...prerequisites.keys()]);
  // Only the closure producer has an authenticated append frontier for its
  // self-named metadata subtype. Refuse before executing any generic step.
  for (const row of recipe.declarations) {
    if (row.space === "type" && row.shape.kind === "struct" && typeof row.shape.name !== "string")
      fail("self-indexed metadata requires the closure reservation cursor");
  }
  const types = new Map(prerequisites);
  for (const [key, token] of types) {
    if (token.key !== key) fail("substituted prerequisite key");
    tx.assertTypeReservation(token);
  }
  const declarations = new Map(recipe.declarations.map((row) => [row.key, row]));
  const signatures = new Map<string, number>();
  const result = new Map<string, NativeDeclaredReservation>();
  for (const step of recipe.reservationSteps) {
    if (step.kind === "intern-signature") {
      const sig = instantiateNativeDeclaredSignature(tx, step.signature, types);
      const index =
        step.name === undefined
          ? tx.internFunctionType(sig.params, sig.results)
          : tx.internFunctionType(sig.params, sig.results, step.name);
      if (step.key !== undefined) signatures.set(step.key, index);
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
  return { reservations: result, signatures };
}

export function executeNativeResourceRecipe(
  tx: PhysicalModuleReservations,
  recipe: NativeResourceRecipe,
  prerequisites: NativeDeclaredTypeTokens = new Map(),
): ReadonlyMap<string, NativeDeclaredReservation> {
  return executeNativeResourceRecipeWithSignatures(tx, recipe, prerequisites).reservations;
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
