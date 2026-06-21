// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #2201 — ES §13.15.2 NamedEvaluation for the logical-assignment operators
 * (`&&=`, `||=`, `??=`). When the LHS is a bare IdentifierReference and the RHS
 * is an *anonymous* function/arrow/class definition, the resulting function
 * inherits the LHS identifier as its `.name`. A *named* RHS keeps its own name.
 *
 * The variables are typed `any` so the assignment of a function to a
 * number/null-initialised binding is TS-valid; this also keeps the receiver of
 * the later `.name` read typed `any` (not `string`), exercising the equality
 * dispatch fix that routes `id.name === "x"` to content-based string equality.
 */
async function nameMatches(source: string): Promise<number> {
  const exports = await compileToWasm(source);
  return (exports.test as () => number)();
}

describe("#2201 — logical-assignment NamedEvaluation", () => {
  it("&&= names an anonymous function with the LHS identifier", async () => {
    expect(
      await nameMatches(`
        let a: any = 1;
        a &&= function () {};
        export function test(): number { return a.name === "a" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("||= names an anonymous arrow with the LHS identifier", async () => {
    expect(
      await nameMatches(`
        let b: any = 0;
        b ||= () => {};
        export function test(): number { return b.name === "b" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("??= names an anonymous function with the LHS identifier", async () => {
    expect(
      await nameMatches(`
        let c: any = null;
        c ??= function () {};
        export function test(): number { return c.name === "c" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("??= names an anonymous class with the LHS identifier", async () => {
    expect(
      await nameMatches(`
        let d: any = null;
        d ??= class {};
        export function test(): number { return d.name === "d" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("a named function RHS keeps its own name (NOT renamed to the LHS)", async () => {
    expect(
      await nameMatches(`
        let a: any = 1;
        a ||= function g() {};
        export function test(): number { return a.name === "g" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("a declaration with no initializer is still named via ??=", async () => {
    expect(
      await nameMatches(`
        let v: any;
        v ??= function () {};
        export function test(): number { return v.name === "v" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("plain `=` NamedEvaluation is unaffected", async () => {
    expect(
      await nameMatches(`
        const f = () => {};
        export function test(): number { return f.name === "f" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("works inside a nested function scope (symbol-scoped, not name-matched)", async () => {
    expect(
      await nameMatches(`
        function f(): number {
          let v: any = 1;
          v &&= function () {};
          return v.name === "v" ? 1 : 0;
        }
        export function test(): number { return f(); }
      `),
    ).toBe(1);
  });
});
