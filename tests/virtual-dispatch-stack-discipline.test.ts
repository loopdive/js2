// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `emitVirtualMethodDispatchByTag` must emit NOTHING when it bails out, and
 * must load `__tag` through a struct type the receiver actually has.
 *
 * WHY: these two defects are why lit's implementation module failed
 * `WebAssembly.compile`, and an invalid implementation is expensive far beyond
 * the one package — the upstream-suite runner halves and retries a unit that
 * fails validation (depth <= 6, i.e. up to 64 full-bundle recompiles for one
 * test file), which is a large part of lit's ~28-minute measurement row.
 *
 * 1. PARTIAL EMISSION ON BAIL-OUT. The function compiled the receiver into
 *    `fctx.body` and only then checked that the receiver was ref-typed.
 *    Returning `undefined` means "I emitted nothing, use the static path", so
 *    for an EXTERNREF receiver — which is what `class extends HTMLElement`
 *    produces — the receiver push stayed on the stack, the static path pushed
 *    it again, and one externref outlived the call. Inside `t && this.k(1)`
 *    the surviving value became the value of an arm whose block type is i32:
 *    `type error in fallthru[0] (expected i32, got externref)`.
 *
 * 2. TAG LOAD THROUGH THE WRONG STRUCT. The cascade read `struct.get $base` from
 *    a local typed with the receiver's own struct. These class structs are not
 *    declared in a Wasm subtype relation (`$__anonClass_0` is a bare
 *    `(sub (struct …))`), so that is a validation error rather than a widening.
 *    It fires when the method is compiled as a synthesised per-subclass copy,
 *    where `this` is the copy's struct but `baseClassName` still names the
 *    original: lit's `y_get_updateComplete` failed with `struct.get[0] expected
 *    type (ref null 54), found local.tee of type (ref null 44)`.
 *
 * Both need a SUBCLASS to exist — that is what puts the call on the virtual
 * dispatch path at all — so every case here declares one.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function compileAndValidate(source: string): Promise<{ compiled: boolean; validationError: string | null }> {
  const result = await compile(source, { fileName: "t.js", skipSemanticDiagnostics: true });
  if (!result.success || !result.binary?.length) {
    return { compiled: false, validationError: result.errors?.[0]?.message ?? "no binary emitted" };
  }
  try {
    await WebAssembly.compile(result.binary);
    return { compiled: true, validationError: null };
  } catch (error) {
    return { compiled: true, validationError: error instanceof Error ? error.message : String(error) };
  }
}

describe("virtual method dispatch keeps the operand stack balanced", () => {
  it("emits a valid module for an externref receiver in a short-circuit arm", async () => {
    // The reduced lit shape: `extends HTMLElement` makes the receiver
    // externref, so the dispatch path bails — and must leave no trace.
    const { validationError } = await compileAndValidate(`
      var y = class extends HTMLElement {
        m() { let t = false; t && this.k(1); }
        k(a) {}
      };
      var i = class extends y {};
      export {};
    `);
    expect(validationError).toBeNull();
  });

  it("emits a valid module for the same shape with ?: and ||", async () => {
    for (const arm of ["t ? this.k(1) : 0", "t || this.k(1)"]) {
      const { validationError } = await compileAndValidate(`
        var y = class extends HTMLElement {
          m() { let t = false; ${arm}; }
          k(a) {}
        };
        var i = class extends y {};
        export {};
      `);
      expect(validationError, `arm: ${arm}`).toBeNull();
    }
  });

  it("emits a valid module when the receiver IS a class struct (the tag-load path)", async () => {
    // No HTMLElement: the receiver is ref-typed, dispatch is really taken, and
    // the `__tag` read must use a struct type the receiver has.
    const { validationError } = await compileAndValidate(`
      var y = class {
        m() { let t = false; t && this.k(1); }
        k(a) {}
      };
      var i = class extends y {};
      export {};
    `);
    expect(validationError).toBeNull();
  });

  it("emits a valid module for a two-deep subclass chain", async () => {
    const { validationError } = await compileAndValidate(`
      var y = class {
        m() { let t = false; t && this.k(1); }
        k(a) {}
      };
      var i = class extends y {};
      var j = class extends i {};
      export {};
    `);
    expect(validationError).toBeNull();
  });

  it("still dispatches to the overriding implementation at runtime", async () => {
    // A balanced stack is necessary, not sufficient: the cascade must still
    // pick the subclass body. Compiling to a valid module and running it is
    // what distinguishes "we fixed the types" from "we broke dispatch".
    const result = await compile(
      `
      class Base {
        constructor() { this.seen = 0; }
        tag() { return 1; }
        run() { let t = true; return t && this.tag(); }
      }
      class Derived extends Base {
        tag() { return 2; }
      }
      export function baseTag() { return new Base().run(); }
      export function derivedTag() { return new Derived().run(); }
    `,
      { fileName: "t.js", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    (imports as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
    const exports = instance.exports as { baseTag(): number; derivedTag(): number };

    expect(exports.baseTag()).toBe(1);
    expect(exports.derivedTag()).toBe(2);
  });
});
