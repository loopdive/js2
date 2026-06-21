// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2188 follow-up — standalone: a MULTI-LEVEL user Error chain
 * (`class D extends A {}` where `A extends Error`) must construct `D` as a real
 * `$Error_struct`.
 *
 * #2188 fixed sibling discrimination for DIRECT builtin-Error subclasses. It
 * left open (documented as a known gap in `issue-2188.test.ts`) the multi-level
 * case: `D`'s direct parent `A` is a USER class, so `compileSuperCall` did not
 * find `D` in `classBuiltinParentMap` (which was only populated when the DIRECT
 * parent is a builtin). `D`'s `super()` therefore chained through `A`'s user
 * `_init` instead of the builtin Error ancestor's `__new_<builtin>`, so `D` was
 * never tagged with the builtin Error `$tag` (field 0): `instanceof Error` was
 * false, `.message` unset, and a thrown `D` was not catchable as `Error`.
 *
 * Fix: make the builtin-parent / externref-backing resolution TRANSITIVE — when
 * the direct parent is itself an externref-backed user Error subclass, propagate
 * the builtin ANCESTOR name and mark the child externref-backed (parents are
 * collected before their children in source order, so the ancestor's mapping is
 * known). `super()` then threads through the builtin ancestor's
 * `__new_<builtin>` and `D` is a proper `$Error_struct`.
 *
 * (Standalone host-import-freedom for the implicit forwarder's undefined-arg
 * padding is provided by #2029/#1702's `emitUndefinedValue` nativeStrings guard;
 * these modules instantiate with an EMPTY import object to prove no env leak.)
 */

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]); // no host-import leak
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2188 follow-up — standalone multi-level user Error chain construction", () => {
  it("(new D) instanceof Error is TRUE for `class D extends A {}` / `A extends Error`", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class D extends A {}
      export function test(): number {
        return (new D()) instanceof Error ? 1 : 0;
      }
    `);
    expect(got).toBe(1);
  });

  it("(new D) instanceof A AND instanceof D both hold (user-class chain still works)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class D extends A {}
      export function test(): number {
        const d = new D();
        return (d instanceof A && d instanceof D) ? 1 : 0;
      }
    `);
    expect(got).toBe(1);
  });

  it("D carries the builtin Error .message field (proves real $Error_struct)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class D extends A {}
      export function test(): number {
        const d = new D('boom');
        return d.message === 'boom' ? 1 : 0;
      }
    `);
    expect(got).toBe(1);
  });

  it("a thrown D is catchable as Error (try/throw/catch instanceof Error)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class D extends A {}
      export function test(): number {
        try { throw new D('x'); } catch (e) { return e instanceof Error ? 1 : 0; }
        return -1;
      }
    `);
    expect(got).toBe(1);
  });

  it("3-level chain: `E extends D extends A extends Error` is instanceof Error", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class D extends A {}
      class E extends D {}
      export function test(): number {
        return (new E()) instanceof Error ? 1 : 0;
      }
    `);
    expect(got).toBe(1);
  });

  it("no regression: a DIRECT `class A extends Error {}` is still instanceof Error", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      export function test(): number {
        return (new A()) instanceof Error ? 1 : 0;
      }
    `);
    expect(got).toBe(1);
  });

  it("no regression: siblings of the chained class stay disjoint (#2188)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class D extends A {}
      class B extends Error {}
      export function test(): number {
        try { throw new D('x'); } catch (e) { return e instanceof B ? 1 : 0; }
        return -1;
      }
    `);
    expect(got).toBe(0);
  });
});
