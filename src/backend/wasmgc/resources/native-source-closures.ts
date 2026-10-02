// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClosureSignature, IrType } from "../../../ir/core/types.js";
import type { IrClosureLowering } from "../../../runtime/wasmgc/values/closure-layouts.js";
import { preparedIrTypeKey } from "../../../ir/program/abi-signatures.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "../../../ir/program/native-source-closure-requirements.js";
import type { NativeVectorResourcePlan } from "../../../ir/program/native-vector-resources.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { createClosureCaptureType } from "../../../runtime/wasmgc/values/closure-capture-layouts.js";
import { CLOSURE_CAPTURE_FIELD_BASE } from "../../../runtime/wasmgc/values/closure-layouts.js";
import {
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  nativeClosureReservationInventory,
  reserveNativeClosureResources,
  type NativeClosureDeclarationPlan,
  type NativeClosureReservations,
} from "./native-closures.js";
import {
  nativeVectorPhysicalType,
  requireNativeVectorTypeReservations,
  type NativeVectorTypeReservations,
} from "./native-vectors.js";
import { requireNativeStringLiteralTypes, type NativeStringLiteralTypeReservations } from "./native-string-literals.js";
import type { NativeDeclaredValType } from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import { requireNativeRefCells, resolveNativeRefCell, type NativeRefCellReservations } from "./native-ref-cells.js";
import { nativeRefCellScalarInner } from "../../../ir/program/native-ref-cell-requirements.js";
import type { AllocSiteId } from "../../../ir/core/nodes.js";
import {
  requireNativeBuiltinFunctionRequestIssuer,
  type NativeBuiltinFunctionRequestIssuer,
} from "./native-builtin-function-requests.js";
import { createRealmSourceClosureType } from "../../../runtime/wasmgc/values/realm-object-layouts.js";
import {
  requireNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
  type NativeRealmObjectLayoutReservations,
} from "./native-realm-object-layouts.js";

/** A future mixed dispatcher may exclude metadata only while these actual fields are disjoint. */
function requireSourceMetadataSeparation(type: TypeReservation): void {
  const shape = type.object;
  if (shape.kind !== "struct" || shape.fields.slice(CLOSURE_CAPTURE_FIELD_BASE).some((field) => field.mutable))
    fail("source capture layout may overlap the mutable builtin metadata family");
}

export interface NativeSourceClosureCarriers {
  readonly realmState?: NativeRealmObjectLayoutReservations;
  readonly refCells?: NativeRefCellReservations;
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly strings?: {
    readonly types: NativeStringLiteralTypeReservations;
    readonly key: string;
    readonly utf8Storage: boolean;
  };
}
export interface NativeSourceClosureTypes {
  readonly requirements: NativeSourceClosureRequirements;
  readonly closures: NativeClosureReservations;
  readonly closurePlan: NativeClosureDeclarationPlan;
  readonly shapes: readonly {
    readonly id: string;
    readonly type: TypeReservation;
    readonly lowering: IrClosureLowering;
  }[];
}
export interface NativeSourceClosureSharedCarriers {
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly strings: NonNullable<NativeSourceClosureCarriers["strings"]>;
}
function expectedData(input: unknown, roles: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    fail("expected shared carriers must be plain data");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== roles.length || roles.some((role) => !Object.hasOwn(fields, role)))
    fail("unexpected shared carrier roles");
  for (const role of roles)
    if (!Object.hasOwn(fields[role]!, "value") || !fields[role]!.enumerable)
      fail("hidden or accessor shared carrier role");
  return Object.fromEntries(roles.map((role) => [role, fields[role]!.value]));
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly carriers: NativeSourceClosureCarriers;
  readonly refCells: NativeRefCellReservations | undefined;
  readonly vectors: NativeVectorTypeReservations;
  readonly vectorPlan: NativeVectorResourcePlan;
  readonly strings: NativeSourceClosureCarriers["strings"];
  readonly stringTypes: NativeStringLiteralTypeReservations | undefined;
  readonly builtins: NativeBuiltinFunctionRequestIssuer | undefined;
  readonly realmState: NativeRealmObjectLayoutReservations | undefined;
  readonly shapeTypes: readonly {
    readonly id: string;
    readonly captures: readonly ValType[];
    readonly key: string;
    readonly name: string;
  }[];
}
const owners = new WeakMap<NativeSourceClosureTypes, Owner>();
function fail(detail: string): never {
  throw new Error(`native source closures: ${detail}`);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) fail(detail);
}
function realmStateCarrier(tx: PhysicalModuleReservations, carriers: NativeSourceClosureCarriers) {
  const field = Object.getOwnPropertyDescriptor(carriers, "realmState");
  if (!field) {
    if ("realmState" in carriers) fail("inherited realm state carrier");
    return undefined;
  }
  if (!Object.hasOwn(field, "value") || !field.enumerable || field.value === undefined)
    fail("realm state carrier requires an issued own data value");
  return requireNativeRealmObjectLayouts(tx, field.value);
}
function authenticateCarriers(
  tx: PhysicalModuleReservations,
  carriers: NativeSourceClosureCarriers,
  requirements: NativeSourceClosureRequirements,
): void {
  realmStateCarrier(tx, carriers);
  if (carriers.refCells) requireNativeRefCells(tx, carriers.refCells, requirements);
  else if (requirements.refCells.length) fail("mutable capture has no issued ref-cell type owner");
  requireNativeVectorTypeReservations(tx, carriers.vectors, carriers.vectorPlan);
  if (carriers.strings)
    requireNativeStringLiteralTypes(tx, carriers.strings.types, carriers.strings.key, carriers.strings.utf8Storage);
}
function carrierValue(tx: PhysicalModuleReservations, carriers: NativeSourceClosureCarriers, type: IrType): ValType {
  if (type.kind === "boxed") {
    const inner = nativeRefCellScalarInner(type);
    const cell = inner && carriers.refCells && resolveNativeRefCell(tx, carriers.refCells, inner);
    if (!cell) fail("mutable capture has no exact issued ref-cell type");
    return { kind: "ref", typeIdx: cell.typeIdx };
  }
  if (type.kind === "extern" || type.kind === "callable") return { kind: "externref" };
  if (type.kind === "string") {
    if (!carriers.strings) fail("logical string has no issued string type owner");
    return { kind: "ref", typeIdx: carriers.strings.types.layout.anyStrTypeIdx };
  }
  if (type.kind === "val" && !type.typeRef && type.val.kind !== "ref" && type.val.kind !== "ref_null")
    return structuredClone(type.val);
  const value = type.kind === "vec" ? nativeVectorPhysicalType(carriers.vectors, type) : undefined;
  if (!value) fail(`${type.kind} needs its actual native carrier owner`);
  return structuredClone(value);
}
function physicalPlan(
  tx: PhysicalModuleReservations,
  requirements: NativeSourceClosureRequirements,
  carriers: NativeSourceClosureCarriers,
  builtins?: NativeBuiltinFunctionRequestIssuer,
) {
  if (requirements.gaps.length) fail(requirements.gaps.map((row) => `${row.unitId}: ${row.detail}`).join("; "));
  const available = new Map<number, TypeReservation>(
    [
      ...(carriers.strings?.types.types ?? []),
      ...(carriers.refCells?.types.map((row) => row.type) ?? []),
      ...carriers.vectors.layouts.flatMap((row) => [row.array, row.carrier]),
    ].map((token) => [token.typeIndex, token]),
  );
  const references = new Map<string, TypeReservation>();
  const declared = (type: IrType): NativeDeclaredValType => {
    const value = carrierValue(tx, carriers, type);
    if (value.kind !== "ref" && value.kind !== "ref_null") return value;
    const token = available.get(value.typeIdx);
    if (!token) fail("physical reference is not an issued prerequisite");
    references.set(token.key, token);
    return { kind: value.kind, typeKey: token.key };
  };
  const requests = requirements.signatures.map((row) => ({
    kind: "signature" as const,
    id: row.id,
    allocationMode: "ordinary" as const,
    params: row.signature.params.map(declared),
    results: row.signature.returnType ? [declared(row.signature.returnType)] : [],
    minimumArgumentCount: row.signature.defaultParamStart ?? row.signature.params.length,
  }));
  if (builtins !== undefined) {
    requireNativeBuiltinFunctionRequestIssuer(tx, builtins);
    for (const token of builtins.referenceTypes) {
      const existing = references.get(token.key);
      if (existing && existing !== token) fail("conflicting builtin reference token");
      references.set(token.key, token);
    }
  }
  const closurePlan = declareNativeClosureResources({
    key: requirements.key,
    startingClosureCounter: 0,
    requests: builtins ? [...requests, ...builtins.requests] : requests,
    referenceTypeKeys: [...references.keys()],
  });
  const shapeTypes = requirements.shapes.map((shape) => ({
    id: shape.id,
    key: `${requirements.key}:capture:${shape.id}`,
    name: `${requirements.key}:${shape.id}`,
    captures: shape.captures.map((type) => carrierValue(tx, carriers, type)),
  }));
  return { closurePlan, references, shapeTypes };
}

/** Only types are allocated here. Unit functions remain the consumer's single slot population. */
export function reserveNativeSourceClosureTypes(
  tx: PhysicalModuleReservations,
  requirements: NativeSourceClosureRequirements,
  carriers: NativeSourceClosureCarriers,
  builtins?: NativeBuiltinFunctionRequestIssuer,
): NativeSourceClosureTypes {
  assertNativeSourceClosureRequirementsCurrent(requirements);
  authenticateCarriers(tx, carriers, requirements);
  const realmState = realmStateCarrier(tx, carriers);
  const { closurePlan, references, shapeTypes } = physicalPlan(tx, requirements, carriers, builtins);
  // Check the complete connected allocation before consuming any wrapper/capture prefix.
  tx.assertReservationKeysAvailable([
    ...closurePlan.declarations.map((row) => row.key),
    ...shapeTypes.filter((row) => row.captures.length || realmState).map((row) => row.key),
  ]);
  const closures = reserveNativeClosureResources(
    tx,
    instantiateNativeClosureRequirements(tx, closurePlan, references),
    closurePlan,
  );
  const shapes = requirements.shapes.map((shape, index) => {
    const description = shapeTypes[index]!;
    const base = closures.signatures.find((row) => row.id === shape.signatureId)?.binding;
    if (!base) fail("missing declared wrapper");
    const type =
      description.captures.length || realmState
        ? tx.reserveType(
            description.key,
            realmState
              ? createRealmSourceClosureType(
                  description.name,
                  base.type.typeIndex,
                  structuredClone([...description.captures]),
                  realmState.types.state.typeIndex,
                )
              : createClosureCaptureType(
                  description.name,
                  base.type.typeIndex,
                  structuredClone([...description.captures]),
                ),
          )
        : base.type;
    const lowering: IrClosureLowering = Object.freeze({
      structTypeIdx: type.typeIndex,
      funcFieldIdx: 0,
      funcTypeIdx: base.liftedFuncTypeIndex,
      ...(realmState ? { realmStateInitializer: realmState.sourceInitializer.handle } : {}),
      capFieldIdx: (capture: number): number => {
        if (!Number.isSafeInteger(capture) || capture < 0 || capture >= shape.captures.length)
          return fail("capture coordinate is outside the actual shape");
        return capture + CLOSURE_CAPTURE_FIELD_BASE;
      },
    });
    if (builtins) requireSourceMetadataSeparation(type);
    return Object.freeze({ id: shape.id, type, lowering });
  });
  const pack = Object.freeze({ requirements, closures, closurePlan, shapes: Object.freeze(shapes) });
  owners.set(pack, {
    tx,
    carriers,
    refCells: carriers.refCells,
    vectors: carriers.vectors,
    vectorPlan: carriers.vectorPlan,
    strings: carriers.strings,
    stringTypes: carriers.strings?.types,
    builtins,
    realmState,
    shapeTypes: structuredClone(shapeTypes),
  });
  return pack;
}

export function requireNativeSourceClosureTypes(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureTypes,
  expectedRequirements: NativeSourceClosureRequirements,
  expectedBuiltinRequests?: NativeBuiltinFunctionRequestIssuer,
  expectedSharedCarriers?: NativeSourceClosureSharedCarriers,
): NativeSourceClosureTypes {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || pack.requirements !== expectedRequirements)
    fail("foreign or copied source type owner");
  if (expectedBuiltinRequests !== undefined) {
    requireNativeBuiltinFunctionRequestIssuer(tx, expectedBuiltinRequests);
    if (owner.builtins !== expectedBuiltinRequests) fail("foreign builtin request issuer");
  }
  if (expectedSharedCarriers !== undefined) {
    const expected = expectedData(expectedSharedCarriers, ["vectors", "vectorPlan", "strings"]),
      strings = expectedData(expected.strings, ["types", "key", "utf8Storage"]);
    if (
      owner.vectors !== expected.vectors ||
      owner.vectorPlan !== expected.vectorPlan ||
      owner.stringTypes !== strings.types ||
      owner.strings?.key !== strings.key ||
      owner.strings?.utf8Storage !== strings.utf8Storage
    )
      fail("foreign shared source carriers");
  }
  assertNativeSourceClosureRequirementsCurrent(expectedRequirements);
  if (realmStateCarrier(tx, owner.carriers) !== owner.realmState) fail("changed realm state carrier identity");
  if (
    owner.carriers.refCells !== owner.refCells ||
    owner.carriers.vectors !== owner.vectors ||
    owner.carriers.vectorPlan !== owner.vectorPlan ||
    owner.carriers.strings !== owner.strings ||
    owner.carriers.strings?.types !== owner.stringTypes
  )
    fail("changed physical carrier identities");
  authenticateCarriers(tx, owner.carriers, expectedRequirements);
  nativeClosureReservationInventory(tx, pack.closures, pack.closurePlan);
  const fresh = physicalPlan(tx, expectedRequirements, owner.carriers, owner.builtins);
  same(fresh.closurePlan, pack.closurePlan, "changed source signature plan");
  same(fresh.shapeTypes, owner.shapeTypes, "changed capture plan");
  for (const [index, row] of pack.shapes.entries()) {
    const shape = expectedRequirements.shapes[index]!,
      description = owner.shapeTypes[index]!;
    const base = pack.closures.signatures.find((entry) => entry.id === shape.signatureId)?.binding;
    if (!base || shape.id !== row.id) fail("changed capture binding");
    if (tx.state === "reserving") tx.assertTypeReservation(row.type);
    else if (tx.physicalIndex(row.type) !== row.type.typeIndex) fail("changed capture coordinate");
    if (shape.captures.length || owner.realmState)
      same(
        row.type.object,
        owner.realmState
          ? createRealmSourceClosureType(
              description.name,
              base.type.typeIndex,
              structuredClone([...description.captures]),
              owner.realmState.types.state.typeIndex,
            )
          : createClosureCaptureType(description.name, base.type.typeIndex, structuredClone([...description.captures])),
        "changed capture layout",
      );
    else if (row.type !== base.type) fail("zero-capture shape is not its actual wrapper");
    if (row.lowering.realmStateInitializer !== owner.realmState?.sourceInitializer.handle)
      fail("changed realm state initializer binding");
    if (owner.builtins) requireSourceMetadataSeparation(row.type);
  }
  return pack;
}

export function resolveNativeSourceClosure(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureTypes,
  signature: IrClosureSignature,
): IrClosureLowering | null {
  requireNativeSourceClosureTypes(tx, pack, pack.requirements);
  const key = preparedIrTypeKey({ kind: "closure", signature });
  const row = pack.requirements.signatures.find(
    (row) => preparedIrTypeKey({ kind: "closure", signature: row.signature }) === key,
  );
  const binding = row && pack.closures.signatures.find((entry) => entry.id === row.id)?.binding;
  if (!binding) return null;
  return {
    structTypeIdx: binding.type.typeIndex,
    funcFieldIdx: 0,
    funcTypeIdx: binding.liftedFuncTypeIndex,
    capFieldIdx: () => fail("signature wrapper has no captures"),
  };
}

/** Emitting a stateful source allocation also requires its exact canonical initializer. */
export function requireCompletedNativeSourceClosureState(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureTypes,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied source type owner");
  // No extra currentness walk on the unchanged stateless completion path.
  // Its caller already authenticates the source owner; there is no initializer to complete.
  if (owner.realmState) {
    requireNativeSourceClosureTypes(tx, pack, pack.requirements);
    requireCompletedNativeRealmObjectLayouts(tx, owner.realmState);
  }
}

/** Exact retained state owner after full source/carrier authentication, never a structural guess. */
export function nativeSourceClosureRealmState(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureTypes,
): NativeRealmObjectLayoutReservations | undefined {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied source type owner");
  requireNativeSourceClosureTypes(tx, pack, pack.requirements);
  return owner.realmState;
}

export function resolveNativeSourceClosureShape(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureTypes,
  signature: IrClosureSignature,
  captures: readonly IrType[],
): NativeSourceClosureTypes["shapes"][number] | undefined {
  requireNativeSourceClosureTypes(tx, pack, pack.requirements);
  const key = preparedIrTypeKey({ kind: "closure", signature });
  const row = pack.requirements.shapes.find((shape) => {
    const logical = pack.requirements.signatures.find((entry) => entry.id === shape.signatureId);
    return (
      logical &&
      preparedIrTypeKey({ kind: "closure", signature: logical.signature }) === key &&
      preparedIrDataMismatch(shape.captures, captures) === undefined
    );
  });
  return row && pack.shapes.find((shape) => shape.id === row.id);
}

/** The cell resolver is backed by the same issued carrier pack used for capture fields. */
export function resolveNativeSourceRefCell(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureTypes,
  inner: ValType,
  allocation?: AllocSiteId,
): { readonly typeIdx: number; readonly fieldIdx: 0 } | null {
  requireNativeSourceClosureTypes(tx, pack, pack.requirements);
  const cells = owners.get(pack)!.refCells;
  return cells ? resolveNativeRefCell(tx, cells, inner, allocation) : null;
}
