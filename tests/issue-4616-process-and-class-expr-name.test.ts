// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest globals + convertDescriptorToString residuals):
// 1. The bare `process` global fell to the graceful-null default —
//    `Object.prototype.toString.call(process)` answered "[object Null]".
//    It now rides the #3087 host-global materialization lane like `Buffer`.
// 2. A NAMED class-expression VALUE (`class Named {}` in a test table) lost
//    its §10.2.9 `.name` across module boundaries; the ctor-value read now
//    stamps the declared name into the sidecar (both the synthetic-name and
//    named-collection arms of compileClassExpression).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-process-class-name.ts",
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

describe("#4616 process global + class-expression name", () => {
  it("bare process reads the host global with its toStringTag", async () => {
    const exp = await run(`
      export function t(): string {
        const p: any = process;
        return typeof p.pid + "|" + Object.prototype.toString.call(process);
      }`);
    expect(exp.t!()).toBe("number|[object process]");
  });

  it("named function/class expression values carry .name across a dynamic read", async () => {
    const exp = await run(`
      function conv(descriptor: any): string {
        if (typeof descriptor === "function" && descriptor.name) return descriptor.name;
        throw new Error("Invalid");
      }
      export function t(): string {
        const table: any[] = [[function named() {}, "named"], [class Named {}, "Named"]];
        const out: string[] = [];
        for (const [input] of table) out.push(conv(input));
        return out.join(",");
      }`);
    expect(exp.t!()).toBe("named,Named");
  });
});
