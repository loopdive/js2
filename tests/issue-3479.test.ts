import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

// #3479 — a class's static method must be a real own property of the constructor
// visible to the reflective host operations, INCLUDING the uncurried
// `Object.prototype.hasOwnProperty.call(C, "m")` form (propertyHelper.js's
// `__hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)`).
// Before the fix, the `_wrapForHost` proxy's has/getOwnPropertyDescriptor traps
// did not consult `_staticMethodNames`, so `hasOwnProperty.call(C, "m")` was
// false even though `"m" in C` and `Object.getOwnPropertyDescriptor(C, "m")` were true.
describe("#3479 static class method own-property reflection via hasOwnProperty.call", () => {
  it("hasOwnProperty.call(C, staticMethod) is true", async () => {
    const src = `
      class C { static m() { return 42; } }
      export function test(): number {
        return Object.prototype.hasOwnProperty.call(C, "m") ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("the .call.bind uncurried form (propertyHelper shape) is true", async () => {
    const src = `
      class C { static m() { return 42; } }
      export function test(): number {
        const __hasOwn: any = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
        return __hasOwn(C, "m") ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("getOwnPropertyDescriptor(C, staticMethod) has spec flags {w:true,e:false,c:true}", async () => {
    const src = `
      class C { static m() { return 42; } }
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(C, "m");
        if (!d) return 0;
        return (d.writable === true && d.enumerable === false && d.configurable === true) ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("does not fabricate an own property for an absent static method name", async () => {
    const src = `
      class C { static m() { return 42; } }
      export function test(): number {
        return Object.prototype.hasOwnProperty.call(C, "nope") ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("in / hasOwnProperty / getOwnPropertyDescriptor agree for a static method", async () => {
    const src = `
      class C { static m() { return 42; } }
      export function test(): number {
        const a = ("m" in C) ? 1 : 0;
        const b = Object.prototype.hasOwnProperty.call(C, "m") ? 1 : 0;
        const c = Object.getOwnPropertyDescriptor(C, "m") ? 1 : 0;
        return a + b + c; // expect 3 — all agree
      }
    `;
    expect(await run(src)).toBe(3);
  });
});
