// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest vi.fn spies) — a nested `function spy()` that reads itself as a
// VALUE (`spy.mock.calls.push(...)`) while capturing an outer variable got no
// stable identity binding, so every self-read re-materialized a fresh closure
// struct: the `spy.mock = {...}` written on the returned instance answered
// undefined inside the body and every spy crashed. Three gaps closed:
//   1. hasStableFunctionValueCaptureAbi now accepts captures of the enclosing
//      function's PARAMS and of boxed capture cells (both entry-stable).
//   2. The lifted-closure and callback body lanes run the same
//      hoistFunctionDeclarations pre-pass as plain function bodies.
//   3. Struct-lowered object-literal METHOD bodies (the `vi.fn` shape) do too.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-spy.ts",
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

describe("#4616 spy self-identity", () => {
  it("a capture-carrying nested function sees its own properties", async () => {
    const exp = await run(`
      let log: string[] = [];
      function makeSpy(implementation: any) {
        function spy() {
          const args = Array.prototype.slice.call(arguments);
          (spy as any).mock.calls.push(args);
          if (typeof implementation === "function") return implementation.apply(this, args);
        }
        (spy as any).mock = { calls: [] };
        return spy;
      }
      export function t(): string {
        const s = makeSpy(function() { log.push("impl"); });
        (Error as any).captureStackTrace = s;
        (Error as any).captureStackTrace(9, 8);
        return log.join(",") + ",calls=" + String((s as any).mock.calls.length);
      }`);
    expect(exp.t!()).toBe("impl,calls=1");
  });

  it("the vi.fn object-literal-method shape works", async () => {
    const exp = await run(`
      let log: string[] = [];
      const vi = {
        fn(implementation: any) {
          function spy() {
            const args = Array.prototype.slice.call(arguments);
            (spy as any).mock.calls.push(args);
            if (typeof implementation === "function") return implementation.apply(this, args);
          }
          (spy as any).mock = { calls: [] };
          return spy;
        },
      };
      export function t(): string {
        const s: any = vi.fn(function() { log.push("impl"); });
        s(1, 2);
        return log.join(",") + ",calls=" + String(s.mock.calls.length);
      }`);
    expect(exp.t!()).toBe("impl,calls=1");
  });
});
