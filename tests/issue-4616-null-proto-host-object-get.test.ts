// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest-docblock cluster, 19 tests) — `__extern_get` classified a
// genuine `Object.create(null)` HOST object as struct-ish from its null
// prototype alone: the direct read was skipped and the `__sget_<key>`
// struct-getter probe answered its miss-DEFAULT. Whenever any module struct
// had a `length` field (the jest harness's `{ length: count }` mock-call
// literals), `pragmas.length` answered 0 — a NUMBER — so the harness's
// deep-equal took its array arm and every docblock toEqual failed. Both
// __extern_get variants now gate on `_isWasmStruct` (extensibility +
// opaqueness probe), which classifies null-proto host objects correctly.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-null-proto.ts",
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

describe("#4616 null-proto host object property reads", () => {
  it("missing keys answer undefined even when a module struct has the same field name", async () => {
    const exp = await run(`
      let count = 0;
      function mockCalls(actual: any): any {
        if (actual === undefined) return { length: count };
        return actual && actual.mock && actual.mock.calls;
      }
      export function t(): string {
        void mockCalls;
        const o: any = Object.create(null);
        o.team = "foo";
        return String(typeof o.length) + "|" + String(o.team) + "|" + String(Object.keys(o));
      }`);
    expect(exp.t!()).toBe("undefined|foo|team");
  });
});
