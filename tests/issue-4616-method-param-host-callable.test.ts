// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest Replaceable cluster) — a callable PARAM of a CLASS METHOD can
// receive a host function at runtime (an any-receiver dynamic method call
// marshals its arrow argument through the host bridge; harnesses pass
// jest.fn() spies). The typed callable-param dispatch's guarded wrapper cast
// nulled and `call_ref` trapped un-catchably ("dereferencing a null
// pointer"). Method params now get the #1712 `__call_function` host arm.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-method-param.ts",
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

describe("#4616 method callable param receives host-bridged function", () => {
  it("class method invoking its callback param works through an any-receiver call", async () => {
    const exp = await run(`
      class Rep {
        object: any;
        constructor(object: any) { this.object = object; }
        forEach(cb: (value: unknown, key: unknown, object: unknown) => void): void {
          const descriptors = Object.getOwnPropertyDescriptors(this.object);
          for (const key of Object.keys(descriptors)) {
            cb(this.object[key], key, this.object);
          }
        }
      }
      export function t(): string {
        const r: any = new Rep({ a: 1, b: 2 });
        const seen: string[] = [];
        r.forEach((v: any, k: any) => { seen.push(String(k) + "=" + String(v)); });
        return seen.join(",");
      }`);
    expect(exp.t!()).toBe("a=1,b=2");
  });
});
