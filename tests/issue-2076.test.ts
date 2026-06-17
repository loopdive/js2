// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2076 — standalone Object.assign drops every source (and the target's own
// keys vanished from Object.keys). Root cause: the call site compiled the
// target / source object-literal arguments with an externref contextual type,
// which routed them to the CLOSED-STRUCT path (their TS contextual type from
// Object.assign's generic signature resolves to a concrete object type, not
// `any`). The native __object_assign reads each operand via `ref.test $Object`
// + a $PropEntry walk, which a closed struct fails — so nothing copied and
// Object.keys saw zero keys.
//
// Fix (expressions/calls.ts): in standalone mode build plain data-property /
// spread object-literal arguments directly as native $Objects via
// compileObjectLiteralAsExternref, so __object_assign recognises them.
//
// Each test compiles with `target: "standalone"`, asserts ZERO host imports
// (pure Wasm), and runs against the WASI polyfill.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: number }> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  // Standalone must be host-import-free: only the WASI snapshot module is allowed.
  const hostImports = WebAssembly.Module.imports(module).filter((i) => i.module !== "wasi_snapshot_preview1").length;
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, hostImports };
}

describe("#2076 — standalone Object.assign copies sources", () => {
  it("the repro: later source overrides + new key both land", async () => {
    const { value, hostImports } = await runStandalone(
      `export function test(): number {
         const t: any = Object.assign({a:1}, {b:2, a:3});
         return (t.a as number) * 10 + (t.b as number);
       }`,
    );
    expect(hostImports).toBe(0);
    expect(value).toBe(32); // a=3, b=2
  });

  it("Object.keys of the result reflects all merged keys", async () => {
    const { value, hostImports } = await runStandalone(
      `export function test(): number {
         const o: any = Object.assign({a:1}, {b:2});
         return Object.keys(o).length;
       }`,
    );
    expect(hostImports).toBe(0);
    expect(value).toBe(2);
  });

  it("multiple sources apply in order — last wins", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const o: any = Object.assign({a:1}, {a:2}, {a:3});
         return o.a as number;
       }`,
    );
    expect(value).toBe(3);
  });

  it("mutates the target in place", async () => {
    // The source's properties land on the ORIGINAL target object (read back
    // through the target binding, not the return value). Object identity of the
    // return value (`r === src`) depends on a separate standalone `===`
    // limitation and is intentionally out of scope here.
    const { value } = await runStandalone(
      `export function test(): number {
         const src: any = {a:1};
         Object.assign(src, {b:2});
         return src.b as number;
       }`,
    );
    expect(value).toBe(2);
  });

  it("a non-literal source variable still copies", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const s: any = {b:2, a:3};
         const t: any = Object.assign({a:1}, s);
         return (t.a as number) * 10 + (t.b as number);
       }`,
    );
    expect(value).toBe(32);
  });

  it("a spread inside the source literal is honored", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const base: any = {b:2};
         const t: any = Object.assign({a:1}, {...base, a:3});
         return (t.a as number) * 10 + (t.b as number);
       }`,
    );
    expect(value).toBe(32);
  });

  it("empty source leaves the target's own keys intact", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const o: any = Object.assign({a:1}, {});
         return Object.keys(o).length;
       }`,
    );
    expect(value).toBe(1);
  });

  it("no source at all returns the target unchanged", async () => {
    const { value } = await runStandalone(
      `export function test(): number {
         const o: any = Object.assign({a:1, b:2});
         return Object.keys(o).length;
       }`,
    );
    expect(value).toBe(2);
  });
});
