// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../../wasm/model/instructions.js";

/** Canonical AnyValue tag test; null and an ordinary receiver are never undefined. */
export function buildClosureUndefinedTest(localIdx: number, anyValueTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: localIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyValueTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: localIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/** #4555 receiver semantics with fresh instruction ownership at every occurrence. */
export function buildInstallableClosureReceiver(localIdx: number, anyValueTypeIdx?: number): Instr[] {
  if (anyValueTypeIdx === undefined) return [{ op: "local.get", index: localIdx }];
  return [
    { op: "local.get", index: localIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyValueTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: localIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" }],
          else: [{ op: "local.get", index: localIdx }],
        },
      ],
      else: [{ op: "local.get", index: localIdx }],
    },
  ];
}
