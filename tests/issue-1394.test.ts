// #1394 — class method-closure caching.
//
// `C.prototype.<method>` must return a singleton closure-struct externref
// so that:
//   1. `c.m === C.prototype.m` holds (verifyProperty's value-equality check).
//   2. Repeated access returns the same closure (no per-access allocation).
//   3. The closure is callable (legacy null-externref returned `undefined()`
//      which silently failed instead of throwing TypeError).
//
// Covered method kinds: regular, generator, async, async-generator. The
// closure's funcref is built once per `${className}_${methodName}` and
// stashed in a module-level externref global.

import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1394 — class method-closure caching (identity invariant)", () => {
  // (#1394 dual-registration bridge) The instance access path resolves
  // through TS's symbol "__class" → synthetic name `__anonClass_N`, while
  // the proto-access path resolves the user-visible identifier. The
  // declarations.ts bridge populates `classExprNameMap[varName] →
  // syntheticName` after both registrations have run, collapsing both
  // paths to the SAME `${syntheticName}_${methodName}` cache key — the
  // two singleton externref reads land on the same module global, so
  // `c.m === C.prototype.m` holds.
  it("c.m === C.prototype.m for a regular method (declared class)", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 1; }
      }
      export function test(): number {
        const c = new C();
        if (c.m !== C.prototype.m) return 999;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  it("c.m === C.prototype.m for var C = class { ... } (dual registration)", async () => {
    const wasm = await compileToWasm(`
      var C = class {
        m(): number { return 1; }
      };
      export function test(): number {
        const c = new C();
        if (c.m !== C.prototype.m) return 999;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  it("C.prototype.m === C.prototype.m on repeated access", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 1; }
      }
      export function test(): number {
        if (C.prototype.m !== C.prototype.m) return 999;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  it("C.prototype.m is non-null (was null pre-fix)", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 1; }
      }
      export function test(): number {
        const m: any = C.prototype.m;
        if (m === null) return 0;
        if (typeof m !== "function" && typeof m !== "object") return 0;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  // (#1394) Activated by the dual-reg bridge that landed in 4edc9d357 —
  // each method kind (regular, generator, async, async-generator) now
  // hits the same `${syntheticName}_${methodName}` cache global on both
  // the instance and prototype access paths.
  it("identity holds across method kinds (regular, gen, async, asyncGen)", async () => {
    const wasm = await compileToWasm(`
      class C {
        m(): number { return 1; }
        *g(): Generator<number> { yield 1; }
        async a(): Promise<number> { return 1; }
        async *ag(): AsyncGenerator<number> { yield 1; }
      }
      export function test(): number {
        const c = new C();
        if (c.m !== C.prototype.m) return 1;
        if (c.g !== C.prototype.g) return 2;
        if (c.a !== C.prototype.a) return 3;
        if (c.ag !== C.prototype.ag) return 4;
        return 0;
      }
    `);
    expect((wasm as any).test()).toBe(0);
  });

  // (#1394) Cache identity must hold across element-access and dot-access
  // spellings — `C.prototype['m'] === C.prototype.m` is the test262
  // shape for computed method names (`class/elements/syntax/valid/grammar-*`).
  it("C.prototype['m'] === C.prototype.m (element-access identity)", async () => {
    const wasm = await compileToWasm(`
      class C { m(): number { return 1; } }
      export function test(): number {
        if (C.prototype["m"] !== C.prototype.m) return 999;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  // (#1394) Inherited methods must resolve to the owning class's cache
  // entry, not the subclass's — `(new D()).m === C.prototype.m` where
  // D extends C and only C defines m.
  it("inherited method: (new D()).m === C.prototype.m", async () => {
    const wasm = await compileToWasm(`
      class C { m(): number { return 1; } }
      class D extends C {}
      export function test(): number {
        const d = new D();
        if (d.m !== C.prototype.m) return 999;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });

  it("two classes with same method name keep distinct identities", async () => {
    const wasm = await compileToWasm(`
      class A {
        m(): number { return 1; }
      }
      class B {
        m(): number { return 2; }
      }
      export function test(): number {
        if (A.prototype.m === B.prototype.m) return 999;
        if (A.prototype.m !== A.prototype.m) return 100;
        if (B.prototype.m !== B.prototype.m) return 200;
        return 1;
      }
    `);
    expect((wasm as any).test()).toBe(1);
  });
});
