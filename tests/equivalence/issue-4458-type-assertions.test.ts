import { describe, expect, it } from "vitest";
import { compileToWasm } from "./helpers.js";

/**
 * #4458 — the LEGACY direct front-end mis-compiled type-erased wrapper
 * expressions.
 *
 * `compileExpressionInner` (src/codegen/expressions.ts) had arms for
 * `AsExpression` and `NonNullExpression` but none for `TypeAssertionExpression`
 * (`<T>x`) or `SatisfiesExpression` (`x satisfies T`). Both fell through to the
 * `Unsupported expression` reporter and returned `null`; the #1919 speculative
 * rollback in `compileExpressionBody` then discarded that diagnostic together
 * with the partial body and substituted a default value — so the wrapper
 * evaluated to **0** with a fully successful compile and no diagnostic.
 *
 * The IR front-end already unwraps all three forms (#3583), so only bodies the
 * IR selector REJECTS were affected. Every `legacy` case below therefore
 * contains a deliberate IR rejector (`**`) to force the fallback; the matching
 * `IR-claimed` case omits it, so the pair also pins the two front-ends to the
 * same answer.
 */
describe("#4458 type-erased wrapper expressions on the legacy path", () => {
  describe("angle-bracket assertion <T>x", () => {
    it("legacy path (IR-rejected body): const initializer", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = <number>x;
          return y + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("IR-claimed body: const initializer", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = <number>x;
          return y + 2;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: return position", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          return (<number>x) + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: call argument", async () => {
      const exports = await compileToWasm(`
        function id(n: number): number {
          return n;
        }
        export function test(): number {
          const x: number = 7;
          return id(<number>x) + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: nested wrappers unwrap to the operand", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = <number>(<number>x);
          return y + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });
  });

  describe("satisfies operator x satisfies T", () => {
    it("legacy path (IR-rejected body): const initializer", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = x satisfies number;
          return y + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("IR-claimed body: const initializer", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = x satisfies number;
          return y + 2;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: return position", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          return (x satisfies number) + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: call argument", async () => {
      const exports = await compileToWasm(`
        function id(n: number): number {
          return n;
        }
        export function test(): number {
          const x: number = 7;
          return id(x satisfies number) + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });
  });

  describe("as expression x as T (control — was already correct)", () => {
    it("legacy path (IR-rejected body): const initializer", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = x as number;
          return y + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("IR-claimed body: const initializer", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const x: number = 7;
          const y = x as number;
          return y + 2;
        }
      `);
      expect(exports.test()).toBe(9);
    });
  });

  describe("non-number operands survive the unwrap", () => {
    it("legacy path: <T>x over a string", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const s: string = "abcd";
          const t = <string>s;
          return t.length + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(6);
    });

    it("legacy path: satisfies over a boolean", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const b: boolean = true;
          const c = b satisfies boolean;
          return (c ? 7 : 3) + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: <T>x over an array element read", async () => {
      const exports = await compileToWasm(`
        export function test(): number {
          const arr: number[] = [1, 2, 7];
          const v = <number>arr[2];
          return v + 2 ** 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });
  });

  describe("the wrapper does not swallow operand side effects", () => {
    it("legacy path: <T>f() still calls f", async () => {
      const exports = await compileToWasm(`
        let calls: number = 0;
        function bump(): number {
          calls = calls + 1;
          return 7;
        }
        export function test(): number {
          const y = <number>bump();
          return y + calls + 2 ** 1 - 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });

    it("legacy path: (f() satisfies T) still calls f", async () => {
      const exports = await compileToWasm(`
        let calls: number = 0;
        function bump(): number {
          calls = calls + 1;
          return 7;
        }
        export function test(): number {
          const y = bump() satisfies number;
          return y + calls + 2 ** 1 - 1;
        }
      `);
      expect(exports.test()).toBe(9);
    });
  });
});
