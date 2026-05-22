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

describe("#1444 — RegExp named groups: `in` on result.groups", () => {
  describe("`in` operator on host externref objects", () => {
    it("returns 1 for a key on regex result.groups (matched)", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<a>a)(?<b>b)?/.exec("a");
          return m && m.groups && ("a" in m.groups) ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("returns 1 for a key on regex result.groups (unmatched optional)", () => {
      // Per §22.2.7.4 step 33.h, every named-capture key is set on `groups`
      // even when its alternative didn't match — value is `undefined` but
      // the key itself is present. `'b' in groups` must return true.
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<a>a)(?<b>b)?/.exec("a");
          return m && m.groups && ("b" in m.groups) ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("returns 1 for both groups in alternation", () => {
      // groups-object-unmatched.js — every named group from the regex is an
      // own key on `groups`, regardless of which alternative matched.
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<x>x)|(?<y>y)/.exec("y");
          if (!m || !m.groups) return -1;
          return ("x" in m.groups) && ("y" in m.groups) ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("returns 0 for a key not present on groups", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<a>a)/.exec("a");
          return m && m.groups && ("zzz" in m.groups) ? 1 : 0;
        }
      `);
      expect(r).toBe(0);
    });
  });

  describe("groups access (regression coverage)", () => {
    it("groups.x === undefined when alternative didn't match", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<a>a).|(?<x>x)/.exec("ab");
          return m && m.groups && m.groups.x === undefined ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("duplicate-named groups resolve to the matched alternative (ES2025)", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<x>a)|(?<x>b)/.exec("bab");
          if (!m || !m.groups) return 0;
          return m[0] === "b" && m.groups.x === "b" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("Lookbehind regressions (sticky / variable / alternation)", () => {
    it("basic lookbehind matches", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<=x)y/.exec("xy");
          return m && m[0] === "y" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("lookbehind with alternation", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<=a|bb)c/.exec("bbc");
          return m && m[0] === "c" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("variable-length lookbehind", () => {
      const r = compileAndRun(`
        export function test(): number {
          const m: any = /(?<=ab+)c/.exec("abbbc");
          return m && m[0] === "c" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("`in` for non-host objects still resolves statically", () => {
    it("array index `in` still works for vec structs", () => {
      const r = compileAndRun(`
        export function test(): number {
          const arr = [10, 20, 30];
          return (0 in arr) && (2 in arr) && !(5 in arr) ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("'length' in array returns 1", () => {
      const r = compileAndRun(`
        export function test(): number {
          const arr = [1, 2];
          return "length" in arr ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });
});
