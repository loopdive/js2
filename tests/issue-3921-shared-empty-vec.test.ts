// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3921 follow-up) `[]`'s zero-length backing store is shared, not allocated.
 *
 * `push` grows on `capacity < length + argc`, which from capacity 0 always
 * trips — so the store an empty literal allocates is replaced by the first push
 * without ever being read. Sharing one immutable singleton per element type is
 * therefore observationally identical, and the census measured it removing
 * 8,922 allocations per acorn parse.
 *
 * The risk is aliasing: if any writer reached a backing store WITHOUT the
 * capacity check, it would scribble on every other empty array in the program.
 * That is what the mutation tests below exist for — two independently-created
 * empty arrays must not observe each other.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndRunHost } from "./helpers/compile.js";

async function run(body: string, env?: Record<string, string>): Promise<unknown> {
  const saved = process.env.JS2WASM_SHARED_EMPTY_VEC;
  if (env?.JS2WASM_SHARED_EMPTY_VEC !== undefined) process.env.JS2WASM_SHARED_EMPTY_VEC = env.JS2WASM_SHARED_EMPTY_VEC;
  try {
    const result = await compile(`export function main() {${body}}`, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    if (!result.success) throw new Error(result.errors.map((e) => e.message).join("; "));
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const ex = instance.exports as Record<string, (() => number) | undefined>;
    ex.__module_init?.();
    return ex.main!();
  } finally {
    // `= undefined` is NOT equivalent: assigning to process.env coerces to the
    // STRING "undefined", which `!== "0"` reads as ENABLED — so the control
    // would silently run instrumented and the comparison would be vacuous.
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (saved === undefined) delete process.env.JS2WASM_SHARED_EMPTY_VEC;
    else process.env.JS2WASM_SHARED_EMPTY_VEC = saved;
  }
}

/** Two empties pushed to independently — the aliasing case that would break. */
const NON_ALIASING = `
  var a = [1]; a.pop();
  var b = [1]; b.pop();
  a.push(7); a.push(8);
  var out = a.length * 100 + b.length * 10 + a[0];
  b.push(3);
  return out + b.length + b[0] + a.length;
`;

/** An empty that is never pushed must still read as length 0. */
const NEVER_PUSHED = `
  var a = [1]; a.pop();
  var b = [1]; b.pop();
  return a.length + b.length + (a.length === 0 ? 5 : 0);
`;

describe("#3921 — shared zero-length backing store", () => {
  for (const [name, body] of [
    ["independently-pushed empties do not alias", NON_ALIASING],
    ["an unpushed empty still reads length 0", NEVER_PUSHED],
  ] as const) {
    it(name, async () => {
      // Pinned against the paired control rather than a hand-computed constant:
      // sharing is a representation change, so the only claim is that it is
      // invisible. Whatever the lane answers, both must answer the same.
      expect(await run(body)).toBe(await run(body, { JS2WASM_SHARED_EMPTY_VEC: "0" }));
    });
  }

  it("matches plain JS on the aliasing fixture", async () => {
    expect(await run(NON_ALIASING)).toBe(new Function(NON_ALIASING)());
  });
});

/**
 * (#3933) The regression that took this optimization out of the merge queue,
 * and the reason every test above was blind to it.
 *
 * ROOT CAUSE: `ctx.sharedEmptyVecGlobals` caches an ABSOLUTE global index.
 * `addStringConstantGlobal` inserts each new string literal as an IMPORT global
 * at index `numImportGlobals` — i.e. BELOW every module-defined global — and
 * calls `fixupModuleGlobalIndices` to shift everything above it. That shifter
 * updates already-emitted `global.get` instructions correctly, and it updates a
 * hand-maintained list of cached indices (`newTargetGlobalIdx` #2023,
 * `holeGlobalIdx` #2001, `genEagerFlagGlobalIdx` #3032 — three prior instances
 * of this exact bug). The new cache was not on that list, so the NEXT `[]` of
 * the same element type reused a stale index naming an unrelated global:
 *
 *  - stale index on an i32/f64 global -> module fails validation (400 tests);
 *  - stale index on an externref global -> the coercion layer repairs it with
 *    `any.convert_extern` + `ref.cast`, so it validates and traps at run time
 *    (+3,634 `illegal_cast`).
 *
 * Net −2,621 test262 passes. The aliasing premise this optimization rests on
 * was never the problem.
 *
 * Two independent reasons the original tests could not fail, both measured:
 *
 *  1. `target: "standalone"` forces `nativeStrings`, and `addStringConstantGlobal`
 *     early-returns without registering an import global — so `numImportGlobals`
 *     stays 0 and the shifter never fires at all. Every test above is standalone.
 *  2. Their fixture (`var a = [1]; a.pop()`) never reaches the modified branch:
 *     small functions compile through the IR front end, which lowers `[]` itself.
 *
 * So the fixture below needs the JS-host lane AND a real string-constant import
 * (`x.length`) AND two empty literals of one element type — the second is the
 * one that reuses the stale cache entry.
 */
const STALE_CACHE_REPRO = `
function f(x: any): number {
  return x.length;
}
const r = f([]);
export function main(): number {
  return r + f([]);
}`;

describe("#3933 — the shared-store cache survives late import-global insertion", () => {
  it("compiles and runs in the JS-host lane", async () => {
    // Before the fix this threw at compile: "struct.new[1] expected type
    // (ref null 1), found global.get of type i32".
    const ex = await compileAndRunHost(STALE_CACHE_REPRO);
    ex.__module_init?.();
    expect(ex.main!()).toBe(0);
  });

  it("agrees with the paired control", async () => {
    const saved = process.env.JS2WASM_SHARED_EMPTY_VEC;
    process.env.JS2WASM_SHARED_EMPTY_VEC = "0";
    try {
      const ex = await compileAndRunHost(STALE_CACHE_REPRO);
      ex.__module_init?.();
      expect(ex.main!()).toBe(0);
    } finally {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      if (saved === undefined) delete process.env.JS2WASM_SHARED_EMPTY_VEC;
      else process.env.JS2WASM_SHARED_EMPTY_VEC = saved;
    }
  });
});
