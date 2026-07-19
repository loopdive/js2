// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3398 (struct.new-arity sub-mechanism, Array.from rows) — non-arrow closures
// must not lexically capture the enclosing `this`.
//
// Only arrows inherit `this` (§8.1.1.3); a function expression / object-literal
// method / accessor binds its own dynamic `this` at call time (installed by the
// closure-call path via `__current_this`). The free-var scan treated `this` as
// an ordinary capturable name for EVERY function-like, so an object-literal
// getter nested in a STRUCT-METHOD return value —
//
//   var obj = { make() { return { index: 0, get val() { return this.index; } } } };
//
// — captured `make`'s `(ref $__anon_N)` self as its `this`. `this.index` then
// statically resolved against the OUTER struct, and the dynamic-property
// auto-add (property-access-dispatch.ts) APPENDED `index` to that already-
// emitted struct: `struct.new` arity mismatch ("not enough arguments on the
// stack for struct.new (need 2, got 1)") — INVALID Wasm in BOTH lanes. This is
// the real `Array.from(obj)` shape: `obj[Symbol.iterator]()` returns
// `{ index, next(), get val() }` (test262 source-object-iterator-1/2, both
// CE→pass with this fix).
//
// Fix: `arrowOwnLocals` shadows `this` for non-arrows, so the capture scan
// leaves it to the runtime receiver; the getter's `this.index` routes through
// the dynamic host/native MOP against the actual inner object.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, `leaked host imports: ${envImports.map((i) => i.name).join(", ")}`).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

async function compileHostValid(src: string): Promise<void> {
  const r = await compile(src, {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  await WebAssembly.compile(r.binary); // must validate
}

const REPRO = `
  export function test(): number {
    var obj = { make() { return { index: 7, get val() { return this.index; } }; } };
    const inner: any = obj.make();
    const got: any = inner.val;
    if (got === 7) return 42;
    return 0;
  }`;

describe("#3398 non-arrow this-capture / getter struct.new arity", () => {
  it("repro compiles valid standalone AND the getter reads the RECEIVER's field", async () => {
    expect(await runStandalone(REPRO)).toBe(42);
  });

  it("repro compiles valid in host (gc) mode too (both lanes were invalid)", async () => {
    await compileHostValid(REPRO);
  });

  it("iterator-protocol shape: method mutates, getter observes (Array.from source shape)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var obj = {
            make() {
              return {
                index: 0,
                bump() { this.index = this.index + 1; return this.index; },
                get val() { return this.index; },
              };
            },
          };
          const it: any = obj.make();
          it.bump();
          it.bump();
          const got: any = it.val;
          if (got === 2) return 42;
          return 0;
        }`),
    ).toBe(42);
  });

  it("GUARD: an ARROW inside a struct method still inherits the lexical this", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const holder = { n: 5, grab() { const f = () => this.n; return f(); } };
          const got: any = holder.grab();
          if (got === 5) return 42;
          return 0;
        }`),
    ).toBe(42);
  });

  it("GUARD: outer struct stays intact — method dispatch on the outer object still works", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          var obj = { make() { return { index: 1, get val() { return this.index; } }; } };
          const a: any = obj.make();
          const b: any = obj.make();
          const got: any = a.val + b.val;
          if (got === 2) return 42;
          return 0;
        }`),
    ).toBe(42);
  });
});
