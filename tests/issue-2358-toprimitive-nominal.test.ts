// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2358 — standalone native ToPrimitive over typed (nominal) object structs.
//
// A typed object literal / class instance compiles to a NOMINAL WasmGC struct
// (`__anon_N` / `ClassName`). The standalone `+` path (`emitAnyAdd`) compiled
// each operand to externref before reducing it via the native `__to_primitive`
// helper — but that helper only recognises the dynamic `$Object` runtime struct
// (`ref.test objectTypeIdx`), so a nominal struct crossed the boundary
// unreduced and `__unbox_number` produced null/NaN. The fix reduces such an
// operand to a primitive via the shared coercion engine WHILE its concrete
// typeIdx is still known (before it crosses the externref boundary).

async function runStandaloneNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS host: standalone modules instantiate with an empty import object.
  expect(r.imports.length).toBe(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#2358 standalone ToPrimitive over nominal object structs", () => {
  it("reduces a typed object literal with valueOf through `obj + number`", async () => {
    expect(
      await runStandaloneNum(`
        export function f(): number {
          const o = { valueOf: () => 4 };
          return (o as any) + 1;
        }
      `),
    ).toBe(5);
  });

  it("reduces a typed object literal on the left of `number + obj`", async () => {
    expect(
      await runStandaloneNum(`
        export function f(): number {
          const o = { valueOf: () => 4 };
          return 1 + (o as any);
        }
      `),
    ).toBe(5);
  });

  it("reduces both operands in `obj + obj`", async () => {
    expect(
      await runStandaloneNum(`
        export function f(): number {
          const a = { valueOf: () => 4 };
          const b = { valueOf: () => 3 };
          return (a as any) + (b as any);
        }
      `),
    ).toBe(7);
  });

  it("reduces a class instance with a valueOf method through `+`", async () => {
    expect(
      await runStandaloneNum(`
        class C { valueOf(): number { return 9; } }
        export function f(): number {
          const c = new C();
          return (c as any) + 1;
        }
      `),
    ).toBe(10);
  });

  // Regression guards — these already worked and must keep working: the dynamic
  // `$Object` literal form (forced by `as any` at the literal) and an any-typed
  // parameter both flow through paths the fix does not touch.
  it("still reduces an `as any` object literal (dynamic $Object path)", async () => {
    expect(
      await runStandaloneNum(`
        export function f(): number {
          return ({ valueOf: () => 4 } as any) + 1;
        }
      `),
    ).toBe(5);
  });

  it("still reduces an any-typed parameter carrying a valueOf object", async () => {
    expect(
      await runStandaloneNum(`
        function g(x: any): number { return x + 1; }
        export function f(): number { return g({ valueOf: () => 4 }); }
      `),
    ).toBe(5);
  });
});
