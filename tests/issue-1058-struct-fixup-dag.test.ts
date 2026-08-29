// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { fixupStructNewArgCounts, fixupStructNewResultCoercion } from "../src/codegen/fixups.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

function sharedBody(): Instr[] {
  let shared: Instr[] = [{ op: "nop" }];
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  return shared;
}

it("#1058 runs struct.new fixups over a shared instruction DAG once", () => {
  const first = sharedBody();
  const second = sharedBody();
  const mod = {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    globals: [],
    functions: [
      { name: "first", typeIdx: 0, locals: [], body: first },
      { name: "second", typeIdx: 0, locals: [], body: second },
    ],
  } as unknown as WasmModule;
  const ctx = {
    mod,
    structMap: new Map(),
    structFields: new Map(),
    classConstructorFields: new Map(),
  } as unknown as CodegenContext;

  fixupStructNewArgCounts(ctx);
  fixupStructNewResultCoercion(ctx);

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
});

it("#1058 fails closed on result coercion for a struct.new body shared across local spaces", () => {
  const body: Instr[] = [
    { op: "struct.new", typeIdx: 2 },
    { op: "local.set", index: 0 },
  ];
  const mod = {
    types: [
      { kind: "func", params: [], results: [] },
      { kind: "func", params: [], results: [] },
      { kind: "struct", name: "Target", fields: [] },
    ],
    imports: [],
    globals: [],
    functions: [
      { name: "external", typeIdx: 0, locals: [{ name: "out", type: { kind: "externref" } }], body },
      { name: "internal", typeIdx: 1, locals: [{ name: "out", type: { kind: "ref_null", typeIdx: 2 } }], body },
    ],
  } as unknown as WasmModule;
  const ctx = { mod, funcMap: new Map(), errors: [] } as unknown as CodegenContext;

  fixupStructNewResultCoercion(ctx);

  expect(body).toEqual([
    { op: "struct.new", typeIdx: 2 },
    { op: "local.set", index: 0 },
  ]);
  expect(mod.codegenErrors).toEqual([
    expect.objectContaining({ severity: "error", message: expect.stringContaining("struct.new result repair") }),
  ]);
  expect(ctx.errors).toEqual(mod.codegenErrors);
});
