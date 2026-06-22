// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2146 — the codegen DI registration slots in src/codegen/shared.ts used to
// turn initialization order into a *runtime trap*: a stub threw a bare
// "X not yet registered" only when first invoked, deep inside codegen, with no
// hint of which registrar module failed to load. This test pins the two
// hardening behaviours that replaced that trap:
//   1. `assertCodegenRegistrationsComplete()` is a no-op on the production path
//      (compiler.ts pulls every registrar module statically), and
//   2. `resolveEnclosingClassName`, which moved out of the DI layer and into
//      shared.ts directly (slot fully retired), still behaves identically.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { assertCodegenRegistrationsComplete, resolveEnclosingClassName } from "../src/codegen/shared.js";
import type { FunctionContext } from "../src/codegen/context/types.js";

describe("#2146 codegen registration hardening", () => {
  it("a real compile passes the registration assertion and runs", async () => {
    const result = await compile(`
      class Box { v: number = 0; get(): number { return this.v; } }
      export function run(): number { const b = new Box(); b.v = 41; return b.get() + 1; }
    `);
    expect(result.errors ?? []).toHaveLength(0);
    expect(result.binary).toBeInstanceOf(Uint8Array);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    expect((instance.exports as { run: () => number }).run()).toBe(42);
  });

  it("assertCodegenRegistrationsComplete is a no-op once the registrar chain is loaded", () => {
    // Importing ../src/index.js (compiler.ts) above pulls every registrar
    // module statically, so the assertion must not throw.
    expect(() => assertCodegenRegistrationsComplete()).not.toThrow();
  });

  it("resolveEnclosingClassName (now defined directly in shared.ts) is behaviour-preserving", () => {
    const ctx = (over: Partial<FunctionContext>) => over as FunctionContext;
    // explicit enclosingClassName wins
    expect(resolveEnclosingClassName(ctx({ name: "anything", enclosingClassName: "Baz" }))).toBe("Baz");
    // falls back to the `${Class}_${method}` compiled-name convention
    expect(resolveEnclosingClassName(ctx({ name: "Foo_bar" }))).toBe("Foo");
    // no underscore, no explicit name → undefined
    expect(resolveEnclosingClassName(ctx({ name: "noUnderscore" }))).toBeUndefined();
    // leading underscore is not a class separator (underscoreIdx must be > 0)
    expect(resolveEnclosingClassName(ctx({ name: "_leading" }))).toBeUndefined();
  });
});
