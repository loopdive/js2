// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2107 (value-rep P4) — standalone any-helper conformance for the `typeof`
 * operator over canonical JsTag (#2104) tags.
 *
 * Two defects fixed here, both observable only on the standalone / WASI
 * (native-strings, no JS host) path where an `any`/union value is carried as an
 * externref and `typeof` routes through the native `__typeof_*` helpers (or, for
 * a true `$AnyValue` operand, `__any_typeof`):
 *
 *   1. `__typeof_object` returned `1` (object) for ANY non-null, non-boxed
 *      primitive externref — including a native `$AnyString` string. So a
 *      string-typed `any` reported BOTH `typeof === "string"` and
 *      `typeof === "object"` as true. Added a `ref.test $AnyString` guard that
 *      classifies a native string as NOT an object.
 *   2. `compileTypeofComparison`'s `$AnyValue` fast-path used pre-canonical tag
 *      maps (`string -> [5,6]`, `object -> [0]`, no `function`). Corrected to
 *      `string -> [5]`, `object -> [0,6]`, `function -> [7]`, and the
 *      `__any_typeof` helper's tag arms now emit "string"/"function" for tags
 *      5/7 instead of collapsing them to "object". `compileTypeofExpression`
 *      now consults `__any_typeof` on the standalone path too (it was gated on
 *      `ctx.fast`, leaving standalone on the null `__typeof` stub).
 *
 * Tests use the *dynamic* typeof path (a runtime-selected union branch) so the
 * value flows through the runtime helper rather than being statically resolved.
 */

async function runStandalone(src: string, target: "standalone" | "wasi"): Promise<number> {
  const r = await compile(src, { target });
  expect(
    r.success,
    `compile failed (${target}):\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, { env: {} });
  return (instance.exports as Record<string, (...a: unknown[]) => number>).test();
}

const TARGETS: Array<"standalone" | "wasi"> = ["standalone", "wasi"];

describe("#2107 standalone typeof conformance over canonical tags", () => {
  for (const target of TARGETS) {
    describe(`target=${target}`, () => {
      // A string held dynamically is `typeof === "string"` and NOT "object".
      it("string-any reports typeof 'string', not 'object'", async () => {
        const src = `
          function pick(i: number): string | number { return i > 0 ? "hi" : 5; }
          export function test(): number {
            const x = pick(1); // runtime string
            const isStr = (typeof x === "string") ? 1 : 0;
            const isObj = (typeof x === "object") ? 1 : 0;
            // expect string=1, object=0  → encode as isStr*10 + isObj
            return isStr * 10 + isObj;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("number-any reports typeof 'number'", async () => {
        const src = `
          function pick(i: number): string | number { return i > 0 ? "hi" : 5; }
          export function test(): number {
            const x = pick(0); // runtime number
            const isNum = (typeof x === "number") ? 1 : 0;
            const isStr = (typeof x === "string") ? 1 : 0;
            return isNum * 10 + isStr;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("object-any reports typeof 'object', not 'string'", async () => {
        const src = `
          function pick(i: number): { a: number } | number { return i > 0 ? { a: 1 } : 5; }
          export function test(): number {
            const x = pick(1); // runtime object
            const isObj = (typeof x === "object") ? 1 : 0;
            const isStr = (typeof x === "string") ? 1 : 0;
            return isObj * 10 + isStr;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("function-any reports typeof 'function', not 'object'", async () => {
        const src = `
          function pick(i: number): (() => number) | number { return i > 0 ? (() => 1) : 5; }
          export function test(): number {
            const x = pick(1); // runtime function
            const isFn = (typeof x === "function") ? 1 : 0;
            const isObj = (typeof x === "object") ? 1 : 0;
            return isFn * 10 + isObj;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("undefined-any reports typeof 'undefined'", async () => {
        const src = `
          function pick(i: number): string | undefined { return i > 0 ? "hi" : undefined; }
          export function test(): number {
            const x = pick(0); // runtime undefined
            const isUndef = (typeof x === "undefined") ? 1 : 0;
            const isStr = (typeof x === "string") ? 1 : 0;
            return isUndef * 10 + isStr;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });
    });
  }
});
