// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { repairBody, repairStructTypeMismatches } from "../src/codegen/fixups.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 repairs a shared instruction DAG once", () => {
  const leaf: Instr[] = [{ op: "ref.null.extern" }, { op: "struct.get", typeIdx: 1, fieldIdx: 0 }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  const mod = {
    imports: [],
    functions: [],
    types: [
      { kind: "func", params: [], results: [] },
      { kind: "struct", name: "Target", fields: [{ name: "x", type: { kind: "i32" }, mutable: true }] },
    ],
  } as unknown as WasmModule;

  expect(repairBody(shared, [], mod)).toBe(1);
  expect(leaf).toEqual([
    { op: "ref.null", typeIdx: 1 },
    { op: "struct.get", typeIdx: 1, fieldIdx: 0 },
  ]);
});

it("#1058 fails closed on a cross-function struct repair with incompatible local spaces", () => {
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: 2, fieldIdx: 0 },
  ];
  const mod = {
    imports: [],
    globals: [],
    functions: [
      { name: "external", typeIdx: 0, locals: [], body },
      { name: "internal", typeIdx: 1, locals: [], body },
    ],
    types: [
      { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "i32" }] },
      { kind: "func", params: [{ kind: "ref_null", typeIdx: 2 }], results: [{ kind: "i32" }] },
      { kind: "struct", name: "Target", fields: [{ name: "x", type: { kind: "i32" }, mutable: true }] },
    ],
  } as unknown as WasmModule;

  const diagnostics: Array<{ severity?: string; message: string }> = [];
  expect(repairStructTypeMismatches(mod, diagnostics as never)).toBe(0);
  expect(body).toEqual([
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: 2, fieldIdx: 0 },
  ]);
  expect(mod.codegenErrors).toEqual([
    expect.objectContaining({ severity: "error", message: expect.stringContaining("struct mismatch repair") }),
  ]);
  expect(diagnostics).toEqual(mod.codegenErrors);
});
