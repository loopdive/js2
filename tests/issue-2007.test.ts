// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2007 — standalone array string-coercion.
 *
 * In standalone / native-strings mode (`--target standalone`, no JS host), the
 * `+`/template ToString of a WasmGC vec (array) fell into the
 * `$__any_to_string` "[object Object]" fallthrough instead of running
 * Array.prototype.join semantics — `"" + [1,2]` returned `"[object Object]"`
 * (length 15) rather than `"1,2"`. (js-host mode already produced "1,2" via
 * #2022/#1997.)
 *
 * The fix routes a statically-known vec concat/template operand through a
 * per-vec-type native join helper (`__vec_join_<elemKind>`), and adds a vec
 * dispatch arm to `$__any_to_string` so nested arrays recurse. Elements join
 * with `","`; numeric elements via `number_toString`, string elements pass
 * through, ref elements (nested arrays / objects) recurse through
 * `$__any_to_string`.
 *
 * Each program self-compares against the expected string and returns 1 (pass)
 * or 0 (fail) so the standalone native-string result (a `ref $AnyString` JS
 * cannot read directly) is checked in-module.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const fn = (instance.exports as Record<string, unknown>).test as () => number;
  return fn();
}

describe("#2007 — standalone array `+`/template string coercion (join semantics)", () => {
  it('number[] coerces to "1,2" not "[object Object]"', async () => {
    expect(
      await runStandalone('export function test(): number { const a = [1, 2]; return ("" + a) === "1,2" ? 1 : 0; }'),
    ).toBe(1);
  });

  it('prefixed concat "a=" + [1,2] yields "a=1,2"', async () => {
    expect(
      await runStandalone(
        'export function test(): number { const a = [1, 2]; return ("a=" + a) === "a=1,2" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it("float[] uses number_toString per element", async () => {
    expect(
      await runStandalone(
        'export function test(): number { const a = [1.5, 2.25]; return ("" + a) === "1.5,2.25" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it("string[] joins without quoting", async () => {
    expect(
      await runStandalone(
        'export function test(): number { const a = ["x", "y"]; return ("" + a) === "x,y" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it('single element array → that element ("7")', async () => {
    expect(
      await runStandalone('export function test(): number { const a = [7]; return ("" + a) === "7" ? 1 : 0; }'),
    ).toBe(1);
  });

  it('empty array → "" ("[" + [] + "]" === "[]")', async () => {
    expect(
      await runStandalone(
        'export function test(): number { const a: number[] = []; return ("[" + a + "]") === "[]" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it('nested arrays recurse: [[1,2],[3]] → "1,2,3"', async () => {
    expect(
      await runStandalone(
        'export function test(): number { const a = [[1, 2], [3]]; return ("" + a) === "1,2,3" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it("template literal substitution joins too", async () => {
    expect(
      await runStandalone(
        "export function test(): number { const a = [1, 2, 3]; return (`v=${a}`) === `v=1,2,3` ? 1 : 0; }",
      ),
    ).toBe(1);
  });

  it("emits a valid standalone module with no host imports", async () => {
    const r = await compile('export function test(): string { const a = [1, 2]; return "" + a; }', {
      fileName: "test.ts",
      target: "standalone",
    });
    expect(r.success).toBe(true);
    // standalone purity: no host imports at all.
    expect((r.imports ?? []).length).toBe(0);
    await expect(WebAssembly.instantiate(r.binary, {})).resolves.toBeDefined();
  });

  // #1448 — a closure-allocating array method (`map`/`filter`) elsewhere in the
  // function must NOT make a sibling array concat emit an invalid module. The
  // join fast-path bails to `$__any_to_string` ("[object Object]") in that case
  // (pre-existing array-join/closure index hazard); the key invariant is "valid
  // module", not the join result.
  it("array concat coexists with a closure array method (valid module)", async () => {
    for (const src of [
      'export function test(): string { const m = [9].map((x) => x); const a = [1, 2]; return "" + a; }',
      'export function test(): string { const a = [1, 2].filter((x) => x > 1); return "" + a; }',
      'export function test(): string { const a = [1, 2].map((x) => x * 2); return "" + a; }',
    ]) {
      const r = await compile(src, { fileName: "test.ts", target: "standalone" });
      expect(r.success).toBe(true);
      await expect(WebAssembly.instantiate(r.binary, {})).resolves.toBeDefined();
    }
  });
});
