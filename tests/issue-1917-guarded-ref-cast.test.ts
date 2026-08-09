// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 Stage A — regression smoke for the `guardedRefCastInstrs` extraction.
 *
 * The `local.tee → ref.test → if (ref.cast_null / ref.null)` guarded-downcast
 * idiom was copy-pasted 11× across `coerceType` (7×) and `coercionInstrs` (4×)
 * in type-coercion.ts; Stage A folds all 11 into one helper.
 *
 * The AUTHORITATIVE neutrality proof is a both-lane (gc host + standalone)
 * Wasm-byte-SHA diff of the example corpus + targeted coercion snippets against
 * origin/main (0 diffs across 62 real binaries) — this refactor emits
 * byte-identical Wasm. These cases are a lightweight live-path smoke: two
 * coercion-heavy programs that route through `coerceType`'s ref-conversion
 * dispatch and are stable on `main`, so a gross breakage of that function would
 * still surface here even though the guarded-cast trap arms themselves are
 * exercised only by any→named-struct unboxing patterns that pre-existingly trap.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, standalone: boolean): Promise<unknown> {
  const r = await compile(src, standalone ? { fileName: "t.ts", target: "standalone" } : { fileName: "t.ts" });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  const importObj = standalone ? {} : (r.importObject ?? {});
  const { instance } = await WebAssembly.instantiate(r.binary, importObj as WebAssembly.Imports);
  return (instance.exports as { test(): unknown }).test();
}

// Array → tuple guarded conversion on a destructuring param (coerceType's
// struct-conversion dispatch); stable on both lanes.
const vecToTuple = `export function test(): number {
  function g([a, b]: [number, number]): number { return a + b; }
  return g([3, 4] as [number, number]);
}`;

// any → native-string unbox from $AnyValue (externval field-4 path), standalone.
const anyToStringLen = `export function test(): number {
  const x: any = "abc";
  const s: string = x;
  return s.length;
}`;

describe("#1917 Stage A — guarded-cast extraction keeps coercion paths stable", () => {
  it("array → tuple destructuring param (host)", async () => expect(await run(vecToTuple, false)).toBe(7));
  it("array → tuple destructuring param (standalone)", async () => expect(await run(vecToTuple, true)).toBe(7));
  it("any → native-string unbox length (standalone)", async () => expect(await run(anyToStringLen, true)).toBe(3));
});
