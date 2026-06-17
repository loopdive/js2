// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2179 — post-delete struct READ returned the stale value for a
// statically-resolvable `any` receiver (JS-host mode).
//
// `const o: any = { a: 1, b: 2 }; delete o.a; o.a` compiled the read to an
// inline `ref.test`+`struct.get` fast-path that read the LIVE WasmGC field and
// bypassed the runtime delete tombstone, so the read returned `1`, and
// `o.a === undefined` constant-folded to `false` (the field's static type is
// `f64`, which can never be `undefined`).
//
// Fix (#2179 A6, JS-host):
//  - A `moduleUsesDelete` pre-scan (`src/codegen/index.ts`) gates the routing so
//    delete-free modules keep the byte-identical inline fast-path.
//  - When the module uses `delete <member>`, `any`/`unknown`-typed property reads
//    route through the tombstone-aware `__extern_get` host helper
//    (`src/codegen/property-access.ts` `tryEmitDeleteAwareDynamicGet`), which
//    returns an `externref` — real `undefined` when tombstoned (so `=== undefined`
//    is no longer folded) and re-add via `__extern_set`/`_safeSet` clears it.
//  - The `__extern_get` struct-field getter fallback and `Object.keys`/`values`/
//    `entries` now consult `_wasmStructDeletedKeys` before reading the live field
//    (`src/runtime.ts`), so a tombstoned key never resurfaces.
//
// Standalone mode (A7 — $Object representation steering) is a separate follow-up;
// this change is JS-host-only (gated on `!ctx.standalone`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run<T = unknown>(src: string): Promise<T> {
  const result = await compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return (inst.instance.exports as Record<string, Function>).test!() as T;
}

describe("#2179 post-delete struct read consults the tombstone (JS-host)", () => {
  it("read of a deleted property returns undefined", async () => {
    expect(
      await run<string>(`export function test(): string {
      const o: any = { a: 1, b: 2 }; delete o.a; return String(o.a);
    }`),
    ).toBe("undefined");
  });

  it("`o.a === undefined` after delete is true (not constant-folded)", async () => {
    // Boolean exports return the i32 representation (1 = true), matching the
    // #2130 read-half assertions.
    expect(
      await run<number>(`export function test(): boolean {
      const o: any = { a: 1, b: 2 }; delete o.a; return o.a === undefined;
    }`),
    ).toBe(1);
  });

  it("delete then re-add reads the new value", async () => {
    expect(
      await run<number>(`export function test(): number {
      const o2: any = { a: 1 }; delete o2.a; o2.a = 5; return o2.a;
    }`),
    ).toBe(5);
  });

  it("dynamic-key delete tombstones the read too", async () => {
    expect(
      await run<string>(`export function test(): string {
      const o: any = { a: 1 }; const k = "a"; delete o[k]; return String(o.a);
    }`),
    ).toBe("undefined");
  });

  it("a sibling property is unaffected by the delete", async () => {
    expect(
      await run<number>(`export function test(): number {
      const o: any = { a: 1, b: 2 }; delete o.a; return o.b;
    }`),
    ).toBe(2);
  });

  it("Object.keys omits the deleted key", async () => {
    expect(
      await run<string>(`export function test(): string {
      const o: any = { a: 1, b: 2 }; delete o.a; return Object.keys(o).join(",");
    }`),
    ).toBe("b");
  });

  it("for-in omits the deleted key", async () => {
    expect(
      await run<string>(`export function test(): string {
      const o: any = { a: 1, b: 2 }; delete o.a; let s = ""; for (const k in o) s += k; return s;
    }`),
    ).toBe("b");
  });

  it("string-valued field reads undefined after delete", async () => {
    expect(
      await run<string>(`export function test(): string {
      const o: any = { s: "hi", t: "bye" }; delete o.s; return o.t + String(o.s);
    }`),
    ).toBe("byeundefined");
  });

  // Regression guards: the gate must not perturb non-delete reads.

  it("typed (non-any) receiver reads are unchanged", async () => {
    expect(
      await run<number>(`interface P { x: number; y: number; }
      export function test(): number { const p: P = { x: 3, y: 4 }; return p.x + p.y; }`),
    ).toBe(7);
  });

  it("method dispatch on an any receiver in a delete-using module works", async () => {
    expect(
      await run<number>(`export function test(): number {
      const o: any = { f: (n: number) => n * 2 }; delete o.g; return o.f(21);
    }`),
    ).toBe(42);
  });
});
