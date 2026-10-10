// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6898 — the native array-like `map` / `filter` arms that the regime reaches
// once the unused harness `eval` shim is elided (standalone already reached them).
//
//  - `Array.prototype.map.call(arrayLike, f)` stores positionally, so an index
//    the HasProperty gate skips must still occupy its slot (was: a dense push,
//    so `{5: v, length: 100}` mapped to a 1-element array).
//  - its result is ArrayCreate(len): a length above 2^32 - 1 throws RangeError
//    before any callback (was: 2^31 loop iterations — the test262 hang).
//  - a callback with no return value answers `undefined`, which is falsy for
//    `filter` (was: the void arm pushed the constant 1).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
beforeAll(() => {
  process.env.JS2WASM_NATIVE_REGIME_JS = "1";
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

const SOURCE = `
function noResult(v: any): void {}
export function voidCallbackIsFalsy(): number {
  const o: any = { 0: 1, 1: 2, length: 2 };
  const r: any = Array.prototype.filter.call(o, noResult);
  return r.length;
}
export function mapKeepsPositions(): number {
  const kv: any = {};
  const o: any = { 5: kv, length: 100 };
  const r: any = Array.prototype.map.call(o, function (v: any, i: any): any { return i === 5 ? v === kv : false; });
  return r.length * 10 + (r[5] === true ? 1 : 0);
}
export function mapHugeLengthThrows(): number {
  let calls = 0;
  const o: any = { 0: 9, length: Infinity };
  try {
    Array.prototype.map.call(o, function (v: any): any { calls++; return v; });
    return -1;
  } catch (e) {
    return (e instanceof RangeError ? 1 : 2) + calls * 10;
  }
}
`;

async function run(lane: "regime" | "standalone") {
  const result = await compile(SOURCE, {
    fileName: "issue-6898-map.ts",
    ...(lane === "regime" ? { semanticProviders: "native-first" as const } : { target: "standalone" as const }),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (instance: WebAssembly.Instance) => void }).setInstance?.(instance);
  return instance.exports as Record<string, () => number>;
}

describe("#6898 native array-like map/filter", () => {
  for (const lane of ["regime", "standalone"] as const) {
    it(`${lane}: a void filter callback keeps nothing`, async () => {
      expect((await run(lane)).voidCallbackIsFalsy()).toBe(0);
    });
    it(`${lane}: map over an array-like keeps each result at its index`, async () => {
      expect((await run(lane)).mapKeepsPositions()).toBe(1001);
    });
    it(`${lane}: map over a length above 2^32 - 1 throws RangeError before any callback`, async () => {
      expect((await run(lane)).mapHugeLengthThrows()).toBe(1);
    });
  }
});
