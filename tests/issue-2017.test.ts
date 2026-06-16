import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2017 — assignment to a getter-only object-literal property must throw a
// catchable strict-mode TypeError (§13.15.2 → §10.1.9 [[Set]] failure), not
// silently no-op. Previously the write trapped with an uncatchable "illegal
// cast"; after the s62 accessor work it silently fell through to the sidecar.
// The fix re-throws the strict-mode TypeError from `_safeSet`.
async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args);
}

describe("#2017 — assignment to getter-only accessor throws TypeError", () => {
  it("throws a catchable TypeError (not illegal cast, not silent)", async () => {
    const r = await run(`
      export function test(): string {
        const o: any = { get x() { return 1; } };
        try { o.x = 99; return "NO-THROW"; }
        catch (e: any) { return e instanceof TypeError ? "TypeError" : "other"; }
      }
    `);
    expect(r).toBe("TypeError");
  });

  it("leaves the getter value unchanged after the rejected write", async () => {
    const r = await run(`
      const o: any = { get x() { return 1; } };
      try { o.x = 99; } catch (e) { /* swallow */ }
      export function test(): number { return o.x; }
    `);
    expect(r).toBe(1);
  });

  it("get/set accessor pairs still accept writes (no over-broad rejection)", async () => {
    const r = await run(`
      let backing = 100;
      const o: any = { get x() { return backing; }, set x(v: number){ backing = v; } };
      o.x = 105;
      export function test(): string { return o.x + "," + backing; }
    `);
    expect(r).toBe("105,105");
  });

  it("adding a brand-new dynamic property still works", async () => {
    const r = await run(`
      const o: any = {};
      o.z = 7;
      export function test(): number { return o.z; }
    `);
    expect(r).toBe(7);
  });
});
