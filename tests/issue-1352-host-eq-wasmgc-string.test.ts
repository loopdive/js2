import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// (#1352) RegExp exec result: wasmGC string struct vs externref V8 string
// strict equality. The host-bridge `host_eq` / `host_loose_eq` /
// `same_value_zero` must normalise a wasmGC opaque operand to its string
// primitive before comparing, so `match[0] === "42"` returns true even when
// one side is an externref V8 string and the other a wasmGC struct.

describe("#1352 — host equality bridges wasmGC string / externref string", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("RegExp exec result element === wasmGC string literal", async () => {
    const ret = await run(`
      export function test(): number {
        const re = /\\d+/;
        const m: any = re.exec("abc1234");
        const expected = "1234";
        if (m === null) return 0;
        return m[0] === expected ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("RegExp exec result element == wasmGC string literal (loose)", async () => {
    const ret = await run(`
      export function test(): number {
        const re = /\\d+/;
        const m: any = re.exec("abc99");
        if (m === null) return 0;
        // eslint-disable-next-line eqeqeq
        return m[0] == "99" ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("RegExp exec result element-by-element comparison with expected array", async () => {
    const ret = await run(`
      export function test(): number {
        const re = /(\\d+)-(\\d+)/;
        const m: any = re.exec("abc12-34xyz");
        if (m === null) return 0;
        const expected = ["12-34", "12", "34"];
        for (let i = 0; i < expected.length; i++) {
          if (m[i] !== expected[i]) return 0;
        }
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Array.prototype.includes (SameValueZero) finds wasmGC string in host array", async () => {
    const ret = await run(`
      export function test(): number {
        const re = /\\d+/g;
        const s = "a1 b2 c3";
        // String.prototype.match with /g returns externref array of externref strings.
        const arr: any = s.match(re);
        if (arr === null) return 0;
        // Search value is a wasmGC string literal; arr elements are externref.
        return arr.includes("2") ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("no regression: distinct strings remain not-equal", async () => {
    const ret = await run(`
      export function test(): number {
        const re = /\\d+/;
        const m: any = re.exec("abc42");
        if (m === null) return 0;
        // Negative case — content differs.
        if (m[0] === "99") return 0;
        // Distinct objects compare not equal.
        const o1: any = {};
        const o2: any = {};
        if (o1 === o2) return 0;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("no regression: identical externref strings remain equal", async () => {
    const ret = await run(`
      export function test(): number {
        const a = "hello";
        const b = "hello";
        return a === b ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
