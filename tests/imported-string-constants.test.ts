import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/**
 * Helper: compile TS source and instantiate with string_constants + polyfill.
 * Returns the Wasm instance exports.
 */
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  // The hand-rolled `env` stub this helper used to carry froze the host-import
  // surface of 2026-03. `56d1211acc` (#2773 S7, 2026-07-09, "externref
  // plain-array OOB reads undefined") made `days[1]` pull in
  // `env.__get_undefined` plus the boxing pair, which the stub could not supply
  // — the e2e cases below died on LinkError, not on anything about string
  // constants. Route through the production runtime's import builder so this
  // file tracks the current surface instead of re-pinning a snapshot of it.
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as any)[fn](...args);
}

describe("importedStringConstants", () => {
  describe("WAT output structure", () => {
    it("string literals become global imports from string_constants namespace", async () => {
      const result = await compile(`
        export function hello(): string {
          return "world";
        }
      `);
      expect(result.success).toBe(true);

      // WAT should contain string_constants import, not env import for strings
      expect(result.wat).toContain('(import "string_constants"');
      expect(result.wat).toContain("(global");
      // Should NOT contain __str_ function imports in env
      expect(result.wat).not.toMatch(/\(import "env" "__str_\d+"/);
      // Should use global.get, not call for string literal access
      expect(result.wat).toContain("global.get");
    });

    it("multiple distinct string literals produce multiple global imports", async () => {
      const result = await compile(`
        export function test(): string {
          const a = "foo";
          const b = "bar";
          const c = "baz";
          return a;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toContain("foo");
      expect(result.stringPool).toContain("bar");
      expect(result.stringPool).toContain("baz");
      // (#731, 8d17e2d8e0) also pre-registers the enclosing function's `.name`
      // and the implicit "" alongside the user literals. Pin the exact pool so
      // a literal that stops being interned is still caught.
      expect([...result.stringPool].sort()).toEqual(["", "bar", "baz", "foo", "test"]);
    });

    it("duplicate string literals share the same global import", async () => {
      const result = await compile(`
        export function test(): string {
          const a = "hello";
          const b = "hello";
          return a;
        }
      `);
      expect(result.success).toBe(true);
      // Should only have one entry for "hello"
      expect(result.stringPool.filter((s: string) => s === "hello").length).toBe(1);
    });

    it("no string_constants section when source has no string literals", async () => {
      const result = await compile(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `);
      expect(result.success).toBe(true);
      // (#731, 8d17e2d8e0) makes the pool non-empty for any named declaration:
      // the `.name` metadata for `add`, plus the implicit "". The claim worth
      // keeping is that no *user* string literal is interned, so pin the pool to
      // exactly that metadata — a stray literal import would still fail here.
      expect([...result.stringPool].sort()).toEqual(["", "add"]);
      expect(result.wat).toContain('(import "string_constants" "add"');
    });
  });

  describe("string pool", () => {
    it("stringPool contains all unique string literals", async () => {
      const result = await compile(`
        export function test(): string {
          const x = "alpha";
          const y = "beta";
          return x;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toEqual(expect.arrayContaining(["alpha", "beta"]));
    });

    it("stringPool contains template literal parts", async () => {
      const result = await compile(`
        export function greet(name: string): string {
          return "Hello, " + name + "!";
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toContain("Hello, ");
      expect(result.stringPool).toContain("!");
    });

    it("stringPool contains string enum values", async () => {
      const result = await compile(`
        enum Color { Red = "RED", Green = "GREEN", Blue = "BLUE" }
        export function test(): string {
          return Color.Red;
        }
      `);
      expect(result.success).toBe(true);
      expect(result.stringPool).toContain("RED");
      expect(result.stringPool).toContain("GREEN");
      expect(result.stringPool).toContain("BLUE");
    });
  });

  describe("buildStringConstants", () => {
    it("creates WebAssembly.Global objects from string pool", () => {
      const constants = buildStringConstants(["hello", "world"]);
      expect(constants["hello"]).toBeInstanceOf(WebAssembly.Global);
      expect(constants["world"]).toBeInstanceOf(WebAssembly.Global);
      expect(constants["hello"].value).toBe("hello");
      expect(constants["world"].value).toBe("world");
    });

    it("deduplicates strings in the pool", () => {
      const constants = buildStringConstants(["a", "b", "a"]);
      expect(Object.keys(constants).length).toBe(2);
      expect(constants["a"].value).toBe("a");
      expect(constants["b"].value).toBe("b");
    });

    it("handles empty string pool", () => {
      const constants = buildStringConstants([]);
      expect(Object.keys(constants).length).toBe(0);
    });

    it("handles empty string as a key", () => {
      const constants = buildStringConstants([""]);
      expect(constants[""]).toBeInstanceOf(WebAssembly.Global);
      expect(constants[""].value).toBe("");
    });

    it("handles special characters in strings", () => {
      const constants = buildStringConstants(["hello\nworld", "tab\there", 'quotes"inside']);
      expect(constants["hello\nworld"].value).toBe("hello\nworld");
      expect(constants["tab\there"].value).toBe("tab\there");
      expect(constants['quotes"inside'].value).toBe('quotes"inside');
    });
  });

  describe("end-to-end execution", () => {
    it("returns a string literal", async () => {
      expect(await run(`export function hello(): string { return "world"; }`, "hello")).toBe("world");
    });

    it("compares string with literal using ===", async () => {
      const src = `
        export function check(s: string): boolean {
          return s === "expected";
        }
      `;
      expect(await run(src, "check", ["expected"])).toBe(1);
      expect(await run(src, "check", ["other"])).toBe(0);
    });

    it("concatenates string literal with parameter", async () => {
      expect(
        await run(
          `
          export function greet(name: string): string {
            return "Hello, " + name;
          }
        `,
          "greet",
          ["Alice"],
        ),
      ).toBe("Hello, Alice");
    });

    it("multiple string literals in one function", async () => {
      expect(
        await run(
          `
          export function classify(n: number): string {
            if (n < 0) return "negative";
            if (n === 0) return "zero";
            return "positive";
          }
        `,
          "classify",
          [0],
        ),
      ).toBe("zero");
    });

    it("string enum value is accessible at runtime", async () => {
      expect(
        await run(
          `
          enum Dir { Up = "UP", Down = "DOWN" }
          export function test(): string {
            return Dir.Down;
          }
        `,
          "test",
        ),
      ).toBe("DOWN");
    });

    it("string array literal access works", async () => {
      expect(
        await run(
          `
          export function test(): string {
            const days = ["MON", "TUE", "WED"];
            return days[1];
          }
        `,
          "test",
        ),
      ).toBe("TUE");
    });

    it("binary validates with WebAssembly.validate", async () => {
      const result = await compile(`
        export function test(): string {
          return "hello";
        }
      `);
      expect(result.success).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
    });

    it("module with no strings needs no string_constants import", async () => {
      const result = await compile(`
        export function add(a: number, b: number): number {
          return a + b;
        }
      `);
      expect(result.success).toBe(true);
      // Same (#731, 8d17e2d8e0) fact from the instantiation side: the module now
      // imports `string_constants` for its `.name` metadata, so a bare `env: {}`
      // no longer links. The intent — a string-free module runs correctly — is
      // kept by supplying only what the pool actually asks for and still
      // asserting no `env` import is required.
      expect(result.imports).toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, {
        env: {},
        string_constants: buildStringConstants(result.stringPool),
      } as WebAssembly.Imports);
      expect((instance.exports as any).add(2, 3)).toBe(5);
    });

    it("module globals coexist with string constant globals", async () => {
      const src = `
        let counter = 0;
        export function increment(): number {
          counter = counter + 1;
          return counter;
        }
        export function label(): string {
          return "count";
        }
      `;
      const result = await compile(src);
      expect(result.success).toBe(true);

      const env: Record<string, Function> = {
        console_log_number: () => {},
        console_log_bool: () => {},
        console_log_string: () => {},
      };
      const jsStringPolyfill = {
        concat: (a: string, b: string) => a + b,
        length: (s: string) => s.length,
        equals: (a: string, b: string) => (a === b ? 1 : 0),
        substring: (s: string, start: number, end: number) => s.substring(start, end),
        charCodeAt: (s: string, i: number) => s.charCodeAt(i),
      };

      const { instance } = await WebAssembly.instantiate(result.binary, {
        env,
        "wasm:js-string": jsStringPolyfill,
        string_constants: buildStringConstants(result.stringPool),
      } as WebAssembly.Imports);
      const exports = instance.exports as any;

      // Module globals work
      expect(exports.increment()).toBe(1);
      expect(exports.increment()).toBe(2);
      // String constant works
      expect(exports.label()).toBe("count");
    });
  });
});
