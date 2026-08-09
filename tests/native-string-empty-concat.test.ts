// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Native strings are immutable values, so the general concat helper may return
// the other operand when either side is empty. This is intentionally NOT an
// optimization for __str_concat_owned: that helper needs private backing before
// a later append can mutate in place.

import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
function join(left: string, right: string): string {
  return left + right;
}

export function run(seed: number): number {
  const value = "value-" + seed;
  const empty = value.substring(0, 0);
  const long = join(value.repeat(8), value.repeat(8));
  const left = join(empty, value);
  const right = join(value, empty);
  const ropeLeft = join(empty, long);
  const ropeRight = join(long, empty);
  return left.length + right.length + ropeLeft.length + ropeRight.length
    + left.charCodeAt(0) + right.charCodeAt(right.length - 1);
}

export function build(count: number): number {
  let value = "";
  for (let index = 0; index < count; index++) value += "ab";
  return value.length;
}
`;

function functionWat(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name}`);
  expect(start, `func $${name} not found`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

async function compileProbe(enabled: boolean) {
  process.env.JS2WASM_STR_CONCAT_EMPTY_IDENTITY = enabled ? "1" : "0";
  const result = await compile(SOURCE, {
    fileName: "native-string-empty-concat.ts",
    target: "standalone",
    hostBridge: "always",
  } as never);
  expect(result.success, result.success ? undefined : result.errors?.[0]?.message).toBe(true);
  expect(WebAssembly.validate(result.binary!)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return {
    run: instance.exports.run as (seed: number) => number,
    concatWat: functionWat(result.wat!, "__str_concat"),
    ownedWat: result.wat!.includes("(func $__str_concat_owned")
      ? functionWat(result.wat!, "__str_concat_owned")
      : undefined,
  };
}

afterEach(() => {
  process.env.JS2WASM_STR_CONCAT_EMPTY_IDENTITY = undefined;
});

describe("native string empty-concat identity", () => {
  it("preserves flat and rope results in both operand orders", async () => {
    const optimized = await compileProbe(true);
    const control = await compileProbe(false);
    for (const seed of [0, 7, 42, -3]) {
      expect(optimized.run(seed)).toBe(control.run(seed));
    }
  });

  it("emits both identity returns behind the kill switch", async () => {
    const optimized = await compileProbe(true);
    const control = await compileProbe(false);
    expect(optimized.concatWat).toMatch(/local\.get 2\s+i32\.eqz[\s\S]*local\.get 1\s+return/);
    expect(optimized.concatWat).toMatch(/local\.get 3\s+i32\.eqz[\s\S]*local\.get 0\s+return/);
    expect(control.concatWat).not.toMatch(/local\.get 2\s+i32\.eqz[\s\S]*local\.get 1\s+return/);
  });

  it("does not add the identity contract to the owned append helper", async () => {
    const optimized = await compileProbe(true);
    const control = await compileProbe(false);
    expect(optimized.ownedWat).toBeDefined();
    expect(optimized.ownedWat).toBe(control.ownedWat);
  });
});
