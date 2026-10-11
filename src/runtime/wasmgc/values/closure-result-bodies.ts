// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, ValType } from "../../../wasm/model/instructions.js";

/** Missing handles preserve only the old caller's fallback; native admission must reject them. */
export type ClosureResultConversion =
  | { readonly kind: "void"; readonly undefinedValue?: readonly Instr[] }
  | { readonly kind: "native-any"; readonly anyToExtern?: FuncHandle }
  | {
      readonly kind: "value";
      readonly returnType: ValType;
      readonly boxNumber?: FuncHandle;
      readonly boxSymbol?: FuncHandle;
      readonly boxBoolean?: FuncHandle;
      readonly boxBigInt?: FuncHandle;
    };

/** Shared #4082/#6642 result policy; each call returns fresh instructions. */
export function buildClosureResultBody(conversion: ClosureResultConversion): Instr[] {
  if (conversion.kind === "void")
    return conversion.undefinedValue ? structuredClone([...conversion.undefinedValue]) : [{ op: "ref.null.extern" }];
  if (conversion.kind === "native-any")
    return conversion.anyToExtern !== undefined
      ? [{ op: "call", funcIdx: conversion.anyToExtern }]
      : [{ op: "extern.convert_any" }];
  const { returnType, boxNumber, boxSymbol, boxBoolean, boxBigInt } = conversion;
  if (returnType.kind === "ref" || returnType.kind === "ref_null") return [{ op: "extern.convert_any" }];
  if (returnType.kind === "f64")
    return boxNumber !== undefined ? [{ op: "call", funcIdx: boxNumber }] : [{ op: "drop" }, { op: "ref.null.extern" }];
  if (returnType.kind === "i32") {
    if (returnType.symbol === true && boxSymbol !== undefined) return [{ op: "call", funcIdx: boxSymbol }];
    if (returnType.boolean === true && boxBoolean !== undefined) return [{ op: "call", funcIdx: boxBoolean }];
    return boxNumber !== undefined
      ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumber }]
      : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (returnType.kind === "i64") {
    if (returnType.bigint === true && boxBigInt !== undefined) return [{ op: "call", funcIdx: boxBigInt }];
    return boxNumber !== undefined
      ? [{ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxNumber }]
      : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  return [];
}
