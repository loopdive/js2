import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndValidate(source: string): Promise<{ valid: boolean; error?: string }> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    return { valid: false, error: `Compile error: ${result.errors?.map((e) => e.message).join("; ")}` };
  }
  try {
    const valid = WebAssembly.validate(result.binary);
    if (!valid) {
      return { valid: false, error: "WebAssembly.validate failed" };
    }
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const mod = new WebAssembly.Module(result.binary);
    new WebAssembly.Instance(mod, imports);
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}

async function compileAndRun(source: string): Promise<any> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

describe("#1070 — Intl.ListFormat / Intl.NumberFormat extern class", () => {
  it("new Intl.ListFormat compiles and validates", async () => {
    const { valid, error } = await compileAndValidate(`
      export function test(): number {
        const fmt = new Intl.ListFormat("en", { type: "conjunction" });
        return fmt ? 1 : 0;
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("new Intl.NumberFormat compiles and validates", async () => {
    const { valid, error } = await compileAndValidate(`
      export function test(): number {
        const fmt = new Intl.NumberFormat("en-US");
        return fmt ? 1 : 0;
      }
    `);
    expect(error).toBeUndefined();
    expect(valid).toBe(true);
  });

  it("Intl.NumberFormat.format works with number argument", async () => {
    const result = await compileAndRun(`
      export function test(): string {
        const fmt = new Intl.NumberFormat("en-US");
        return fmt.format(1234.5);
      }
    `);
    expect(result).toBe("1,234.5");
  });

  it("Intl.ListFormat instance is truthy", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const fmt = new Intl.ListFormat("en");
        return fmt ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Intl.NumberFormat.resolvedOptions returns object", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const fmt = new Intl.NumberFormat("en-US");
        const opts = fmt.resolvedOptions();
        return opts ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
