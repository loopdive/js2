// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest Replaceable "Type null is not support") — a literal with a
// computed SYMBOL key (`{ a: 1, [symbolKey]: 3 }`) routes its VALUE to the
// host plain-object path (#2126), but the un-annotated local's slot stayed
// struct-typed: the store null-cast and every later read answered NULL in
// the lifted-closure lanes. The local typing now consults the SAME
// `objectLiteralForcesHostPath` predicate as the literal routing (#2804
// lockstep discipline).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-computed-symbol.ts",
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

describe("#4616 computed-symbol-key literal local typing", () => {
  it("un-annotated local holding a symbol-keyed literal reads back intact from a registered closure", async () => {
    const exp = await run(`
      const tests: any[] = [];
      function it2(name: string, body: any) { tests.push({ body: function (a: any) { return body(a); } }); }
      it2("x", () => {
        const symbolKey = Symbol("jest");
        const object = { a: 1, b: 2, [symbolKey]: 3 };
        return String(object === null) + "|" + String((object as any).a) + "|" + String((object as any)[symbolKey]) + "|" + String(Object.keys(object));
      });
      export function t(): string {
        return String(tests[0].body(undefined));
      }`);
    expect(exp.t!()).toBe("false|1|3|a,b");
  });
});
