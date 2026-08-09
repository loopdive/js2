import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const KILL_SWITCH = "JS2WASM_NATIVE_CONST_NEEDLE_INDEXOF";
const savedKillSwitch = process.env[KILL_SWITCH];

afterEach(() => {
  if (savedKillSwitch === undefined) delete process.env[KILL_SWITCH];
  else process.env[KILL_SWITCH] = savedKillSwitch;
});

async function compileGc(source: string) {
  const result = await compile(source, {
    fast: true,
    experimentalIR: false,
    optimize: 4,
    emitWat: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function runGc(source: string, ...args: number[]): Promise<number> {
  const result = await compileGc(source);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports.test as (...values: number[]) => number)(...args);
}

describe("native constant-needle indexOf", () => {
  it("finds and misses a short const-alias needle from dynamic receivers and positions", async () => {
    const source = `
      export function test(which: number, from: number): number {
        const texts: string[] = ["xxjumpyy", "no match", "jump", "jumpjump"];
        const text = texts[which];
        const needle = "jump";
        return text.indexOf(needle, from);
      }
    `;
    expect(await runGc(source, 0, 0)).toBe(2);
    expect(await runGc(source, 1, 0)).toBe(-1);
    expect(await runGc(source, 2, -20)).toBe(0);
    expect(await runGc(source, 3, 1)).toBe(4);
    expect(await runGc(source, 3, 20)).toBe(-1);
  });

  it("compares UTF-16 code units and flattens rope receivers", async () => {
    const source = `
      export function test(count: number): number {
        let text = "head";
        for (let i = 0; i < count; i = i + 1) text = text + "x";
        text = text + "💡tail";
        const needle = "💡";
        return text.indexOf(needle);
      }
    `;
    expect(await runGc(source, 0)).toBe(4);
    expect(await runGc(source, 1)).toBe(5);
    expect(await runGc(source, 7)).toBe(11);
  });

  it("emits the fixed compare shape by default and the generic helper with the kill switch", async () => {
    const source = `
      export function test(text: string): number {
        const alias1 = "needle";
        const alias2 = alias1;
        return text.indexOf(alias2);
      }
    `;
    delete process.env[KILL_SWITCH];
    const enabled = await compileGc(source);
    expect(enabled.wat).toContain("__str_indexOf_const_result");

    process.env[KILL_SWITCH] = "0";
    const disabled = await compileGc(source);
    expect(disabled.wat).not.toContain("__str_indexOf_const_result");
    expect(disabled.wat).toMatch(/call \$__str_indexOf|call \d+/);
  });

  it("declines mutable, table-selected, one-unit, and long needles", async () => {
    const sources = [
      `export function test(text: string, choose: number): number {
         let needle = "jump";
         if (choose) needle = "none";
         return text.indexOf(needle);
       }`,
      `export function test(text: string, choose: number): number {
         const needles = ["jump", "none"];
         return text.indexOf(needles[choose]);
       }`,
      `export function test(text: string): number { return text.indexOf("x"); }`,
      `export function test(text: string): number { return text.indexOf("123456789"); }`,
    ];
    delete process.env[KILL_SWITCH];
    for (const source of sources) {
      const result = await compileGc(source);
      expect(result.wat).not.toContain("__str_indexOf_const_result");
    }
  });
});
