// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

/**
 * #1443 — String.prototype.{replace,replaceAll,match,search,split} delegation to
 *   the searchValue's Symbol.{replace,match,search,split} method.
 *
 * The compiler short-circuits the native string-helper path when the static
 * type of the first argument is not string-like, routing instead to the JS
 * host import. The host then runs spec-correct JS native String.prototype.*
 * which performs Symbol.* dispatch.
 *
 * Scope of this fix:
 *   - Fast path is preserved when the search value is statically a string
 *     (existing wasm `__str_replace` / `__str_replaceAll` / `__str_split`).
 *   - Non-string-typed search values (RegExp, boolean, number, object) are
 *     routed to the host import which correctly delegates per ECMA-262.
 *   - Primitive search values (boolean/number/string) do NOT trigger Symbol
 *     dispatch (per spec: only Object searchValues do).
 */
describe("#1443 — String.prototype.* Symbol dispatch", () => {
  it("preserves the native fast path for string search values", async () => {
    const src = `
      function test(): string {
        return "abc".replace("b", "X");
      }
      export { test };
    `;
    const exports = await compileAndInstantiate(src);
    expect((exports as { test: () => string }).test()).toBe("aXc");
  });

  it("preserves the native replaceAll fast path for string search values", async () => {
    const src = `
      function test(): string {
        return "a-b-c".replaceAll("-", "_");
      }
      export { test };
    `;
    const exports = await compileAndInstantiate(src);
    expect((exports as { test: () => string }).test()).toBe("a_b_c");
  });

  it("preserves the native split fast path for string separators", async () => {
    const src = `
      function test(): number {
        const parts = "a,b,c".split(",");
        return parts.length;
      }
      export { test };
    `;
    const exports = await compileAndInstantiate(src);
    expect((exports as { test: () => number }).test()).toBe(3);
  });

  it("routes RegExp search values to the host (existing behavior)", async () => {
    const src = `
      function test(): string {
        return "hello world".replace(/o/g, "0");
      }
      export { test };
    `;
    const exports = await compileAndInstantiate(src);
    expect((exports as { test: () => string }).test()).toBe("hell0 w0rld");
  });

  it("does not dispatch Symbol.replace when searchValue is a primitive (number)", async () => {
    // Per ECMA-262 §22.1.3.18 step 2: "If searchValue is neither undefined
    // nor null, then 2a. Let replacer be ? GetMethod(searchValue, @@replace)."
    // GetMethod is only invoked for Object searchValues — primitives skip
    // the dispatch and fall through to standard string replacement.
    const src = `
      function test(): string {
        const s: string = "ab3c";
        return s.replace(3 as any, "<X>");
      }
      export { test };
    `;
    const exports = await compileAndInstantiate(src);
    expect((exports as { test: () => string }).test()).toBe("ab<X>c");
  });
});
