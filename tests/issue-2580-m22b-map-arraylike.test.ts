// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 M2.2b) `Array.prototype.map.call(arrayLike, cb)` native $ObjVec arm.
//
// In standalone/WASI, `map.call(<array-like object>)` was REFUSED (it was the last
// entry in STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS) because its host
// `__js_array_new`/`__extern_set` result-builder leaks a host import + tripped the
// binary-emitter local-type bug. M2.2b gives it a native `$ObjVec` result-builder
// (`__objvec_new`/`__objvec_push`, mirroring the landed `filter` arm): for the
// `.call(arrayLike)` generic-method case the loop iterates indices 0..length-1
// densely, so a sequential push is index-correct. Host/gc mode keeps the JS-array
// builder.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Host (gc) mode run.
async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { run: () => unknown }).run();
}

// Standalone (pure-Wasm, no host imports) run.
async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { run: () => unknown }).run();
}

const ARRLIKE_MAP_LEN = `export function run(): number {
  const o: any = { length: 3, 0: 1, 1: 2, 2: 3 };
  const r: any = Array.prototype.map.call(o, (x: number) => x * 2);
  return r.length;
}`;
const ARRLIKE_MAP_E0 = `export function run(): number {
  const o: any = { length: 3, 0: 1, 1: 2, 2: 3 };
  const r: any = Array.prototype.map.call(o, (x: number) => x * 2);
  return r[0];
}`;
const ARRLIKE_MAP_E2 = `export function run(): number {
  const o: any = { length: 3, 0: 1, 1: 2, 2: 3 };
  const r: any = Array.prototype.map.call(o, (x: number) => x * 2);
  return r[2];
}`;

describe("#2580 M2.2b — map.call(arrayLike) native $ObjVec arm (standalone)", () => {
  it("standalone: result length is the array-like length", async () => {
    expect(await runStandalone(ARRLIKE_MAP_LEN)).toBe(3);
  });

  it("standalone: result[0] is index-correct (was refused/empty)", async () => {
    expect(await runStandalone(ARRLIKE_MAP_E0)).toBe(2);
  });

  it("standalone: result[2] is index-correct (sequential push = positional)", async () => {
    expect(await runStandalone(ARRLIKE_MAP_E2)).toBe(6);
  });

  // Host/gc mode must be unchanged (it keeps the JS-array builder).
  it("host: map.call(arrayLike) still correct", async () => {
    expect(await runHost(ARRLIKE_MAP_LEN)).toBe(3);
    expect(await runHost(ARRLIKE_MAP_E2)).toBe(6);
  });

  // Direct-array .map must be unchanged in both modes (the change is gated to the
  // array-like generic-call path; the dense-array map path is untouched).
  it("direct [].map unchanged (host + standalone)", async () => {
    const src = `export function run(): number { return [1, 2, 3].map((x) => x * 2)[1]; }`;
    expect(await runHost(src)).toBe(4);
    expect(await runStandalone(src)).toBe(4);
  });
});
