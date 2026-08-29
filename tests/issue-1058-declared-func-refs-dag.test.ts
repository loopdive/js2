// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

// Initialize the codegen module graph through its supported entry point before
// importing this finalizer seam; class-bodies participates in an ESM cycle.
import "../src/codegen/index.js";
import { collectDeclaredFuncRefs } from "../src/codegen/class-bodies.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 collects ref.func targets from a shared instruction DAG once", () => {
  const leaf: Instr[] = [{ op: "ref.func", funcIdx: 3 }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }

  const mod = {
    imports: [],
    functions: [{ name: "target", typeIdx: 0, locals: [], body: shared }],
    declaredFuncRefs: [],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;
  const ctx = { mod } as unknown as CodegenContext;

  collectDeclaredFuncRefs(ctx);

  expect(mod.declaredFuncRefs).toEqual([3]);
});
