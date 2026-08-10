// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ENV_NAME = "JS2WASM_NATIVE_BATCHED_CONCAT";
const originalEnv = process.env[ENV_NAME];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = originalEnv;
});

const SOURCE = `
  let order = 0;
  function mark(n: number): number {
    order = order * 10 + n;
    return n;
  }

  export function run(a: number, b: number): number {
    order = 0;
    const text = "x" + mark(a) + "-" + mark(b);
    return order * 100 + text.length;
  }

  export function grouped(a: number, b: number, c: number): number {
    return ("x" + (a + b) + "-" + c).length;
  }

  export function sliced(n: number): number {
    const base = "abcdef";
    return ("x" + base.substring(1, 3) + "-" + n).length;
  }

  export function longResult(a: number, b: number): number {
    return ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789--------" + a + "-" + b).length;
  }
`;

async function build(disabled: boolean) {
  if (disabled) process.env[ENV_NAME] = "0";
  else delete process.env[ENV_NAME];
  const result = await compile(SOURCE, {
    fileName: disabled ? "native-batched-control.ts" : "native-batched-candidate.ts",
    target: "standalone",
    optimize: 4,
    emitWat: true,
    emitWatOnlyFunctions: ["run", "__str_concat_4"],
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("native batched string concat", () => {
  it("batches safely and keeps the pairwise kill-switch control", async () => {
    const candidate = await build(false);
    expect(candidate.wat).toContain("__str_concat_4");

    const control = await build(true);
    expect(control.wat).not.toContain("__str_concat_4");

    const instance = await WebAssembly.instantiate(candidate.binary, {});
    const exports = instance.instance.exports as Record<string, (...args: number[]) => number>;

    expect(exports.run!(1, 2)).toBe(1204); // order 12; "x1-2".length === 4
    expect(exports.grouped!(2, 3, 4)).toBe(4); // "x5-4", not "x23-4"
    expect(exports.sliced!(9)).toBe(5); // "xbc-9"
    expect(exports.longResult!(12, 34)).toBe(75);
  });
});
