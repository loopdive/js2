// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest deepCyclicCopy keepPrototype family): patching `Array.isArray`
// with a COMPILED closure (jest.spyOn(Array, 'isArray').mockImplementation)
// stack-overflowed: the runtime's own arg-conversion helpers read the live
// `Array.isArray`, so calling the patch recursed spy → trampoline → arg
// conversion → patched isArray → spy. Internal runtime decisions now use the
// module-load `_nativeIsArray` snapshot; only the user-visible
// `__extern_is_array` lane still reads the live global (so the patch is
// observable where the spec says it is).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-patched-isarray.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 patched Array.isArray with a compiled implementation", () => {
  it("calls the patch without recursing through arg conversion, then restores", async () => {
    const exp = await run(`
      export function t(): string {
        const marker: any = { tag: 1 };
        const A: any = Array;
        const orig = A.isArray;
        A.isArray = (x: any) => x === marker;
        const r1 = A.isArray([1, 2]);
        const r2 = A.isArray(marker);
        A.isArray = orig;
        const r3 = A.isArray([1, 2]);
        return String(r1) + "," + String(r2) + "," + String(r3);
      }`);
    expect(exp.t!()).toBe("false,true,true");
  });
});
