// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { repairCrossHierarchyOperands } from "../src/codegen/cross-hierarchy-operands.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 repairs cross-hierarchy operands in a shared instruction DAG once", () => {
  const leaf: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.set", index: 1 },
  ];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  const mod = {
    types: [
      { kind: "func", params: [{ kind: "ref_null", typeIdx: 1 }], results: [] },
      { kind: "struct", name: "Target", fields: [] },
    ],
    imports: [],
    globals: [],
    functions: [{ name: "target", typeIdx: 0, locals: [{ name: "out", type: { kind: "externref" } }], body: shared }],
  } as unknown as WasmModule;

  expect(repairCrossHierarchyOperands(mod)).toBe(1);
  expect(leaf).toEqual([{ op: "local.get", index: 0 }, { op: "extern.convert_any" }, { op: "local.set", index: 1 }]);
});

it("#1058 fails closed for a cross-function body whose local types require different repairs", () => {
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.set", index: 1 },
  ];
  const mod = {
    types: [
      { kind: "func", params: [{ kind: "ref_null", typeIdx: 2 }], results: [] },
      { kind: "func", params: [{ kind: "externref" }], results: [] },
      { kind: "struct", name: "Target", fields: [] },
    ],
    imports: [],
    globals: [],
    functions: [
      { name: "internal", typeIdx: 0, locals: [{ name: "out", type: { kind: "externref" } }], body },
      { name: "external", typeIdx: 1, locals: [{ name: "out", type: { kind: "externref" } }], body },
    ],
  } as unknown as WasmModule;

  const diagnostics: Array<{ severity?: string; message: string }> = [];
  expect(repairCrossHierarchyOperands(mod, diagnostics as never)).toBe(0);
  expect(body).toEqual([
    { op: "local.get", index: 0 },
    { op: "local.set", index: 1 },
  ]);
  expect(mod.codegenErrors).toEqual([
    expect.objectContaining({
      severity: "error",
      message: expect.stringContaining("one instruction array is owned by multiple functions"),
    }),
  ]);
  expect(diagnostics).toEqual(mod.codegenErrors);
});

it("#1058 repairs a struct.set receiver across a structured value producer", () => {
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 1 },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: 17 }],
      else: [{ op: "f64.const", value: 23 }],
    },
    { op: "struct.set", typeIdx: 1, fieldIdx: 0 },
  ];
  const mod = {
    types: [
      { kind: "func", params: [{ kind: "externref" }], results: [] },
      { kind: "struct", name: "Target", fields: [{ name: "value", type: { kind: "f64" }, mutable: true }] },
    ],
    imports: [],
    globals: [],
    functions: [{ name: "target", typeIdx: 0, locals: [], body }],
  } as unknown as WasmModule;

  expect(repairCrossHierarchyOperands(mod)).toBe(2);
  expect(body).toEqual([
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: 1 },
    { op: "i32.const", value: 1 },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: 17 }],
      else: [{ op: "f64.const", value: 23 }],
    },
    { op: "struct.set", typeIdx: 1, fieldIdx: 0 },
  ]);
});
