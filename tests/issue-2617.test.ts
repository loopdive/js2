import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// #2617 — a Proxy trap's abrupt completion (throw) and the host engine's §10.5
// invariant TypeErrors must PROPAGATE through the boundary helpers, not be
// swallowed by the try/catch that falls through to the struct/undefined path.
// Gated strictly on `_isUserProxy(obj)` so the non-proxy fast path is unchanged.

async function run(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as { test?: () => unknown }).test?.();
}

describe("#2617 — Proxy trap throws + §10.5 invariants propagate", () => {
  it("a `has` trap that throws propagates (was swallowed → false)", async () => {
    const src = `
      export function test(): number {
        const p = new Proxy({}, { has: function () { throw new RangeError("x"); } });
        try {
          const r = ("a" in p);
          return 0; // must not reach — the throw must propagate
        } catch (e) {
          return e instanceof RangeError ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a getPrototypeOf trap returning a non-object throws TypeError (§10.5.1 invariant)", async () => {
    const src = `
      export function test(): number {
        const p = new Proxy({}, { getPrototypeOf: function () { return 1 as any; } });
        try {
          Object.getPrototypeOf(p);
          return 0; // must not reach — invariant TypeError
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a get trap that throws propagates", async () => {
    const src = `
      export function test(): number {
        const p = new Proxy({ attr: 1 }, { get: function () { throw new Error("g"); } });
        try {
          const v = p.attr;
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a deleteProperty trap that THROWS propagates", async () => {
    const src = `
      export function test(): number {
        const p = new Proxy({}, { deleteProperty: function () { throw new RangeError("d"); } });
        try {
          delete (p as any).attr;
          return 0;
        } catch (e) {
          return e instanceof RangeError ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a deleteProperty trap RETURNING false does NOT throw in non-strict context (returns false)", async () => {
    // Regression guard: the always-strict runtime's "trap returned falsish"
    // TypeError must be mapped to a plain `false`, not propagated.
    const src = `
      export function test(): number {
        const p = new Proxy({}, { deleteProperty: function () { return false; } });
        let threw = 0;
        let result = 1;
        try {
          result = (delete (p as any).attr) ? 1 : 0;
        } catch (e) {
          threw = 1;
        }
        // must NOT throw, and delete must yield false (0)
        return threw === 0 && result === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a non-proxy struct read is unaffected (fast path unchanged)", async () => {
    const src = `
      export function test(): number {
        const o = { a: 3, b: 7 };
        return o.a * o.b; // direct struct.get, no boundary helper
      }
    `;
    expect(await run(src)).toBe(21);
  });
});
