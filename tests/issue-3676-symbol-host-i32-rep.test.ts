// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3676 — JS-host symbol VALUE producers must yield the canonical i32 symbol id.
 *
 * The compiler represents a symbol value as an i32 id everywhere: `mapTsTypeToWasm`
 * maps `symbol` → i32 and `compileSymbolCall` (`Symbol()`) returns an unbranded
 * i32 counter. Two producers disagreed under the default JS-host target and
 * handed back an `externref` instead:
 *
 *   1. `Symbol.for(key)`          → `__symbol_for` host import (externref)
 *   2. `Symbol.<wellKnown>` value → `__get_builtin` + `__extern_get` (externref)
 *
 * Landing an externref in a `symbol`-typed i32 slot makes `coerceType` bridge it
 * with `__unbox_number` — literally `Number(Symbol())` — which throws TypeError
 * per §7.1.4. Because module-scope initializers run in `__module_init`, the
 * module compiled to a VALID binary that could not be instantiated at all.
 *
 * This is the defect that stopped React 19's production CJS build from
 * instantiating: its first statement is twelve chained `Symbol.for(...)`
 * initializers plus `MAYBE_ITERATOR_SYMBOL = Symbol.iterator`.
 *
 * NOTE ON TEST PATH: a bare `compile()` does NOT reproduce this — compilation
 * succeeds and emits a valid module. The failure is only observable at
 * INSTANTIATE time, so every case here must go through a helper that actually
 * instantiates with the real host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import { compileAndRunHost } from "./helpers/compile.js";

/**
 * Instantiate the way the shipping runtime does — via `instantiateWasm`, which
 * prefers the native `wasm:js-string` builtins and only falls back to the JS
 * polyfill. `compileAndRunHost` calls `WebAssembly.instantiate` directly, so it
 * always takes the polyfill path. That difference is invisible for everything
 * else in this file, but the custom-`@@iterator` sentinel below only works on
 * the native-builtin path (on BOTH the merge base and this branch), so it must
 * be exercised through the runtime's own helper to mean anything.
 */
async function compileAndRunNativeStrings(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    imports.env,
    imports.string_constants,
    (imports as unknown as { string_constants16?: Record<string, WebAssembly.Global> }).string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#3676 Symbol.for / well-known symbols use the canonical i32 id (JS-host)", () => {
  describe("module-scope initializers instantiate", () => {
    // The regression proper: each of these threw
    // "Cannot convert a Symbol value to a number" from __module_init.
    it("var S = Symbol.for(k)", async () => {
      const e = await compileAndRunHost(`
        var S = Symbol.for("k");
        export function g(): number { return S === Symbol.for("k") ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("const S = Symbol.for(k)", async () => {
      const e = await compileAndRunHost(`
        const S = Symbol.for("k");
        export function g(): number { return S === Symbol.for("k") ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("let S = Symbol.for(k)", async () => {
      const e = await compileAndRunHost(`
        let S = Symbol.for("k");
        export function g(): number { return S === Symbol.for("k") ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("multi-declarator list (the React shape)", async () => {
      // React: `var REACT_ELEMENT_TYPE = Symbol.for("..."), REACT_PORTAL_TYPE = ...`
      const e = await compileAndRunHost(`
        var A = Symbol.for("react.transitional.element"),
            B = Symbol.for("react.portal"),
            C = Symbol.iterator;
        export function distinct(): number { return A !== B ? 1 : 0; }
        export function stable(): number { return A === Symbol.for("react.transitional.element") ? 1 : 0; }
        export function iter(): number { return C === Symbol.iterator ? 1 : 0; }
      `);
      expect(e.distinct!()).toBe(1);
      expect(e.stable!()).toBe(1);
      expect(e.iter!()).toBe(1);
    });

    it("var S = Symbol.iterator", async () => {
      const e = await compileAndRunHost(`
        var S = Symbol.iterator;
        export function g(): number { return S === Symbol.iterator ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("var S = Symbol.asyncIterator", async () => {
      const e = await compileAndRunHost(`
        var S = Symbol.asyncIterator;
        export function g(): number { return S === Symbol.asyncIterator ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });
  });

  describe("reads of a symbol binding (not just the store)", () => {
    // These were the rows that made the defect broader than "module initializer":
    // a function-LOCAL `var S = Symbol.for(...)` also failed, but only once S was
    // actually READ. A probe that declared S and never used it passed vacuously.
    it("function-local Symbol.for, compared against the same key", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { const S = Symbol.for("k"); return S === Symbol.for("k") ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("function-local Symbol.for, compared against a different key", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { const S = Symbol.for("k"); return S === Symbol.for("q") ? 1 : 0; }
      `);
      expect(e.g!()).toBe(0);
    });

    it("typeof a Symbol.for binding is 'symbol'", async () => {
      const e = await compileAndRunHost(`
        var S = Symbol.for("k");
        export function g(): number { return typeof S === "symbol" ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });
  });

  describe("registry semantics survive the representation change", () => {
    it("Symbol.keyFor(Symbol.for(k)) === k", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return Symbol.keyFor(Symbol.for("k")) === "k" ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("Symbol.keyFor through a module global", async () => {
      const e = await compileAndRunHost(`
        var S = Symbol.for("kk");
        export function g(): number { return Symbol.keyFor(S) === "kk" ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("Symbol.keyFor of an UNregistered symbol is undefined", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return Symbol.keyFor(Symbol("k")) === undefined ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("Symbol.keyFor of a well-known symbol is undefined", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return Symbol.keyFor(Symbol.iterator) === undefined ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("Symbol.for(k).description === k", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return Symbol.for("d").description === "d" ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("String(Symbol.for(k)) is the descriptive string", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return String(Symbol.for("s")) === "Symbol(s)" ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("a Symbol.for value works as a property key", async () => {
      const e = await compileAndRunHost(`
        var A = Symbol.for("a"), B = Symbol.for("b");
        export function g(): number { const o: any = {}; o[A] = 1; o[B] = 2; return o[A] * 10 + o[B]; }
      `);
      expect(e.g!()).toBe(12);
    });
  });

  describe("REGRESSION SENTINELS — shapes that already worked must keep working", () => {
    // An over-broad fix that changed these is a net loss, so they are asserted
    // explicitly rather than assumed.
    it("SENTINEL: module-scope Symbol() still instantiates and is unique", async () => {
      const e = await compileAndRunHost(`
        var A = Symbol("k"), B = Symbol("k");
        export function same(): number { return A === A ? 1 : 0; }
        export function distinct(): number { return A === B ? 1 : 0; }
      `);
      expect(e.same!()).toBe(1);
      expect(e.distinct!()).toBe(0);
    });

    it("SENTINEL: declare-then-assign still works", async () => {
      const e = await compileAndRunHost(`
        var S: any;
        S = Symbol.for("k");
        export function g(): number { return S === Symbol.for("k") ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("SENTINEL: Symbol('d').description still round-trips", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return Symbol("d").description === "d" ? 1 : 0; }
      `);
      expect(e.g!()).toBe(1);
    });

    it("SENTINEL: for-of over an array still uses @@iterator", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { let t = 0; for (const v of [1, 2, 3]) t += v; return t; }
      `);
      expect(e.g!()).toBe(6);
    });

    it("SENTINEL: a user object's [Symbol.iterator] protocol still drives for-of", async () => {
      // This is the sharpest sentinel for the well-known-symbol half of the
      // change: a user object keyed by `[Symbol.iterator]` must still be found
      // by for-of after `Symbol.<wellKnown>` value reads stopped going through
      // `__get_builtin`. Run on the native-builtin instantiation path — see
      // `compileAndRunNativeStrings`.
      const e = await compileAndRunNativeStrings(`
        const o = {
          [Symbol.iterator]() {
            let i = 0;
            return { next() { return i < 3 ? { value: ++i, done: false } : { value: undefined, done: true }; } };
          },
        };
        export function g(): number { let t = 0; for (const v of o as any) t += v; return t; }
      `);
      expect(e.g!()).toBe(6);
    });

    it("SENTINEL: distinct well-known symbols stay distinct", async () => {
      const e = await compileAndRunHost(`
        export function g(): number { return (Symbol.iterator as any) === (Symbol.asyncIterator as any) ? 1 : 0; }
      `);
      expect(e.g!()).toBe(0);
    });

    // NOTE: the §20.4.2.2 step-1 "Symbol key makes ToString throw" branch is
    // deliberately NOT asserted here. Reaching it requires the argument's
    // STATIC type to be `symbol`, which `Symbol.for(key: string)` rejects — any
    // cast wide enough to compile (`as any` / `as never`) also defeats the
    // `isSymbolType` gate that selects the branch, so the test would only ever
    // exercise the cast. That branch sits ABOVE the code this change touches
    // and is byte-for-byte untouched by it.
  });

  describe("lowering shape (guards against a silent revert to the externref path)", () => {
    it("Symbol.iterator folds to a constant id, with no __get_builtin round trip", async () => {
      const r = await compile(`var S = Symbol.iterator; export function g(): number { return 1; }`, {
        emitWat: true,
      } as never);
      const wat = (r as unknown as { wat: string }).wat;
      expect(wat).toContain("$__module_init");
      // Positive: the module-init store must be a folded constant.
      expect(wat).toMatch(/\$__module_init[\s\S]*?i32\.const 1[\s\S]*?global\.set/);
      // Negative: the two host imports of the broken lowering must be gone.
      expect(wat).not.toContain("__get_builtin");
      expect(wat).not.toContain("__unbox_number");
    });

    it("Symbol.for uses the id-returning host import, not __unbox_number", async () => {
      const r = await compile(`var S = Symbol.for("k"); export function g(): number { return 1; }`, {
        emitWat: true,
      } as never);
      const wat = (r as unknown as { wat: string }).wat;
      expect(wat).toContain("__symbol_for_id");
      expect(wat).not.toContain("__unbox_number");
    });
  });
});
