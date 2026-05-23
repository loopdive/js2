// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1468 Cluster A — `for (const { w = D } of [{ w: undefined }])` must
 * fire the destructuring default per ECMA-262 §13.7.5.5 because the value of
 * the matched property is `undefined`.
 *
 * Root cause: when a property in an object literal is initialised with the
 * `undefined` literal/identifier (or a TS type narrows to the literal
 * `undefined`), TypeScript types that property as the literal `undefined`.
 * `mapTsTypeToWasm` legitimately maps `void`/`undefined` to `i32` because
 * function *return* types use that sentinel for "no result". For a struct
 * *field* — a value slot — i32 silently lost the "this is undefined" tag:
 * codegen stored `i32.const 0`, the host getter read it back as the i32 0
 * (which V8 surfaces as `false` via Boolean coercion), and
 * `__extern_is_undefined` returned false, so destructuring defaults like
 * `{ w = 99 }` never fired.
 *
 * Fix: in `ensureStructForType` (the inline-object-literal struct registrar),
 * widen a property whose TS type is *exactly* the `undefined`/`void`
 * primitive to `externref` so the existing `__get_undefined()` path
 * preserves the JS `undefined` identity. The wider `T | undefined` union
 * branch already widens to `externref`/inner-T in `mapTsTypeToWasm`, so this
 * only affects the bare-`undefined` slot.
 *
 * Cluster B (`for ([x, ] of …)` trailing-elision iterator close) is left
 * open under #1468; this PR is scoped to Cluster A.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1468 Cluster A — { w: undefined } preserves JS undefined for destructuring defaults", () => {
  it("for (const { w = 99 } of [{ w: undefined }]) → w === 99 (acceptance criterion 1)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          for (const { w = 99 } of [{ w: undefined }] as any[]) {
            return w === 99 ? 1 : 0;
          }
          return -1;
        }
      `),
    ).toBe(1);
  });

  it("for (const { w = 99 } of [{ w: null }]) → w === null (regression guard, acceptance criterion 2)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          for (const { w = 99 } of [{ w: null }] as any[]) {
            return w === null ? 1 : 0;
          }
          return -1;
        }
      `),
    ).toBe(1);
  });

  it("for (const { w = 99 } of [{}]) → w === 99 (missing key still fires default)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          for (const { w = 99 } of [{}] as any[]) {
            return w === 99 ? 1 : 0;
          }
          return -1;
        }
      `),
    ).toBe(1);
  });

  it("var { w = 99 } = { w: undefined } → w === 99 (plain destructuring)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          var o: any = { w: undefined };
          var { w = 99 } = o as any;
          return w === 99 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("var o = { w: undefined }; typeof o.w === 'undefined' (identity preserved)", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          var o: any = { w: undefined };
          return typeof (o as any).w;
        }
      `),
    ).toBe("undefined");
  });

  it("{ w: undefined }.w === undefined (strict-equality identity)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          var o: any = { w: undefined };
          return (o as any).w === undefined ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  describe("regression guards for adjacent primitive slot widening", () => {
    it("boolean-literal property keeps i32 storage (no widening)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var o: any = { f: false };
            return (o as any).f === false ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("numeric-literal property keeps f64 storage", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var o: any = { n: 42 };
            return (o as any).n === 42 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("string-literal property keeps externref/string storage", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var o: any = { s: "hi" };
            return (o as any).s === "hi" ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });
});
