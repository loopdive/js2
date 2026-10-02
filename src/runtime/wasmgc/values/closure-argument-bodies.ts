// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, ValType } from "../../../wasm/model/instructions.js";

export function needsExternToAnyForClosureParam(paramType: ValType): boolean {
  switch (paramType.kind) {
    case "anyref":
    case "eqref":
    case "ref":
    case "ref_null":
      return true;
    default:
      // externref / ref_extern (already extern), funcref, and value types.
      return false;
  }
}

export function buildClosureReferenceArgument(paramType: ValType, materializer?: FuncHandle): Instr[] {
  if ((paramType.kind === "ref" || paramType.kind === "ref_null") && materializer !== undefined) {
    const ops: Instr[] = [{ op: "call", funcIdx: materializer }];
    if (paramType.kind === "ref") ops.push({ op: "ref.as_non_null" });
    return ops;
  }
  const ops: Instr[] = [{ op: "any.convert_extern" }];
  if (paramType.kind === "ref") ops.push({ op: "ref.cast", typeIdx: paramType.typeIdx });
  else if (paramType.kind === "ref_null") ops.push({ op: "ref.cast_null", typeIdx: paramType.typeIdx });
  return ops;
}

export function buildClosureF64Argument(argLocalIdx: number, unboxIdx: number, isUndefinedIdx?: number): Instr[] {
  const unbox: Instr[] = [
    { op: "local.get", index: argLocalIdx },
    { op: "call", funcIdx: unboxIdx },
  ];
  if (isUndefinedIdx === undefined) return unbox;
  return [
    { op: "local.get", index: argLocalIdx },
    { op: "call", funcIdx: isUndefinedIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }],
      else: unbox,
    },
  ];
}

export function buildClosureI64Argument(
  argLocalIdx: number,
  toBigInt: FuncHandle | undefined,
  unboxNumber: FuncHandle | undefined,
): Instr[] {
  if (toBigInt !== undefined)
    return [
      { op: "local.get", index: argLocalIdx },
      { op: "call", funcIdx: toBigInt },
    ];
  if (unboxNumber !== undefined)
    return [
      { op: "local.get", index: argLocalIdx },
      { op: "call", funcIdx: unboxNumber },
      { op: "i64.trunc_sat_f64_s" },
    ];
  return [{ op: "i64.const", value: 0n }];
}

export interface ClosureArgumentConversion {
  readonly unboxNumber?: FuncHandle;
  readonly isUndefined?: FuncHandle;
  readonly toBigInt?: FuncHandle;
  readonly unwrapForWasm?: FuncHandle;
  readonly materializer?: FuncHandle;
}

/** One method-argument conversion policy, including actual-count omission. */
export function buildClosureMethodArgument(
  argLocalIdx: number,
  formalIndex: number,
  paramType: ValType | undefined,
  argcGlobalIdx: number,
  bindings: ClosureArgumentConversion,
): Instr[] {
  let ops: Instr[] = [{ op: "local.get", index: argLocalIdx }];
  if (paramType) {
    if (paramType.kind === "f64" && bindings.unboxNumber !== undefined)
      return buildClosureF64Argument(argLocalIdx, bindings.unboxNumber, bindings.isUndefined);
    if (paramType.kind === "i32" && bindings.unboxNumber !== undefined)
      ops.push({ op: "call", funcIdx: bindings.unboxNumber }, { op: "i32.trunc_sat_f64_s" });
    else if (paramType.kind === "i64")
      return buildClosureI64Argument(argLocalIdx, bindings.toBigInt, bindings.unboxNumber);
    else if (needsExternToAnyForClosureParam(paramType)) {
      const convert = (): Instr[] => [
        { op: "local.get", index: argLocalIdx },
        ...(bindings.unwrapForWasm === undefined ? [] : [{ op: "call", funcIdx: bindings.unwrapForWasm } as Instr]),
        ...buildClosureReferenceArgument(paramType, bindings.materializer),
      ];
      ops =
        paramType.kind === "ref_null" && bindings.isUndefined !== undefined
          ? [
              { op: "local.get", index: argLocalIdx },
              { op: "call", funcIdx: bindings.isUndefined },
              {
                op: "if",
                blockType: { kind: "val", type: paramType },
                then: [{ op: "ref.null", typeIdx: paramType.typeIdx }],
                else: convert(),
              },
            ]
          : convert();
    }
  }
  if (paramType?.kind !== "ref_null") return ops;
  return [
    { op: "global.get", index: argcGlobalIdx },
    { op: "i32.const", value: formalIndex },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: paramType },
      then: ops,
      else: [{ op: "ref.null", typeIdx: paramType.typeIdx }],
    },
  ];
}
