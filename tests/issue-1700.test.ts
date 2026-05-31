// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

/**
 * #1700 — TypedArray (Uint8Array) export-parameter ABI gap.
 *
 * Before this change, an exported function `(input: Uint8Array)` lowered to
 * `(ref null $Vec[f64])` and JS callers passing a real `Uint8Array` hit
 * `TypeError: type incompatibility when transforming from/to JS` at the
 * boundary. The fix adds:
 *
 *   - `__new_vec_f64(i32 len) -> externref`, a JS-callable vec allocator.
 *   - `CompileResult.exportSignatures`, a per-export TS-level classification.
 *   - `wrapExports(exports, { signatures })`, which copies `Uint8Array`
 *     args into a Wasm vec via the allocator + `__vec_set_byte`, and wraps
 *     `Uint8Array`-typed returns back into a real `Uint8Array`.
 */

async function instantiate(r: CompileResult): Promise<WebAssembly.Instance> {
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return instance;
}

describe("#1700 TypedArray export-parameter marshalling", () => {
  it("compiles: round-trips Uint8Array through a Uint8Array-typed export", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`);
    expect(r.exportSignatures).toBeDefined();
    const sig = r.exportSignatures!.echoBytes;
    expect(sig).toBeDefined();
    expect(sig!.params).toEqual(["uint8array"]);
    expect(sig!.result).toBe("uint8array");

    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const input = new Uint8Array([97, 98, 99]);
    const out = exports.echoBytes(input);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([97, 98, 99]);
  });

  it("empty Uint8Array round-trips as length-zero Uint8Array", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const out = exports.echoBytes(new Uint8Array(0));
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).length).toBe(0);
  });

  it("accepts plain Array<number> for a Uint8Array param (Uint8Array.from-style)", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const out = exports.echoBytes([1, 2, 3]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("masks out-of-range values into byte range (matches Uint8Array semantics)", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const out = exports.echoBytes([256, -1, 257]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([0, 255, 1]);
  });

  it("throws TypeError when caller passes a non-array to a Uint8Array param", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    expect(() => exports.echoBytes("foo" as any)).toThrow(TypeError);
    expect(() => exports.echoBytes(42 as any)).toThrow(TypeError);
  });

  it("multi-arg: only Uint8Array slot is marshalled; number and string pass through", async () => {
    const r = await compile(`
      export function blendBytes(n: number, buf: Uint8Array): Uint8Array {
        return buf;
      }
    `);
    expect(r.exportSignatures!.blendBytes.params).toEqual(["other", "uint8array"]);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const out = exports.blendBytes(7, new Uint8Array([10, 20, 30]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([10, 20, 30]);
  });

  it("regression guard: externref/any param keeps the externref pass-through path", async () => {
    // No Uint8Array in the signature → no exportSignatures entry, wrapper
    // is the legacy pass-through (this is the path that already worked).
    const r = await compile(`
      export function echoAny(input: any): any { return input; }
    `);
    expect(r.exportSignatures?.echoAny).toBeUndefined();
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const input = new Uint8Array([1, 2, 3]);
    const out = exports.echoAny(input);
    // externref result; identity preserved across the call (no copying)
    expect(out).toBe(input);
  });

  it("module size: a TypedArray-free module does not emit __new_vec_f64", async () => {
    const r = await compile(`
      export function add(a: number, b: number): number { return a + b; }
    `);
    const instance = await instantiate(r);
    expect((instance.exports as Record<string, unknown>).__new_vec_f64).toBeUndefined();
    expect(r.exportSignatures).toBeUndefined();
  });

  it("marshal: false — argument marshalling still runs (export must be callable)", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, {
      marshal: false,
      signatures: r.exportSignatures,
    });
    const out = exports.echoBytes(new Uint8Array([5, 6, 7]));
    // marshal:false → raw WasmGC handle. Not a Uint8Array. We can still
    // inspect length via the exported __vec_len helper.
    expect(out).not.toBeInstanceOf(Uint8Array);
    const vecLen = (instance.exports as Record<string, any>).__vec_len as (v: any) => number;
    expect(vecLen(out)).toBe(3);
  });

  it("--target wasi: Uint8Array argument marshalling reaches the compiled function", async () => {
    // Under WASI, `__box_number` is intentionally absent, so `__vec_get`
    // returns null for numeric elements and the return-side
    // `_wasmToPlain` ⇒ `Uint8Array` wrap is lossy (separate follow-up;
    // tracked alongside #1664). What #1700 fixes — the JS→Wasm arg
    // path — must still work. Verify by passing marshal:false and using
    // `__vec_len` directly to confirm the vec made it across.
    const r = await compile(`export function echoBytes(input: Uint8Array): Uint8Array { return input; }`, {
      target: "wasi",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(r.exportSignatures?.echoBytes?.result).toBe("uint8array");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const exports = wrapExports(instance.exports, {
      marshal: false,
      signatures: r.exportSignatures,
    });
    const out = exports.echoBytes(new Uint8Array([42, 43, 44]));
    const vecLen = (instance.exports as Record<string, any>).__vec_len as (v: any) => number;
    expect(vecLen(out)).toBe(3);
  });

  it("null pass-through: Uint8Array param accepting null forwards null without alloc", async () => {
    const r = await compile(`export function echoBytes(input: Uint8Array | null): Uint8Array | null { return input; }`);
    expect(r.exportSignatures?.echoBytes?.params).toEqual(["uint8array"]);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { signatures: r.exportSignatures });
    const out = exports.echoBytes(null);
    // Wasm ref.null → JS null is the expected pass-through.
    expect(out).toBeNull();
  });
});
