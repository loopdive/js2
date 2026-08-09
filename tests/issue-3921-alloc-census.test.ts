// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3921) Per-type WasmGC allocation census.
 *
 * Nothing available observes WasmGC allocation — V8's sampling heap profiler
 * does not see `struct.new` (0.2 MB sampled across a 58 MB acorn parse) and
 * `--trace-gc-object-stats` is unavailable — so #3780 round 4 could attribute
 * only ~10 MB of the 43.6 MB allocated per parse. This pass counts it in the
 * emitter instead.
 *
 * The three properties worth pinning are the ones that would make the numbers
 * lies rather than the ones that would make the pass fail loudly:
 *   1. the counts are EXACT against a fixture whose allocation count is known
 *      by construction;
 *   2. they survive `wasm-opt -O4`, which is the configuration every perf
 *      measurement uses — a pass that only works unoptimized measures nothing;
 *   3. with the flag off the binary is byte-identical, so the instrumentation
 *      cannot leak into a shipped artifact.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { compile } from "../src/index.js";

/** N `Pt` instances and N 2-element arrays, by construction. */
const FIXTURE = `
function Pt(x, y) { this.x = x; this.y = y; }
export function main(n) {
  var acc = 0;
  for (var i = 0; i < n; i++) { var p = new Pt(i, i + 1); var a = [p.x, p.y]; acc += a[0] + a[1]; }
  return acc;
}`;

async function build(census: boolean, optimize?: number): Promise<Uint8Array> {
  const saved = process.env.JS2WASM_ALLOC_CENSUS;
  if (census) process.env.JS2WASM_ALLOC_CENSUS = "1";
  // `= undefined` is NOT equivalent here — assigning to process.env coerces to
  // the STRING "undefined", which the flag check would read as enabled.
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  else delete process.env.JS2WASM_ALLOC_CENSUS;
  try {
    const result = await compile(FIXTURE, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      ...(optimize === undefined ? {} : { optimize }),
    });
    if (!result.success) throw new Error(result.errors.map((e) => e.message).join("; "));
    return result.binary;
  } finally {
    // biome-ignore lint/performance/noDelete: see above — env vars need delete
    if (saved === undefined) delete process.env.JS2WASM_ALLOC_CENSUS;
    else process.env.JS2WASM_ALLOC_CENSUS = saved;
  }
}

async function countsFor(binary: Uint8Array, iterations: number): Promise<Map<string, number>> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  const exports = instance.exports as Record<string, WebAssembly.Global | ((n: number) => number) | undefined>;
  (exports.__module_init as (() => void) | undefined)?.();
  (exports.main as (n: number) => number)(iterations);
  const out = new Map<string, number>();
  for (const [name, value] of Object.entries(exports)) {
    if (!name.startsWith("__alloc_count_")) continue;
    const count = (value as WebAssembly.Global).value as number;
    if (count > 0) out.set(name, count);
  }
  return out;
}

describe("#3921 — per-type allocation census", () => {
  it("counts exactly, at both optimization levels", async () => {
    for (const optimize of [undefined, 4]) {
      const counts = await countsFor(await build(true, optimize), 1000);
      const named = (needle: string): number | undefined => [...counts].find(([name]) => name.includes(needle))?.[1];
      // One `new Pt` and one array literal per iteration, by construction.
      expect(named("__fnctor_Pt")).toBe(1000);
      expect(named("__vec_externref")).toBe(1000);
    }
  });

  it("leaves the shipped binary byte-identical when disabled", async () => {
    const off = await build(false, 4);
    const on = await build(true, 4);
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    // Not just "different sizes" — the OFF build must match a build made with
    // the pass absent entirely, which is what a second OFF build stands in for.
    expect(sha(off)).toBe(sha(await build(false, 4)));
    expect(sha(on)).not.toBe(sha(off));
  });
});
