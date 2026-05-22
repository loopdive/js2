// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1519 sub-issue B — `new`-on built-in non-constructor namespace
 * objects must throw `TypeError`.
 *
 * Per ECMA-262 §7.2.10 IsConstructor (also §13.3.5.1
 * EvaluateNew step 5), `new V` where `V` has no `[[Construct]]` internal
 * method must throw `TypeError`. The built-in namespace objects `Math`,
 * `JSON`, `Reflect`, and `Atomics` are described by spec as ordinary
 * objects with neither `[[Call]]` nor `[[Construct]]`.
 *
 * The existing code in `compileNewExpression` (#730) handled three
 * patterns that match by static type:
 *
 *   1. arrow function — no `[[Construct]]`
 *   2. property access of the form `X.prototype.Y` — prototype methods
 *      lack `[[Construct]]`
 *   3. non-identifier expressions whose TS type has call sigs but no
 *      construct sigs
 *
 * Identifiers referring to namespace objects (`Math`, `JSON`, …) fell
 * through *all* three branches because:
 *
 *   - they aren't arrow functions or property accesses
 *   - they're identifiers, so the non-identifier check is skipped
 *
 * — and ended up in the generic identifier-constructor lookup, which
 * fails silently and produces a wasm-validation error or a null result
 * downstream. Test262 negative tests like `S11.2.2_A4_T*.js` saw either a
 * crash or a non-TypeError exception.
 *
 * Fix: add an explicit IsConstructor short-circuit *after* the existing
 * non-identifier branches and *before* the constructor lookup that
 * detects the four documented built-in non-constructor namespaces by
 * name and throws via `emitThrowTypeError`. The name match runs on the
 * source expression after unwrapping `as`-casts, parens, and
 * non-null assertions so `new Math()`, `new (Math)()`, and
 * `new (Math as any)()` all trip the same path.
 *
 * Target test262 cases:
 *   language/expressions/new/S11.2.2_A4_T1.js  (new this — TBD, separate)
 *   language/expressions/new/S11.2.2_A4_T2.js  (new null — separate)
 *   language/expressions/new/S11.2.2_A4_T5.js  (new Math)
 *
 * Sub-issues A (spread compile error), C (new.target via apply/call) and
 * D (object-spread invalid wasm) remain open under #1519 and require
 * codegen changes outside this scope.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1519 sub-issue B — `new`-on namespace throws TypeError", () => {
  it("new Math throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          try { new (Math as any)(); return 0; }
          catch (e: any) { return e instanceof TypeError ? 1 : 0; }
        }
      `),
    ).toBe(1);
  });

  it("new JSON throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          try { new (JSON as any)(); return 0; }
          catch (e: any) { return e instanceof TypeError ? 1 : 0; }
        }
      `),
    ).toBe(1);
  });

  it("new Reflect throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          try { new (Reflect as any)(); return 0; }
          catch (e: any) { return e instanceof TypeError ? 1 : 0; }
        }
      `),
    ).toBe(1);
  });

  it("new (Math)() (paren-wrapped) throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          try { new ((Math) as any)(); return 0; }
          catch (e: any) { return e instanceof TypeError ? 1 : 0; }
        }
      `),
    ).toBe(1);
  });

  describe("regression guards: real constructors keep working", () => {
    it("new Date(0) still produces a Date object", async () => {
      expect(
        await runWasm(`
          export function test(): string {
            var d: Date = new Date(0);
            return typeof d;
          }
        `),
      ).toBe("object");
    });

    it("new Array(3) still produces a length-3 array", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var a: number[] = new Array(3);
            return a.length;
          }
        `),
      ).toBe(3);
    });

    it("new Error('x') still works (real constructor)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            var e: any = new Error("hi");
            return e.message === "hi" ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("new Number(42) still produces a Number wrapper object", async () => {
      expect(
        await runWasm(`
          export function test(): string {
            var n: any = new Number(42);
            return typeof n;
          }
        `),
      ).toBe("object");
    });

    it("user class still constructs normally", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            class C { x: number; constructor(x: number) { this.x = x; } }
            var c: C = new C(99);
            return c.x;
          }
        `),
      ).toBe(99);
    });
  });
});
