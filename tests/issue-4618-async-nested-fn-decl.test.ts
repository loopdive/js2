// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618 defect (c): a nested function declaration inside an async EXPORT
// function was a hard CE — the async parent reaches prepared-unit slot
// binding before Phase 3 lowers the lifted nested body, so the fresh
// allocator slot still carried the placeholder typeIdx 0 (a struct type) and
// preparedUnitProgramAbiBinding threw "has non-function type 0". Planning is
// now deferred for placeholder slots (empty body); the slot resolves by
// funcIdx and the Phase-3 patch lands in place.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-async-nested-fn.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

describe("#4618 nested function declaration in an async export", () => {
  it("compiles and the nested function captures the enclosing const", async () => {
    const exp = await run(`
      export async function t(): Promise<string> {
        const marker = "captured-ok";
        function inner(): string {
          return marker;
        }
        return inner();
      }`);
    expect(await exp.t!()).toBe("captured-ok");
  });
});
