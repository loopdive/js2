// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { asVal, type AllocSiteId, type IrType } from "../nodes.js";
import type { ValType } from "../types.js";
import type { IrVectorLowering } from "./handles.js";
import type { IrLowerResolver } from "./lower-contracts.js";

/** Resolve the actual admitted backend representation without borrowing GC coordinates. */
export function resolveVectorLowering(
  type: IrType,
  element: ValType | null,
  resolver: IrLowerResolver,
  funcName: string,
  alloc?: AllocSiteId,
): IrVectorLowering | null {
  if (type.kind === "vec" && type.layout) {
    if (resolver.vectorRepresentation === "linear")
      throw new Error(`ir/lower: persisted WasmGC vector layout cannot enter Linear lowering (${funcName})`);
    if (!element) throw new Error(`ir/lower: missing vector element type (${funcName})`);
    return {
      valueType: { kind: type.nullable ? "ref_null" : "ref", typeIdx: resolver.resolveType(type.layout.carrierType) },
      vecStructTypeIdx: resolver.resolveType(type.layout.carrierType),
      lengthFieldIdx: type.layout.lengthFieldIndex,
      dataFieldIdx: type.layout.dataFieldIndex,
      arrayTypeIdx: resolver.resolveType(type.layout.dataType),
      elementValType: element,
    };
  }
  const value = asVal(type);
  const layout =
    type.kind === "vec"
      ? element
        ? (resolver.resolveVecForElement?.(element, alloc) ?? null)
        : null
      : value
        ? (resolver.resolveVec?.(value) ?? null)
        : null;
  if (layout) {
    const linear = "linearMemory" in layout;
    if (resolver.vectorRepresentation === "linear" && !linear)
      throw new Error(`ir/lower: Linear vector resolver returned a WasmGC handle (${funcName})`);
    if (resolver.vectorRepresentation === "wasmgc" && linear)
      throw new Error(`ir/lower: WasmGC vector resolver returned a Linear handle (${funcName})`);
  }
  return layout;
}

/** Carrier comes from the selected representation, never a missing-layout fallback. */
export function vectorCarrierType(layout: IrVectorLowering, nullable: boolean): ValType {
  if ("linearMemory" in layout) return { kind: "i32" };
  return layout.valueType ?? { kind: nullable ? "ref_null" : "ref", typeIdx: layout.vecStructTypeIdx };
}

/** Signature projection preserves the GC carrier-only lookup and its reservation order. */
export function resolveVectorCarrierType(
  type: Extract<IrType, { kind: "vec" }>,
  element: ValType,
  resolver: IrLowerResolver,
  funcName: string,
): ValType {
  if (type.layout) {
    if (resolver.vectorRepresentation === "linear")
      throw new Error(`ir/lower: persisted WasmGC vector layout cannot enter Linear lowering (${funcName})`);
    return { kind: type.nullable ? "ref_null" : "ref", typeIdx: resolver.resolveType(type.layout.carrierType) };
  }
  const layout = resolveVectorLowering(type, element, resolver, funcName);
  if (!layout) throw new Error(`ir/lower: resolver cannot lower vec IrType (${funcName})`);
  return vectorCarrierType(layout, type.nullable);
}
