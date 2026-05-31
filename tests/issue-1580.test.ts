// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1580 — string-hash competitive benchmark: wasm-validator pre-existing
 * bug + uncompetitive hot runtime.
 *
 * Two distinct issues this regression test guards against:
 *
 * 1. **wasm-validator pre-existing bug** — the WASI standalone artifact
 *    we feed into `wasmtime compile -W gc=y,function-references=y` must
 *    parse cleanly. Historically `js2wasm --optimize` failed silently with
 *    a misleading "wasm-opt not available" warning because the system
 *    binary path didn't enable the feature flags js2wasm relies on
 *    (saturating float-to-int, bulk-memory, tail-call, multivalue,
 *    typed-function-references, strings).
 *
 * 2. **Uncompetitive runtime** — the hash hot loop (`for (let i=0; i<s.length;
 *    i++) h = (h*31 + s.charCodeAt(i)) | 0`) over a string-builder receiver
 *    was emitting a fresh `struct.new $NativeString` on every `.length` and
 *    `.charCodeAt` read. That's two allocations per iteration; on a 20k
 *    string-builder the hot loop allocated ~40,000 structs and ran at
 *    "Interpreter-class" numbers (~63ms warm vs. V8 JIT ~1ms). The
 *    materialized-ref cache in `emitStringBuilderRead` collapses that to
 *    one allocation per builder lifetime (until the next `+=` invalidates
 *    the cache).
 *
 * The test asserts compile success, byte-level binary validity (via
 * `WebAssembly.compile`), and that the inner hash loop contains an
 * `array.get_u` op (the inline char access) rather than any host import
 * call. We don't measure runtime here — that's the landing-page benchmark
 * generator's job — but the compile+validate path catches any regression
 * that re-introduces the validator error or removes the inline path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const STRING_HASH_SOURCE = `
export function run(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
  let text = "";
  for (let i = 0; i < n; i++) {
    const a = (i * 13) & 31;
    const b = (a + 7) & 31;
    text += alphabet.charAt(a);
    text += alphabet.charAt(b);
    text += ";";
  }

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash | 0;
}
`;

describe("#1580 — string-hash benchmark validator + perf", () => {
  it("compiles the WASI standalone string-hash artifact without errors", async () => {
    const result = await compile(STRING_HASH_SOURCE, {
      fileName: "string-hash.js",
      target: "wasi",
      nativeStrings: true,
    });
    expect(result.success, `Compile failed: ${result.errors?.map((e) => e.message).join("; ")}`).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    // No host imports — the standalone bench artifact must not reach for
    // a JS runtime. If this ever adds imports, the wasmtime benchmark
    // generator will throw.
    expect(result.imports ?? []).toEqual([]);
  });

  it("emits a binary that WebAssembly.compile accepts (GC + function-references)", async () => {
    const result = await compile(STRING_HASH_SOURCE, {
      fileName: "string-hash.js",
      target: "wasi",
      nativeStrings: true,
    });
    expect(result.success).toBe(true);
    // Browser-side validation is the closest stand-in for wasmtime's
    // parser; both accept the standard GC + function-references + bulk-
    // memory feature set. A regression that emits a malformed binary
    // surfaces here.
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("inner hash loop uses inline array.get_u (not a host call per character)", async () => {
    const result = await compile(STRING_HASH_SOURCE, {
      fileName: "string-hash.js",
      target: "wasi",
      nativeStrings: true,
    });
    expect(result.success).toBe(true);
    // The receiver of `text.charCodeAt(i)` is the string-builder local
    // `text`. emitStringBuilderRead materializes a single $NativeString
    // view (cached in `text$mat`) and `charCodeAt` reduces to an inline
    // `array.get_u $u16Array`. The presence of this op anywhere in the
    // WAT is a necessary (not sufficient) condition for the inline path.
    expect(result.wat).toContain("array.get_u");
    // The build loop's `text += ...` should still be the doubling-buffer
    // rewrite from #1210 — search for the helper name that gives that
    // away. (`__str_buf_next_cap` is only emitted under the rewrite.)
    expect(result.wat).toContain("__str_buf_next_cap");
  });

  it("string-builder read caches the materialized $NativeString", async () => {
    const result = await compile(STRING_HASH_SOURCE, {
      fileName: "string-hash.js",
      target: "wasi",
      nativeStrings: true,
    });
    expect(result.success).toBe(true);
    // The cache slot is allocated as `<name>$mat` next to the buf/len/cap
    // triple. If the cache slot disappears from the locals list, the
    // per-iteration `struct.new $NativeString` is back.
    expect(result.wat).toMatch(/\$text\$mat\b/);
  });

  it("hash receiver code reuses the cached materialization across length and charCodeAt", async () => {
    const result = await compile(STRING_HASH_SOURCE, {
      fileName: "string-hash.js",
      target: "wasi",
      nativeStrings: true,
    });
    expect(result.success).toBe(true);
    // The cached materialization should produce exactly one `struct.new`
    // for `$NativeString` per `+=` (allocated lazily on first read inside
    // the read-path `if`). We can't count emitter sites precisely without
    // walking the IR, but the cache pattern emits a single
    // `ref.is_null` guard per read followed by `local.get` reuse — a
    // direct grep proxy for whether the cache code shape is intact.
    expect(result.wat).toContain("ref.is_null");
  });

  // ── Reopened 2026-05-30 ──────────────────────────────────────────────
  // The committed landing-page benchmark JSON
  // (`benchmarks/results/wasm-host-wasmtime-hot-runtime.json`) carried the
  // EXACT pre-fix `string-hash` warm number (63,659 µs) for nine days after
  // the fix merged, because the JSON is only regenerated by a manual
  // `pnpm run refresh:benchmarks:wasmtime` (needs wasmtime on PATH) and no CI
  // job re-runs it. The fix WAS on main and effective the whole time — the
  // published number simply predated it (JSON committed 2026-05-21 22:42,
  // fix merged 2026-05-21 23:49). This guard makes that silent-staleness
  // mode loud: if the committed JSON ever shows the Interpreter-class
  // pre-fix number again, this fails and points at a stale refresh.
  it("committed benchmark JSON does not carry the pre-fix Interpreter-class number", () => {
    const jsonPath = resolve(HERE, "..", "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
    const rows = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
      name: string;
      scenario: string;
      wasmUs: number;
    }>;
    const warm = rows.find((r) => r.name === "string-hash" && r.scenario === "warm");
    expect(warm, "string-hash/warm row missing from benchmark JSON").toBeDefined();
    // The pre-fix baseline was ~63,659 µs warm (~40k per-read struct.new
    // allocations). Post-fix is ~22 ms on wasmtime 44. Anything at or above
    // ~40 ms warm means the JSON predates the #1580 fix (stale refresh) or a
    // codegen regression re-introduced the per-iteration allocation. The
    // bound is deliberately loose (40 ms) so honest machine-to-machine
    // variance never trips it — only the Interpreter-class regime does.
    expect(
      warm!.wasmUs,
      `string-hash warm = ${warm!.wasmUs} µs is at Interpreter-class levels. ` +
        `Either the committed JSON is stale (re-run 'pnpm run refresh:benchmarks:wasmtime' ` +
        `on a wasmtime host) or a codegen change re-added per-iteration $NativeString allocation.`,
    ).toBeLessThan(40_000);
  });
});
