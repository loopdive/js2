// Spec-compliance gap tests (from #1563 ECMAScript spec gap analysis).
//
// Each test in this file documents a KNOWN gap in the compiler's
// ECMAScript implementation, surfaced by the architect survey in
// `plan/issues/backlog/1563-ecmascript-spec-compliance-gap-analysis.md`.
//
// Convention:
//   - `it.fails(...)` — the assertion expresses spec-correct behaviour
//     but the compiler is known to be wrong today. vitest treats this
//     as an *expected* failure: it PASSES while the bug exists and
//     FAILS the day the bug is fixed (signalling: remove the `.fails`).
//   - `it(...)` — the assertion expresses spec-correct behaviour the
//     compiler already implements; the test is a regression guard.
//
// This file is test-only and cannot regress any production code path.
// The `.fails` markers ensure CI stays green even though the bugs are
// not yet fixed.

import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Spec-compliance gaps (#1563)", { timeout: 20000 }, () => {
  // Gap G3 / proposed #1566 — §7.1.4 ToNumber on Symbol must throw TypeError.
  // currently fails: Number(Symbol('x')) silently returns NaN via host
  // __unbox_number path; spec mandates TypeError before the conversion.
  it.fails("Number(Symbol('x')) throws TypeError (§7.1.4)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        try {
          // @ts-ignore — Symbol() is not type-coercible per spec.
          var n = Number(Symbol("x"));
          return 0; // no-throw: bug present
        } catch (e: any) {
          if (e instanceof TypeError) return 1; // spec-correct
          return 2; // wrong error type
        }
      }
    `);
    expect(exports.test()).toBe(1); // TypeError
  });

  // Gap G3 sibling — §13.5.4 unary `+` on Symbol must throw TypeError.
  // currently fails: +Symbol('x') goes through the same f64 coercion path
  // as Number(Symbol), so it also silently produces NaN instead of throwing.
  it.fails("+Symbol('x') throws TypeError (§13.5.4)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        try {
          // @ts-ignore — unary + on Symbol is not allowed per spec.
          var n = +Symbol("x");
          return 0; // no-throw: bug present
        } catch (e: any) {
          if (e instanceof TypeError) return 1; // spec-correct
          return 2; // wrong error type
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Gap G2 / proposed #1565 — §7.1.2 ToBoolean on BigInt must use i64.eqz.
  // currently passes (regression cover): ToBoolean(0n) and ToBoolean(1n)
  // happen to produce the right answer via the f64-conversion path because
  // the values are small. The deeper bug surfaces for BigInts > 2^53 —
  // see the next test. Keep this test green to prevent regression of the
  // small-BigInt fast path.
  it("Boolean(0n) === false and Boolean(1n) === true (§7.1.2)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        // 1 if (Boolean(0n)===false && Boolean(1n)===true), else 0.
        var a: boolean = Boolean(0n);
        var b: boolean = Boolean(1n);
        if (!a && b) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Bonus: very-large BigInt truthiness — spec says any nonzero BigInt is true.
  // currently fails: compiling `Boolean(1n << 60n)` produces an invalid Wasm
  // binary (WebAssembly.validate fails). Either the BigInt-shift path emits
  // a malformed type or the ToBoolean coercion picks the wrong opcode for
  // i64 receivers — both symptoms of the same missing i64.eqz path.
  it.fails("Boolean(2n**60n) === true (§7.1.2 BigInt precision)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var big: bigint = 1n << 60n; // 2^60 — well above 2^53.
        return Boolean(big) ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Gap G30/G31 / #779c / proposed #1580 — §22.1.3.22 String.prototype.split
  // result must have %Array.prototype% as its [[Prototype]] so that
  // `.constructor` chases up to `Array`.
  // currently passes (regression cover): #779c (task #70, merged) wired the
  // split-result prototype. This test guards against regression of that fix.
  it('"a,b".split(",").constructor === Array (§22.1.3.22)', async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var parts: any = "a,b".split(",");
        return parts.constructor === Array ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Same gap, sibling — Array.prototype.filter / map / slice result constructor.
  // currently passes (regression cover): Array methods now return arrays whose
  // [[Prototype]] is %Array.prototype% so `.constructor === Array` holds.
  // The deeper @@species threading (proposed #1580) is still open; this test
  // only covers the default-constructor case.
  it("[1,2,3].filter(x=>x>1).constructor === Array (§22.1.3.6 / ArraySpeciesCreate)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var src: any = [1, 2, 3];
        var out: any = src.filter((x: number) => x > 1);
        return out.constructor === Array ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Gap G1 / proposed #1564 — §7.1.1 ToPrimitive: if the user-defined
  // [Symbol.toPrimitive] (or valueOf / toString) returns a non-primitive,
  // spec says throw TypeError. The compiler's in-binary fallback at
  // type-coercion.ts:1822-1850 currently lacks the "Type(result) is Object"
  // guard and silently propagates the returned object.
  // currently fails: the snippet below should throw TypeError but does not.
  it.fails("ToPrimitive throws TypeError when valueOf/toString return objects (§7.1.1 step 7)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var o: any = {
          valueOf() { return {}; },     // non-primitive
          toString() { return {}; },    // non-primitive
        };
        try {
          // Trigger ToPrimitive(o, "number"): unary + uses ToNumber → ToPrimitive.
          var n = +o;
          return 0; // no-throw: bug present
        } catch (e: any) {
          if (e instanceof TypeError) return 1; // spec-correct
          return 2; // wrong error type
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Same gap, string-hint variant — String(o) uses hint "string".
  // currently fails: same fallback path lacks the guard.
  it.fails("ToPrimitive (string hint) throws TypeError on non-primitive toString (§7.1.1)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var o: any = {
          toString() { return {}; },
          valueOf() { return {}; },
        };
        try {
          // String(o) takes hint "string" → ToPrimitive(o, "string").
          var s: string = String(o);
          return 0; // no-throw: bug present
        } catch (e: any) {
          if (e instanceof TypeError) return 1; // spec-correct
          return 2; // wrong error type
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
