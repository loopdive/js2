// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2507 — standalone `any[].find(cb)` / `any[].findLast(cb)` emitted invalid
// Wasm: `local.set[0] expected type f64, found local.get of type externref`.
// `find`/`findLast` return the matched ELEMENT; for a boxed-any (`externref`)
// element array (`any[]`, `new Array(N)`) the element is an `externref`, but the
// non-fast (standalone) result local was typed f64 with a NaN "not found"
// sentinel — so the externref element `local.set` into the f64 local failed
// validation. `findIndex`/`findLastIndex` (which return an index, not the
// element) were unaffected.
//
// Fix (compileArrayFind / compileArrayFindLast): when the element kind is
// `externref`, keep the result type `externref` with a `ref.null.extern`
// (undefined) "not found" sentinel — which is also the correct spec result.
// Numeric / boolean / string-ref element finds are unchanged.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).run();
}

const fn = (body: string) => `export function run(): number { ${body} }`;

describe("#2507 — standalone any[] find/findLast return the externref element", () => {
  it("any[].find returns the matched element value", async () => {
    expect(
      await runStandalone(fn(`const a: any[] = [1, 2, 3]; return a.find((x: any) => (x as number) > 1) as number;`)),
    ).toBe(2);
  });

  it("any[].find returns undefined when nothing matches", async () => {
    expect(
      await runStandalone(
        fn(
          `const a: any[] = [1, 2, 3]; const r = a.find((x: any) => (x as number) > 9); return r === undefined ? -1 : (r as number);`,
        ),
      ),
    ).toBe(-1);
  });

  it("any[].findLast returns the last matched element", async () => {
    expect(
      await runStandalone(
        fn(`const a: any[] = [1, 2, 3]; return a.findLast((x: any) => (x as number) > 1) as number;`),
      ),
    ).toBe(3);
  });

  it("any[] with string elements: find by predicate returns the element", async () => {
    expect(
      await runStandalone(
        fn(
          `const a: any[] = ["aa", "bbb"]; const r = a.find((x: any) => (x as string).length > 2); return (r as string).length;`,
        ),
      ),
    ).toBe(3);
  });

  // ── regressions: typed-element finds + the index variants are unchanged ──
  it("number[].find still returns the element value", async () => {
    expect(await runStandalone(fn(`const a = [1, 2, 3]; return a.find((x) => x > 1) as number;`))).toBe(2);
  });

  it("number[].findLast still returns the last matching element", async () => {
    expect(await runStandalone(fn(`const a = [5, 2, 8]; return a.findLast((x) => x > 3) as number;`))).toBe(8);
  });

  it("any[].findIndex still returns the index (unaffected)", async () => {
    expect(
      await runStandalone(fn(`const a: any[] = [1, 2, 3]; return a.findIndex((x: any) => (x as number) > 1);`)),
    ).toBe(1);
  });
});
