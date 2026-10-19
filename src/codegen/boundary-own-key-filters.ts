// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";

interface OwnKeyFilterLayout {
  readonly ownKeysIdx: number;
  readonly objVecNewIdx: number;
  readonly objVecPushIdx: number;
  readonly objVecTypeIdx: number;
  readonly objVecArrTypeIdx: number;
  readonly anyStrTypeIdx: number;
  readonly symbolTypeIdx: number;
}

/** GetOwnPropertyKeys filtering is native; the boundary supplies only [[OwnPropertyKeys]]. */
function filteredKeysBody(layout: OwnKeyFilterLayout, keyTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: layout.ownKeysIdx },
    { op: "local.tee", index: 1 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 1 }, { op: "return" }] },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: layout.objVecTypeIdx },
    { op: "local.set", index: 2 },
    { op: "call", funcIdx: layout.objVecNewIdx },
    { op: "local.set", index: 3 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 4 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 4 },
            { op: "local.get", index: 2 },
            { op: "struct.get", typeIdx: layout.objVecTypeIdx, fieldIdx: 0 },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 2 },
            { op: "struct.get", typeIdx: layout.objVecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 4 },
            { op: "array.get", typeIdx: layout.objVecArrTypeIdx },
            { op: "local.set", index: 5 },
            { op: "local.get", index: 5 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: layout.anyStrTypeIdx },
            { op: "local.get", index: 5 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: layout.symbolTypeIdx },
            { op: "i32.or" },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
            { op: "local.get", index: 5 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: keyTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 3 },
                { op: "local.get", index: 5 },
                { op: "call", funcIdx: layout.objVecPushIdx },
              ],
            },
            { op: "local.get", index: 4 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 4 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 3 },
  ];
}

export function registerBoundaryOwnKeyFilters(
  layout: OwnKeyFilterLayout,
  registerNative: (
    name: string,
    params: ValType[],
    results: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number,
): { names: number; symbols: number } {
  if (layout.anyStrTypeIdx < 0 || layout.symbolTypeIdx < 0)
    throw Error("Boundary own keys require native string and symbol carriers");
  const register = (name: string, keyTypeIdx: number) =>
    registerNative(
      name,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "keys", type: { kind: "externref" } },
        { name: "vector", type: { kind: "ref_null", typeIdx: layout.objVecTypeIdx } },
        { name: "filtered", type: { kind: "externref" } },
        { name: "index", type: { kind: "i32" } },
        { name: "key", type: { kind: "externref" } },
      ],
      filteredKeysBody(layout, keyTypeIdx),
    );
  return {
    names: register("__boundary_own_string_keys_native", layout.anyStrTypeIdx),
    symbols: register("__boundary_own_symbol_keys_native", layout.symbolTypeIdx),
  };
}
