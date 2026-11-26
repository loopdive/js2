// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/**
 * #1829 — `marshalTypedArrayArgs` byte-masked EVERY element (`src[j] & 0xff`),
 * not just `Uint8Array`. That silently corrupted `Uint16Array` / `Uint32Array`
 * (and signed/float) arguments to a compiled export by truncating each element
 * to its low byte. The fix masks only when the slot is classified
 * `"uint8array"`; for the `"typed-array"` catch-all it writes the value
 * unmasked. The vec backing store is f64 and `__vec_set_byte` widens its i32
 * arg via `f64.convert_i32_u`, so unsigned-integer typed arrays now round-trip
 * up to 2^32-1 at full precision.
 *
 * Tested at the arg boundary with `marshal: false` + `__vec_get`/`__vec_len`,
 * which reads the element values that actually crossed into the Wasm vec
 * (the return-side `typed-array` wrap is a separate v1 limitation — see
 * classifyTypedArrayType notes).
 */

async function instantiate(r: CompileResult): Promise<WebAssembly.Instance> {
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return instance;
}

// Read every element that landed in the Wasm vec back out as a JS number.
function readVec(instance: WebAssembly.Instance, vec: unknown): number[] {
  const ex = instance.exports as Record<string, any>;
  const vecLen = ex.__vec_len as (v: any) => number;
  const vecGet = ex.__vec_get as (v: any, i: number) => unknown;
  const n = vecLen(vec);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number(vecGet(vec, i)));
  return out;
}

describe("#1829 typed-array argument marshalling no longer byte-truncates", () => {
  it("Uint16Array values above 255 cross the boundary unmasked", async () => {
    const r = await compile(`export function echo(input: Uint16Array): Uint16Array { return input; }`);
    expect(r.exportSignatures?.echo?.params).toEqual(["typed-array"]);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { marshal: false, signatures: r.exportSignatures });
    // 256 & 0xff === 0, 4660 & 0xff === 52, 65535 & 0xff === 255 — the OLD
    // behaviour would have produced [0, 52, 255]; we expect the real values.
    const out = exports.echo(new Uint16Array([256, 4660, 65535]));
    expect(readVec(instance, out)).toEqual([256, 4660, 65535]);
  });

  it("Uint32Array large values round-trip at full precision", async () => {
    const r = await compile(`export function echo(input: Uint32Array): Uint32Array { return input; }`);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { marshal: false, signatures: r.exportSignatures });
    const out = exports.echo(new Uint32Array([0, 65536, 4294967295]));
    expect(readVec(instance, out)).toEqual([0, 65536, 4294967295]);
  });

  it("Uint8Array still byte-masks (unchanged #1700 semantics)", async () => {
    const r = await compile(`export function echo(input: Uint8Array): Uint8Array { return input; }`);
    expect(r.exportSignatures?.echo?.params).toEqual(["uint8array"]);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { marshal: false, signatures: r.exportSignatures });
    // 256 → 0, 257 → 1, 511 → 255 (Uint8Array indexed-write semantics preserved)
    const out = exports.echo(new Uint8Array([256, 257, 511]));
    expect(readVec(instance, out)).toEqual([0, 1, 255]);
  });

  it("multi-arg: only the typed-array slot is marshalled, number passes through", async () => {
    const r = await compile(`
      export function blend(scale: number, buf: Uint16Array): Uint16Array { return buf; }
    `);
    expect(r.exportSignatures?.blend?.params).toEqual(["other", "typed-array"]);
    const instance = await instantiate(r);
    const exports = wrapExports(instance.exports, { marshal: false, signatures: r.exportSignatures });
    const out = exports.blend(3, new Uint16Array([300, 4096]));
    expect(readVec(instance, out)).toEqual([300, 4096]);
  });
});
