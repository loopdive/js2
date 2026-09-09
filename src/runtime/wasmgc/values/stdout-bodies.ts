// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, GlobalHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";

/** Resolved physical dependencies; these records do not grant admission. */
export interface StdoutAppendResources {
  readonly accGlobalIdx: GlobalHandle;
  readonly concatIdx: FuncHandle;
}
export interface StdoutPrepareResources {
  readonly accGlobalIdx: GlobalHandle;
  readonly flatGlobalIdx: GlobalHandle;
  readonly flatTypeIdx: TypeHandle;
  readonly flattenIdx: FuncHandle;
}
export interface StdoutCharResources {
  readonly flatGlobalIdx: GlobalHandle;
  readonly flatTypeIdx: TypeHandle;
  readonly dataTypeIdx: TypeHandle;
}

export function buildStdoutAppendDefinition(resources: StdoutAppendResources): { locals: LocalDef[]; body: Instr[] } {
  const { accGlobalIdx, concatIdx } = resources;
  const body: Instr[] = [
    // if s is null → nothing to append
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    // if acc is null → acc = s (first line), done
    { op: "global.get", index: accGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "global.set", index: accGlobalIdx }, { op: "return" }],
    },
    // acc = __str_concat(acc, s) — both non-null here
    { op: "global.get", index: accGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    { op: "global.set", index: accGlobalIdx },
  ];
  return { locals: [], body };
}

export function buildStdoutPrepareDefinition(resources: StdoutPrepareResources): { locals: LocalDef[]; body: Instr[] } {
  const { accGlobalIdx, flatGlobalIdx, flatTypeIdx, flattenIdx } = resources;
  const body: Instr[] = [
    { op: "global.get", index: accGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "global.get", index: accGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: flattenIdx },
    { op: "global.set", index: flatGlobalIdx },
    { op: "global.get", index: flatGlobalIdx },
    { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
  ];
  return { locals: [], body };
}

export function buildStdoutCharDefinition(resources: StdoutCharResources): { locals: LocalDef[]; body: Instr[] } {
  const { flatGlobalIdx, flatTypeIdx, dataTypeIdx } = resources;
  const L_I = 0;
  const L_BUF = 1;
  const body: Instr[] = [
    { op: "global.get", index: flatGlobalIdx },
    { op: "local.tee", index: L_BUF },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    // i < 0 || i >= len → 0
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_BUF },
    { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.ge_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    // data[off + i]
    { op: "local.get", index: L_BUF },
    { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 2 }, // data
    { op: "local.get", index: L_BUF },
    { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 1 }, // off
    { op: "local.get", index: L_I },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: dataTypeIdx },
  ];
  return {
    locals: [{ name: "buf", type: { kind: "ref_null", typeIdx: flatTypeIdx } }],
    body,
  };
}
