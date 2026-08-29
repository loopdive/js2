// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { brandCollidingShapeTypes, SHAPE_BRAND_FIELD } from "../src/codegen/shape-brand.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 brands a shared instruction DAG once", () => {
  const leaf: Instr[] = [{ op: "struct.new", typeIdx: 1 }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }

  const mod = {
    types: [
      { kind: "struct", name: "__vec_base", fields: [], final: false },
      { kind: "struct", name: "__anon_0", fields: [{ name: "x", type: { kind: "i32" }, mutable: true }] },
      { kind: "struct", name: "__anon_1", fields: [{ name: "y", type: { kind: "i32" }, mutable: true }] },
    ],
    functions: [
      { name: "target", typeIdx: 0, locals: [], body: shared },
      { name: "alsoTarget", typeIdx: 0, locals: [], body: shared },
    ],
    globals: [{ name: "shared", type: { kind: "i32" }, mutable: false, init: shared }],
  } as unknown as WasmModule;

  expect(brandCollidingShapeTypes(mod)).toEqual([1, 2]);
  expect(mod.types[1]).toMatchObject({
    kind: "struct",
    fields: [{ name: "x" }, { name: SHAPE_BRAND_FIELD, type: { kind: "ref_null", typeIdx: 0 } }],
  });
  expect(leaf).toEqual([
    { op: "ref.null", typeIdx: 0 },
    { op: "struct.new", typeIdx: 1 },
  ]);
});
