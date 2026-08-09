// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4121) A linked implicit-any helper can return a proven number without
 * forcing unrelated string parameters back through the dynamic carrier.
 */
import { afterEach, describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";
import { numericReturnsFlagEnabled } from "../src/derivation-flags.js";

const FLAG = "JS2WASM_NUMERIC_RETURNS";
const savedFlag = process.env[FLAG];

afterEach(() => {
  if (savedFlag === undefined) Reflect.deleteProperty(process.env, FLAG);
  else process.env[FLAG] = savedFlag;
});

async function build(packageSource: string, entrySource: string, enabled = true) {
  process.env[FLAG] = enabled ? "1" : "0";
  return compileMulti(
    {
      "package.js": packageSource,
      "entry.mjs": entrySource,
    },
    "entry.mjs",
    {
      allowJs: true,
      emitWat: true,
      emitWatOnlyFunctions: ["next", "identity", "maybeNumber", "same", "read"],
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      target: "standalone",
    },
  );
}

async function instantiate(result: Awaited<ReturnType<typeof build>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const numericPackage = `
  function next(str, min, len) {
    const index = str.indexOf(";", min);
    return index === -1 ? len : index;
  }
  export function parse(str) {
    const len = str.length;
    return next(str, 0, len);
  }
`;

const numericEntry = `
  import { parse } from "./package.js";
  /** @param {number} seed */
  export function run(seed) {
    const header = "a=" + seed + "; b=2";
    return parse(header);
  }
`;

describe("#4121 — binding-aware numeric return carriers", () => {
  it("defaults on and keeps an independently numeric result unboxed", async () => {
    Reflect.deleteProperty(process.env, FLAG);
    expect(numericReturnsFlagEnabled()).toBe(true);

    const result = await build(numericPackage, numericEntry);
    expect(result.wat).toMatch(/\(func \$next (?:\(type \d+\)|\(param \(ref null \d+\) f64 f64\) \(result f64\))/);
    expect(result.wat).toMatch(/\(func \(param \(ref null \d+\) f64 f64\) \(result f64\)\)/);

    const exports = await instantiate(result);
    expect((exports.run as (seed: number) => number)(3751)).toBe(6);
  });

  it("restores the parent externref result with one kill switch", async () => {
    const result = await build(numericPackage, numericEntry, false);
    expect(numericReturnsFlagEnabled()).toBe(false);
    expect(result.wat).toMatch(/\(func \$next \(param \(ref null \d+\) f64 f64\) \(result externref\)/);

    const exports = await instantiate(result);
    expect((exports.run as (seed: number) => number)(3751)).toBe(6);
  });

  it("rejects a returned string binding and preserves its identity", async () => {
    const result = await build(
      `
        function identity(value, unusedNumber) { return value; }
        export function read() { return identity("ok", 1); }
      `,
      `
        import { read } from "./package.js";
        export function run() { return read() === "ok" ? 1 : 0; }
      `,
    );
    const exports = await instantiate(result);
    expect((exports.run as () => number)()).toBe(1);
  });

  it("rejects an implicit-undefined fallthrough path", async () => {
    const result = await build(
      `
        function maybeNumber(unusedString, value, choose) {
          if (choose) return value;
        }
        export function read() { return maybeNumber("unused", 7, false); }
      `,
      `
        import { read } from "./package.js";
        export function run() { return read() === undefined ? 1 : 0; }
      `,
    );
    expect(result.wat).toMatch(/\(func \$maybeNumber \(param \(ref null \d+\) f64 i32\) \(result externref\)/);
  });

  it("uses a boolean-branded i32 only when every return is boolean", async () => {
    const result = await build(
      `
        function same(left, right, unusedNumber) { return left === right; }
        export function read() { return same("a", "a", 1); }
      `,
      `
        import { read } from "./package.js";
        export function run() { return read() === true ? 1 : 0; }
      `,
    );
    expect(result.wat).toMatch(/\(func \(param \(ref null \d+\) \(ref null \d+\) f64\) \(result i32\)\)/);
    const exports = await instantiate(result);
    expect((exports.run as () => number)()).toBe(1);
  });
});
