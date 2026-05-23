// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1456 — Private reference read-only TypeError on assignment.
 *
 * Per ES2022 §7.3.18 (PrivateElementSet) and §13.15.2:
 *   - Private *methods* throw TypeError on any write (`=`, `+=`, …).
 *   - Private *accessor* with no setter throws TypeError on write.
 *   - Plain private fields and accessors with both get/set behave normally.
 *
 * The fix lives in `src/codegen/expressions/assignment.ts`:
 *   - `compilePropertyAssignment` for simple `this.#m = v`.
 *   - `compilePropertyCompoundAssignment` for `this.#m += v`, `this.#m %= v`, etc.
 *
 * Both call the new `classifyPrivateMember` helper to detect method /
 * getter-only accessor LHS, evaluate the RHS for side effects (per spec
 * order), then emit `__new_TypeError` + `throw`.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1456 — private method/accessor readonly TypeError", () => {
  it("simple assignment to private method throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          class C {
            #m() {}
            run() { (this as any).#m = 42; }
          }
          try { new C().run(); return 0; } catch (e: any) { return 1; }
        }
      `),
    ).toBe(1);
  });

  it("compound assignment to private method throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          class C {
            #m() {}
            run() { (this as any).#m %= 1; }
          }
          try { new C().run(); return 0; } catch (e: any) { return 1; }
        }
      `),
    ).toBe(1);
  });

  it("compound assignment to getter-only accessor throws TypeError", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          class C {
            get #x() { return 1; }
            run() { (this as any).#x += 1; }
          }
          try { new C().run(); return 0; } catch (e: any) { return 1; }
        }
      `),
    ).toBe(1);
  });

  it("plain private field compound assignment still works", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          class C {
            #n: number = 0;
            inc(): number { this.#n += 1; return this.#n; }
          }
          const c = new C();
          c.inc();
          return c.inc();
        }
      `),
    ).toBe(2);
  });

  it("private accessor with getter+setter still works", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          class C {
            #val: number = 0;
            get #x(): number { return this.#val; }
            set #x(v: number) { this.#val = v; }
            run(): number { this.#x = 5; return this.#x; }
          }
          return new C().run();
        }
      `),
    ).toBe(5);
  });
});
