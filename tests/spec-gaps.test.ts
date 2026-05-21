/**
 * Spec-gap compliance checklist (#1563).
 *
 * Each test here exercises a KNOWN ECMAScript spec gap in the compiler.
 * Most are EXPECTED TO FAIL today — they are tracked under specific issues
 * (#1564, #1565, #1566 and friends) surfaced by the gap analysis in
 * `plan/issues/backlog/1563-ecmascript-spec-compliance-gap-analysis.md`.
 *
 * This file is a living compliance checklist: as each underlying bug is
 * fixed, the corresponding test should start passing. We deliberately do
 * NOT mark these `it.fails` — we want the failure surface visible so the
 * tech lead sees the residual spec debt at every test run.
 *
 * Each test returns a string sentinel (e.g. `'TypeError'`, `'no-throw'`)
 * rather than throwing, so the failure mode is observable as a value
 * mismatch instead of an uncaught Wasm trap.
 */

import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("ECMAScript spec gaps (#1563 living checklist)", () => {
  // ---------------------------------------------------------------------
  // §7.1.3 ToNumeric — Symbol must throw TypeError
  // ---------------------------------------------------------------------
  // currently fails: #1566 — Number(Symbol(...)) silently produces NaN
  // through the `_toNumber` host path instead of throwing TypeError per
  // spec step "If argument is Symbol, throw a TypeError exception."
  it("§7.1.3 ToNumeric(Symbol) throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        try {
          const s: any = Symbol("x");
          const _n = Number(s);
          return "no-throw";
        } catch (e) {
          return e instanceof TypeError ? "TypeError" : "other";
        }
      }
    `);
    expect(exports.test()).toBe("TypeError");
  });

  // ---------------------------------------------------------------------
  // §7.1.4 ToNumber — Symbol via unary plus must throw TypeError
  // ---------------------------------------------------------------------
  // currently fails: #1566 — `+Symbol(...)` does not throw; the unary `+`
  // lowering coerces via the same host path that returns NaN.
  it("§7.1.4 ToNumber(Symbol) via unary plus throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        try {
          const s: any = Symbol("x");
          const _n = +s;
          return "no-throw";
        } catch (e) {
          return e instanceof TypeError ? "TypeError" : "other";
        }
      }
    `);
    expect(exports.test()).toBe("TypeError");
  });

  // ---------------------------------------------------------------------
  // §7.1.2 ToBoolean(BigInt) — precision-preserving truthiness
  // ---------------------------------------------------------------------
  // currently fails: #1565 — Boolean(BigInt) lowers through `f64.convert_i64_s`
  // which loses precision; for very large BigInts (>2^53) the f64 round-trip
  // can yield the wrong truthiness, and the spec mandates an i64-level test.
  it("§7.1.2 ToBoolean(0n) is false, ToBoolean(1n) is true, large BigInt is true", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const a = Boolean(0n);
        const b = Boolean(1n);
        const c = Boolean(2n ** 100n);
        // Encode three booleans as a single tag string so we can return one value.
        return (a ? "T" : "F") + (b ? "T" : "F") + (c ? "T" : "F");
      }
    `);
    expect(exports.test()).toBe("FTT");
  });

  // ---------------------------------------------------------------------
  // §22.1.3.22 String.prototype.split — result is a true Array
  // ---------------------------------------------------------------------
  // currently fails: #779c / #1580 — `.split(",")` returns an array whose
  // `[[Prototype]]` is not `%Array.prototype%`, so `.constructor` is not
  // identical to `Array` and `Object.getPrototypeOf(...)` is not
  // `Array.prototype`. ~78 test262 fails depend on this identity.
  it("§22.1.3.22 String.prototype.split result has %Array.prototype% as its prototype", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const parts = "a,b".split(",");
        const ctorIsArray: any = (parts as any).constructor === Array;
        const protoIsArrayProto: any =
          Object.getPrototypeOf(parts) === Array.prototype;
        return (ctorIsArray ? "T" : "F") + (protoIsArrayProto ? "T" : "F");
      }
    `);
    expect(exports.test()).toBe("TT");
  });

  // ---------------------------------------------------------------------
  // §7.1.1 ToPrimitive — Symbol.toPrimitive returning a non-primitive
  // ---------------------------------------------------------------------
  // currently fails: #1564 — when a user-defined [Symbol.toPrimitive] returns
  // a non-primitive (an Object), spec step 7 mandates throwing a TypeError.
  // The in-binary fallback in `type-coercion.ts:1822-1850` lacks the
  // "if Type(result) is Object" guard.
  it("§7.1.1 ToPrimitive throws TypeError when Symbol.toPrimitive returns an Object", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const o: any = {
          [Symbol.toPrimitive](_hint: string): any {
            return {} as any;
          },
        };
        try {
          const _s = "" + o;
          return "no-throw";
        } catch (e) {
          return e instanceof TypeError ? "TypeError" : "other";
        }
      }
    `);
    expect(exports.test()).toBe("TypeError");
  });
});
