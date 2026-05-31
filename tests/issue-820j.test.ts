import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runI32(src: string): Promise<number | string> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) return "CE:" + (r.errors?.[0]?.message ?? "?");
  const imports = buildImports(r.imports, undefined, r.stringPool, {});
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

describe("#820j generator/asyncgenerator prototype shape", () => {
  it("Generator instance two-hop prototype is %GeneratorPrototype% (toStringTag)", async () => {
    const src = `
      function* g() { yield 1; }
      const GP = Object.getPrototypeOf(Object.getPrototypeOf(g()));
      export function test(): number { return GP[Symbol.toStringTag] === 'Generator' ? 1 : 0; }`;
    expect(await runI32(src)).toBe(1);
  });

  it("AsyncGenerator instance two-hop prototype is %AsyncGeneratorPrototype%", async () => {
    const src = `
      async function* g() { yield 1; }
      const GP = Object.getPrototypeOf(Object.getPrototypeOf(g()));
      export function test(): number { return GP[Symbol.toStringTag] === 'AsyncGenerator' ? 1 : 0; }`;
    expect(await runI32(src)).toBe(1);
  });

  it("%GeneratorPrototype%.constructor is a data property per spec §27.5.1.1", async () => {
    const src = `
      function* g() {}
      const Gen = Object.getPrototypeOf(g);
      const GP = Gen.prototype;
      const d = Object.getOwnPropertyDescriptor(GP, 'constructor');
      export function test(): number {
        return (GP.constructor === Gen && d && 'value' in d &&
                d.writable === false && d.enumerable === false && d.configurable === true) ? 1 : 0;
      }`;
    expect(await runI32(src)).toBe(1);
  });

  it("%AsyncGeneratorPrototype%.constructor is a data property per spec §27.6.1.1", async () => {
    const src = `
      async function* g() {}
      const Gen = Object.getPrototypeOf(g);
      const GP = Gen.prototype;
      const d = Object.getOwnPropertyDescriptor(GP, 'constructor');
      export function test(): number {
        return (GP.constructor === Gen && d && 'value' in d &&
                d.writable === false && d.configurable === true) ? 1 : 0;
      }`;
    expect(await runI32(src)).toBe(1);
  });

  it("prototype methods brand-check the receiver (TypeError on incompatible)", async () => {
    const src = `
      function* g() {}
      const GP = Object.getPrototypeOf(g).prototype;
      let threw = false;
      try { GP.next.call({}); } catch (e) { threw = e instanceof TypeError; }
      export function test(): number { return threw ? 1 : 0; }`;
    expect(await runI32(src)).toBe(1);
  });

  it("instance .next() still yields buffered values after the chain change", async () => {
    const src = `
      function* g() { yield 5; }
      const it = g();
      const r = it.next();
      export function test(): number { return (r.value === 5 && r.done === false) ? 1 : 0; }`;
    expect(await runI32(src)).toBe(1);
  });
});
