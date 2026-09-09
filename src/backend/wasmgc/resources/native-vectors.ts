// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "../../../ir/core/types.js";
import type { NativeVectorElement, NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import { VECTOR_CALLABLE_DECLARATION } from "../../../ir/runtime/vector-callables.js";
import { irCallableBindingKey } from "../../../ir/core/callable-bindings.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import {
  type PhysicalModuleReservations,
  type PhysicalFunctionSignature,
  type TypeReservation,
  type FunctionReservation,
  type TagReservation,
  type TagImportReservation,
} from "../../../wasm/physical/module-reservations.js";
import {
  buildVectorGrowStoreBody,
  createVectorBaseType,
  createVectorBackingArrayType,
  createVectorCarrierType,
} from "../../../runtime/wasmgc/values/vector-grow-store.js";

export interface NativeVectorLayout {
  readonly vecStructTypeIdx: number;
  readonly arrayTypeIdx: number;
  readonly elementValType: ValType;
  // Deliberately no valueType: each logical use owns its nullability.
}
export interface NativeVectorReservedLayout {
  readonly element: NativeVectorElement;
  readonly array: TypeReservation;
  readonly carrier: TypeReservation;
  readonly layout: NativeVectorLayout;
}
export interface NativeVectorTypeReservations {
  readonly base?: TypeReservation;
  readonly layouts: readonly NativeVectorReservedLayout[];
}
export interface NativeVectorHelperReservation {
  readonly function: FunctionReservation;
}

// Provenance/completion checks only; physical allocation and resource identity remain
// exclusively owned by the caller's PhysicalModuleReservations transaction.
const typeOwners = new WeakMap<
  NativeVectorTypeReservations,
  { transaction: PhysicalModuleReservations; plan: NativeVectorResourcePlan }
>();
const helperOwners = new WeakMap<
  NativeVectorHelperReservation,
  {
    transaction: PhysicalModuleReservations;
    types: NativeVectorTypeReservations;
    tag: TagReservation | TagImportReservation;
    signature: PhysicalFunctionSignature;
    tagTypeIndex: number;
  }
>();

function fail(detail: string): never {
  throw new Error(`native vector resources: ${detail}`);
}
function equal(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}
function validateTypes(types: NativeVectorTypeReservations, transaction?: PhysicalModuleReservations): void {
  const owner = typeOwners.get(types);
  if (!owner || (transaction && owner.transaction !== transaction)) fail("foreign vector type reservations");
  if (types.layouts.length === 0) {
    if (types.base) fail("unexpected vector base");
    return;
  }
  if (!types.base) fail("missing shared vector base");
  equal(types.base.object, createVectorBaseType(), "vector base descriptor mismatch");
  for (const row of types.layouts) {
    equal(
      row.array.object,
      createVectorBackingArrayType(`__arr_${row.element}`, { kind: row.element }),
      "vector backing array descriptor mismatch",
    );
    equal(
      row.carrier.object,
      createVectorCarrierType({
        name: `__vec_${row.element}`,
        baseTypeIndex: types.base.typeIndex,
        arrayTypeIndex: row.array.typeIndex,
      }),
      "vector carrier descriptor mismatch",
    );
    equal(
      row.layout,
      {
        vecStructTypeIdx: row.carrier.typeIndex,
        arrayTypeIdx: row.array.typeIndex,
        elementValType: { kind: row.element },
      },
      "vector lookup descriptor mismatch",
    );
  }
}

/** Reserve on the caller's empty-origin transaction; never adopt legacy caches. */
export function reserveNativeVectorTypes(
  transaction: PhysicalModuleReservations,
  plan: NativeVectorResourcePlan,
): NativeVectorTypeReservations {
  if (!plan.anchor) fail("missing entry-source anchor");
  equal(
    plan.layouts,
    (["f64", "externref"] as const).filter((element) => plan.layouts.includes(element)),
    "noncanonical vector layout order/population",
  );
  const key = (role: string): string => `physical:vector:${JSON.stringify(plan.anchor)}:${role}`;
  const base = plan.layouts.length ? transaction.reserveType(key("base"), createVectorBaseType()) : undefined;
  const layouts = plan.layouts.map((element): NativeVectorReservedLayout => {
    const array = transaction.reserveType(
      key(`array:${element}`),
      createVectorBackingArrayType(`__arr_${element}`, { kind: element }),
    );
    const carrier = transaction.reserveType(
      key(`carrier:${element}`),
      createVectorCarrierType({
        name: `__vec_${element}`,
        baseTypeIndex: base!.typeIndex,
        arrayTypeIndex: array.typeIndex,
      }),
    );
    return Object.freeze({
      element,
      array,
      carrier,
      layout: Object.freeze({
        vecStructTypeIdx: carrier.typeIndex,
        arrayTypeIdx: array.typeIndex,
        elementValType: Object.freeze({ kind: element }),
      }),
    });
  });
  const result = Object.freeze({ ...(base ? { base } : {}), layouts: Object.freeze(layouts) });
  typeOwners.set(result, { transaction, plan });
  return result;
}

export function resolveNativeVectorForElement(
  types: NativeVectorTypeReservations,
  element: ValType,
): NativeVectorLayout | undefined {
  validateTypes(types);
  return types.layouts.find((row) => preparedIrDataMismatch(row.layout.elementValType, element) === undefined)?.layout;
}
export function resolveNativeVector(
  types: NativeVectorTypeReservations,
  value: ValType,
): NativeVectorLayout | undefined {
  validateTypes(types);
  return value.kind === "ref" || value.kind === "ref_null"
    ? types.layouts.find((row) => row.carrier.typeIndex === value.typeIdx)?.layout
    : undefined;
}
export function nativeVectorPhysicalType(types: NativeVectorTypeReservations, type: IrType): ValType | undefined {
  validateTypes(types);
  if (type.kind === "val") return type.typeRef ? undefined : type.val;
  if (type.kind !== "vec" || type.layout || type.elementType.kind !== "val" || type.elementType.typeRef)
    return undefined;
  const layout = resolveNativeVectorForElement(types, type.elementType.val);
  return layout ? { kind: type.nullable ? "ref_null" : "ref", typeIdx: layout.vecStructTypeIdx } : undefined;
}
export function nativeVectorPhysicalSignature(
  types: NativeVectorTypeReservations,
  signature: { readonly params: readonly IrType[]; readonly results: readonly IrType[] },
): PhysicalFunctionSignature | undefined {
  const params = signature.params.map((type) => nativeVectorPhysicalType(types, type));
  const results = signature.results.map((type) => nativeVectorPhysicalType(types, type));
  return params.every((type): type is ValType => type !== undefined) &&
    results.every((type): type is ValType => type !== undefined)
    ? { params, results }
    : undefined;
}

/** Call after imports and original unit functions, before startup support/freeze. */
export function reserveNativeVectorHelper(
  transaction: PhysicalModuleReservations,
  plan: NativeVectorResourcePlan,
  types: NativeVectorTypeReservations,
  tag: TagReservation | TagImportReservation | undefined,
): NativeVectorHelperReservation | undefined {
  validateTypes(types, transaction);
  equal(typeOwners.get(types)!.plan, plan, "vector plan changed between reservations");
  if (!plan.helper) return undefined;
  if (!plan.exceptionRequired || !tag) fail("vector helper requires the reserved exception tag");
  const declaration = VECTOR_CALLABLE_DECLARATION;
  if (
    plan.helper.referenceKey !== irCallableBindingKey(declaration.ref.binding) ||
    plan.helper.name !== declaration.ref.name
  )
    fail("noncanonical vector helper binding");
  const signature = nativeVectorPhysicalSignature(types, declaration);
  if (!signature) fail("vector helper signature lacks its exact carrier");
  const tagTypeIndex = transaction.internFunctionType([{ kind: "externref" }], []);
  if (tag.kind === "tag")
    equal(tag.object, { name: "__exn", typeIdx: tagTypeIndex }, "exception tag descriptor mismatch");
  else
    equal(
      tag.object,
      { module: "env", name: "__exn", desc: { kind: "tag", typeIdx: tagTypeIndex } },
      "shared exception tag descriptor mismatch",
    );
  const fn = transaction.reserveFunction(plan.helper.bindingId, plan.helper.name, signature);
  const result = Object.freeze({ function: fn });
  helperOwners.set(result, { transaction, types, tag, signature, tagTypeIndex });
  return result;
}

/** Fill exactly the reserved helper after the caller freezes; never freeze or seal here. */
export function fillNativeVectorHelper(
  transaction: PhysicalModuleReservations,
  helper: NativeVectorHelperReservation,
): void {
  const owner = helperOwners.get(helper);
  if (!owner || owner.transaction !== transaction) fail("foreign vector helper reservation");
  validateTypes(owner.types, transaction);
  for (const token of [owner.types.base!, ...owner.types.layouts.flatMap((row) => [row.array, row.carrier])])
    if (transaction.physicalIndex(token) !== token.typeIndex) fail("vector type coordinate mismatch");
  transaction.physicalIndex(helper.function);
  const tagIndex = transaction.physicalIndex(owner.tag);
  const layout = resolveNativeVectorForElement(owner.types, { kind: "externref" });
  if (!layout) fail("missing externref vector carrier");
  transaction.fillFunction(
    helper.function,
    buildVectorGrowStoreBody({
      carrierTypeIndex: layout.vecStructTypeIdx,
      arrayTypeIndex: layout.arrayTypeIdx,
      exceptionTagIndex: tagIndex,
      gapFill: { kind: "default" },
    }),
  );
}
