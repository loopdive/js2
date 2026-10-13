// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "../../../ir/core/types.js";
import type { NativeVectorElement, NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import { VECTOR_CALLABLE_DECLARATION } from "../../../ir/runtime/vector-callables.js";
import { irCallableBindingKey } from "../../../ir/core/callable-bindings.js";
import { preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
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

import { NUMERIC_APPEND_DECLARATION } from "../../../ir/runtime/numeric-vector-callables.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import {
  describeGcNumericVectorAppend,
  buildGcNumericVectorAppendBody,
} from "../../../wasm/physical/gc-vector-append.js";

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
  { transaction: PhysicalModuleReservations; plan: NativeVectorResourcePlan; snapshot: NativeVectorResourcePlan }
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
  typeOwners.set(result, { transaction, plan, snapshot: structuredClone(plan) });
  return result;
}

/** Read-only producer/ledger check before another owner uses these physical carriers. */
export function requireNativeVectorTypeReservations(
  transaction: PhysicalModuleReservations,
  types: NativeVectorTypeReservations,
  expectedPlan: NativeVectorResourcePlan,
): NativeVectorTypeReservations {
  const owner = typeOwners.get(types);
  if (!owner || owner.plan !== expectedPlan) fail("foreign or substituted vector plan");
  validateTypes(types, transaction);
  equal(owner.plan, owner.snapshot, "stale vector resource plan");
  for (const token of [types.base, ...types.layouts.flatMap((row) => [row.array, row.carrier])]) {
    if (!token) continue;
    if (transaction.state === "reserving") transaction.assertTypeReservation(token);
    else if (transaction.physicalIndex(token) !== token.typeIndex) fail("changed vector type coordinate");
  }
  return types;
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

/** Opaque in-process identity; numeric append never borrows the externref helper. */
export interface NativeNumericAppendReservation {
  readonly kind: "native-numeric-append";
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly plan: NativeVectorResourcePlan;
  readonly snapshot: NativeVectorResourcePlan;
  readonly types: NativeVectorTypeReservations;
  readonly fn: FunctionReservation;
  readonly assertEmissionActive: () => void;
  state: "reserved" | "filled" | "complete" | "failed";
}
const owners = new WeakMap<NativeNumericAppendReservation, Owner>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `numeric append resources: ${detail}`);
}
function layout(tx: PhysicalModuleReservations, plan: NativeVectorResourcePlan, types: NativeVectorTypeReservations) {
  requireNativeVectorTypeReservations(tx, types, plan);
  const row = types.layouts.find((item) => item.element === "f64");
  if (!row) invalid("missing original f64 carrier/backing reservations");
  return row;
}
export function reserveNativeNumericAppend(
  tx: PhysicalModuleReservations,
  plan: NativeVectorResourcePlan,
  types: NativeVectorTypeReservations,
  assertEmissionActive: () => void,
): NativeNumericAppendReservation | undefined {
  assertEmissionActive();
  if (!plan.numericAppendHelper) return undefined;
  if (tx.state !== "reserving") invalid("append must reserve before freeze");
  const binding = plan.numericAppendHelper;
  if (
    binding.referenceKey !== irCallableBindingKey(NUMERIC_APPEND_DECLARATION.ref.binding) ||
    binding.name !== NUMERIC_APPEND_DECLARATION.ref.name ||
    !plan.demands.some((owner) => owner.uses.some((use) => use.feature === NUMERIC_APPEND_DECLARATION.feature))
  )
    invalid("noncanonical numeric append demand/binding");
  const row = layout(tx, plan, types);
  const recipe = describeGcNumericVectorAppend(row.carrier.typeIndex, row.array.typeIndex);
  const fn = tx.reserveFunction(binding.bindingId, binding.name, recipe);
  const result = Object.freeze({ kind: "native-numeric-append" as const });
  owners.set(result, { tx, plan, snapshot: structuredClone(plan), types, fn, assertEmissionActive, state: "reserved" });
  return result;
}
function use<T>(
  tx: PhysicalModuleReservations,
  resource: NativeNumericAppendReservation,
  action: (owner: Owner) => T,
): T {
  const owner = owners.get(resource);
  if (!owner) invalid("unknown append reservation");
  try {
    if (owner.tx !== tx || owner.state === "failed") invalid("foreign or failed append reservation");
    owner.assertEmissionActive();
    if (tx.state !== "filling") invalid("append use requires frozen reservation space");
    if (preparedIrDataMismatch(owner.plan, owner.snapshot) !== undefined) invalid("stale append plan");
    layout(tx, owner.plan, owner.types);
    tx.physicalIndex(owner.fn);
    return action(owner);
  } catch (error) {
    owner.state = "failed";
    throw error;
  }
}
/** Read the actual owned token, never a caller-supplied function/type coordinate. */
export function nativeNumericAppendFunction(
  tx: PhysicalModuleReservations,
  resource: NativeNumericAppendReservation,
): FunctionReservation {
  return use(tx, resource, (owner) => owner.fn);
}
export function fillNativeNumericAppend(
  tx: PhysicalModuleReservations,
  resource: NativeNumericAppendReservation,
): void {
  use(tx, resource, (owner) => {
    if (owner.state !== "reserved") invalid("duplicate append fill");
    const row = layout(tx, owner.plan, owner.types);
    const recipe = describeGcNumericVectorAppend(row.carrier.typeIndex, row.array.typeIndex);
    tx.fillFunction(owner.fn, {
      locals: recipe.locals,
      body: buildGcNumericVectorAppendBody(row.carrier.typeIndex, row.array.typeIndex),
    });
    tx.assertCompletedReservation(owner.fn);
    owner.state = "filled";
  });
}
export function requireCompletedNativeNumericAppend(
  tx: PhysicalModuleReservations,
  resource: NativeNumericAppendReservation,
): void {
  use(tx, resource, (owner) => {
    if (owner.state !== "filled" && owner.state !== "complete") invalid("append body is incomplete");
    tx.assertCompletedReservation(owner.fn);
    owner.state = "complete";
  });
}
