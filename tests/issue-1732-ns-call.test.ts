import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, standalone = false): Promise<unknown> {
  // The boolean `standalone` option was replaced by `target: "standalone"`.
  const r = await compile(src, { fileName: "test.ts", ...(standalone ? { target: "standalone" as const } : {}) });
  if (!r.success) throw new Error("compile failed: " + (r.errors?.[0]?.message ?? "?"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports.test as () => unknown)();
}

// #1732 — a built-in non-callable namespace object (Math/JSON/Reflect/Atomics)
// has no [[Call]]; calling it as a function must throw TypeError. The new-site
// already threw via the NAMESPACE_NON_CONSTRUCTORS guard in new-super.ts; this
// closes the call-as-function form (built-ins/Math/prop-desc.js "no [[Call]]").
describe("#1732 non-callable namespace call throws TypeError", () => {
  for (const ns of ["Math", "JSON", "Reflect", "Atomics"]) {
    for (const standalone of [false, true]) {
      it(`${ns}() throws TypeError (standalone=${standalone})`, async () => {
        const src = `export function test(): number { try { (${ns} as any)(); return 0; } catch(e) { return e instanceof TypeError ? 1 : 2; } }`;
        expect(await run(src, standalone)).toBe(1);
      });
    }
  }

  // Guard: member calls on the namespace still work (no over-broad throw).
  it("Math.abs(-5) still works", async () => {
    expect(await run(`export function test(): number { return Math.abs(-5); }`)).toBe(5);
  });
  it("Math.max(1, 2) still works", async () => {
    expect(await run(`export function test(): number { return Math.max(1, 2); }`)).toBe(2);
  });

  // Guard: `new Math()` keeps throwing (the existing #1732 S2 new-site guard).
  it("new Math() still throws TypeError", async () => {
    const src = `export function test(): number { try { new (Math as any)(); return 0; } catch(e) { return e instanceof TypeError ? 1 : 2; } }`;
    expect(await run(src)).toBe(1);
  });

  // Guard: a user-declared identifier named like a namespace is NOT intercepted.
  it("a user function named JSON-like is still callable", async () => {
    const src = `function myMath(): number { return 7; } export function test(): number { return myMath(); }`;
    expect(await run(src)).toBe(7);
  });
});
