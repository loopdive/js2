// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 widens block types in a shared instruction DAG once", () => {
  const leaf: Instr[] = [
    {
      op: "block",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: 1 } },
      body: [{ op: "ref.null", typeIdx: 1 }],
    },
  ];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  const mod = {
    types: [
      { kind: "func", params: [], results: [] },
      { kind: "struct", name: "Target", fields: [] },
    ],
    functions: [
      { name: "first", typeIdx: 0, locals: [{ name: "value", type: { kind: "ref", typeIdx: 1 } }], body: shared },
      { name: "second", typeIdx: 0, locals: [], body: shared },
    ],
    globals: [],
    imports: [],
  } as unknown as WasmModule;

  widenNonDefaultableTypes(mod);

  expect(mod.functions[0]!.locals[0]!.type).toEqual({ kind: "ref_null", typeIdx: 1 });
  expect((leaf[0] as Extract<Instr, { op: "block" }>).blockType).toEqual({
    kind: "val",
    type: { kind: "ref_null", typeIdx: 1 },
  });
});
