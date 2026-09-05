// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: `console` referenced as a VALUE (not `console.m(...)` call position)
// compiled to the null-externref fallback, so react's upstream
// `spyOnDevAndProd(console, 'log')` threw "Cannot access property on null or
// undefined" inside the spy helper (`target[key]`) for all 7 StrictMode
// console-logs-logging tests. Bare `console` now resolves to the real host
// global via `__extern_get(__get_globalThis(), "console")` — the same
// host-only path the ERM constructors use (gated off for standalone/wasi).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-console-value.ts",
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

describe("#4618 bare `console` as a first-class value", () => {
  it("passes the host console object, not null", async () => {
    const exp = await run(`
      function grab(target: any, key: any): any {
        const original = target[key];
        return typeof original;
      }
      export function asValue(): any {
        const c: any = console;
        return c === null ? "null" : c === undefined ? "undef" : typeof c;
      }
      export function asArg(): any { return grab(console, "log"); }
      export function methodRead(): any {
        const c: any = console;
        return typeof c.log;
      }`);
    expect((exp.asValue as () => unknown)()).toBe("object");
    expect((exp.asArg as () => unknown)()).toBe("function");
    expect((exp.methodRead as () => unknown)()).toBe("function");
  });
});
