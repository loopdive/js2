// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #3569 — Standalone JSON.stringify: well-formed surrogate escaping
// (ES2019 §25.5.4.3 QuoteJSONString, feature well-formed-json-stringify).
//
// The host-free native codec (`__json_quote_string`, src/codegen/json-runtime.ts)
// previously copied every code unit ≥ 0x20 verbatim, so a LONE UTF-16 surrogate
// leaked through unescaped. The spec requires a lone surrogate to be emitted as
// `\uXXXX` while the two units of a valid high+low pair are copied verbatim.
//
// Verdicts are checked via `charCodeAt` on the returned native string to avoid
// backslash-escaping ambiguity in the expected literal.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const src = "export function test(): number {\n" + body + "\n}";
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  // Guard: no JSON host import — the fix stays on the pure-Wasm codec.
  const labels = result.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.filter((l) => /env::JSON_(parse|stringify)/.test(l))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#3569 standalone JSON.stringify well-formed surrogate escaping", () => {
  it("escapes a lone HIGH surrogate as \\uXXXX", async () => {
    // "\uD834" (unpaired high) -> "\ud834"  → codes " \ u d 8 3 4 "
    const r = await runStandalone(`
      const s: string = "\\uD834";
      const r: string = JSON.stringify(s);
      return (r.length === 8
        && r.charCodeAt(0) === 34 && r.charCodeAt(1) === 92
        && r.charCodeAt(2) === 117 && r.charCodeAt(3) === 100
        && r.charCodeAt(4) === 56 && r.charCodeAt(5) === 51
        && r.charCodeAt(6) === 52 && r.charCodeAt(7) === 34) ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes a lone LOW surrogate as \\uXXXX", async () => {
    // "\uDF06" (unpaired low) -> "\udf06"  → codes " \ u d f 0 6 "
    const r = await runStandalone(`
      const s: string = "\\uDF06";
      const r: string = JSON.stringify(s);
      return (r.length === 8
        && r.charCodeAt(0) === 34 && r.charCodeAt(1) === 92
        && r.charCodeAt(2) === 117 && r.charCodeAt(3) === 100
        && r.charCodeAt(4) === 102 && r.charCodeAt(5) === 48
        && r.charCodeAt(6) === 54 && r.charCodeAt(7) === 34) ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("copies a valid high+low surrogate pair through verbatim", async () => {
    // "𝌆" (U+1D306) -> the two units unchanged inside quotes
    const r = await runStandalone(`
      const s: string = "\\uD834\\uDF06";
      const r: string = JSON.stringify(s);
      return (r.length === 4
        && r.charCodeAt(0) === 34
        && r.charCodeAt(1) === 0xD834 && r.charCodeAt(2) === 0xDF06
        && r.charCodeAt(3) === 34) ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("handles mixed lone + paired surrogates (\\ud834 𝌆 \\ud834)", async () => {
    // "\uD834𝌆\uD834" -> "\ud834" + <pair verbatim> + "\ud834"
    // length = 1 + 6 + 2 + 6 + 1 = 16
    const r = await runStandalone(`
      const s: string = "\\uD834\\uD834\\uDF06\\uD834";
      const r: string = JSON.stringify(s);
      return (r.length === 16
        && r.charCodeAt(0) === 34
        && r.charCodeAt(1) === 92 && r.charCodeAt(2) === 117
        && r.charCodeAt(7) === 0xD834 && r.charCodeAt(8) === 0xDF06
        && r.charCodeAt(9) === 92 && r.charCodeAt(10) === 117
        && r.charCodeAt(15) === 34) ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("still escapes control chars and quotes alongside a valid pair", async () => {
    // regression guard: "\n𝌆\"" -> \n escaped, pair verbatim, quote escaped
    const r = await runStandalone(`
      const s: string = "\\n\\uD834\\uDF06\\"";
      const r: string = JSON.stringify(s);
      // " \ n <D834> <DF06> \ " "
      return (r.length === 8
        && r.charCodeAt(0) === 34
        && r.charCodeAt(1) === 92 && r.charCodeAt(2) === 110
        && r.charCodeAt(3) === 0xD834 && r.charCodeAt(4) === 0xDF06
        && r.charCodeAt(5) === 92 && r.charCodeAt(6) === 34
        && r.charCodeAt(7) === 34) ? 1 : 0;
    `);
    expect(r).toBe(1);
  });
});
