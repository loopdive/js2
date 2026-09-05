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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

const TEST262 = existsSync(join(__dirname, "..", "test262", "harness", "assert.js"));

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

const FILTER_TEST262_ROOT = join(process.cwd(), "test262", "test", "built-ins", "Array", "prototype", "filter");
const EXACT_ES5_FILTER_ROWS = ["15.4.4.20-9-b-5.js", "15.4.4.20-9-b-7.js", "15.4.4.20-9-b-11.js"] as const;

describe.skipIf(!TEST262)("§15.4.4.20 exact ES5 standalone residual rows", () => {
  const previousEvalEngine = process.env.JS2WASM_EVAL_ENGINE;
  beforeAll(() => {
    // The exact 5-7 row reaches eval as a callback thisArg. Pin this small
    // ratchet to the refusal/interpreter provider so a developer checkout
    // without the optional QuickJS artifact cannot turn it into a link error.
    process.env.JS2WASM_EVAL_ENGINE = "interpreter";
    resetTest262RuntimeEvalProviderForTest();
  });
  afterAll(() => {
    if (previousEvalEngine === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EVAL_ENGINE");
    else process.env.JS2WASM_EVAL_ENGINE = previousEvalEngine;
    resetTest262RuntimeEvalProviderForTest();
  });

  for (const file of EXACT_ES5_FILTER_ROWS) {
    it(`passes the literal Test262 row ${file}`, async () => {
      const result = await runTest262File(
        join(FILTER_TEST262_ROOT, file),
        "built-ins/Array/prototype/filter",
        120_000,
        "standalone",
      );
      expect(result.status, result.error ?? file).toBe("pass");
    }, 180_000);
  }
});

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
  it("keeps the captured result length after an accessor shrinks a heterogeneous array", async () => {
    // The accessor fires while filter is visiting index 0. The captured len is
    // four, but ArraySetLength leaves indices 0..2 present, so only three
    // values may be copied into the result.
    expect(
      await run(
        `const arr = [0, 1, 2, "last"];
        Object.defineProperty(arr, "0", { get: function (): number { arr.length = 3; return 0; }, configurable: true });
        export function test(): number {
          return arr.filter(function (): boolean { return true; }).length;
        }`,
        "standalone",
      ),
    ).toBe(3);
  });

  it("does not truncate a non-configurable accessor during filter", async () => {
    // The getter at index 1 requests a shrink to two, but index 2 is
    // non-configurable. ArraySetLength must stop at three and filter must keep
    // the captured index 2 in its result.
    expect(
      await run(
        `const arr = [0, 1, 2];
        Object.defineProperty(arr, "2", { get: function (): string { return "unconfigurable"; }, configurable: false });
        Object.defineProperty(arr, "1", {
          get: function (): number {
            // The test source is an ES module, so catch strict-mode's
            // TypeError here; the noStrict Test262 variant suppresses it.
            try {
              arr.length = 2;
            } catch (_) {}
            return 1;
          },
          configurable: true,
        });
        export function test(): number {
          return arr.filter(function (): boolean { return true; }).length;
        }`,
        "standalone",
      ),
    ).toBe(3);
  });

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

  it("preserves a sparse numeric hole across widening before a prototype add", async () => {
    // An unannotated literal is widened to the externref carrier because its
    // accessor makes filter's indexed reads dynamic.  The original f64 hole
    // must remain an internal `$Hole`, so the callback sees the prototype
    // accessor added while visiting index 0 rather than a boxed NaN value.
    expect(
      await run(
        `var arr = [0, , 2];
        Object.defineProperty(arr, "0", { get: function (): number {
          Object.defineProperty(Array.prototype, "1", { get: function (): number { return 6.99; }, configurable: true });
          return 0;
        }, configurable: true });
        export function test(): number {
          var out = arr.filter(function (): boolean { return true; });
          return out.length * 100 + (out[1] === 6.99 ? 1 : 0);
        }`,
        "standalone",
      ),
    ).toBe(301);
  });

  it("preserves a sparse numeric hole across widening before a prototype delete", async () => {
    // The same carrier conversion must not turn the deleted prototype slot
    // into an own value.  Once the callback removes Array.prototype[1], index
    // 1 is absent and filter copies only indices 0 and 2.
    expect(
      await run(
        `var arr = [0, , 2];
        Object.defineProperty(arr, "0", { get: function (): number {
          delete Array.prototype[1];
          return 0;
        }, configurable: true });
        Array.prototype[1] = 1;
        export function test(): number {
          var out = arr.filter(function (): boolean { return true; });
          return out.length * 10 + (out[1] === 2 ? 1 : 0);
        }`,
        "standalone",
      ),
    ).toBe(21);
  });
});

describe("§15.4.4.20 filter — exact ES5 descriptor rows", () => {
  for (const file of ["15.4.4.20-9-b-14.js", "15.4.4.20-9-b-16.js"] as const) {
    it.skipIf(!TEST262)(`${file} passes in full through the Test262 runner`, { timeout: 60_000 }, async () => {
      const result = await runTest262File(
        join(__dirname, "..", "test262", "test", "built-ins/Array/prototype/filter", file),
        "array-filter-exact-rows",
        30_000,
        "standalone",
      );
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
