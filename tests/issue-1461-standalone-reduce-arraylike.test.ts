import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1461 / #54 — standalone `Array.prototype.reduce`/`reduceRight.call(arrayLike,
 * cb, init)` over a non-array receiver (`{0:…, 1:…, length:n}`, an `arguments`
 * object, …).
 *
 * The standalone lane refused these loudly (the generic `$Object` arm would leak
 * a host import / emit invalid Wasm). The **with-initial-value** form is in fact
 * host-import-free (the accumulator boxes through the native `__box_number`), so
 * it is allowed through and produces valid, correct Wasm. The **no-initial-value**
 * form's §23.1.3.21 forward hole-scan still trips a module-finalization
 * func-index shift (→ invalid Wasm), so it stays gracefully refused (compile
 * error, NOT invalid Wasm) until that separate bug is fixed.
 */
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

async function compileResult(source: string): Promise<{ success: boolean; validWasm: boolean }> {
  const r = await compile(source, { target: "standalone" });
  return { success: r.success, validWasm: r.success ? WebAssembly.validate(r.binary) : false };
}

describe("#1461/#54 — standalone reduce/reduceRight.call over an array-like receiver", () => {
  it("reduce.call(arrayLike, cb, init) sums correctly", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const o: any = {0:1, 1:2, 2:3, length:3};
           const r: any = Array.prototype.reduce.call(o, (a:any,x:any)=>(a as number)+(x as number), 0);
           return Number(r);
         }`,
      ),
    ).toBe(6);
  });

  it("reduceRight.call(arrayLike, cb, init) folds from the right", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const o: any = {0:1, 1:2, 2:3, length:3};
           const r: any = Array.prototype.reduceRight.call(o, (a:any,x:any)=>(a as number)+(x as number), 10);
           return Number(r);
         }`,
      ),
    ).toBe(16);
  });

  it("reduce.call over an arguments object works with an initial value", async () => {
    expect(
      await runStandalone(
        `function g(): number {
           const r: any = Array.prototype.reduce.call(arguments, (a:any,x:any)=>(a as number)+(x as number), 100);
           return Number(r);
         }
         export function run(): number { return g(); }`,
      ),
    ).toBe(100);
  });

  it("reduce.call with NO initial value gracefully refuses (compile error, not invalid Wasm)", async () => {
    const { success, validWasm } = await compileResult(
      `export function run(): number {
         const o: any = {0:1, 1:2, length:2};
         const r: any = Array.prototype.reduce.call(o, (a:any,x:any)=>(a as number)+(x as number));
         return Number(r);
       }`,
    );
    // Must NOT compile to an invalid module: either a clean compile error, or
    // (once the finalization-shift bug is fixed) a valid module — never invalid Wasm.
    expect(success ? validWasm : true).toBe(true);
  });
});
