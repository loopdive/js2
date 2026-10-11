// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #6651 (lane-I5) — a `super.<method>()` call whose parent method returns VOID
 * was SILENTLY DELETED, in three different places, all by the same conflation:
 * `null` returned to the #1919 speculative wrapper in `compileExpressionBody`
 * means "inner produced no usable value", so the wrapper calls
 * `rollbackSpeculative`, truncates the instructions already emitted and
 * substitutes a default constant. A void call legitimately produces no value,
 * so it read as a failure and the parent method's side effects vanished while
 * the program still compiled and ran — `super.increment();` became
 * `i32.const 0; drop`.
 *
 * The three sites, each a separate arm of the same bug:
 *   1. `compileSuperMethodCallCore` returned `null` for a void parent method
 *      even after emitting the call (now VOID_RESULT — cf. #1551, which fixed
 *      exactly this for the nested `super(...)` arm and left `super.m()`).
 *   2. The INLINE concise-arrow IIFE arm in `call-tail-dispatch` returned
 *      `compileExpression`'s `null` straight through, rolling back the whole
 *      inlined IIFE.
 *   3. The LIFTED IIFE path (`compileIIFE`, taken when the call supplies fewer
 *      arguments than the arrow declares — `(_ => super.m())()`) gave the
 *      lifted FunctionContext neither `enclosingClassName` nor a `this` local,
 *      so the super lowering bailed to its evaluate-args-and-default fallback.
 *
 * These are target-independent (both lanes were affected); the standalone
 * assertions below instantiate under EMPTY imports, which is also the strictest
 * form of the check.
 */

async function runStandalone(src: string): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => number }).test?.();
}

describe("#6651 — void super.<method>() must not be rolled back", () => {
  it("statement-position super call to a void parent method runs", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          let c = 0;
          class A { f(): void { c += 5; } }
          class B extends A { g(): void { super.f(); } }
          new B().g();
          return c;
        }
      `),
    ).toBe(5);
  });

  it("void super call mutating `this` through the parent method runs", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          class A { x = 0; bump(): void { (this as any).x += 5; } }
          class B extends A { g(): void { super.bump(); } }
          const b = new B(); b.g();
          return (b as any).x;
        }
      `),
    ).toBe(5);
  });

  it("concise-body arrow IIFE with a void super call runs (inline arm)", async () => {
    expect(
      await runStandalone(`
        var count = 0;
        class A { increment(): void { count++; } }
        class B extends A { incrementer(): void { ((_: any) => super.increment())(0); } }
        export function test(): number { new B().incrementer(); return count; }
      `),
    ).toBe(1);
  });

  it("under-applied arrow IIFE with a void super call runs (lifted arm)", async () => {
    // `(_ => super.increment())()` — fewer args than params, so the inline
    // fast path declines and the IIFE is LIFTED into a real function.
    expect(
      await runStandalone(`
        var count = 0;
        class A { increment(): void { count++; } }
        class B extends A { incrementer(): void { ((_: any) => super.increment())(); } }
        export function test(): number { new B().incrementer(); return count; }
      `),
    ).toBe(1);
  });

  it("a value-returning super call is unchanged", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          class A { f(): number { return 7; } }
          class B extends A { f(): number { return super.f() + 1; } }
          return new B().f();
        }
      `),
    ).toBe(8);
  });
});
