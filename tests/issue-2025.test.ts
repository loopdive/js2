import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// (#2025) Calling an extracted method whose body reads `this`
// (`const f = a.m; f()`) used to TRAP uncatchably ("dereferencing a null
// pointer") because the extraction trampoline passed a `ref.null` receiver and
// the method's `struct.get this` trapped. JS spec throws a *catchable*
// TypeError there (`this` is undefined). The fix makes the trampoline detect a
// GENUINELY-absent receiver and throw a catchable TypeError — only for methods
// that actually read `this`, and only for a truly-null receiver (a merely
// structurally-different receiver keeps its prior behaviour, which is what
// regressed the earlier trampoline-throw attempt #1571).

async function run<T = unknown>(src: string, fn: string): Promise<T> {
  const exports = (await compileAndInstantiate(src)) as Record<string, () => T>;
  return exports[fn]!();
}

describe("#2025 extracted-method null-this", () => {
  it("extracted this-using method throws a CATCHABLE TypeError (not a trap)", async () => {
    const src = `
      class A { x: number = 42; m(): number { return this.x; } }
      export function t(): string {
        const a = new A();
        const f = a.m;
        try { return "got:" + f(); } catch (e) { return "threw"; }
      }
    `;
    expect(await run<string>(src, "t")).toBe("threw");
  });

  it("extracted method that ignores `this` still runs (no spurious throw)", async () => {
    const src = `
      class A { m(): number { return 7; } }
      export function t(): number { const a = new A(); const f = a.m; return f(); }
    `;
    expect(await run<number>(src, "t")).toBe(7);
  });

  it("direct method call is unchanged", async () => {
    const src = `
      class A { x: number = 5; m(): number { return this.x; } }
      export function t(): number { return new A().m(); }
    `;
    expect(await run<number>(src, "t")).toBe(5);
  });

  it("bound extraction (a.m.bind(a)) is unchanged", async () => {
    const src = `
      class A { x: number = 9; m(): number { return this.x; } }
      export function t(): number { const a = new A(); const f = a.m.bind(a); return f(); }
    `;
    expect(await run<number>(src, "t")).toBe(9);
  });

  it("extracted this-using method that is then re-bound via call() works", async () => {
    const src = `
      class A { x: number = 11; m(): number { return this.x; } }
      export function t(): number { const a = new A(); const f = a.m; return f.call(a); }
    `;
    expect(await run<number>(src, "t")).toBe(11);
  });

  it("object-literal extracted method reading `this` throws catchably", async () => {
    const src = `
      const o = { v: 3, m(): number { return this.v; } };
      export function t(): string {
        const f = o.m;
        try { return "got:" + f(); } catch (e) { return "threw"; }
      }
    `;
    expect(await run<string>(src, "t")).toBe("threw");
  });
});
