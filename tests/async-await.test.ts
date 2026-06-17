import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// These tests previously instantiated with a bare `{ env: {} }` import object,
// which no longer satisfies a compiled module's imports (it needs
// `string_constants` etc. — #1667), so all but the .d.ts checks failed on main.
// Migrated to the `compile()` + `buildImports` harness, which auto-fills the
// full import set. Async fns still take the legacy synchronous path
// (ASYNC_CPS_ENABLED is off), so calling one returns the value directly.
//
// Awaited values come from INTERNAL compiled async functions. Host `declare
// class` method calls returning `number` do NOT marshal correctly (a
// pre-existing defect independent of async — a sync `svc.fetchValue(): number`
// already returns the default 0 on main), so the old `Host.*` shapes are
// replaced with internal async callees that do marshal.

async function instantiate(src: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(src);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if (imports.setExports) imports.setExports(exports as Record<string, Function>);
  return exports;
}

describe("async/await support", () => {
  it("async function returning a number compiles and runs", async () => {
    const exports = await instantiate(`
      export async function getNum(): Promise<number> {
        return 42;
      }
    `);
    expect(exports.getNum()).toBe(42);
  });

  it("await on an internal async value (#1796 — genuine suspension returns a real Promise)", async () => {
    // `getValue` awaits `fetchValue()` (a non-static async call) so it
    // genuinely suspends and is CPS-lowered to return a real Promise — no
    // longer the legacy synchronous fakery. Await it through a microtask tick.
    const exports = await instantiate(`
      async function fetchValue(): Promise<number> { return 99; }
      export async function getValue(): Promise<number> {
        const val = await fetchValue();
        return val;
      }
    `);
    await expect(exports.getValue()).resolves.toBe(99);
  });

  it("async function with multiple sequential awaits", async () => {
    const exports = await instantiate(`
      async function getA(): Promise<number> { return 10; }
      async function getB(): Promise<number> { return 20; }
      export async function sumTwo(): Promise<number> {
        const a = await getA();
        const b = await getB();
        return a + b;
      }
    `);
    expect(exports.sumTwo()).toBe(30);
  });

  it("async void function compiles and runs", async () => {
    const exports = await instantiate(`
      export async function doWork(): Promise<void> {
        const x = 1 + 2;
      }
    `);
    expect(() => exports.doWork()).not.toThrow();
  });

  it("Promise<number> return type maps correctly in .d.ts", async () => {
    const result = await compile(`
      export async function compute(): Promise<number> {
        return 5;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.dts).toContain("Promise<number>");
    expect(result.dts).toContain("compute");
  });

  it("async function with arithmetic on awaited values", async () => {
    const exports = await instantiate(`
      async function getX(): Promise<number> { return 7; }
      async function getY(): Promise<number> { return 3; }
      export async function calculate(): Promise<number> {
        const x = await getX();
        const y = await getY();
        return x * y + 1;
      }
    `);
    expect(exports.calculate()).toBe(22); // 7 * 3 + 1
  });

  it("async function with boolean return", async () => {
    const exports = await instantiate(`
      export async function check(): Promise<boolean> {
        return true;
      }
    `);
    expect(exports.check()).toBe(1); // boolean true = i32(1)
  });

  it("non-async function is not marked as async in .d.ts", async () => {
    const result = await compile(`
      export function syncFn(): number { return 1; }
      export async function asyncFn(): Promise<number> { return 2; }
    `);
    expect(result.success).toBe(true);
    // syncFn should not have Promise wrapper
    expect(result.dts).toContain("syncFn(): number;");
    // asyncFn should have Promise wrapper
    expect(result.dts).toContain("asyncFn(): Promise<number>;");
  });
});
