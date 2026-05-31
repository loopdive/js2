// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1637 — two halves:
 *
 * 1. Boolean.prototype.toString/valueOf receiver coercion (§20.3.3.2/.3
 *    thisBooleanValue): a numeric/bigint receiver arriving via
 *    __extern_method_call is coerced back to a boolean primitive.
 * 2. Implicit Symbol→string coercion must throw TypeError (§7.1.17 ToString).
 *    Explicit String()/.toString() on a Symbol is allowed and out of scope.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, {}, r.stringPool) as Record<string, unknown> & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("Symbol implicit string coercion throws TypeError (#1637)", () => {
  it("template literal substitution of a Symbol throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          const s = \`\${Symbol("x")}\`;
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("string + Symbol concatenation throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          const s = "v=" + Symbol("x");
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Symbol + string concatenation throws TypeError", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          const s = Symbol("x") + "=v";
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("non-Symbol concat and templates are unaffected", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return "n=" + 5 + ", b=" + true + \`, t=\${42}\`;
      }
    `);
    expect(exports.test()).toBe("n=5, b=true, t=42");
  });

  it("Symbol.for with a string key still works", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        return Symbol.for("abc") === Symbol.for("abc");
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Symbol.keyFor on an unregistered Symbol returns undefined", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        return Symbol.keyFor(Symbol("x")) === undefined;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});

describe("#1637 — Boolean.prototype receiver coercion", () => {
  it('Boolean.prototype.toString.call(0) === "false"', async () => {
    const r = await run(`export function test(): string { return (Boolean.prototype.toString as any).call(0); }`);
    expect(r).toBe("false");
  });

  it('Boolean.prototype.toString.call(1) === "true"', async () => {
    const r = await run(`export function test(): string { return (Boolean.prototype.toString as any).call(1); }`);
    expect(r).toBe("true");
  });

  it("Boolean.prototype.valueOf.call(true) === true", async () => {
    const r = await run(
      `export function test(): number { return (Boolean.prototype.valueOf as any).call(true) === true ? 1 : 0; }`,
    );
    expect(r).toBe(1);
  });

  it("Boolean.prototype.valueOf.call(false) === false", async () => {
    const r = await run(
      `export function test(): number { return (Boolean.prototype.valueOf as any).call(false) === false ? 1 : 0; }`,
    );
    expect(r).toBe(1);
  });

  it('Boolean.prototype.toString.call(true) === "true"', async () => {
    const r = await run(`export function test(): string { return (Boolean.prototype.toString as any).call(true); }`);
    expect(r).toBe("true");
  });
});
