// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (jest test.each idiom) — three defects in the call-of-call shape
// `__upstreamEach(cases)(name, body)` used by the generated jest harness:
//   1. The arrow argument was classified as a HOST callback (callee is a
//      CallExpression — no carve-out), wrapped in `__make_callback`, and the
//      receiving closure's guarded root cast nulled → un-catchable trap.
//   2. A declared rest callback param (`body: (...args: unknown[]) => void`)
//      resolved to ONE positional vec slot, so `body(row)` coerced its single
//      argument into a vec and matched only a `(vec) -> void` wrapper no
//      fixed-arity arrow satisfies.
//   3. `ensureLateImport("__box_number")` followed by `addUnionImports`
//      re-added the import — the adapter-manifest validator then rejected the
//      module ("duplicate adapter import 'env::__box_number' appears 2 times").

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-each.ts",
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

describe("#4616 test.each call-of-call idiom", () => {
  it("runs the each-table body for every case", async () => {
    const exp = await run(`
      let log: string[] = [];
      function it2(name: string, body: () => void): void {
        try { body(); log.push("pass:" + name); } catch (e) { log.push("fail:" + name); }
      }
      function __upstreamEach(cases: unknown[]) {
        return function(name: string, body: (...args: unknown[]) => void) {
          for (let i = 0; i < cases.length; i++) {
            const row = cases[i];
            it2(String(name) + ":" + i, function() { body(row); });
          }
        };
      }
      export function t(): string {
        __upstreamEach([1, 2])("case", (v: unknown) => {
          if (v === undefined || v === null) throw new Error("lost arg");
        });
        return log.join(",");
      }`);
    expect(exp.t!()).toBe("pass:case:0,pass:case:1");
  });

  it("a declared-rest callback receives positional call-site args", async () => {
    const exp = await run(`
      function driver(body: (...args: unknown[]) => void): void {
        body(7);
        body(8, 9);
      }
      export function t(): string {
        let s = "";
        driver((a: unknown, b: unknown) => { s += "[" + String(a) + "," + String(b) + "]"; });
        return s;
      }`);
    expect(exp.t!()).toBe("[7,undefined][8,9]");
  });
});
