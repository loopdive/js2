// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { NativeInvocationRequirements } from "./program/native-invocation-requirements.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  planNativeSourceClosureRequirements,
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./program/native-source-closure-requirements.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./program/prepared-contracts.js";
import type { IrFunction, IrType } from "./core/nodes.js";
import { nativeRefCellScalarInner } from "./program/native-ref-cell-requirements.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import { irUnitCallableBindingId } from "./core/callable-bindings.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import {
  reserveNativeSourceClosureTypes,
  requireNativeSourceClosureTypes,
  resolveNativeSourceClosure,
  resolveNativeSourceClosureShape,
  resolveNativeSourceRefCell,
  type NativeSourceClosureTypes,
  type NativeSourceClosureCarriers,
} from "../backend/wasmgc/resources/native-source-closures.js";
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  PhysicalFunctionSignature,
} from "../wasm/physical/module-reservations.js";
import { sameValTypes } from "../wasm/physical/function-types.js";
import {
  bindNativeSourceClosureCallables,
  requireNativeSourceClosureCallables,
  type NativeSourceClosureCallables,
} from "../backend/wasmgc/resources/native-source-closure-callables.js";
import type { Instr, ValType } from "../wasm/model/instructions.js";
import { lowerIrFunctionBody } from "./lower-generic.js";
import { wasmValueTypeConverter } from "./backend/wasm-lowering.js";
import type { IrLowerResolver } from "./backend/lower-contracts.js";
import { WasmGcEmitter } from "./backend/wasmgc-emitter.js";
import { LinearEmitter } from "./backend/linear-emitter.js";
import type { IrBackendKind } from "./backend/legality.js";
import type { NativeBuiltinFunctionRequests } from "../backend/wasmgc/resources/native-builtin-function-requests.js";

export interface NativeSourceClosureEmission {
  readonly requirements: NativeSourceClosureRequirements;
  readonly types: NativeSourceClosureTypes;
}
interface SourceOwner {
  readonly tx: PhysicalModuleReservations;
  readonly units: Map<IrUnitId, { readonly fn: IrFunction; readonly slot: FunctionReservation }>;
  readonly completed: Set<IrUnitId>;
  callables?: NativeSourceClosureCallables;
  bound: boolean;
  readonly builtins: NativeBuiltinFunctionRequests | undefined;
}
const owners = new WeakMap<NativeSourceClosureEmission, SourceOwner>();
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native source invocation: ${detail}`);
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeSourceClosureEmission): SourceOwner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied source association");
  assertPreparedIrProgram(pack.requirements.demands.program);
  assertNativeSourceClosureRequirementsCurrent(pack.requirements);
  requireNativeSourceClosureTypes(tx, pack.types, pack.requirements);
  return owner;
}

export function prepareNativeSourceClosureInput(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeSourceClosureRequirements | undefined {
  assertPreparedIrProgram(program);
  if (!program.runtime.includes(projection)) fail("unselected runtime projection");
  return planNativeSourceClosureRequirements(program, projection);
}

export function beginNativeSourceClosureEmission(
  tx: PhysicalModuleReservations,
  requirements: NativeSourceClosureRequirements,
  carriers: NativeSourceClosureCarriers,
  builtins?: NativeBuiltinFunctionRequests,
): NativeSourceClosureEmission {
  assertPreparedIrProgram(requirements.demands.program);
  assertNativeSourceClosureRequirementsCurrent(requirements);
  const types = reserveNativeSourceClosureTypes(tx, requirements, carriers, builtins);
  const pack = Object.freeze({ requirements, types });
  owners.set(pack, { tx, units: new Map(), completed: new Set(), bound: false, builtins });
  return pack;
}

/** Bind only after the existing consumer loop has allocated and frozen all unit slots. */
export function bindNativeSourceClosureUnits(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.bound || tx.state !== "filling") fail("source slots require one frozen binding operation");
  const prepared = pack.requirements.demands.projection.prepared.functions;
  const rows = pack.requirements.units.map((unit) => {
    const fn = prepared.find((candidate) => candidate.unitId === unit.unitId);
    const slot = slots.get(unit.unitId);
    if (!fn || !slot || slot.key !== irUnitCallableBindingId(unit.unitId))
      fail("source unit has no exact original ABI slot");
    tx.physicalIndex(slot);
    if (fn.asyncPlan || fn.asyncRuntime) fail("async closure body has no native canonical frame completion owner");
    const shape = pack.types.shapes.find((candidate) => candidate.id === unit.shapeId);
    if (!shape || !fn.closureSubtype) fail("source unit has no exact capture shape");
    const resolved = resolveNativeSourceClosureShape(
      tx,
      pack.types,
      fn.closureSubtype.signature,
      fn.closureSubtype.captureFieldTypes,
    );
    if (resolved !== shape) fail("source slot capture metadata differs from its actual type owner");
    // The lifted signature already exists in the sole canonical wrapper owner.
    if (slot.object.typeIdx !== shape.lowering.funcTypeIdx) fail("source slot does not use its exact lifted signature");
    return { unitId: unit.unitId, fn, slot };
  });
  const referencedSlots = [...new Set(pack.requirements.allocations.map((row) => row.liftedUnitId))].map((id) => {
    const row = rows.find((candidate) => candidate.unitId === id);
    if (!row) fail("source allocation target has no authenticated lifted unit slot");
    return row.slot;
  });
  for (const slot of referencedSlots) tx.declareFunctionReference(slot);
  for (const row of rows) owner.units.set(row.unitId, { fn: row.fn, slot: row.slot });
  owner.bound = true;
}

export function nativeSourceClosureCallableBindings(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  requirements: NativeInvocationRequirements,
): NativeSourceClosureCallables {
  const owner = requireOwner(tx, pack);
  if (!owner.bound) fail("source callables have not been bound to the consumer's slots");
  owner.callables ??= bindNativeSourceClosureCallables(
    tx,
    pack.types,
    new Map([...owner.units].map(([id, row]) => [id, row.slot])),
    requirements,
  );
  return requireNativeSourceClosureCallables(tx, owner.callables, pack.types);
}

export function nativeSourceClosureValueType(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  logical: IrType,
): ValType | undefined {
  requireOwner(tx, pack);
  if (logical.kind === "boxed") {
    const inner = nativeRefCellScalarInner(logical);
    const cell = inner && resolveNativeSourceRefCell(tx, pack.types, inner);
    if (!cell) fail("logical mutable capture has no selected ref-cell owner");
    return { kind: "ref", typeIdx: cell.typeIdx };
  }
  if (logical.kind !== "closure" && logical.kind !== "callable") return undefined;
  if (!resolveNativeSourceClosure(tx, pack.types, logical.signature))
    fail("logical signature has no selected wrapper owner");
  return logical.kind === "callable"
    ? { kind: "externref" }
    : { kind: "ref", typeIdx: pack.types.closures.root.typeIndex };
}

export function nativeSourceClosureResolver(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
): Pick<IrLowerResolver, "resolveClosure" | "resolveClosureRoot" | "resolveClosureSubtype" | "resolveRefCell"> {
  const owner = requireOwner(tx, pack);
  if (!owner.bound) fail("source resolver used before original unit binding");
  return {
    resolveRefCell: (inner, allocation) => resolveNativeSourceRefCell(tx, pack.types, inner, allocation),
    resolveClosure: (signature) => resolveNativeSourceClosure(tx, pack.types, signature),
    resolveClosureRoot: () => {
      requireOwner(tx, pack);
      return pack.types.closures.root.typeIndex;
    },
    resolveClosureSubtype: (signature, captures, hostOneShot, domAuthority, liftedHandle) => {
      requireOwner(tx, pack);
      if (hostOneShot || domAuthority) fail("certified callback authority is not an ordinary source carrier");
      const shape = resolveNativeSourceClosureShape(tx, pack.types, signature, captures);
      if (!shape) return null;
      if (liftedHandle !== undefined) {
        // resolveFunc supplies a stable FuncHandle, not the final raw index.
        const association = pack.requirements.units.find(
          (unit) => unit.shapeId === shape.id && owner.units.get(unit.unitId)?.slot.handle === liftedHandle,
        );
        if (!association) fail("closure allocation does not target its selected lifted source slot");
        tx.physicalIndex(owner.units.get(association.unitId)!.slot);
      }
      return shape.lowering;
    },
  };
}

/** The only source completion producer: actually lower the retained body into its original slot. */
export function fillPreparedPrimaryUnit(
  tx: PhysicalModuleReservations,
  fn: IrFunction,
  slot: FunctionReservation,
  signature: PhysicalFunctionSignature,
  resolver: IrLowerResolver,
  backend: IrBackendKind,
  source?: NativeSourceClosureEmission,
): void {
  const owner = source ? requireOwner(tx, source) : undefined;
  const association = owner?.units.get(fn.unitId);
  if (association && (association.fn !== fn || association.slot !== slot || owner!.completed.has(fn.unitId)))
    fail("source canonical lowering uses a changed function/slot or repeats completion");
  if (fn.closureSubtype && source && !association) fail("unbound source closure body");
  const emitter = backend === "wasmgc" ? new WasmGcEmitter(resolver) : new LinearEmitter();
  const lowered = lowerIrFunctionBody<Instr[], ValType>(
    fn,
    resolver,
    emitter,
    wasmValueTypeConverter(backend, resolver, fn.name),
  );
  const params = lowered.params.flatMap((param) => [...param.slots]);
  const results = lowered.results.flatMap((result) => [...result]);
  if (!sameValTypes(params, signature.params) || !sameValTypes(results, signature.results))
    fail(`body ${fn.unitId} lowered to a signature different from its original ABI slot`);
  tx.fillFunction(slot, {
    locals: lowered.locals.flatMap((local) =>
      local.slots.map((type, index) => ({
        name: index === 0 ? local.name : `${local.name}$${index}`,
        type,
      })),
    ),
    body: lowered.body,
  });
  if (association) owner!.completed.add(fn.unitId);
}

export function requireCompletedNativeSourceClosures(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
): NativeSourceClosureEmission {
  const owner = requireOwner(tx, pack);
  if (!owner.bound || owner.units.size !== pack.requirements.units.length || owner.completed.size !== owner.units.size)
    fail("source canonical lowering is incomplete");
  for (const [unitId, row] of owner.units) {
    if (!owner.completed.has(unitId)) fail("source unit did not pass canonical lowering");
    tx.assertCompletedReservation(row.slot);
  }
  return pack;
}
