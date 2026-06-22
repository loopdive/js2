import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// #2616 — a present-but-non-callable Proxy trap must throw a TypeError at
// operation time (§10.5 / §7.3.10 GetMethod), not be silently dropped. Two
// parts: (1) the TS checker must not hard-reject `{ get: {} }` against
// ProxyHandler<T> (it compiles, then throws at runtime); (2) the host bridge
// (_buildProxyBridgeHandler) installs a throwing trap for the non-callable value.

async function run(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as { test?: () => unknown }).test?.();
}

describe("#2616 — present non-callable Proxy trap → TypeError", () => {
  it("compiles `new Proxy(t, { get: {} })` (TS no longer hard-errors)", async () => {
    const r = await compile(
      `export function test(): number { const p = new Proxy({ a: 1 }, { get: {} as any }); return 1; }`,
      { fileName: "t.ts" },
    );
    // The non-callable trap value must not block compilation.
    expect(r.success).toBe(true);
  });

  it("get with a non-callable trap throws TypeError on access", async () => {
    // built-ins/Proxy/get/trap-is-not-callable.js shape.
    const src = `
      export function test(): number {
        const p = new Proxy({ attr: 1 }, { get: {} as any });
        try {
          const v = p.attr;
          return 0; // should not reach — read must throw
        } catch (e) {
          return e instanceof TypeError ? 1 : 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("an absent trap still forwards (undefined handler trap is NOT an error)", async () => {
    // get: undefined → genuine absence → host forwards to target (no throw).
    const src = `
      export function test(): number {
        const p = new Proxy({ attr: 1 }, { get: undefined });
        try {
          const v = p.attr; // must NOT throw
          return typeof v === "number" ? 1 : 0;
        } catch (e) {
          return 2;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("a callable get trap still runs normally (regression guard)", async () => {
    const src = `
      export function test(): number {
        const p = new Proxy({ attr: 1 }, { get: function () { return 9; } });
        return p.attr; // trap returns 9
      }
    `;
    expect(await run(src)).toBe(9);
  });

  it("a non-Proxy bad assignment is still a hard TS error (scope guard)", async () => {
    const r = await compile(`const bad: (x: number) => number = {};`, { fileName: "t.ts" });
    expect(r.success).toBe(false);
  });
});
