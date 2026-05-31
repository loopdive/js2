// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1663 — pure-Wasm `parseInt` / `parseFloat` in standalone / WASI mode.
 *
 * Under `--target wasi` / `--target standalone` there is no JS runtime to
 * satisfy the `env.parseInt` / `env.parseFloat` host imports, so the compiler
 * emits WasmGC-native scanners instead (see `parse-number-native.ts`). Each
 * test asserts:
 *   1. The compiled module emits ZERO `env.parseInt` / `env.parseFloat`
 *      imports (so it instantiates with an empty import object).
 *   2. The native scanner returns the spec-correct value (ECMA-262 §19.2.4/5).
 *
 * A control case proves the default (JS-host) `gc` path still emits the host
 * imports.
 *
 * `Number(string)` ToNumber coercion is NOT covered here — it routes through
 * the `__unbox_number` union helper, which does not yet parse strings in the
 * native path. Tracked as a #1663 follow-up.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PARSE_IMPORT_RE = /^(parseInt|parseFloat)$/;

async function runStandalone(expr: string, target: "wasi" | "standalone" = "wasi"): Promise<number> {
  const src = `export function test(): number { return ${expr}; }`;
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const parseImports = WebAssembly.Module.imports(mod)
    .filter((i) => PARSE_IMPORT_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  expect(parseImports, "no parseInt/parseFloat host import should be emitted").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).test();
}

describe("#1663 standalone parseInt/parseFloat — no JS host imports", () => {
  it("parseInt decimal", async () => {
    expect(await runStandalone('parseInt("42")')).toBe(42);
  });

  it("parseInt hex prefix (auto radix)", async () => {
    expect(await runStandalone('parseInt("0xFF")')).toBe(255);
  });

  it("parseInt explicit radix 2", async () => {
    expect(await runStandalone('parseInt("10", 2)')).toBe(2);
  });

  it("parseInt explicit radix 16, lowercase digits", async () => {
    expect(await runStandalone('parseInt("ff", 16)')).toBe(255);
  });

  it("parseInt with leading whitespace, sign, trailing garbage", async () => {
    expect(await runStandalone('parseInt("  -7px")')).toBe(-7);
  });

  it("parseInt leading plus", async () => {
    expect(await runStandalone('parseInt("+5")')).toBe(5);
  });

  it("parseInt no digits → NaN", async () => {
    expect(Number.isNaN(await runStandalone('parseInt("abc")'))).toBe(true);
  });

  it("parseFloat fraction", async () => {
    expect(await runStandalone('parseFloat("3.14")')).toBe(3.14);
  });

  it("parseFloat positive exponent", async () => {
    expect(await runStandalone('parseFloat("1e3")')).toBe(1000);
  });

  it("parseFloat signed negative exponent", async () => {
    expect(await runStandalone('parseFloat("-2.5e-1")')).toBe(-0.25);
  });

  it("parseFloat Infinity", async () => {
    expect(await runStandalone('parseFloat("Infinity")')).toBe(Infinity);
  });

  it("parseFloat trailing garbage", async () => {
    expect(await runStandalone('parseFloat("10.5px")')).toBe(10.5);
  });

  it("parseFloat no digits → NaN", async () => {
    expect(Number.isNaN(await runStandalone('parseFloat("xyz")'))).toBe(true);
  });

  it("works under --target standalone too", async () => {
    expect(await runStandalone('parseInt("0xFF")', "standalone")).toBe(255);
    expect(await runStandalone('parseFloat("1e3")', "standalone")).toBe(1000);
  });
});

describe("#1663 default (JS-host) gc path is unchanged", () => {
  it("still emits env.parseInt / env.parseFloat host imports under gc", async () => {
    const src = `export function test(): number { return parseInt("42") + parseFloat("3.14"); }`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    const names = WebAssembly.Module.imports(mod)
      .filter((i) => PARSE_IMPORT_RE.test(i.name))
      .map((i) => i.name)
      .sort();
    expect(names).toEqual(["parseFloat", "parseInt"]);
  });
});
