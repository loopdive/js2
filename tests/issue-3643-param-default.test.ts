// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3643 follow-up — an array-literal argument to an unannotated array
// binding-pattern parameter must reach the callee as a destructurable value.
//
// `function f([a, b = 9])` widens its parameter to externref (#862; nested
// declarations since #6653), but TypeScript still types the call-site literal
// `[1]` with the pattern's contextual tuple `[any, number?]`. In JS-host mode
// the internal-call argument path compiled that literal as a `$__tuple_*`
// struct and boxed it with `extern.convert_any`. The callee's destructure only
// recognises vec carriers, so it fell through to host GetIterator on an opaque
// struct: `TypeError: value is not iterable` (or NaN before the strict drain).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<Record<string, any>> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(
    result.success,
    `Compile failed:\n${(result.errors ?? []).map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#3643 — array-literal argument to a binding-pattern parameter (host mode)", () => {
  it("nested declaration with a defaulted element", async () => {
    const e = await run(`
      // @ts-nocheck
      export function paramDefault() { function f([a, b = 9]) { return a + b; } return f([1]); }
      export function fullArgs() { function f([a, b = 9]) { return a + b; } return f([1, 2]); }
      export function noDefault() { function f([a, b]) { return a * 10 + b; } return f([3, 4]); }
      export function onlyDefault() { function f([a, b = 9]) { return b; } return f([1]); }
    `);
    expect(e.paramDefault()).toBe(10);
    expect(e.fullArgs()).toBe(3);
    expect(e.noDefault()).toBe(34);
    expect(e.onlyDefault()).toBe(9);
  });

  it("top-level declaration with a defaulted element", async () => {
    const e = await run(`
      // @ts-nocheck
      function g([a, b = 9]) { return a + b; }
      export function topLevel() { return g([1]); }
      function s([x, y = "z"]) { return x + y; }
      export function strings() { return s(["a"]); }
    `);
    expect(e.topLevel()).toBe(10);
    expect(e.strings()).toBe("az");
  });

  it("heterogeneous literal argument", async () => {
    const e = await run(`
      // @ts-nocheck
      function f([a, b]) { return a + b; }
      export function mixed() { return f([1, "x"]); }
    `);
    expect(e.mixed()).toBe("1x");
  });

  it("controls — non-literal arguments and pattern defaults still bind", async () => {
    const e = await run(`
      // @ts-nocheck
      export function viaVar() { function f([a, b = 9]) { return a + b; } var arr = [1]; return f(arr); }
      export function patternDefault() { function h([x] = [4]) { return x; } return h(); }
    `);
    expect(e.viaVar()).toBe(10);
    expect(e.patternDefault()).toBe(4);
  });
});
