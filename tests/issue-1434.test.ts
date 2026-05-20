// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1434 — ToNumber/ToNumeric coercion and unary operator edge cases.
 *
 * Per ECMA-262 §7.1.4 ToNumber, Symbol and BigInt primitives MUST throw a
 * TypeError when coerced to Number. Two pre-existing gaps blocked spec
 * compliance:
 *
 *   1. The runtime `unbox/number` intent wrapped its final `Number(v)` call
 *      in a `try / catch { return NaN }`. That swallowed the TypeError that
 *      `Number(Symbol())` and `Number(0n)` throw natively. After this fix
 *      the exception propagates to the Wasm catch_all sink, matching the
 *      spec and the prior #1319 / #1379 ToPrimitive chain.
 *
 *   2. Unary `+` on an externref operand fell back to the `parseFloat`
 *      host import when `__unbox_number` had not been pre-registered.
 *      `parseFloat` does NOT throw on Symbol and returns NaN for empty
 *      strings (Number("") is 0 per spec). Routing the externref → f64
 *      coercion through the standard `coerceType` helper guarantees
 *      `__unbox_number` is auto-imported via `addUnionImports`, so the
 *      centralized ToNumber funnel is used in all paths.
 *
 * Sibling fixes:
 *   - #1379 — `++` / `--` ToNumeric on non-number operands.
 *   - #1319 — ToPrimitive on wasm-structs without valueOf/toString.
 *   - #1416 — host ToPrimitive for sidecar @@toPrimitive.
 *
 * Test262 cases this targets:
 *   language/expressions/unary-plus/bigint-throws.js
 *   language/expressions/unary-plus/S11.4.6_A2.2_T1.js
 *   language/expressions/unary-minus/S11.4.7_A2.2_T1.js
 *   language/expressions/unary-minus/bigint-non-primitive.js
 *   built-ins/Symbol/prototype/toPrimitive/* (TypeError propagation)
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1434 — ToNumber / ToNumeric coercion on unary operators", () => {
  describe("Symbol coercion throws TypeError (§7.1.4)", () => {
    it("unary + on Symbol throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { var x: any = +s; return 0; } catch (e) { return 1; }
          }
        `),
      ).toBe(1);
    });

    it("unary - on Symbol throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { var x: any = -s; return 0; } catch (e) { return 1; }
          }
        `),
      ).toBe(1);
    });

    it("bitwise ~ on Symbol throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { var x: any = ~s; return 0; } catch (e) { return 1; }
          }
        `),
      ).toBe(1);
    });

    it("Number(Symbol()) throws TypeError", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { var x: any = Number(s); return 0; } catch (e) { return 1; }
          }
        `),
      ).toBe(1);
    });

    it("++ on Symbol throws TypeError", async () => {
      // UpdateExpression calls ToNumeric (§13.4) which dispatches to ToNumber
      // for non-BigInt operands. Symbol → TypeError.
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try { ++s; return 0; } catch (e) { return 1; }
          }
        `),
      ).toBe(1);
    });
  });

  describe("ToNumber primitives match Number() (§7.1.4)", () => {
    it("unary + on null = 0 (Number(null) = 0)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = null;
            var y: any = +x;
            return y === 0 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary + on undefined = NaN", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any;
            var y: any = +x;
            return Number.isNaN(y) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary + on true = 1, on false = 0", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var a: any = true;
            var b: any = false;
            return (+a) === 1 && (+b) === 0 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it('unary + on empty string = 0 (Number("") = 0, NOT parseFloat NaN)', async () => {
      // Pre-fix: unary + fell back to parseFloat when __unbox_number was
      // unregistered. parseFloat("") = NaN, but Number("") = 0. The fix
      // routes through coerceType which guarantees __unbox_number.
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = "";
            var y: any = +x;
            return y === 0 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary + on whitespace-padded numeric string trims and parses", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = "  42  ";
            var y: any = +x;
            return y === 42 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary + on non-numeric string = NaN", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = "abc";
            var y: any = +x;
            return Number.isNaN(y) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });

  describe("ToPrimitive chain (§7.1.1) for objects", () => {
    it("unary + on { valueOf: () => 5 } returns 5", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = { valueOf: function () { return 5; } };
            var y: any = +x;
            return y === 5 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary + on { valueOf: () => '1', toString: () => '0' } returns 1", async () => {
      // S11.4.6_A2.2_T1 — valueOf is consulted first (hint 'number') and
      // its string return is then ToNumber-coerced to 1.
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = { valueOf: function () { return "1"; }, toString: function () { return "0"; } };
            var y: any = +x;
            return y === 1 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary - on { valueOf: () => -1, toString: () => 0 } returns 1", async () => {
      // S11.4.7_A2.2_T1 — symmetric for unary minus.
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = { valueOf: function () { return -1; }, toString: function () { return 0; } };
            var y: any = -x;
            return y === 1 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("unary + on object with sidecar @@toPrimitive returns its number", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = {};
            x[Symbol.toPrimitive] = function (hint: any) { return 42; };
            var y: any = +x;
            return y === 42 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });

  describe("typeof / void preserve spec semantics", () => {
    it("typeof Symbol() === 'symbol'", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            return typeof s === "symbol" ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("typeof undefined === 'undefined'", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any;
            return typeof x === "undefined" ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("typeof null === 'object'", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = null;
            return typeof x === "object" ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("void 0 yields undefined regardless of operand", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var a: any = void 0;
            var b: any = void "string";
            var c: any = void (function () { return 5; })();
            return a === undefined && b === undefined && c === undefined ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("typeof on Symbol does not invoke ToNumber (no TypeError)", async () => {
      // §12.5.5 typeof: returns "symbol" without coercing.
      expect(
        await runWasm(`
          export function test(): number {
            var s: any = Symbol();
            try {
              var t: any = typeof s;
              return t === "symbol" ? 1 : 0;
            } catch (e) { return 0; }
          }
        `),
      ).toBe(1);
    });
  });

  describe("Unary minus / tilde on strings (regression guard for #1379 + #1434)", () => {
    it("- on string '5' returns -5", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = "5";
            var y: any = -x;
            return y === -5 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("~ on string '5' returns -6 (ToInt32('5') = 5, ~5 = -6)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = "5";
            var y: any = ~x;
            return y === -6 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("~ on null returns -1 (ToInt32(null) = 0, ~0 = -1)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = null;
            var y: any = ~x;
            return y === -1 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("- on object { valueOf: () => '7' } returns -7", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var x: any = { valueOf: function () { return "7"; } };
            var y: any = -x;
            return y === -7 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });
});
