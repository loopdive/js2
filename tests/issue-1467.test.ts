// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #1467 — Error / AggregateError / Symbol prototype protocol fidelity.
 *
 * Closes four spec gaps:
 *   1. Symbol.prototype.description accessor (35 test262 fails)
 *   2. Error.prototype.toString receiver checks (30 fails — partial here;
 *      the prototype-replacement bucket needs a deeper rework tracked
 *      separately, but Error.toString returning "name: message" still works)
 *   3. AggregateError without `new`, ToString on message, IterableToList,
 *      non-enumerable own properties (25 fails)
 *   4. Error.isError(value) ES2025 static method (12 fails)
 */
describe("#1467 — Error / Symbol / AggregateError protocol fidelity", () => {
  describe("Symbol.prototype.description", () => {
    it("Symbol('x').description === 'x'", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          const s = Symbol('hello');
          return s.description === 'hello' ? 1 : 0;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("Symbol().description === undefined", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          const s = Symbol();
          return s.description === undefined ? 1 : 0;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("preserves description across multiple symbols", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          const a = Symbol('alpha');
          const b = Symbol('beta');
          const c = Symbol();
          if (a.description !== 'alpha') return 0;
          if (b.description !== 'beta') return 0;
          if (c.description !== undefined) return 0;
          return 1;
        }
      `);
      expect(exp.test!()).toBe(1);
    });
  });

  describe("AggregateError (new)", () => {
    it("new AggregateError([], msg) sets message", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          const e = new AggregateError([], 'oops');
          return e.message === 'oops' ? 1 : 0;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("coerces non-string message via ToString", async () => {
      // Spec §20.5.7.1.1 step 3.b: message is run through ToString.
      const exp = await compileToWasm(`
        export function test(): number {
          const e = new AggregateError([], 42 as any);
          return e.message === '42' ? 1 : 0;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("errors is stored as own property (length matches input)", async () => {
      // NOTE: __make_iterable recursively walks the iterable and misinterprets
      // host Error instances as zero-length vecs, so we can't yet assert
      // `errors[0].message`. The OWN-PROPERTY shape (length, descriptor flags)
      // is still verifiable.
      const exp = await compileToWasm(`
        export function test(): number {
          const e = new AggregateError(['a', 'b', 'c'], 'm');
          if ((e as any).errors.length !== 3) return 0;
          if ((e as any).errors[0] !== 'a') return 0;
          if ((e as any).errors[2] !== 'c') return 0;
          return 1;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("undefined errors arg throws TypeError per spec", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          try {
            new AggregateError(undefined as any, 'm');
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : 0;
          }
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("instance has AggregateError.prototype in its chain", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          const e = new AggregateError([], 'm');
          return e instanceof AggregateError ? 1 : 0;
        }
      `);
      expect(exp.test!()).toBe(1);
    });
  });

  describe("Error.isError", () => {
    it("Error.isError(new Error()) === true", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          return (Error as any).isError(new Error('x')) === true ? 1 : 0;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("returns true for Error subclass instances", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          if ((Error as any).isError(new TypeError('a')) !== true) return 0;
          if ((Error as any).isError(new RangeError('b')) !== true) return 0;
          if ((Error as any).isError(new SyntaxError('c')) !== true) return 0;
          return 1;
        }
      `);
      expect(exp.test!()).toBe(1);
    });

    it("returns false for non-error objects and primitives", async () => {
      const exp = await compileToWasm(`
        export function test(): number {
          if ((Error as any).isError({}) !== false) return 0;
          if ((Error as any).isError('Error') !== false) return 0;
          if ((Error as any).isError(null) !== false) return 0;
          if ((Error as any).isError(undefined) !== false) return 0;
          return 1;
        }
      `);
      expect(exp.test!()).toBe(1);
    });
  });

  describe("Error.prototype.toString", () => {
    it('default format is "name: message"', async () => {
      const exp = await compileToWasm(`
        export function test(): string {
          const e = new Error('boom');
          return e.toString();
        }
      `);
      expect(exp.test!()).toBe("Error: boom");
    });

    it("TypeError.toString preserves the type name", async () => {
      const exp = await compileToWasm(`
        export function test(): string {
          const e = new TypeError('bad');
          return e.toString();
        }
      `);
      expect(exp.test!()).toBe("TypeError: bad");
    });
  });
});
