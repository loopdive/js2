import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3229 — `Object.keys/values/entries(closedStruct).length` read INLINE on the
// call expression returned 0 instead of the field count. The static struct
// fast-path (`compileObjectKeysOrValues`) built and returned a vec-of-externref,
// but an inline `.length` dispatches on the CANONICAL `string[]`/`T[]` vec type
// (vec-of-string / vec-of-f64 from `resolveWasmType(returnType)`); the
// `ref.test` against that type failed on the vec-of-externref, so `.length`
// fell to the `else` arm → 0. (Assigning to a typed variable first worked
// because the store COERCED the vec to the canonical layout.) The fix builds the
// fast-path vec with the canonical arr/element types, coercing each element.
// Mode-agnostic — reproduced in host/gc AND standalone.
async function run(source: string, opts: Record<string, unknown> = {}): Promise<unknown> {
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test!();
}

const P = `type P = { a: number; b: number; c: number };`;

for (const [label, opts] of [
  ["host/gc", {}],
  ["standalone", { target: "standalone" }],
] as const) {
  describe(`#3229 Object.keys/values/entries inline .length (${label})`, () => {
    it("Object.keys(typedLocal).length inline === field count", async () => {
      expect(
        await run(
          `${P}
          export function test(): number { const o: P = { a: 1, b: 2, c: 3 }; return Object.keys(o).length; }`,
          opts,
        ),
      ).toBe(3);
    });

    it("Object.values(typedLocal).length inline === field count", async () => {
      expect(
        await run(
          `${P}
          export function test(): number { const o: P = { a: 1, b: 2, c: 3 }; return Object.values(o).length; }`,
          opts,
        ),
      ).toBe(3);
    });

    it("Object.entries(typedLocal).length inline === field count", async () => {
      expect(
        await run(
          `${P}
          export function test(): number { const o: P = { a: 1, b: 2, c: 3 }; return Object.entries(o).length; }`,
          opts,
        ),
      ).toBe(3);
    });

    it("keys content survives the canonical-vec build", async () => {
      expect(
        await run(
          `type Q = { abc: number; de: number };
          export function test(): number { const o: Q = { abc: 1, de: 2 }; const k = Object.keys(o); return k[0].length + k[1].length; }`,
          opts,
        ),
      ).toBe(5);
    });

    it("values content survives (unboxed number[] element)", async () => {
      expect(
        await run(
          `${P}
          export function test(): number { const o: P = { a: 10, b: 20, c: 3 }; const v = Object.values(o); return v[0] + v[1] + v[2]; }`,
          opts,
        ),
      ).toBe(33);
    });

    it("values inline index reads the right slot", async () => {
      expect(
        await run(
          `type Q = { a: number; b: number };
          export function test(): number { const o: Q = { a: 7, b: 9 }; return Object.values(o)[1]; }`,
          opts,
        ),
      ).toBe(9);
    });

    it("keys.length drives a for-loop (inline in the condition)", async () => {
      expect(
        await run(
          `type Q = { x: number; yy: number; zzz: number };
          export function test(): number { const o: Q = { x: 1, yy: 2, zzz: 3 }; const k = Object.keys(o); let s = 0; for (let i = 0; i < k.length; i++) s += k[i].length; return s; }`,
          opts,
        ),
      ).toBe(6);
    });

    it("heterogeneous values (string|number) still box to an externref vec", async () => {
      expect(
        await run(
          `type Q = { a: number; s: string };
          export function test(): number { const o: Q = { a: 5, s: "hi" }; return Object.values(o).length; }`,
          opts,
        ),
      ).toBe(2);
    });

    it("entries content survives", async () => {
      expect(
        await run(
          `type Q = { a: number; b: number };
          export function test(): number { const o: Q = { a: 4, b: 6 }; const e = Object.entries(o); return (e[0][1] as number) + (e[1][1] as number); }`,
          opts,
        ),
      ).toBe(10);
    });

    it("keys via an intermediate variable still works (regression guard)", async () => {
      expect(
        await run(
          `${P}
          export function test(): number { const o: P = { a: 1, b: 2, c: 3 }; const k = Object.keys(o); return k.length; }`,
          opts,
        ),
      ).toBe(3);
    });
  });
}
