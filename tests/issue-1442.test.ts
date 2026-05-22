import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): any {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.[0]?.message}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("#1442 — String.prototype methods: ToString on receiver", () => {
  describe("Boolean primitive receivers (the main regression)", () => {
    it("String.prototype.trim.call(true) === 'true'", () => {
      // Without `__box_boolean` routing, `true` was boxed as `Number(1)` and
      // the result was `"1"` instead of `"true"`.
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          const r = String.prototype.trim.call(true);
          return r === "true" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("String.prototype.trim.call(false) === 'false'", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          const r = String.prototype.trim.call(false);
          return r === "false" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("String.prototype.toLowerCase.call(true) === 'true'", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          const r = String.prototype.toLowerCase.call(true);
          return r === "true" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("String.prototype.charAt.call(true, 0) === 't'", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          const r = String.prototype.charAt.call(true, 0);
          return r === "t" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("Number primitive receivers", () => {
    it("String.prototype.trim.call(-Infinity) === '-Infinity'", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          const r = String.prototype.trim.call(-Infinity);
          return r === "-Infinity" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("String.prototype.indexOf.call(123, '2') === 1", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          return String.prototype.indexOf.call(123, "2");
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("Null / undefined receivers (RequireObjectCoercible)", () => {
    it("String.prototype.charAt.call(null) throws TypeError", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          try {
            String.prototype.charAt.call(null);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : 0;
          }
        }
      `);
      expect(r).toBe(1);
    });

    it("String.prototype.trim.call(undefined) throws TypeError", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          try {
            String.prototype.trim.call(undefined);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : 0;
          }
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("Wrapper object receivers", () => {
    it("String.prototype.trim.call(new Boolean(true)) === 'true'", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          const r = String.prototype.trim.call(new Boolean(true));
          return r === "true" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("String.prototype.indexOf.call(new Number(123), '2') === 1", () => {
      const r = compileAndRun(`
        declare const String: any;
        export function test(): number {
          return String.prototype.indexOf.call(new Number(123), "2");
        }
      `);
      expect(r).toBe(1);
    });
  });
});
