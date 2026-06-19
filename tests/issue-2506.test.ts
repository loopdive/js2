import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2506 — standalone `any[]` / boxed-any element `Array.prototype.find` &
 * `findLast`.
 *
 * `find`/`findLast` return the matched *element*. The standalone (`!ctx.fast`)
 * lane defaulted the result local to f64 and `local.set` the element into it —
 * but a boxed-any (`any[]`) element is an externref, producing **invalid Wasm**
 * (`local.set[0] expected type f64, found ... externref`). `findIndex`/
 * `findLastIndex` (return i32) and `number[]`/`string[]` find were unaffected.
 *
 * Fix: for a ref-typed element keep the find result slot + return type as an
 * externref, with `ref.null.extern` (the `undefined` sentinel) for not-found.
 *
 * These assert valid Wasm + the spec-correct found / not-found behaviour.
 */
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2506 — standalone any[] find / findLast (valid Wasm + spec value)", () => {
  it("find returns the matched numeric element", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1,2,3]; const v = a.find(x => x === 2); return typeof v === "number" ? (v as number) : -99; }`,
      ),
    ).toBe(2);
  });

  it("find returns undefined (not NaN/0) when no element matches", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1,2,3]; const v = a.find(x => x === 9); return v === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("find returns a matched string element", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = ["a","bb","ccc"]; const v = a.find(x => (x as string).length === 2); return typeof v === "string" ? (v as string).length : -1; }`,
      ),
    ).toBe(2);
  });

  it("findLast returns the last matched element", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1,2,2,3]; const v = a.findLast(x => x === 2); return typeof v === "number" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("number[] find is unaffected (control)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: number[] = [1,2,3]; const v = a.find(x => x === 2); return v ?? 0; }`,
      ),
    ).toBe(2);
  });

  it("findIndex over any[] is unaffected (control)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1,2,3]; return a.findIndex(x => x === 2); }`,
      ),
    ).toBe(1);
  });
});
