// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Explicit Wasm adapter: backend selection and final Wasm function assembly.
import type { IrFunction, IrType } from "../nodes.js";
import type { LocalDef, ValType } from "../types.js";
import type { IrBackendKind } from "./legality.js";
import type { BackendEmitter } from "./emitter.js";
import type { TypeConverter } from "./contract.js";
import type { IrLowerResolver, IrLowerResult, IrLoweredValue, IrLoweredSignature } from "./lower-contracts.js";
import {
  lowerIrFunctionBody,
  lowerIrTypeToValType,
  projectIrFunctionSignatureWithConverter,
} from "../lower-generic.js";
import { WasmGcEmitter } from "./wasmgc-emitter.js";

/**
 * Wasm-shaped type conversion lives at the Wasm adapter edge. Linear-Wasm
 * also uses this converter today because its scalar slots are Wasm ValTypes;
 * non-Wasm consumers pass their own `TypeConverter` to the generic lowerer.
 */
export function wasmValueTypeConverter(
  backend: IrBackendKind,
  resolver: IrLowerResolver,
  funcName: string,
): TypeConverter<ValType> {
  return {
    backend,
    convertType: (type: IrType): readonly ValType[] => [lowerIrTypeToValType(type, resolver, funcName)],
  };
}

/** Project a WasmGC function boundary without emitting body instructions. */
export function projectIrFunctionSignature(func: IrFunction, resolver: IrLowerResolver): IrLoweredSignature<ValType> {
  const emitter = new WasmGcEmitter(resolver);
  return projectIrFunctionSignatureWithConverter(
    func,
    resolver,
    emitter,
    wasmValueTypeConverter("wasmgc", resolver, func.name),
  );
}

function flattenWasmValues(values: readonly IrLoweredValue<ValType>[]): LocalDef[] {
  return values.flatMap((value) =>
    value.slots.map((type, slot) => ({
      name: slot === 0 ? value.name : `${value.name}$${slot}`,
      type,
    })),
  );
}

function flattenSlots<Slot>(values: readonly (readonly Slot[])[]): Slot[] {
  return values.flatMap((slots) => [...slots]);
}

/**
 * #1584 (a0-tail): thin WasmGC wrapper. Every pre-#1584 caller is unchanged —
 * it still returns `IrLowerResult` (`{ func: WasmFunction }`) with `S = Instr[]`
 * lowering, byte-identical to the previous monolithic body. The generic body
 * does all the work; this only assembles the `WasmFunction` shape from the
 * `Instr[]` sink.
 */

export function lowerIrFunctionToWasm(
  func: IrFunction,
  resolver: IrLowerResolver,
  // #1713: the active backend. Defaults to WasmGcEmitter so every existing
  // caller (integration.ts) is unchanged and Phase 1 stays zero-delta.
  // #1714/#1715 pass an explicit emitter selected by compile target.
  emitter: BackendEmitter = new WasmGcEmitter(resolver),
): IrLowerResult {
  const lowered = lowerIrFunctionBody(
    func,
    resolver,
    emitter,
    wasmValueTypeConverter(emitter.backend, resolver, func.name),
  );
  const params = flattenWasmValues(lowered.params).map((param) => param.type);
  const results = flattenSlots(lowered.results);
  return {
    func: {
      name: lowered.name,
      typeIdx: resolver.internFuncType({ kind: "func", params, results }),
      locals: flattenWasmValues(lowered.locals),
      body: lowered.body,
      exported: lowered.exported,
    },
  };
}
