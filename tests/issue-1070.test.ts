import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildCompiledImports } from "../src/runtime.ts";
import { compileAndRunTestSyncJoined } from "./helpers/compile.js";

// (#6986) Intl has no native implementation on the native semantic regime:
// these extern classes forward to the host's Intl only with the `intl` host
// accelerator (`--host-accelerator intl`).
const INTL = { hostAccelerators: ["intl"] } as const;

const compileAndRun = (source: string) => compileAndRunTestSyncJoined(source, INTL);

async function compileAndValidate(source: string): Promise<{ valid: boolean; error?: string }> {
  const result = await compile(source, { fileName: "test.ts", ...INTL });
  if (!result.success) {
    return { valid: false, error: `Compile error: ${result.errors?.map((e) => e.message).join("; ")}` };
  }
  try {
    const valid = WebAssembly.validate(result.binary);
    if (!valid) {
      return { valid: false, error: "WebAssembly.validate failed" };
    }
    const imports = buildCompiledImports(result);
    const mod = new WebAssembly.Module(result.binary);
    new WebAssembly.Instance(mod, imports);
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
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
