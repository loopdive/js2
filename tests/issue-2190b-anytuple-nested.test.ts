// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2190-residual — standalone nested element access on an `any[]` whose elements
// are HETEROGENEOUS tuples (`[["a", 1], ["b", 2]]`, the canonical
// `Object.fromEntries` entries shape) trapped with "dereferencing a null
// pointer". The array-literal first-element heuristic picked `$AnyString` for the
// whole vec (element 0 is "a"), then the number element was emitted as
// `f64.const 1; drop` and replaced with `ref.null $AnyString; ref.as_non_null`
// — a guaranteed null-deref on a later read of `e[i][1]`.
//
// Fix (literals.ts compileArrayLiteral): when the first-element heuristic picked
// a native-string element type but the literal contains a NON-string element,
// widen the vec to `externref` (mirroring the existing numeric-first
// `hasObjectElem` widening) so each element is boxed by its own static type at
// construction (`__box_number` / native-string / …). number[] / string[] /
// homogeneous literals are untouched.
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

describe("#2190b — standalone nested access on an any[] of heterogeneous tuples", () => {
  it("any[] of [string,number] tuples: e[0][1] reads the number (was null-deref)", async () => {
    expect(await runStandalone(fn(`const e: any[] = [["a", 1]]; return e[0][1] as number;`))).toBe(1);
  });

  it("multiple tuples: e[1][1]", async () => {
    expect(await runStandalone(fn(`const e: any[] = [["a", 1], ["b", 2]]; return e[1][1] as number;`))).toBe(2);
  });

  it("the string element of the tuple still reads correctly: e[0][0].length", async () => {
    expect(await runStandalone(fn(`const e: any[] = [["a", 1]]; return (e[0][0] as string).length;`))).toBe(1);
  });

  it("a hand-rolled fromEntries over the any[] tuples now works end-to-end", async () => {
    expect(
      await runStandalone(
        fn(
          `const e: any[] = [["a", 1], ["b", 2]]; const o: any = {}; for (let i = 0; i < e.length; i++) { const p: any = e[i]; o[p[0]] = p[1]; } return o.a as number;`,
        ),
      ),
    ).toBe(1);
  });

  it("flat mixed-scalar any[] still works (string + number + boolean)", async () => {
    expect(await runStandalone(fn(`const a: any[] = [1, "x", true]; return (a[1] as string).length;`))).toBe(1);
    expect(await runStandalone(fn(`const a: any[] = [0, "a"]; return a[0] as number;`))).toBe(0);
  });

  // ── regression: homogeneous literals untouched ──
  it("number[] / string[] / number[][] unchanged", async () => {
    expect(await runStandalone(fn(`const a = [1, 2, 3]; return a[1];`))).toBe(2);
    expect(await runStandalone(fn(`const a = ["x", "yy"]; return a[1].length;`))).toBe(2);
    expect(await runStandalone(fn(`const e: number[][] = [[1, 2]]; return e[0][1];`))).toBe(2);
  });

  it("all-string any[] unchanged", async () => {
    expect(await runStandalone(fn(`const a: any[] = ["x", "y"]; return (a[0] as string).length;`))).toBe(1);
  });
});
