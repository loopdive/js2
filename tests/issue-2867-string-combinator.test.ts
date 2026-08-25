// #2867 string-combinator slice — native, host-free Promise combinators over a
// STRING argument. Strings are iterable per §22.1.5 (the String iterator yields
// code points, surrogate pairs kept whole), so `Promise.all('ab')` must fulfil
// with `['a', 'b']` instead of falling through to the unsatisfiable
// `Promise_all` host import. The drain arm lives in `__combinator_to_vec`
// (`buildToVecStringArm`, promise-combinators.ts); the compile-time admission is
// the `stringArm` predicate in `isDynamicCombinatorArgEligible` (calls.ts).
//
// Host-free: instantiate with no imports, drive settlement with the module's
// own `__drain_microtasks` export. Runs on BOTH carrier lanes (wasi +
// standalone — live since the #2980 widen).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(body: string, reads: string[], target: "wasi" | "standalone"): Promise<Record<string, number>> {
  const src = `
let ff = 0;
let rj = 0;
let val = 0;
${body}
export function getFf(): number { return ff; }
export function getRj(): number { return rj; }
export function getVal(): number { return val; }
`;
  const r = await compile(src, { fileName: "t.ts", target });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  // The string arm is native: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, CallableFunction>;
  ex.run!();
  ex.__drain_microtasks?.();
  const out: Record<string, number> = {};
  for (const n of reads) out[n] = ex[n]!() as number;
  return out;
}

for (const target of ["wasi", "standalone"] as const) {
  describe(`#2867 string combinator (${target} carrier)`, () => {
    it("Promise.all over a string fulfils with its characters", async () => {
      const r = await run(
        `
        export function run(): void {
          Promise.all("abc").then(
            (arr: any[]) => {
              val = arr.length;
              const s0 = arr[0] as string;
              const s2 = arr[2] as string;
              ff = s0.charCodeAt(0) * 1000 + s2.charCodeAt(0);
            },
            (e: any) => { rj = -1; },
          );
        }
        `,
        ["getVal", "getFf", "getRj"],
        target,
      );
      // 'a' = 97, 'c' = 99
      expect(r).toEqual({ getVal: 3, getFf: 97099, getRj: 0 });
    });

    it("Promise.all('') fulfils immediately with an empty array", async () => {
      const r = await run(
        `
        export function run(): void {
          Promise.all("").then(
            (arr: any[]) => { ff = 1; val = arr.length; },
            (e: any) => { rj = -1; },
          );
        }
        `,
        ["getFf", "getVal", "getRj"],
        target,
      );
      expect(r).toEqual({ getFf: 1, getVal: 0, getRj: 0 });
    });

    it("iterates by code point: a surrogate pair is one element", async () => {
      const r = await run(
        `
        export function run(): void {
          // "a" + U+1F600 (2 code units) + "b" — 4 units, 3 code points
          Promise.all("a\\u{1F600}b").then(
            (arr: any[]) => {
              val = arr.length;
              const mid = arr[1] as string;
              ff = mid.length; // the pair stays whole: 2 code units
            },
            (e: any) => { rj = -1; },
          );
        }
        `,
        ["getVal", "getFf", "getRj"],
        target,
      );
      expect(r).toEqual({ getVal: 3, getFf: 2, getRj: 0 });
    });

    it("Promise.race over a string fulfils with the first character", async () => {
      const r = await run(
        `
        export function run(): void {
          Promise.race("xy").then(
            (v: any) => { const s = v as string; val = s.charCodeAt(0); },
            (e: any) => { rj = -1; },
          );
        }
        `,
        ["getVal", "getRj"],
        target,
      );
      expect(r).toEqual({ getVal: 120, getRj: 0 }); // 'x'
    });

    it("a string reaching the drain through an any-typed value takes the string arm", async () => {
      const r = await run(
        `
        export function run(): void {
          const x: any = "hi";
          Promise.all(x).then(
            (arr: any[]) => { val = arr.length; },
            (e: any) => { rj = -1; },
          );
        }
        `,
        ["getVal", "getRj"],
        target,
      );
      expect(r).toEqual({ getVal: 2, getRj: 0 });
    });

    it("non-iterable numbers still reject with a TypeError", async () => {
      const r = await run(
        `
        export function run(): void {
          const x: any = 42;
          Promise.all(x).then(
            (arr: any[]) => { ff = 1; },
            (e: any) => { rj = 1; },
          );
        }
        `,
        ["getFf", "getRj"],
        target,
      );
      expect(r).toEqual({ getFf: 0, getRj: 1 });
    });
  });
}
