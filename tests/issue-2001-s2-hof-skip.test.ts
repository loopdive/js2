// (#2001 S2) Sparse-array HOF visit-SKIP on the dense WasmGC vec.
//
// S1 introduced the `$Hole` sentinel and a universal `$Hole → undefined`
// value-read mapping, so a *visited* hole reads as `undefined`. S2 adds the
// genuine §23.1.3.* visit semantics that the read-mapping alone cannot give:
//   • forEach/some/every/reduce/reduceRight/indexOf/lastIndexOf SKIP a hole —
//     the callback is NOT invoked and the hole never matches an `indexOf` /
//     contributes to a `reduce` fold.
//   • map produces a RESULT hole at the hole index (callback not called; the
//     result slot is `$Hole`, so it renders as "" in join), preserving sparsity.
//   • filter omits holes (a hole contributes nothing).
//   • includes does NOT skip (it uses Get, so `[,].includes(undefined) === true`)
//     — verified to remain S1's hole→undefined read behaviour.
//   • find/findIndex/findLast/findLastIndex use Get (not HasProperty), so they
//     VISIT a hole observing `undefined` — left to S1's read-map (NOT skipped).
//
// Scope: ONLY `any[]` / untyped externref-element vecs. A typed `number[]`
// kernel (f64 element) is byte-identical — the skip gate is element-typed
// (`externref` only), never a `ref.test` on an f64/i32 vec.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

// Standalone harness — `$Hole` is pure WasmGC, so the skip gate works engine-
// native with no host import; assert via numbers / `.length` to avoid decoding
// native strings.
async function runStandalone(source: string, fn = "run"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]();
}

describe("#2001 S2 — sparse-array HOF visit-skip (any[] only)", () => {
  describe("forEach / map / filter — the headline visit-skip", () => {
    it("forEach does NOT visit a hole (count 2, not 3)", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1, , 3]; let c = 0; a.forEach(() => { c++; }); return c; }`,
        ),
      ).toBe(2);
    });

    it("map skips the callback at a hole and preserves a result hole", async () => {
      // Visit count is 2 (callback not called on the hole) and the result hole
      // renders as "" in join: [10, <hole>, 30] → "10,,30".
      expect(
        await run(
          `export function run(): number { const a: any[] = [1, , 3]; let c = 0; a.map((x: any) => { c++; return x; }); return c; }`,
        ),
      ).toBe(2);
      expect(
        await run(
          `export function run(): string { const a: any[] = [1, , 3]; return a.map((x: any) => (x as number) * 10).join(","); }`,
        ),
      ).toBe("10,,30");
    });

    it("filter omits holes (a hole contributes nothing)", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1, , 3]; return a.filter(() => true).length; }`),
      ).toBe(2);
    });
  });

  describe("some / every — hole skipped, not observed as undefined", () => {
    it("some does NOT see a hole as undefined", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1, , 3]; return a.some((x: any) => x === undefined); }`,
        ),
      ).toBe(0);
      // …but an EXPLICIT undefined element IS seen.
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1, undefined, 3]; return a.some((x: any) => x === undefined); }`,
        ),
      ).toBe(1);
    });

    it("every is not falsified by a hole (hole skipped)", async () => {
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [2, , 4]; return a.every((x: any) => (x as number) % 2 === 0); }`,
        ),
      ).toBe(1);
    });
  });

  describe("indexOf / lastIndexOf / includes — Get vs HasProperty", () => {
    it("indexOf(undefined) does NOT match a hole (HasProperty) → -1", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1, , 3]; return a.indexOf(undefined); }`),
      ).toBe(-1);
    });

    it("lastIndexOf(undefined) does NOT match a hole → -1, but a present value still matches", async () => {
      expect(
        await run(`export function run(): number { const a: any[] = [1, , 3]; return a.lastIndexOf(undefined); }`),
      ).toBe(-1);
      expect(await run(`export function run(): number { const a: any[] = [3, , 3]; return a.lastIndexOf(3); }`)).toBe(
        2,
      );
    });

    it("includes(undefined) DOES match a hole (Get) → true — NOT skipped", async () => {
      expect(
        await run(`export function run(): boolean { const a: any[] = [1, , 3]; return a.includes(undefined); }`),
      ).toBe(1);
    });
  });

  describe("reduce / reduceRight — holes skipped for seed-seek and fold", () => {
    it("reduce skips holes in the fold", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [5, , , 2]; return a.reduce((x: any, y: any) => (x as number) + (y as number)) as number; }`,
        ),
      ).toBe(7);
    });

    it("reduce no-initial-value seeks the first PRESENT element", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [, 5, 2]; return a.reduce((x: any, y: any) => (x as number) + (y as number)) as number; }`,
        ),
      ).toBe(7);
    });

    it("reduce with an initial value skips holes", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [1, , 3]; return a.reduce((x: any, y: any) => (x as number) + (y as number), 100) as number; }`,
        ),
      ).toBe(104);
    });

    it("reduce on an all-holes array (no initial value) throws TypeError", async () => {
      expect(
        await run(
          `export function run(): string { const a: any[] = [, ,]; try { a.reduce((x: any, y: any) => x); return "no-throw"; } catch (e) { return "threw"; } }`,
        ),
      ).toBe("threw");
    });

    it("reduceRight skips holes and seeks the last PRESENT element for the seed", async () => {
      expect(
        await run(
          `export function run(): number { const a: any[] = [5, , , 2]; return a.reduceRight((x: any, y: any) => (x as number) + (y as number)) as number; }`,
        ),
      ).toBe(7);
      expect(
        await run(
          `export function run(): number { const a: any[] = [1, , 3]; return a.reduceRight((x: any, y: any) => (x as number) + (y as number), 100) as number; }`,
        ),
      ).toBe(104);
    });
  });

  describe("find / findIndex — Get semantics: a hole IS visited as undefined (NOT skipped)", () => {
    it("find observes undefined at a hole (Get, not HasProperty)", async () => {
      // §23.1.3.8 uses Get, so the callback DOES run on a hole with `undefined`.
      expect(
        await run(
          `export function run(): boolean { const a: any[] = [1, , 3]; return a.find((x: any) => x === undefined) === undefined ? false : true; }`,
        ),
      ).toBe(0); // find returns the (undefined) hole value → the ternary yields false
      expect(
        await run(
          `export function run(): number { const a: any[] = [1, , 3]; let c = 0; a.find((x: any) => { c++; return false; }); return c; }`,
        ),
      ).toBe(3); // find VISITS all 3 indices including the hole
    });
  });

  describe("typed no-regression guard — the dense numeric kernel is untouched", () => {
    it("a dense number[] forEach kernel still sums (no hole machinery on f64)", async () => {
      expect(
        await run(
          `export function run(): number { const a = [1, 2, 3, 4]; let s = 0; a.forEach((x) => { s += x; }); return s; }`,
        ),
      ).toBe(10);
    });

    it("a dense number[] reduce / map / indexOf are unchanged", async () => {
      expect(
        await run(`export function run(): number { const a = [1, 2, 3, 4]; return a.reduce((x, y) => x + y); }`),
      ).toBe(10);
      expect(
        await run(`export function run(): string { const a = [1, 2, 3]; return a.map((x) => x * 2).join(","); }`),
      ).toBe("2,4,6");
      expect(await run(`export function run(): number { const a = [10, 20, 30]; return a.indexOf(20); }`)).toBe(1);
    });

    it("a dense any[] (no holes) is unaffected even though usesArrayHoles is module-wide", async () => {
      // The module has a hole literal so usesArrayHoles is set, but this dense
      // any[] still forEach-counts every element.
      expect(
        await run(
          `const h: any[] = [1, , 3]; export function run(): number { const a: any[] = [1, 2, 3]; let c = 0; a.forEach(() => { c++; }); return c; }`,
        ),
      ).toBe(3);
    });

    it("the compiled binary is deterministic (reproducible bytes)", async () => {
      const src = `export function run(): number { const a: any[] = [1, , 3]; let c = 0; a.forEach(() => { c++; }); return c; }`;
      const a = (await compile(src)).binary;
      const b = (await compile(src)).binary;
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });
  });

  describe("standalone (pure Wasm — $Hole skip is engine-native, no host import)", () => {
    it("forEach visit-skip standalone (count 2)", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1, , 3]; let c = 0; a.forEach(() => { c++; }); return c; }`,
        ),
      ).toBe(2);
    });

    it("map skips the callback at a hole standalone (visit count 2)", async () => {
      // join needs native-string concat (a separate standalone gap), so assert the
      // skip via a visit counter rather than the rendered result.
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [1, , 3]; let c = 0; a.map((x: any) => { c++; return x; }); return c; }`,
        ),
      ).toBe(2);
    });

    it("reduce skip standalone ([5,,,2] sum 7)", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a: any[] = [5, , , 2]; return a.reduce((x: any, y: any) => (x as number) + (y as number)) as number; }`,
        ),
      ).toBe(7);
    });
  });
});
