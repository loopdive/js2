// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { eliminateDeadImports } from "../src/codegen/dead-elimination.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 scans and remaps instruction arrays shared across module roots once", () => {
  const shared: Instr[] = [
    { op: "call", funcIdx: 2 },
    { op: "ref.null", typeIdx: 2 },
    { op: "drop" },
    { op: "ref.null", typeIdx: 3 },
    { op: "struct.get", typeIdx: 3, fieldIdx: 0 },
    { op: "drop" },
  ];
  const mod = {
    types: [
      { kind: "func", params: [], results: [] },
      { kind: "array", element: { kind: "i32" }, mutable: true },
      { kind: "struct", name: "Keep", fields: [] },
      { kind: "struct", name: "Target", fields: [{ name: "x", type: { kind: "i32" }, mutable: true }] },
    ],
    imports: [
      { module: "env", name: "dead", desc: { kind: "func", typeIdx: 0 } },
      { module: "env", name: "live", desc: { kind: "func", typeIdx: 0 } },
    ],
    functions: [
      { name: "first", typeIdx: 0, locals: [], body: shared },
      { name: "second", typeIdx: 0, locals: [], body: shared },
    ],
    globals: [],
    elements: [],
    exports: [],
    tags: [],
    declaredFuncRefs: [1],
  } as unknown as WasmModule;

  eliminateDeadImports(mod);

  expect(mod.imports.map((entry) => entry.name)).toEqual(["live"]);
  expect(shared[0]).toEqual({ op: "call", funcIdx: 1 });
  expect(shared[3]).toEqual({ op: "ref.null", typeIdx: 2 });
  expect(shared[4]).toEqual({ op: "struct.get", typeIdx: 2, fieldIdx: 0 });
});
