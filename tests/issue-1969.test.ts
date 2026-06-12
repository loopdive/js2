// #1969 — `__array_concat_any` (the host bridge used when a concat argument is
// `any`-typed) appended array arguments whole instead of spreading them, so
// `[1,2].concat(x)` with `x` an array gave `[1,2,x]` (length 3, x read back as
// NaN) instead of `[1,2,...x]`. §23.1.3.1.1 IsConcatSpreadable step 2: a true
// Array (or a WasmGC vec — the compiled form of one) is ALWAYS spread.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const result = await compile(src, { skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return (instance.exports as { test(): unknown }).test();
}

describe("#1969 concat spreads array arguments (IsConcatSpreadable)", () => {
  it("spreads a single any-typed array argument", async () => {
    const got = await run(`export function test(): string {
      const a: any = [5, 6];
      const c = [1, 2].concat(a);
      return c.length + ":" + String(c[2]) + ":" + String(c[3]);
    }`);
    expect(got).toBe("4:5:6"); // node: [1,2,5,6]
  });

  it("spreads multiple any-typed array arguments in order", async () => {
    const got = await run(`export function test(): string {
      const a: any = [3, 4];
      const b: any = [5];
      const c = [1, 2].concat(a, b);
      return c.length + ":" + String(c[2]) + ":" + String(c[4]);
    }`);
    expect(got).toBe("5:3:5"); // node: [1,2,3,4,5]
  });

  it("an empty array argument contributes nothing", async () => {
    const got = await run(`export function test(): number {
      const a: any = [];
      return [1, 2].concat(a).length;
    }`);
    expect(got).toBe(2);
  });

  it("interleaves spread arrays with scalar arguments", async () => {
    const got = await run(`export function test(): string {
      const a: any = [10, 20];
      const c = [1].concat(a, 99 as any);
      return c.length + ":" + String(c[1]) + ":" + String(c[3]);
    }`);
    expect(got).toBe("4:10:99"); // node: [1,10,20,99]
  });

  it("spreads the top level of a nested array argument (depth-1, element count)", async () => {
    // Primary fix: the argument is spread, so the result length is correct and
    // the leading scalar element survives. (Deep round-trip of a NESTED inner
    // array element through externref is a separate representation limitation —
    // see the issue's residual note; element count + scalar value are correct.)
    const got = await run(`export function test(): number {
      const x: any = [5, [6]];
      return [1, 2].concat(x).length;
    }`);
    expect(got).toBe(4); // node length: [1,2,5,[6]]
  });
});
