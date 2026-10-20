// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2580 M3 B-protoextend — inherited indexed data/accessor on the
// `Object.prototype` chain, read by the generic `Array.prototype.X.call(arrayLike, …)`
// cluster (host/gc mode).
//
// Root cause (verified per-process + runtime trace, host mode):
//   A generic Array method invoked on an array-like *plain object* receiver
//   (`Array.prototype.indexOf.call({length:3}, v)`) reads `obj[i]` via §7.3.2
//   `Get`, which walks the receiver's `[[Prototype]]` chain to `%Object.prototype%`.
//   A test that does `Object.prototype[0] = true` makes `({length:3})[0]` resolve
//   to `true`. In this compiler an array-like plain-object receiver is an OPAQUE
//   WasmGC struct whose runtime `[[Prototype]]` is `null`, so the own-only
//   `obj[i]` / sidecar lookups in `__extern_get_idx` / `__extern_has_idx` missed
//   the inherited index — the generic-method loop skipped it. The trace showed
//   `(idx in obj) === false` while `idx in Object.prototype === true`:
//   `Object.prototype[i] = v` lands on the REAL host `Object.prototype`, but the
//   struct receiver never consulted it.
//
// Fix: as the FINAL fallback in `__extern_get_idx` / `__extern_has_idx` (after own
// struct fields, the sidecar and own accessor descriptors miss), consult
// `%Object.prototype%[idx]` — the single `[[Prototype]]` chain every object value
// shares (matching the architect decision to route inherited reads through the ONE
// shared `Object.prototype` walk, not a per-receiver prototype field). A real
// array / `$Vec` / any receiver carrying its own element is resolved earlier and
// never enters this arm, so the hot path is unchanged.
//
// SCOPE: inherited DATA properties on `Object.prototype` for an array-like
// plain-object receiver — the `built-ins/Array/prototype/<m>/<m>-9-b-i-N`
// "inherited data property on an Array-like object" subset. `Array.prototype[i]=v`
// inherited on REAL arrays already resolves through the native array path; the
// fnctor `.prototype=` lap (B-fnctor) and getter-bodies that close over outer
// scope are separate, later sub-mechanisms. Host/gc mode.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  (imports as { setInstance?: (e: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#2580 B-protoextend — inherited Object.prototype index read (host)", () => {
  // The canonical b-i-8 shape: `indexOf.call({length:3}, v)` finds `v` at the
  // index where `Object.prototype[i] = v` placed it (inherited data property).
  it("indexOf.call(arrayLike) reads an inherited Object.prototype index", async () => {
    const src = `export function run(): number {
      (Object.prototype as any)[0] = true;
      (Object.prototype as any)[1] = false;
      (Object.prototype as any)[2] = "true";
      const r0 = Array.prototype.indexOf.call({ length: 3 } as any, true);
      const r1 = Array.prototype.indexOf.call({ length: 3 } as any, false);
      const r2 = Array.prototype.indexOf.call({ length: 3 } as any, "true");
      delete (Object.prototype as any)[0];
      delete (Object.prototype as any)[1];
      delete (Object.prototype as any)[2];
      return r0 * 100 + r1 * 10 + r2;
    }`;
    // r0=0, r1=1, r2=2  →  0*100 + 1*10 + 2 = 12
    expect(await runHost(src)).toBe(12);
  });

  // forEach visits inherited indices (HasProperty walks the proto chain) and the
  // callback sees the inherited value.
  it("forEach.call(arrayLike) visits inherited Object.prototype indices", async () => {
    const src = `export function run(): string {
      (Object.prototype as any)[0] = "a";
      (Object.prototype as any)[1] = "b";
      let log = "";
      Array.prototype.forEach.call({ length: 2 } as any, function (v: any, i: any): void {
        log = log + i + ":" + v + ";";
      });
      delete (Object.prototype as any)[0];
      delete (Object.prototype as any)[1];
      return log;
    }`;
    expect(await runHost(src)).toBe("0:a;1:b;");
  });

  // `some` honours an inherited element value.
  it("some.call(arrayLike) honours an inherited Object.prototype element", async () => {
    const src = `export function run(): boolean {
      (Object.prototype as any)[2] = 42;
      const r = Array.prototype.some.call({ length: 3 } as any, function (v: any): boolean {
        return v === 42;
      });
      delete (Object.prototype as any)[2];
      return r;
    }`;
    expect(await runHost(src)).toBeTruthy();
  });

  // An OWN index shadows the inherited one (the proto fallback must NOT mask an
  // own element — it is reached only after own lookups miss).
  it("an own index shadows the inherited Object.prototype index", async () => {
    const src = `export function run(): number {
      (Object.prototype as any)[0] = 111;
      const r = Array.prototype.indexOf.call({ length: 1, 0: 222 } as any, 222);
      const miss = Array.prototype.indexOf.call({ length: 1, 0: 222 } as any, 111);
      delete (Object.prototype as any)[0];
      // 222 is the own element at index 0; 111 (inherited) is shadowed → not found.
      return r * 10 + (miss + 1);
    }`;
    // r=0 (222 found at own index 0), miss=-1 (111 shadowed) → 0*10 + 0 = 0
    expect(await runHost(src)).toBe(0);
  });

  // Hot-path guard: a plain array-like own-data receiver with NO proto write is
  // unaffected (the fallback never fires because own indices resolve first).
  it("array-like own-data receiver is unaffected by the proto fallback", async () => {
    const src = `export function run(): number {
      return Array.prototype.indexOf.call({ length: 3, 0: 7, 1: 8, 2: 9 } as any, 8);
    }`;
    expect(await runHost(src)).toBe(1);
  });
});
