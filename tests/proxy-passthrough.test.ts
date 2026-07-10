import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Helper: compile TS source and instantiate with the shared buildImports()
 * host-import builder so every runtime helper the binary declares is
 * supplied — including the `string_constants` import namespace (#1667).
 * The hand-rolled `{ env: {} }` this replaced was missing
 * `string_constants`, which broke all three tests at instantiation time
 * once string literals became imported constants (#3127 — same root cause
 * and fix as tests/functional-array-methods.test.ts).
 */
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any)[fn](...args);
}

describe("Proxy pass-through (issue #498 tier 0)", () => {
  it("new Proxy(target, {}) returns target value for struct property access", async () => {
    const src = `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const target = new Point(10, 20);
        const proxy = new Proxy(target, {});
        return proxy.x + proxy.y;
      }
    `;
    expect(await run(src, "test")).toBe(30);
  });

  it("new Proxy(target, handler) with get trap fires the trap (§10.5.8)", async () => {
    // (#3127) This test originally asserted the tier-0 "pass-through" mode
    // where the get trap was IGNORED (expected 42, the target's value). Since
    // #2180 the compiler builds real host Proxies with working traps, so the
    // spec-correct result is the trap's return value.
    const src = `
      class Box {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      export function test(): number {
        const obj = new Box(42);
        const p = new Proxy(obj, {
          get(t: Box, prop: string) { return 7; }
        });
        // Real Proxy semantics: the get trap fires — p.value is the trap result.
        return p.value;
      }
    `;
    expect(await run(src, "test")).toBe(7);
  });

  it("proxy of simple object passes through field reads", async () => {
    const src = `
      export function test(): number {
        const target = { a: 3, b: 7 };
        const proxy = new Proxy(target, {});
        return proxy.a * proxy.b;
      }
    `;
    expect(await run(src, "test")).toBe(21);
  });
});
