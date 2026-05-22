// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1436 — Global object descriptors and global function coercion /
 * URI semantics.
 *
 * Targeted spec gaps:
 *
 *   1. `isNaN` / `isFinite` must funnel their argument through ToNumber,
 *      so Symbol/BigInt primitives and abrupt valueOf/toString completions
 *      surface as TypeError per ECMA-262 §7.1.4 (continues the #1434 fix
 *      via the centralized `__unbox_number` import).
 *
 *   2. `parseInt` / `parseFloat` perform `? ToString(string)` before their
 *      grammar match (§19.2.5 / §19.2.4). The runtime previously wrapped
 *      the input in `String(s)`, which returns `SymbolDescriptiveString`
 *      for Symbols and never throws, so `parseInt(Symbol())` silently
 *      yielded NaN instead of the spec-required TypeError.
 *
 *   3. `encodeURI` / `decodeURI` / `encodeURIComponent` /
 *      `decodeURIComponent` all begin with `? ToString(uri)` (§19.2.6).
 *      The same `String(s)` wrapper hid the Symbol TypeError. The native
 *      JS host already implements RFC 3629 surrogate handling and malformed
 *      `%`-escape detection — exposing it directly preserves those spec
 *      behaviors.
 *
 * Test262 cases this targets:
 *   built-ins/isNaN/return-abrupt-from-tonumber-number-symbol.js
 *   built-ins/isNaN/return-abrupt-from-tonumber-number.js
 *   built-ins/isFinite/return-abrupt-from-tonumber-number-symbol.js
 *   built-ins/parseInt/* (Symbol coercion paths)
 *   built-ins/parseFloat/* (Symbol coercion paths)
 *   built-ins/encodeURI / decodeURI / *Component (Symbol & malformed paths)
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1436 — global functions: ToNumber / ToString coercion", () => {
  describe("isNaN propagates abrupt ToNumber completions (§7.1.4 via #1434)", () => {
    it("isNaN(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { isNaN(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("isNaN propagates throws from valueOf", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var marker: any = new TypeError("oops");
            var obj: any = { valueOf: function() { throw marker; } };
            try { isNaN(obj); return 0; }
            catch (e: any) { return e === marker ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("isNaN('foo') is true (Number('foo') is NaN)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "foo";
            return isNaN(s) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("isNaN('42') is false (Number('42') is 42)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "42";
            return isNaN(s) ? 1 : 0;
          }
        `),
      ).toBe(0);
    });

    it("isNaN(undefined) is true (Number(undefined) is NaN)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var u: any;
            return isNaN(u) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("isNaN(null) is false (Number(null) is 0)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var n: any = null;
            return isNaN(n) ? 1 : 0;
          }
        `),
      ).toBe(0);
    });
  });

  describe("isFinite propagates abrupt ToNumber completions", () => {
    it("isFinite(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { isFinite(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("isFinite(Infinity) is false", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            return isFinite(Infinity) ? 1 : 0;
          }
        `),
      ).toBe(0);
    });

    it("isFinite(undefined) is false", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var u: any;
            return isFinite(u) ? 1 : 0;
          }
        `),
      ).toBe(0);
    });

    it("isFinite('42') is true (Number('42') is 42)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "42";
            return isFinite(s) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("isFinite(null) is true (Number(null) is 0)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var n: any = null;
            return isFinite(n) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });

  describe("parseInt threads ToString through the native global (§19.2.5)", () => {
    it("parseInt(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { parseInt(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("parseInt('  0x1F  ') honors 0x prefix", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "  0x1F  ";
            return parseInt(s);
          }
        `),
      ).toBe(31);
    });

    it("parseInt('42', 2) is NaN (invalid char)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "42";
            var v: any = parseInt(s, 2);
            return Number.isNaN(v) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("parseInt('11', 2) is 3", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "11";
            return parseInt(s, 2);
          }
        `),
      ).toBe(3);
    });
  });

  describe("parseFloat threads ToString through the native global (§19.2.4)", () => {
    it("parseFloat(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { parseFloat(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("parseFloat('3.14abc') is 3.14", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "3.14abc";
            return parseFloat(s);
          }
        `),
      ).toBe(3.14);
    });

    it("parseFloat('Infinity') is Infinity", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "Infinity";
            var r: any = parseFloat(s);
            return r === Infinity ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("parseFloat('') is NaN", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "";
            var v: any = parseFloat(s);
            return Number.isNaN(v) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });

  describe("URI encode/decode preserve ToString TypeError on Symbol (§19.2.6)", () => {
    it("encodeURI(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { encodeURI(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("encodeURIComponent(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { encodeURIComponent(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("decodeURI(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { decodeURI(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("decodeURIComponent(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { decodeURIComponent(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });
  });

  describe("URI encode/decode round-trips and malformed escapes", () => {
    it("decodeURI('hello%20world') is 'hello world'", async () => {
      expect(
        await runWasm(`
          export function test(): string {
            return decodeURI("hello%20world");
          }
        `),
      ).toBe("hello world");
    });

    it("encodeURI('http://a.b/c d') escapes the space", async () => {
      expect(
        await runWasm(`
          export function test(): string {
            return encodeURI("http://a.b/c d");
          }
        `),
      ).toBe("http://a.b/c%20d");
    });

    it("encodeURIComponent('?=&#') escapes all four", async () => {
      expect(
        await runWasm(`
          export function test(): string {
            return encodeURIComponent("?=&#");
          }
        `),
      ).toBe("%3F%3D%26%23");
    });

    it("decodeURI('%E0%A4%A') throws URIError (malformed)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            try { decodeURI("%E0%A4%A"); return 0; }
            catch (e: any) { return 1; }
          }
        `),
      ).toBe(1);
    });
  });

  describe("Number(x) global threads through the centralized ToNumber funnel", () => {
    it("Number(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { Number(s); return 0; }
            catch (e: any) { return e instanceof TypeError ? 1 : 0; }
          }
        `),
      ).toBe(1);
    });

    it("Number('  42  ') is 42 (trim per spec)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "  42  ";
            return Number(s);
          }
        `),
      ).toBe(42);
    });

    it("Number('') is 0 (parseFloat('') is NaN — they must differ)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = "";
            return Number(s);
          }
        `),
      ).toBe(0);
    });
  });
});
