// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1983 — `${ClassName}_${member}` funcMap keys must not collide with user
 * functions.
 *
 * A class member `A.m` registers the synthetic funcMap key `A_m`; a top-level
 * `function A_m()` would claim the same flat key, and the user-function
 * reservation then SILENTLY SKIPS it (`funcMap.has("A_m")` already true) — so
 * `A_m()` call sites resolved to the class method's funcIdx (wrong signature →
 * validation trap) and `new A().m()` resolved to the user function.
 *
 * Fix: `classMemberFuncKey` relocates the class member's funcMap key + wasm
 * display name to `__cm$<name>` ONLY on a real collision (byte-identical
 * otherwise). Routed through producers + every consumer that resolves a
 * class-member funcIdx — legacy dispatch (calls.ts / new-super.ts), the IR
 * backend's ClassRegistry (`methodFuncName` / `constructorFuncName`), and the
 * property-access getter/method-reference paths.
 *
 * Standalone + empty importObject (proves no JS host; instantiate with `{}`).
 */
async function standaloneExports(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...a: unknown[]) => number>;
}

describe("#1983 — class-member funcMap key collision with user functions", () => {
  it("method A.m vs function A_m — both callable, correct dispatch", async () => {
    const ex = await standaloneExports(`
      class A { m(): number { return 10; } }
      function A_m(): number { return 2; }
      export function test(): number { return new A().m() + A_m(); }
    `);
    expect(ex.test()).toBe(12);
  });

  it("constructor A_new vs function A_new", async () => {
    const ex = await standaloneExports(`
      class A { x: number = 7; }
      function A_new(): number { return 3; }
      export function test(): number { return new A().x + A_new(); }
    `);
    expect(ex.test()).toBe(10);
  });

  it("getter B.v vs function B_get_v", async () => {
    const ex = await standaloneExports(`
      class B { get v(): number { return 5; } }
      function B_get_v(): number { return 3; }
      export function test(): number { const b = new B(); return b.v + B_get_v(); }
    `);
    expect(ex.test()).toBe(8);
  });

  it("non-colliding class is byte-identical / unchanged (safe-by-construction)", async () => {
    const ex = await standaloneExports(`
      class C { m(): number { return 10; } }
      export function test(): number { return new C().m() + 5; }
    `);
    expect(ex.test()).toBe(15);
  });

  it("user function reachable on its own when it shadows a method name", async () => {
    const ex = await standaloneExports(`
      class A { m(): number { return 10; } }
      function A_m(): number { return 42; }
      export function onlyUser(): number { return A_m(); }
    `);
    expect(ex.onlyUser()).toBe(42);
  });
});
