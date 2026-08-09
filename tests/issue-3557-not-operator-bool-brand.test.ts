// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

// #3557 — the logical-NOT (`!` / `!!`) result is ALWAYS a JS boolean, so its
// i32 result must carry the boolean brand (`{kind:"i32", boolean:true}`). Before
// this fix `!x`/`!!x` was born brandless, so when the value crossed the host
// boundary (a dynamic property write, a Set/Map key, `typeof`) it boxed via
// `__box_number` and reified as the NUMBER 1/0 instead of `true`/`false`.
//
// Surfaced by the acorn differential corpus: `node.async = !!isAsync` (and the
// whole `computed`/`async`/… family) marshalled as i32 0/1, so
// `node.async === false` was false (it was 0) and `typeof node.async` was
// "number". This is the missing prefix-unary member of the boolean-producing
// operator family that #2712 already brands for `===`/`<`/`in`/`instanceof`.
//
// Fix: brand the `!`/`!!` result in expressions/unary.ts (lane-agnostic — the
// `from.boolean` check in coerceType's i32→externref arm picks `__box_boolean`
// in both gc/host and standalone).

async function run<T>(src: string): Promise<T> {
  const exports = await compileAndInstantiate(src);
  return (exports as { f: () => T }).f();
}

describe("#3557 logical-NOT result is a boolean at the host boundary", () => {
  describe("the acorn repro — `node.<flag> = !!cond` marshals as a boolean", () => {
    it("`typeof (!x)` is 'boolean'", async () => {
      expect(await run(`export function f(): string { const x = 0; return typeof (!x); }`)).toBe("boolean");
    });

    it("`typeof (!!x)` is 'boolean'", async () => {
      expect(await run(`export function f(): string { const x: any = 5; return typeof (!!x); }`)).toBe("boolean");
    });

    it("dynamic property write of `!!cond` reads back as a boolean (typeof)", async () => {
      // Mirrors `node.async = !!isAsync` on acorn's open node objects.
      expect(
        await run(`export function f(): string {
          const isAsync = 1;
          const node: any = {};
          node.async = !!isAsync;
          return typeof node.async;
        }`),
      ).toBe("boolean");
    });

    it("dynamic property write of `!cond` strict-equals false (not 0)", async () => {
      expect(
        await run(`export function f(): number {
          const node: any = {};
          node.computed = !true;   // false
          return node.computed === false ? 1 : 0; // 1 iff a real boolean
        }`),
      ).toBe(1);
    });

    it("`(!!cond) as any` boxed into a Set is a boolean element (not the number 1)", async () => {
      expect(
        await run(`export function f(): number {
          const x: any = 3;
          return new Set<any>([(!!x) as any]).has(1) ? 1 : 0; // 0 — the element is boolean true
        }`),
      ).toBe(0);
    });

    it("`(!!cond) as any` boxed into a Set matches has(true)", async () => {
      expect(
        await run(`export function f(): number {
          const x: any = 3;
          return new Set<any>([(!!x) as any]).has(true) ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("JSON.stringify surfaces a `!!cond` field as a boolean, not 0/1", async () => {
      // The exact acorn surface: a serialized AST node's boolean flags.
      expect(
        await run(`export function f(): string {
          const isAsync = 0;
          const node: any = {};
          node.async = !!isAsync;   // false
          node.generator = !isAsync; // true
          return JSON.stringify(node);
        }`),
      ).toBe('{"async":false,"generator":true}');
    });
  });

  describe("brand is structurally inert — no arithmetic/branch regression", () => {
    it("`!x` used in arithmetic still coerces to number 1/0", async () => {
      expect(
        await run(`export function f(): number { const x = 0; return (!x as any) ? ((!x as any) + 1) : -1; }`),
      ).toBe(2);
    });

    it("`!x` as a branch condition still works", async () => {
      expect(await run(`export function f(): number { const x = 0; if (!x) return 7; return 0; }`)).toBe(7);
    });

    it("a genuine number field is unaffected (still a number)", async () => {
      expect(
        await run(`export function f(): number {
          const node: any = {};
          node.start = 5;
          return typeof node.start === "number" ? node.start : -1;
        }`),
      ).toBe(5);
    });
  });
});
