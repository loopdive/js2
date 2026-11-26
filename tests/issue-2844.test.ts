import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// #2844 — for-of / for-await array-pattern REST element bound to a nested OBJECT
// pattern (`[...{ 0: v, length: z }]`) dropped the object-pattern bindings: the
// rest vec was treated as a plain named struct (no field `0`), so numeric-key
// bindings stayed at their NaN default. The rest target is array-like per
// §13.3.3.6 — `length` -> A.length, integer key k -> A[k] (OOB -> undefined).

async function run(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const instance = await instantiateWithRuntime(r);
  let ret = (instance.exports as any).test();
  if (ret && typeof ret.then === "function") ret = await ret;
  return ret;
}

describe("#2844 for-of/for-await array rest element bound to a nested pattern", () => {
  it("for-of: rest -> object pattern with numeric + length keys", async () => {
    const src = `
      export function test(): number {
        let out = 0;
        for (let [...{ 0: v, length: z }] of [[7, 8, 9]]) { out = v * 100 + z; }
        return out; // v=7, z=3 -> 703
      }`;
    expect(await run(src)).toBe(703);
  });

  it("for-await: rest -> object pattern with numeric + length keys", async () => {
    const src = `
      export async function test(): Promise<number> {
        let out = 0;
        for await (let [...{ 0: v, length: z }] of [[7, 8, 9]]) { out = v * 100 + z; }
        return out; // v=7, z=3 -> 703
      }`;
    expect(await run(src)).toBe(703);
  });

  it("for-of: full cluster shape — OOB key binds undefined, length reads vec length", async () => {
    // Mirrors test262 for-of/dstr/let-ary-ptrn-rest-obj-prop-id:
    //   [...{ 0: v, 1: w, 2: x, 3: y, length: z }] over [[7,8,9]]
    //   v=7, w=8, x=9, y=undefined (OOB), z=3
    const src = `
      export function test(): number {
        let out = 0;
        for (let [...{ 0: v, 1: w, 2: x, 3: y, length: z }] of [[7, 8, 9]]) {
          let yUndef = (y !== y) ? 1 : 0; // OOB read is undefined (NaN in f64)
          out = v * 1000 + w * 100 + x * 10 + z + yUndef * 100000;
        }
        return out; // 100000 + 7000 + 800 + 90 + 3
      }`;
    expect(await run(src)).toBe(107893);
  });

  it("for-of: rest -> object pattern shorthand { length } (obj-id cluster)", async () => {
    // Mirrors test262 for-of/dstr/let-ary-ptrn-rest-obj-id: [...{ length }]
    const src = `
      export function test(): number {
        let out = -1;
        for (let [...{ length }] of [[1, 2, 3]]) { out = length; }
        return out; // 3
      }`;
    expect(await run(src)).toBe(3);
  });

  it("for-of: fixed bindings followed by rest -> object pattern", async () => {
    const src = `
      export function test(): number {
        let out = 0;
        for (let [a, ...{ 0: b, length: z }] of [[7, 8, 9, 10]]) {
          out = a * 1000 + b * 100 + z; // a=7, rest=[8,9,10] -> b=8, z=3
        }
        return out; // 7000 + 800 + 3
      }`;
    expect(await run(src)).toBe(7803);
  });

  it("for-await: full cluster shape (async)", async () => {
    const src = `
      export async function test(): Promise<number> {
        let out = 0;
        for await (let [...{ 0: v, 1: w, 2: x, 3: y, length: z }] of [[7, 8, 9]]) {
          let yUndef = (y !== y) ? 1 : 0;
          out = v * 1000 + w * 100 + x * 10 + z + yUndef * 100000;
        }
        return out;
      }`;
    expect(await run(src)).toBe(107893);
  });

  // ---- Controls that must keep working (regression guards) ----

  it("control: for-of rest -> array pattern [...[a, b]] (already worked)", async () => {
    const src = `
      export function test(): number {
        let out = 0;
        for (let [...[a, b]] of [[7, 8, 9]]) { out = a * 100 + b; }
        return out; // 708
      }`;
    expect(await run(src)).toBe(708);
  });

  it("control: for-of rest -> identifier [...rest] (already worked)", async () => {
    const src = `
      export function test(): number {
        let out = 0;
        for (let [...rest] of [[7, 8, 9]]) { out = rest[0] * 100 + rest.length; }
        return out; // 703
      }`;
    expect(await run(src)).toBe(703);
  });

  it("control: for-await rest -> array pattern [...[a, b]] (already worked)", async () => {
    const src = `
      export async function test(): Promise<number> {
        let out = 0;
        for await (let [...[a, b]] of [[7, 8, 9]]) { out = a * 100 + b; }
        return out; // 708
      }`;
    expect(await run(src)).toBe(708);
  });

  // ---- Param / var-decl lanes (shared helper) stay correct ----

  it("param lane: function([...{ 0: v, length: z }]) (shared helper)", async () => {
    const src = `
      function f([...{ 0: v, length: z }]: number[]): number { return v * 100 + z; }
      export function test(): number { return f([7, 8, 9]); }`;
    expect(await run(src)).toBe(703);
  });

  it("var-decl lane: var [...{ 0: v, length: z }] = [...] (shared helper)", async () => {
    const src = `
      export function test(): number {
        var [...{ 0: v, length: z }] = [7, 8, 9];
        return v * 100 + z;
      }`;
    expect(await run(src)).toBe(703);
  });
});
