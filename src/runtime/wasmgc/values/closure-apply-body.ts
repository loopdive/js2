// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";

/** Treat null/undefined apply carriers as an empty argument list. */
export function guardNullableApplyArguments(undefinedValue: Instr[], fallback: Instr[]): Instr[] {
  return [
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: undefinedValue,
      else: fallback,
    },
  ];
}

export interface ClosureApplyCarrier {
  readonly typeIdx: number;
  readonly arrayTypeIdx: number;
  readonly dataLocal: number;
  readonly lengthLocal: number;
}
export interface ClosureApplyArgumentRead {
  readonly genericIndex?: FuncHandle;
  readonly fallbackUndefined: readonly Instr[];
  readonly object?: { readonly carrier: ClosureApplyCarrier; readonly undefinedValue: readonly Instr[] };
  readonly direct?: { readonly carrier: ClosureApplyCarrier; readonly undefinedValue: readonly Instr[] };
  readonly nullishUndefined: readonly Instr[];
}

function fastArgument(
  index: number,
  carrier: ClosureApplyCarrier,
  fallback: Instr[],
  missing: readonly Instr[],
): Instr[] {
  return [
    { op: "local.get", index: carrier.dataLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: fallback,
      else: [
        { op: "i32.const", value: index },
        { op: "local.get", index: carrier.lengthLocal },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "local.get", index: carrier.dataLocal },
            { op: "ref.as_non_null" },
            { op: "i32.const", value: index },
            { op: "array.get", typeIdx: carrier.arrayTypeIdx },
          ],
          else: structuredClone([...missing]),
        },
      ],
    },
  ];
}

/** Exact direct-vector → ObjVec → generic-reader precedence, with actual OOB undefined. */
export function buildClosureApplyArgument(index: number, read: ClosureApplyArgumentRead): Instr[] {
  let fallback: Instr[] =
    read.genericIndex === undefined
      ? structuredClone([...read.fallbackUndefined])
      : [
          { op: "local.get", index: 2 },
          { op: "f64.const", value: index },
          { op: "call", funcIdx: read.genericIndex },
        ];
  if (read.object) fallback = fastArgument(index, read.object.carrier, fallback, read.object.undefinedValue);
  if (read.direct) fallback = fastArgument(index, read.direct.carrier, fallback, read.direct.undefinedValue);
  return guardNullableApplyArguments(structuredClone([...read.nullishUndefined]), fallback);
}

function fastLength(carrier: ClosureApplyCarrier, fallback: Instr[]): Instr[] {
  return [
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: carrier.typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: carrier.typeIdx },
        { op: "struct.get", typeIdx: carrier.typeIdx, fieldIdx: 1 },
        { op: "local.set", index: carrier.dataLocal },
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: carrier.typeIdx },
        { op: "struct.get", typeIdx: carrier.typeIdx, fieldIdx: 0 },
        { op: "local.tee", index: carrier.lengthLocal },
      ],
      else: fallback,
    },
  ];
}

export function buildClosureApplyLength(read: {
  readonly genericLength?: FuncHandle;
  readonly object?: ClosureApplyCarrier;
  readonly direct?: ClosureApplyCarrier;
}): Instr[] {
  let length: Instr[] =
    read.genericLength === undefined
      ? [{ op: "i32.const", value: 0 }]
      : [{ op: "local.get", index: 2 }, { op: "call", funcIdx: read.genericLength }, { op: "i32.trunc_f64_s" }];
  if (read.object) length = fastLength(read.object, length);
  if (read.direct) length = fastLength(read.direct, length);
  return length;
}

/** The shared method call operands; callers retain their own provider acquisition order. */
export function buildClosureApplyCallArm(method: FuncHandle, argumentsBody: readonly (readonly Instr[])[]): Instr[] {
  return [
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    ...argumentsBody.flatMap((body) => structuredClone([...body])),
    { op: "call", funcIdx: method },
  ];
}

/** Route an actual Proxy carrier before the ordinary closure arity dispatcher. */
export function buildClosureApplyProxyGuard(proxyGuardTypeIdx: number, proxyApplyIdx: FuncHandle): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: proxyGuardTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: proxyApplyIdx },
        { op: "return" },
      ],
    },
  ];
}
