// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3163 — `new (Fn as any)()` on a function-style constructor returned null.
//
// The class/fnctor arms in compileNewExpression gated on the RAW callee node
// being an identifier (`ts.isIdentifier(expr.expression)`), so a cast/paren
// wrapper — `new (P as any)()`, the natural minimal-repro shape and the
// "constructor stored behind an any cast" idiom — missed both arms and fell
// to the dynamic path, which yielded null. The #1528b unwrap
// (`unwrappedNonId`: parens / `as` / `!` / type assertions) already existed
// for the non-constructor GUARDS; the fix routes the identifier ARMS through
// the same unwrapped node (`calleeIdent`), so a cast callee constructs
// exactly like the bare identifier. Guards are unaffected (they fire before
// the arms): `new ((() => {}) as any)()` and `new (Math as any)()` still
// throw TypeError.

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime-instantiate.js";

describe("#3163 — new (Fn as any)() constructs the fnctor instance", () => {
  it("single as-any cast returns the instance", async () => {
    const src = `
      function P(this: any): void { this.v = 7; }
      export function test(): string {
        const p: any = new (P as any)();
        return p === null ? "NULL" : ("ok v=" + (p.v as number));
      }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("ok v=7");
  });

  it("double cast (as any as { new(): any }) returns the instance", async () => {
    const src = `
      function P(this: any): void { this.v = 7; }
      export function test(): string {
        const p: any = new (P as any as { new (): any })();
        return p === null ? "NULL" : ("ok v=" + (p.v as number));
      }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("ok v=7");
  });

  it("cast CLASS constructor also constructs (same raw-node gate)", async () => {
    const src = `
      class C { x: number; constructor() { this.x = 3; } }
      export function test(): string {
        const c: any = new (C as any)();
        return c === null ? "NULL" : ("ok x=" + (c.x as number));
      }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("ok x=3");
  });

  it("bare identifier path unregressed", async () => {
    const src = `
      function P(this: any): void { this.v = 7; }
      export function test(): string {
        const p: any = new P();
        return p === null ? "NULL" : ("ok v=" + (p.v as number));
      }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("ok v=7");
  });

  it("non-constructor guards still fire through casts (arrow / Math)", async () => {
    const src = `
      export function test(): string {
        let out = "";
        try { new ((() => {}) as any)(); out += "no-throw"; } catch (e) { out += (e instanceof TypeError ? "TypeError" : "other"); }
        out += "|";
        try { new (Math as any)(); out += "no-throw"; } catch (e) { out += (e instanceof TypeError ? "TypeError" : "other"); }
        return out;
      }
    `;
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("TypeError|TypeError");
  });
});
