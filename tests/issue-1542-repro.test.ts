// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1542 — Class method destructured-pattern param default not applied.
 *
 * Repro before fix. Confirms the failure shape, then asserts the fix.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1542 class method dstr default", () => {
  it("method([,] = g()) returns 'ok'", async () => {
    const exports = await compileToWasm(`
      function* g() { yield; }
      class C {
        method([,] = g()): string { return 'ok'; }
      }
      export function test(): string {
        const c = new C();
        return c.method();
      }
    `);
    expect(exports.test()).toBe("ok");
  });

  // Side-effect-observing repro mirroring the test262 harness shape. The
  // generator default closes over module-scope state; if the default is
  // silently coerced to null instead of actually being invoked, `first`
  // stays 0 and we expose the latent bug that the no-side-effect repros
  // miss.
  // Exactly mirrors test262's
  // test/language/statements/class/dstr/meth-dflt-ary-ptrn-elem-ary-elision-init.js
  // — the canonical 134-fail family. Outer pattern destructures `[]` (an
  // explicit-empty array), so the inner BindingElement `[[,] = g()]` gets
  // `undefined` from the outer iterator and the *inner* default `g()` must
  // fire. Today the inner default is silently dropped → inner `[,]` runs
  // against `null` → throws.
  it("method([[,] = g()] = []) — nested BindingElement default must fire (test262 harness)", async () => {
    const exports = await compileToWasm(`
      let first: number = 0;
      let second: number = 0;
      function* g(): any {
        first += 1;
        yield;
        second += 1;
      }
      class C {
        method([[,] = g()] = []): void {}
      }
      export function callMethod(): void { new C().method(); }
      export function getFirst(): number { return first; }
      export function getSecond(): number { return second; }
    `);
    (exports.callMethod as () => void)();
    expect((exports.getFirst as () => number)()).toBe(1);
    expect((exports.getSecond as () => number)()).toBe(0);
  });

  it("method([,] = g()) actually invokes the generator default (test262 harness shape)", async () => {
    const exports = await compileToWasm(`
      let first: number = 0;
      let second: number = 0;
      function* g(): any {
        first += 1;
        yield;
        second += 1;
      }
      class C {
        method([,] = g()): void {}
      }
      export function callMethod(): void { new C().method(); }
      export function getFirst(): number { return first; }
      export function getSecond(): number { return second; }
    `);
    (exports.callMethod as () => void)();
    expect((exports.getFirst as () => number)()).toBe(1);
    expect((exports.getSecond as () => number)()).toBe(0);
  });

  it("method({ x = 1 } = {}) returns 1", async () => {
    const exports = await compileToWasm(`
      class C {
        method({ x = 1 } = {}): number { return x; }
      }
      export function test(): number {
        const c = new C();
        return c.method();
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("private method #m([,] = g()) returns 'priv'", async () => {
    const exports = await compileToWasm(`
      function* g() { yield; }
      class C {
        #m([,] = g()): string { return 'priv'; }
        run(): string { return this.#m(); }
      }
      export function test(): string {
        return new C().run();
      }
    `);
    expect(exports.test()).toBe("priv");
  });
});
