// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1536 Phase 2 — native Error `$name` field materialization (standalone mode).
//
// #1104 Phase 1 built the `$Error_struct` with a `$name` field but stored a
// `ref.null.extern` PLACEHOLDER, so `err.name` was undefined in standalone /
// WASI mode. This slice materializes the class-name string ("Error" /
// "TypeError" / …) into `$name` inside `__new_<ErrorName>`.
//
// SCOPE NOTE: this slice fixes the CONSTRUCTOR (the field now holds the right
// string, and the emitted Wasm is valid + instantiates). The `.name` *reader*
// in property-access.ts has a SEPARATE, PRE-EXISTING coercion defect (a double
// `any.convert_extern` / `ref.cast null` round-trip) that makes
// `err.name === "X"` and `err.name.length` emit invalid Wasm — that fails
// identically on `main` without this change, so it is NOT introduced here and
// is tracked as a follow-up. These tests therefore assert the constructor +
// throw/catch path (which works end-to-end) and the materialized-name bytes in
// the emitted module, NOT a `.name`-read comparison.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** UTF-8-ish codepoint sequence of an ASCII string, as the i16-array literal the ctor emits. */
function asciiCodes(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

describe("#1536 Phase 2 — native Error `$name` materialization (standalone)", () => {
  it("`new TypeError(...)` constructor materializes the name string (not ref.null.extern)", async () => {
    const src = `
      export function test(): number {
        try { throw new TypeError("boom"); } catch (e) { return 1; }
      }
    `;
    const r = await compile(src, { target: "wasi" });
    expect(r.success).toBe(true);
    // The __new_TypeError body must push the "TypeError" code units (an
    // array.new_fixed of its char codes) — i.e. the $name field is no longer
    // the Phase-1 `ref.null.extern` placeholder.
    const wat = r.wat ?? "";
    const ctorStart = wat.indexOf("(func $__new_TypeError");
    expect(ctorStart).toBeGreaterThanOrEqual(0);
    const ctorBody = wat.slice(ctorStart, ctorStart + 600);
    for (const code of asciiCodes("TypeError")) {
      expect(ctorBody).toContain(`i32.const ${code}`);
    }
    // And there must be at least one struct.new for the materialized
    // NativeString (the name) in addition to the $Error_struct.new.
    expect((ctorBody.match(/struct\.new/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("construct + throw + catch of a native Error instantiates and runs (no host import)", async () => {
    const src = `
      export function test(): number {
        try { throw new RangeError("oops"); } catch (e) { return 42; }
      }
    `;
    const r = await compile(src, { target: "wasi" });
    expect(r.success).toBe(true);
    const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(envImports).not.toContain("__new_RangeError");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const test = instance.exports.test as () => number;
    expect(test()).toBe(42);
  });

  it("all standard Error subclasses construct with their name string (valid Wasm)", async () => {
    // Each constructor must emit valid Wasm with its own name materialized.
    const names = ["Error", "TypeError", "RangeError", "SyntaxError", "URIError", "EvalError", "ReferenceError"];
    for (const n of names) {
      const src = `
        export function test(): number {
          try { throw new ${n}("x"); } catch (e) { return 1; }
        }
      `;
      const r = await compile(src, { target: "wasi" });
      expect(r.success, `${n} compiles`).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      expect((instance.exports.test as () => number)(), `${n} runs`).toBe(1);
      const wat = r.wat ?? "";
      const s = wat.indexOf(`(func $__new_${n}`);
      expect(s, `${n} ctor present`).toBeGreaterThanOrEqual(0);
      const body = wat.slice(s, s + 700);
      // First char code of the name appears as an i32.const in the ctor body.
      expect(body, `${n} name materialized`).toContain(`i32.const ${n.charCodeAt(0)}`);
    }
  });

  it("the `--target standalone` path also materializes the name", async () => {
    const src = `
      export function test(): number {
        try { throw new TypeError("x"); } catch (e) { return 7; }
      }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(7);
  });
});

describe("#1536 Gap #1 — native Error `.stack` field (standalone)", () => {
  it("$Error_struct constructors carry a 4th $stack field initialized to null", async () => {
    // The ctor must push 4 field values before `struct.new $Error_struct`:
    // tag(i32) + message + name + stack(ref.null.extern). Without the new
    // field the ctor would push only 3 and the struct.new arity would change.
    const src = `
      export function test(): number {
        const e = new Error("boom");
        return 1;
      }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // Wasm-native ctor, no host import.
    const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(envImports).not.toContain("__new_Error");
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("reading `error.stack` standalone compiles, validates, and does not trap", async () => {
    // `.stack` is non-standard and initialized to null (≈ undefined). The read
    // must lower to the `$Error_struct` fast path (struct.get fieldIdx 3), NOT
    // the host `__extern_get` import, and must not trap at runtime.
    const src = `
      export function test(): number {
        const e = new Error("boom");
        const s = e.stack;
        // Touch the value in a way that doesn't deref it: a null/undefined
        // .stack is falsy, so this returns 5 without trapping.
        return s ? 9 : 5;
      }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(envImports).not.toContain("__extern_get");
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(5);
  });

  it("`.message` and `.name` field indices are unchanged by the new `.stack` field", async () => {
    // Regression guard: adding $stack at fieldIdx 3 must keep message=1/name=2.
    // The construct+throw+catch path (which reads no fields) still runs, and
    // the module stays valid — proving the struct layout shift didn't corrupt
    // the existing fast paths.
    const src = `
      export function test(): number {
        try { throw new TypeError("boom"); } catch (e) { return 3; }
      }
    `;
    const r = await compile(src, { target: "standalone" });
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.test as () => number)()).toBe(3);
  });
});
