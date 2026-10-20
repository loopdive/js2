// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import { buildBuiltinFunctionArgument, type BuiltinFunctionDefinition } from "./builtin-function-bodies.js";

export type NativeObjectToObjectOperation = "get-prototype" | "value-of" | "prototype-getter" | "is-prototype-of";
/** Fixed catalog Call ABI, not public-source admission or an ownership capability. */
export function buildNativeObjectToObjectDefinition(d: {
  readonly operation: Exclude<NativeObjectToObjectOperation, "is-prototype-of">;
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  readonly undefinedGlobal: number;
  readonly toObject: FuncHandle;
  readonly getPrototypeOf: FuncHandle;
}): BuiltinFunctionDefinition {
  const input =
    d.operation === "get-prototype" ? buildBuiltinFunctionArgument(d, 1, 0) : [{ op: "local.get" as const, index: 0 }];
  const wrapping = [...input, { op: "call" as const, funcIdx: d.toObject }];
  if (d.operation === "value-of") return { locals: [], body: wrapping };
  return {
    locals: [
      { name: "prototype", type: { kind: "externref" } },
      { name: "status", type: { kind: "i32" } },
    ],
    body: [
      ...wrapping,
      { op: "call", funcIdx: d.getPrototypeOf },
      { op: "local.set", index: 2 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 2 },
    ],
  };
}

/** Native object identity, not primitive payload equality. No additional prototype reads for cycle detection. */
export function buildNativeObjectIsPrototypeOfDefinition(d: {
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  readonly undefinedGlobal: number;
  readonly undefinedTypeIdx: number;
  readonly toObject: FuncHandle;
  readonly isPrimitive: FuncHandle;
  readonly classify: FuncHandle;
  readonly getPrototypeOf: FuncHandle;
  readonly boxBoolean: FuncHandle;
}): BuiltinFunctionDefinition {
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const n = (value: number): Instr => ({ op: "i32.const", value });
  const wide = (value: bigint): Instr => ({ op: "i64.const", value });
  const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
  const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });
  const result = (value: number): Instr[] => [n(value), call(d.boxBoolean), { op: "return" }];
  const eq = (a: number, b: number): Instr[] => [
    get(a),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: -19 },
    get(b),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: -19 },
    { op: "ref.eq" },
  ];
  const admitted = (): Instr[] => [get(2), call(d.classify), n(0), { op: "i32.le_s" }, when([{ op: "unreachable" }])];
  return {
    locals: [
      { name: "cursor", type: { kind: "externref" } },
      { name: "receiver", type: { kind: "externref" } },
      { name: "status", type: { kind: "i32" } },
      { name: "checkpoint", type: { kind: "externref" } },
      { name: "power", type: { kind: "i64" } },
      { name: "distance", type: { kind: "i64" } },
    ],
    body: [
      ...buildBuiltinFunctionArgument(d, 1, 0),
      set(2),
      // Primitive V is decided before ToObject(this), including omission/nullish this.
      get(2),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.undefinedTypeIdx },
      when([
        get(2),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.undefinedTypeIdx },
        { op: "global.get", index: d.undefinedGlobal },
        { op: "ref.eq" },
        when(result(0)),
        { op: "unreachable" },
      ]),
      get(2),
      call(d.isPrimitive),
      when(result(0)),
      ...admitted(),
      get(0),
      call(d.toObject),
      set(3),
      get(2),
      set(5),
      wide(1n),
      set(6),
      wide(0n),
      set(7),
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          get(2),
          call(d.getPrototypeOf),
          set(2),
          set(4),
          get(4),
          n(1),
          { op: "i32.ne" },
          when([{ op: "unreachable" }]),
          get(2),
          { op: "ref.is_null" },
          when(result(0)),
          ...admitted(),
          ...eq(2, 3),
          when(result(1)),
          // Brent compares identities already returned by the semantic walk.
          // No Floyd-style extra GetPrototypeOf calls or fixed depth cutoff.
          ...eq(2, 5),
          when([{ op: "unreachable" }]),
          get(7),
          wide(1n),
          { op: "i64.add" },
          { op: "local.tee", index: 7 },
          get(6),
          { op: "i64.eq" },
          when([
            get(2),
            set(5),
            wide(0n),
            set(7),
            get(6),
            wide(0n),
            { op: "i64.lt_s" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i64" } },
              // Saturate unsigned distance capacity instead of wrapping the checkpoint interval to zero.
              then: [wide(-1n)],
              else: [get(6), wide(1n), { op: "i64.shl" }],
            },
            set(6),
          ]),
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}
