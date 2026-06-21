// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2188 — standalone: sibling Error subclasses must be distinguishable by
 * `instanceof`.
 *
 * `#1536c` made `class MyError extends Error {}` instantiate + resolve
 * `instanceof` natively in standalone mode. The instance is the parent's
 * `$Error_struct`, discriminated by the parent's builtin `$tag` (field 0).
 * That is exact for a single subclass, but TWO distinct `extends Error`
 * siblings share the SAME parent tag, so `instanceof` could not tell them
 * apart: `(new A) instanceof B` returned true (node: false).
 *
 * Fix (#2188): give each standalone-native user Error subclass instance a
 * per-class brand — `$Error_struct.$userClassId` (field 4) = the subclass's
 * unique `classTagMap` id, written at the subclass construction site
 * (`emitSetSubclassUserBrand` in class-bodies.ts). The standalone
 * `instanceof <UserSubclass>` path (identifiers.ts) reads the brand against the
 * set {ctorName's id} ∪ {descendant subclass ids} instead of the shared builtin
 * tag, so siblings are disjoint. `instanceof Error`/`instanceof TypeError`
 * (builtin RHS) keep the field-0 builtin-tag check unchanged.
 *
 * The LHS in these tests is a `catch`-bound `any` (the realistic test262
 * shape — catch an error, check its type), which exercises the dynamic
 * externref instanceof path the brand targets. A statically-typed
 * `new A() instanceof B` already resolves at compile time and is correct.
 *
 * Known pre-existing gap (NOT this issue): a multi-level *user* chain
 * `class D extends A {}` where `A extends Error` does not construct `D` as a
 * proper `$Error_struct` (D's direct parent is a user class, so D's `super()`
 * chains through A's init, not `__new_Error`). On both upstream/main and this
 * branch, `(new D) instanceof A` / `instanceof Error` return false. That is a
 * construction-routing gap orthogonal to the sibling-brand fix here; this PR
 * neither fixes nor regresses it. `(new D) instanceof D` works (D is branded).
 */

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2188 — standalone sibling Error subclass instanceof precision", () => {
  it("(new A) instanceof B is FALSE for distinct siblings A,B extends Error", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class B extends Error {}
      export function test(): number {
        try { throw new A("x"); } catch (e) { return e instanceof B ? 1 : 0; }
      }
    `);
    expect(got).toBe(0);
  });

  it("(new A) instanceof A is TRUE (self)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class B extends Error {}
      export function test(): number {
        try { throw new A("x"); } catch (e) { return e instanceof A ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("(new A) instanceof Error is TRUE (builtin parent — field-0 tag path)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class B extends Error {}
      export function test(): number {
        try { throw new A("x"); } catch (e) { return e instanceof Error ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("(new B) instanceof A is FALSE (reverse sibling direction)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class B extends Error {}
      export function test(): number {
        try { throw new B("x"); } catch (e) { return e instanceof A ? 1 : 0; }
      }
    `);
    expect(got).toBe(0);
  });

  it("cross-family: (new C extends TypeError) instanceof TypeError is TRUE", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class C extends TypeError {}
      export function test(): number {
        try { throw new C("x"); } catch (e) { return e instanceof TypeError ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("cross-family: (new C extends TypeError) instanceof Error is TRUE (TypeError <: Error)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class C extends TypeError {}
      export function test(): number {
        try { throw new C("x"); } catch (e) { return e instanceof Error ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("cross-family: (new C extends TypeError) instanceof A (extends Error) is FALSE", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class C extends TypeError {}
      export function test(): number {
        try { throw new C("x"); } catch (e) { return e instanceof A ? 1 : 0; }
      }
    `);
    expect(got).toBe(0);
  });

  it("a plain builtin Error (brand -1) is NOT an instance of any user subclass", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      export function test(): number {
        try { throw new Error("x"); } catch (e) { return e instanceof A ? 1 : 0; }
      }
    `);
    expect(got).toBe(0);
  });

  it("a plain builtin Error is still instanceof Error (no brand regression)", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      export function test(): number {
        try { throw new Error("x"); } catch (e) { return e instanceof Error ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("three siblings stay mutually disjoint", async () => {
    const got = await runStandalone(`
      class A extends Error {}
      class B extends Error {}
      class C extends Error {}
      export function test(): number {
        let n = 0;
        try { throw new A("x"); } catch (e) {
          if (e instanceof A) n += 1;          // +1
          if (e instanceof B) n += 10;         // +0
          if (e instanceof C) n += 100;        // +0
          if (e instanceof Error) n += 1000;   // +1000
        }
        return n;
      }
    `);
    expect(got).toBe(1001);
  });
});
