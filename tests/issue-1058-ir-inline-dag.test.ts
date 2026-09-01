// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";

import type { CodegenContext } from "../src/codegen/context/types.js";
import { inlineUserFunctions } from "../src/codegen/ir-inline.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

const FLAG = "JS2WASM_IR_INLINE";
const originalFlag = process.env[FLAG];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

it("#1058 leaves shared IR opaque while still inlining an ordinary function", () => {
  // One physical call sits behind 2^28 incoming paths. The default-on inliner
  // must neither edge-walk that graph nor choose one incoming relocation/hotness
  // context for all of them.
  const sharedLeaf: Instr[] = [{ op: "call", funcIdx: 1 }];
  let sharedBody = sharedLeaf;
  for (let depth = 0; depth < 28; depth++) {
    sharedBody = [{ op: "if", blockType: { kind: "empty" }, then: sharedBody, else: sharedBody }];
  }

  const functions = [
    { name: "shared", typeIdx: 0, locals: [], body: sharedBody },
    { name: "shared_region_target", typeIdx: 0, locals: [], body: [{ op: "nop" } as Instr] },
    { name: "calls_shared", typeIdx: 0, locals: [], body: [{ op: "call", funcIdx: 0 } as Instr] },
    { name: "ordinary_target", typeIdx: 0, locals: [], body: [{ op: "nop" } as Instr] },
    { name: "ordinary_caller", typeIdx: 0, locals: [], body: [{ op: "call", funcIdx: 3 } as Instr] },
  ];
  const mod = {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    functions,
    globals: [],
    elements: [],
    exports: [],
    declaredFuncRefs: [],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;
  const ctx = {
    mod,
    moduleInitChunkHelperNames: new Set<string>(),
    numImportGlobals: 0,
    callerStrictGlobalIdx: -1,
    sourceFunctionStrictness: new Map(),
    sourceFunctionStrictnessByBody: new WeakMap(),
  } as unknown as CodegenContext;

  delete process.env[FLAG]; // shipped default: enabled
  inlineUserFunctions(ctx);

  expect(functions[0]!.body).toBe(sharedBody);
  expect(sharedLeaf).toEqual([{ op: "call", funcIdx: 1 }]);
  expect(functions[2]!.body).toEqual([{ op: "call", funcIdx: 0 }]);
  expect(functions[4]!.body.some((instr) => instr.op === "call" && instr.funcIdx === 3)).toBe(false);
});
