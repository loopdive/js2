// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2917 — Standalone native `class X extends <Builtin>` super-construction.
 *
 * Slice 1 (`extends Object` own fields): since #3238 the parent instance is a
 * native `$Object`, but the #2101a own-field read/write path unconditionally
 * cast it to `$Error_struct` (the Error-family backing) and TRAPPED (illegal
 * cast) on any ctor own-field write. Own fields now route by backing
 * (`externrefBackedOwnFieldBacking`): Object ancestry stores fields directly
 * on the instance via `__extern_set` / `__extern_get`.
 *
 * Slice 2 (`extends Array`): parent construction leaked an unsatisfiable
 * `env::__new_Array` host import. `emitStandaloneArrayConstructor` now builds
 * a real native `$__vec_externref` honoring §23.1.1.1 Array(...) argument
 * semantics (trailing forwarder undefined-padding stripped; single boxed
 * number → length; otherwise the args become the elements).
 *
 * Arity fix: the #3238/#3239 `__new_<Builtin>` helpers registered ONE plain
 * funcMap name keyed off the first call site's arity; a later site with a
 * different arity (multi-level chains — implicit forwarder arity varies per
 * class) called it with extra args that stayed on the operand stack and
 * (validly!) became the forwarder's return value: `new B(4,5)` returned the
 * boxed `4` instead of the new instance. Helpers now register per-arity
 * (`__new_X@N`) and return the funcIdx.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = r.imports.map((i) => `${i.module}::${i.name}`).filter((n) => n.startsWith("env::__new_"));
  expect(leaked, "leaked env::__new_* host import(s)").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#2917 slice 1 — extends Object own fields (native $Object backing)", () => {
  it("ctor own-field write + read works (was: illegal cast)", async () => {
    expect(
      await runStandalone(`
        class X extends Object {
          own: number;
          constructor() { super(); this.own = 42; }
        }
        export function f(): number { return new X().own; }
      `),
    ).toBe(42);
  });

  it("implicit ctor still instantiates host-free with instanceof", async () => {
    expect(
      await runStandalone(`
        class X extends Object {}
        export function f(): number { return new X() instanceof X ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("two-level extends-Object chain stores fields per instance", async () => {
    // NOTE: intermediate user ctor bodies in a builtin-ancestor chain are not
    // yet replayed (pre-existing, family-wide) — assert B's OWN field only.
    expect(
      await runStandalone(`
        class A extends Object {}
        class B extends A {
          y: number;
          constructor() { super(); this.y = 4; }
        }
        export function f(): number { return new B().y; }
      `),
    ).toBe(4);
  });
});

describe("#2917 slice 2 — extends Array (native $__vec_externref backing)", () => {
  it("new X() → empty array (forwarder undefined-padding stripped)", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number { return new X().length; }
      `),
    ).toBe(0);
  });

  it("instanceof Sub AND instanceof Array both hold", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number {
          const x = new X();
          return (x instanceof X ? 1 : 0) + (x instanceof Array ? 2 : 0);
        }
      `),
    ).toBe(3);
  });

  it("single numeric arg → length (§23.1.1.1 step 4)", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number { return new X(3).length; }
      `),
    ).toBe(3);
  });

  it("multiple args become the elements", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number {
          const x = new X(7, 8, 9);
          return x.length * 100 + (x[0] as number) + (x[2] as number);
        }
      `),
    ).toBe(316);
  });

  it("explicit super(n) in a user ctor forwards the argument", async () => {
    expect(
      await runStandalone(`
        class X extends Array {
          constructor(n: number) { super(n); }
        }
        export function f(): number { return new X(5).length; }
      `),
    ).toBe(5);
  });

  it("in-bounds element write round-trips", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number {
          const x = new X(7, 8);
          x[0] = 5;
          return (x[0] as number) * 10 + x.length;
        }
      `),
    ).toBe(52);
  });

  it("inherited push() works on the vec backing", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number {
          const x = new X();
          x.push(4);
          return (x[0] as number) * 10 + x.length;
        }
      `),
    ).toBe(41);
  });

  it("Array.isArray answers true for the subclass instance", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number { return Array.isArray(new X()) ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("multi-level chain: B extends A extends Array (per-arity __new_ fix)", async () => {
    // Pre-fix, A's implicit forwarder registered __new_Array with ITS arity;
    // B's call with a larger arity left args on the stack and new B(4,5)
    // returned the boxed 4 instead of the array.
    expect(
      await runStandalone(`
        class A extends Array {}
        class B extends A {}
        export function f(): number {
          const b = new B(4, 5);
          return (b instanceof B ? 1 : 0) + (b instanceof Array ? 2 : 0)
            + b.length * 10 + (b[1] as number);
        }
      `),
    ).toBe(1 + 2 + 20 + 5);
  });
});

describe("#2917 regression controls", () => {
  it("extends Error family stays green (own field via $props side-slot)", async () => {
    expect(
      await runStandalone(`
        class MyErr extends Error {
          code: number;
          constructor() { super("boom"); this.code = 7; }
        }
        export function f(): number {
          const e = new MyErr();
          return (e instanceof MyErr ? 1 : 0) + (e instanceof Error ? 2 : 0) + e.code * 10;
        }
      `),
    ).toBe(1 + 2 + 70);
  });

  it("gc / JS-host mode keeps the __new_Array host import (byte-inert lane)", async () => {
    const r = await compile(
      `
      class X extends Array {}
      export function f(): number { return new X() instanceof X ? 1 : 0; }
      `,
      {},
    );
    expect(r.success).toBe(true);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels).toContain("env::__new_Array");
  });
});

describe("#2917 — §23.1.1.1 RangeError on invalid single numeric length", () => {
  it("new X(3.5) throws a catchable RangeError", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number {
          try {
            const x = new X(3.5);
            return x.length;
          } catch (e) {
            return e instanceof RangeError ? -1 : -2;
          }
        }
      `),
    ).toBe(-1);
  });

  it("new X(-1) throws RangeError; integral length still fine", async () => {
    expect(
      await runStandalone(`
        class X extends Array {}
        export function f(): number {
          let r: number = 0;
          try { new X(-1); r = 100; } catch (e) { r = e instanceof RangeError ? 1 : 2; }
          return r * 10 + new X(4).length;
        }
      `),
    ).toBe(14);
  });
});
