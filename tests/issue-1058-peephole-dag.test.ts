// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { peepholeOptimize } from "../src/codegen/peephole.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 optimizes a shared instruction DAG once", () => {
  const leaf: Instr[] = [{ op: "local.get", index: 0 }, { op: "drop" }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  const mod = {
    types: [{ kind: "func", params: [{ kind: "i32" }], results: [] }],
    functions: [{ name: "target", typeIdx: 0, locals: [], body: shared }],
  } as unknown as WasmModule;

  expect(peepholeOptimize(mod)).toBe(2);
  expect(leaf).toEqual([]);
});

it("#1058 declines local-type Pattern 5 when the then arm is shared across functions", () => {
  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: 2 },
  ];
  const guardedRead = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "ref.test", typeIdx: 2 },
    { op: "if", blockType: { kind: "empty" }, then: arm, else: [] },
  ];
  const mod = {
    types: [
      { kind: "func", params: [{ kind: "ref_null", typeIdx: 2 }], results: [] },
      { kind: "func", params: [{ kind: "anyref" }], results: [] },
      { kind: "struct", name: "Target", fields: [] },
    ],
    functions: [
      { name: "typed", typeIdx: 0, locals: [], body: guardedRead() },
      { name: "dynamic", typeIdx: 1, locals: [], body: guardedRead() },
    ],
  } as unknown as WasmModule;

  expect(peepholeOptimize(mod)).toBe(0);
  expect(arm[1]).toEqual({ op: "ref.cast", typeIdx: 2 });
});
