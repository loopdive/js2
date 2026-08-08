// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5.1 §15.4.4.20 / ES2024 §23.1.3.7 `Array.prototype.filter` — the element
// access discipline the dense WasmGC vec kernel used to skip.
//
// The typed `arr.filter(cb)` lowering (`compileArrayFilter`, array-methods.ts)
// cached the receiver's `data` array and `length` once and read `data[i]` with
// a raw `array.get`. Three spec clauses that broke, each covered below:
//
//   1. `len` is captured ONCE (step 3) but `HasProperty(O, Pk)` is
//      re-evaluated per index (step 5.b) — a callback that shrinks `.length`
//      makes every trailing index absent (test262 `15.4.4.20-9-4`).
//   2. `Get(O, Pk)` runs fresh immediately before the callback (step 5.b.i) —
//      a callback that reallocates the backing must be observed by later
//      iterations.
//   3. An index defined as an ACCESSOR via `Object.defineProperty(arr, "2",
//      { get })` lives in the #3251 vec-overlay companion, not the backing
//      array; `arr.length` may legitimately exceed the physical backing
//      (test262 `15.4.4.20-9-c-i-10/-12/-14`).
//
// NOTE — the receivers below are deliberately left UNANNOTATED so the checker
// keeps them `number[]` and the call lowers through the typed vec kernel, the
// path test262's untyped JS takes for a plain array literal. An `: any`
// receiver would route to the dynamic `__hof_filter` lane instead, which is a
// different (already presence-gated) lowering.
//
// The presence gate is unconditional (both lanes); the overlay-aware element
// read is gated on the #4159 `vecAccessorDescriptorDirty` pre-scan flag, so a
// module that never installs a non-data descriptor keeps the dense kernel.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const opts = target === "standalone" ? { target: "standalone" as const } : {};
  const r = await compile(src, opts);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

/** Assert the same observable result on both lowering lanes. */
async function bothLanes(src: string, expected: unknown): Promise<void> {
  expect(await run(src, "standalone"), "standalone").toStrictEqual(expected);
  expect(await run(src, "gc"), "gc").toStrictEqual(expected);
}

describe("§15.4.4.20 filter — HasProperty is re-evaluated per index", () => {
  it("skips indices a callback removed by shrinking .length (test262 15.4.4.20-9-4)", async () => {
    // len is fixed at 5, but after the first callback `srcArr.length = 2`
    // leaves only indices 0 and 1 present.
    await bothLanes(
      `const srcArr = [1, 2, 3, 4, 6];
      export function test(): number {
        const resArr = srcArr.filter(function (): boolean {
          srcArr.length = 2;
          return true;
        });
        return resArr.length;
      }`,
      2,
    );
  });

  it("does not visit indices beyond the captured len when the callback grows the array", async () => {
    // §23.1.3.7 step 3 captures len ONCE — appended elements are never visited.
    await bothLanes(
      `const srcArr = [1, 2];
      let calls = 0;
      export function test(): number {
        srcArr.filter(function (): boolean {
          calls = calls + 1;
          srcArr.push(9);
          return false;
        });
        return calls;
      }`,
      2,
    );
  });

  it("reads each element fresh from the live backing (step 5.b.i)", async () => {
    // The push reallocates the backing; iteration 1 must read the NEW array.
    await bothLanes(
      `const srcArr = [1, 2];
      export function test(): number {
        const out = srcArr.filter(function (v: number, i: number): boolean {
          if (i === 0) {
            srcArr.push(3);
            srcArr[1] = 7;
          }
          return true;
        });
        return out[1];
      }`,
      7,
    );
  });
});

describe("§15.4.4.20 filter — accessor indices installed by defineProperty", () => {
  it("invokes an own accessor over an existing element (standalone overlay route)", async () => {
    expect(
      await run(
        `const arr = [1, 2];
        export function test(): number {
          Object.defineProperty(arr, "0", { get: function (): number { return 99; }, configurable: true });
          const out = arr.filter(function (): boolean { return true; });
          return out[0];
        }`,
        "standalone",
      ),
    ).toBe(99);
  });

  it("visits an accessor index defined past the physical backing (test262 15.4.4.20-9-c-i-10)", async () => {
    // `Object.defineProperty(arr, "2", …)` on an empty array makes `.length` 3
    // while the WasmGC backing stays empty; the loop must still reach index 2.
    expect(
      await run(
        `const arr: number[] = [];
        export function test(): number {
          Object.defineProperty(arr, "2", { get: function (): number { return 12; }, configurable: true });
          const out = arr.filter(function (v: number, i: number): boolean { return i === 2 && v === 12; });
          return out.length * 100 + out[0];
        }`,
        "standalone",
      ),
    ).toBe(112);
  });

  it("keeps a plain dense filter unchanged when no accessor descriptor exists", async () => {
    await bothLanes(
      `const arr = [1, 2, 3, 4];
      export function test(): number {
        const out = arr.filter(function (v: number): boolean { return v % 2 === 0; });
        return out.length * 100 + out[0] * 10 + out[1];
      }`,
      224,
    );
  });

  it("still skips array-literal holes (#2001 hole gate is preserved)", async () => {
    expect(
      await run(
        `const arr: any[] = [1, , 3];
        let calls = 0;
        export function test(): number {
          const out = arr.filter(function (): boolean { calls = calls + 1; return true; });
          return calls * 10 + out.length;
        }`,
        "standalone",
      ),
    ).toBe(22);
  });
});
