import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("; "));
  const imps = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps);
  if (imps.setExports) imps.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

// #786: Object.keys/values/entries on objects whose fields are added
// dynamically (after an empty `{}` initializer) previously emitted invalid
// wasm — the field-name strings were never registered, so array.new_fixed
// underflowed the stack. compileStringLiteral now late-registers them.
describe("Issue #786: Object.keys/values/entries on dynamically-extended objects", () => {
  it("Object.keys on dynamically-extended object does not crash and returns count", async () => {
    expect(
      await run(`
      export function test(): number {
        const o: any = {};
        o.a = 1;
        o.b = 2;
        return Object.keys(o).length;
      }
    `),
    ).toBe(2);
  });

  it("Object.keys preserves dynamically-added key names", async () => {
    expect(
      await run(`
      export function test(): number {
        const o: any = {};
        o.foo = 1;
        const k = Object.keys(o);
        return k[0] === 'foo' ? 1 : 0;
      }
    `),
    ).toBe(1);
  });

  it("Object.values on dynamically-extended object", async () => {
    expect(
      await run(`
      export function test(): number {
        const o: any = {};
        o.a = 10;
        o.b = 20;
        return Object.values(o).length;
      }
    `),
    ).toBe(2);
  });

  it("Object.entries on dynamically-extended object", async () => {
    expect(
      await run(`
      export function test(): number {
        const o: any = {};
        o.a = 1;
        o.b = 2;
        return Object.entries(o).length;
      }
    `),
    ).toBe(2);
  });

  it("Object.keys on empty object still returns 0", async () => {
    expect(
      await run(`
      export function test(): number {
        const o: any = {};
        return Object.keys(o).length;
      }
    `),
    ).toBe(0);
  });

  it("Object.keys on inline-field object unaffected", async () => {
    expect(
      await run(`
      export function test(): number {
        const o = { x: 1, y: 2, z: 3 };
        return Object.keys(o).length;
      }
    `),
    ).toBe(3);
  });
});
