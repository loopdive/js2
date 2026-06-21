// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2026 PR-2 — `.constructor` identity on an externref / `any`-typed instance.
//
// `new A().constructor === A` already held for a statically-typed receiver
// (`compileInstanceMember` routes `.constructor` to the `__class_<Name>`
// singleton). But when the instance flows through an `any` binding (returned
// from `function id(x: any): any`), the static arm misses and `.constructor`
// fell to the generic `__extern_get` read, which never `===` the class object.
//
// PR-2 recovers identity at runtime via the SAME class-`__tag` mechanism #2026
// PR-1's dynamic-`new` uses: read the instance `__tag` (struct field 0) and a
// flat `tag == classTag` chain selects the matching `__class_<Name>` singleton —
// making both sides of `=== A` reference-identical, host-free (standalone-safe).
// Discrimination is by `__tag`, never struct type (canonicalization merges
// same-shape class structs — #2009).
//
// Spec: ECMA-262 §10.2.4 (constructor wiring), §20.2.2 / §7.2.16 (identity).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test: () => unknown }).test();
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Pure-Wasm ABI: must instantiate with NO host imports.
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod).filter((i) => i.module === "env")).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const ID = "function id(x: any): any { return x; }";

describe("issue #2026 PR-2: .constructor identity via any-typed receiver", () => {
  it("a.constructor === A through an any binding (host) → true", async () => {
    expect(
      await runHost(`class A { v = 1; } ${ID}
        export function test(): boolean { const a: any = id(new A()); return a.constructor === A; }`),
    ).toBe(1);
  });

  it("static receiver unchanged: new A().constructor === A → true", async () => {
    expect(
      await runHost(`class A { v = 1; }
        export function test(): boolean { return new A().constructor === A; }`),
    ).toBe(1);
  });

  it("shape-colliding classes discriminate by tag (host) → true", async () => {
    expect(
      await runHost(`class A { x = 1; } class B { x = 2; } ${ID}
        export function test(): boolean { const a: any = id(new A()); return a.constructor === A && a.constructor !== B; }`),
    ).toBe(1);
  });

  it("wrong-class comparison is false → false", async () => {
    expect(
      await runHost(`class A { x = 1; } class B { x = 2; } ${ID}
        export function test(): boolean { const a: any = id(new A()); return a.constructor === B; }`),
    ).toBe(0);
  });

  it("subclass instance: b.constructor === B → true", async () => {
    expect(
      await runHost(`class A { x = 1; } class B extends A { y = 2; } ${ID}
        export function test(): boolean { const b: any = id(new B()); return b.constructor === B; }`),
    ).toBe(1);
  });

  it("non-class externref .constructor does not match a class (no crash) → false", async () => {
    expect(
      await runHost(`class A { x = 1; } ${ID}
        export function test(): boolean { const n: any = id(42); return n.constructor === A; }`),
    ).toBe(0);
  });

  // Regression guard for the net-479 break: the `.constructor`-via-tag arm fires
  // for ANY `any`-typed `.constructor` access once a user class exists. When the
  // receiver is NOT a user-class instance, the arm must FALL THROUGH to the real
  // (host) `.constructor`, not clobber it with null. Before the fix it returned
  // null, so a host object's `.constructor` evaluated to null and any later use
  // (`.name`, `new ...`) trapped "Cannot access property on null or undefined" —
  // this is exactly what nulled the test262 harness `TypedArray` shim
  // (`Object.getPrototypeOf(Int8Array.prototype).constructor`) and cascaded to
  // ~478 TypedArray tests.
  it("host receiver keeps its real .constructor through the arm (host) → true", async () => {
    expect(
      await runHost(`class A { x = 1; } ${ID}
        export function test(): boolean { const s: any = id("hi"); const c: any = s.constructor; return c === String; }`),
    ).toBe(1);
  });

  it("non-class .constructor stays usable (no null trap) (host) → true", async () => {
    // Mirrors the harness pattern: read `.constructor` off an `any` host value
    // and then USE the result. A null result would trap on the subsequent read.
    expect(
      await runHost(`class A { x = 1; } ${ID}
        export function test(): boolean {
          const obj: any = id([1, 2, 3]);
          const ctor: any = obj.constructor;
          return ctor === Array && ctor.name === "Array";
        }`),
    ).toBe(1);
  });

  it("standalone: a.constructor === A via any, zero env imports → true", async () => {
    expect(
      await runStandalone(`class A { v = 1; } ${ID}
        export function test(): boolean { const a: any = id(new A()); return a.constructor === A; }`),
    ).toBe(1);
  });

  it("standalone: shape-colliding classes discriminate by tag → true", async () => {
    expect(
      await runStandalone(`class A { x = 1; } class B { x = 2; } ${ID}
        export function test(): boolean { const a: any = id(new A()); return a.constructor === A && a.constructor !== B; }`),
    ).toBe(1);
  });
});
