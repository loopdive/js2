// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import type { CodegenContext } from "../src/codegen/context/types.js";
import { resolveSameShapeFieldNameCollisions } from "../src/codegen/struct-field-exports.js";
import type { FieldDef, Instr, WasmModule } from "../src/ir/types.js";

it("#1058 stamps a shared instruction DAG once for all colliding shapes", () => {
  const firstFields: FieldDef[] = [{ name: "x", type: { kind: "f64" }, mutable: true }];
  const secondFields: FieldDef[] = [{ name: "y", type: { kind: "f64" }, mutable: true }];
  const leaf: Instr[] = [{ op: "struct.new", typeIdx: 1 }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }

  const mod = {
    types: [
      { kind: "struct", name: "__anon_0", fields: firstFields },
      { kind: "struct", name: "__anon_1", fields: secondFields },
      { kind: "func", params: [], results: [] },
    ],
    functions: [
      { name: "target", typeIdx: 2, locals: [], body: shared },
      { name: "alsoTarget", typeIdx: 2, locals: [], body: shared },
    ],
    globals: [{ name: "shared", type: { kind: "i32" }, mutable: false, init: shared }],
  } as unknown as WasmModule;
  const ctx = {
    mod,
    structFields: new Map([
      ["__anon_0", firstFields],
      ["__anon_1", secondFields],
    ]),
    structMap: new Map([
      ["__anon_0", 0],
      ["__anon_1", 1],
    ]),
    structInsertionOrder: new Map(),
    shapeIdByStructName: new Map(),
    shapeNameCsvById: [],
  } as unknown as CodegenContext;

  expect(resolveSameShapeFieldNameCollisions(ctx)).toEqual([0, 1]);
  expect(firstFields.at(-1)).toEqual({ name: "$shape", type: { kind: "i32" }, mutable: false });
  expect(secondFields.at(-1)).toEqual({ name: "$shape", type: { kind: "i32" }, mutable: false });
  expect(leaf).toEqual([
    { op: "i32.const", value: 2 },
    { op: "struct.new", typeIdx: 1 },
  ]);
});
