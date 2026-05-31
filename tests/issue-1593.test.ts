import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => number }).test();
}

// ECMAScript §13.15.5.4: a binding element's default initializer is evaluated
// ONLY when the matched value is `undefined`, never when it is `null` or any
// other defined value. The `init-skipped` test262 cluster verifies this.
describe("#1593 destructuring default-init triggers only on undefined", () => {
  it("array pattern: defined values (incl. null) skip the initializer", async () => {
    const src = `
      let initCount = 0;
      function counter() { initCount = initCount + 1; }
      export function test() {
        const [w = counter(), x = counter(), y = counter(), z = counter()] = [null, 0, false, ''];
        let r = 0;
        if (w === null) r += 1;
        if (x === 0) r += 2;
        if (y === false) r += 4;
        if (z === '') r += 8;
        if (initCount === 0) r += 16;
        return r;
      }`;
    expect(await run(src)).toBe(31);
  });

  it("object pattern: defined values (incl. null) skip the initializer", async () => {
    const src = `
      let initCount = 0;
      function counter() { initCount = initCount + 1; }
      export function test() {
        const { s: t = counter(), u: v = counter(), w: x = counter(), y: z = counter() } =
          { s: null, u: 0, w: false, y: '' };
        let r = 0;
        if (t === null) r += 1;
        if (v === 0) r += 2;
        if (x === false) r += 4;
        if (z === '') r += 8;
        if (initCount === 0) r += 16;
        return r;
      }`;
    expect(await run(src)).toBe(31);
  });

  it("for-of pattern: defined values skip the initializer", async () => {
    const src = `
      let initCount = 0;
      function counter() { initCount = initCount + 1; }
      export function test() {
        let r = 0;
        for (const [w = counter(), x = counter(), y = counter(), z = counter()] of [[null, 0, false, '']]) {
          if (w === null) r += 1;
          if (x === 0) r += 2;
          if (y === false) r += 4;
          if (z === '') r += 8;
        }
        if (initCount === 0) r += 16;
        return r;
      }`;
    expect(await run(src)).toBe(31);
  });

  it("numeric field with void initializer compiles (then-branch type-checks)", async () => {
    // Even though the default never fires here (value is defined), the
    // initializer's then-branch must coerce its void/externref result to the
    // f64 local so the whole if/else validates — the core #1593 codegen fix.
    const src = `
      let initCount = 0;
      function counter() { initCount = initCount + 1; }
      export function test() {
        const { u: v = counter() } = { u: 0 };
        return v === 0 && initCount === 0 ? 1 : 99;
      }`;
    expect(await run(src)).toBe(1);
  });

  it("missing object property triggers the initializer", async () => {
    const src = `
      export function test() {
        const { a = 42 } = {} as { a?: number };
        return a === 42 ? 1 : 99;
      }`;
    expect(await run(src)).toBe(1);
  });
});
