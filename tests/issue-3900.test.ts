import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3900 — gc-native `toLowerCase`/`toUpperCase` grew an ASCII fast path and
 * moved its Unicode tables into module globals.
 *
 * The risk the fast path introduces is that an all-ASCII input silently skips
 * the Unicode path, and that a non-ASCII code unit at an awkward offset (index
 * 0, the last index, immediately after a fold) fails to bail out. The risk the
 * globals introduce is that the tables stop being reachable, or get rebuilt.
 * Both are covered below by comparing against the host JS engine's own result
 * for the same literal.
 *
 * Runs under `--target standalone` so there is no JS host import to fall back
 * on: everything asserted here is executed by the pure-Wasm case-mapping path.
 */

/** Every string is checked in BOTH directions against the host engine. */
const CASES = [
  // ── ASCII fast path ──
  "",
  " ",
  // Exhaust the byte-sized ASCII domain: the fast path's unsigned interval
  // check must fold exactly A-Z/a-z and preserve every boundary/control unit.
  String.fromCharCode(...Array.from({ length: 128 }, (_, codeUnit) => codeUnit)),
  "a",
  "Z",
  "Hello World Test String",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  // The ASCII characters that bracket the A-Z / a-z runs: @[`{ must NOT fold.
  "@[`{",
  "!\"#$%&'()*+,-./:;<=>?\\]^_|~",
  "The quick brown fox JUMPS over 13 lazy dogs.",
  // ── bail-out position coverage ──
  "éabcdef", // non-ASCII first
  "abcédef", // non-ASCII in the middle
  "abcdefé", // non-ASCII last
  "Aé", // non-ASCII right after a folded ASCII char
  "éA", // folded ASCII right after non-ASCII
  // ── simple (1:1) Unicode mappings ──
  "àÀéÉ", // àÀéÉ
  "café",
  "АБВабв", // Cyrillic
  // ── length-changing special casing (1:N) ──
  "straße", // ß → SS
  "ﬁ", // ﬁ → FI
  "İı", // İ ı
  "ßẞ", // ß ẞ
  "ǅǆǄ", // ǅ ǆ Ǆ title/digraph
  "ᾀ", // ᾀ
  // ── Final_Sigma (context-sensitive) ──
  "Σ",
  "ΑΣ", // ΑΣ  → final
  "ΑΣΒ", // ΑΣΒ → medial
  "ΣΣ", // ΣΣ
  "ΟΔΟΣ", // ΟΔΟΣ
  "aΣb",
  "ASCIIΣ", // ASCII prefix then a final sigma
  "ΣASCII",
] as const;

function literal(source: string): string {
  return JSON.stringify(source);
}

/**
 * Compile one module that self-checks every case against the value the host
 * engine computed at build time, and returns 0 or the 1-based failing index.
 */
async function checkAll(target: "standalone" | "wasi"): Promise<number> {
  const checks = CASES.map(
    (source, index) =>
      `  if (${literal(source)}.toLowerCase() !== ${literal(source.toLowerCase())}) return ${index * 2 + 1};\n` +
      `  if (${literal(source)}.toUpperCase() !== ${literal(source.toUpperCase())}) return ${index * 2 + 2};`,
  ).join("\n");
  const result = await compile(`export function test(): number {\n${checks}\n  return 0;\n}`, { target });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => number>).test();
}

function describeFailure(code: number): string {
  if (code === 0) return "";
  const source = CASES[Math.floor((code - 1) / 2)];
  const method = code % 2 === 1 ? "toLowerCase" : "toUpperCase";
  return `${literal(source)}.${method}() mismatched the host engine`;
}

describe("#3900 ASCII fast path in native case conversion", () => {
  for (const target of ["standalone", "wasi"] as const) {
    it(`matches the host engine for ASCII and Unicode inputs under ${target}`, async () => {
      const code = await checkAll(target);
      expect(describeFailure(code)).toBe("");
    }, 120_000);
  }

  it("keeps the Unicode tables out of the hot function body", async () => {
    // The tables are ~9.3 KB of `i32.const` operands. Before #3900 they were
    // rebuilt into locals inside `__str_to{Upper,Lower}Case`, so the code
    // section carried all of them (11,303 B for this program) and every call
    // re-materialised a ~1.9k-element array. They now live in module globals,
    // which both removes the per-call rebuild and stops function inlining from
    // duplicating the operand sequences. Guard the code section, not the total
    // module size: the table bytes themselves are irreducible (see #3900).
    const result = await compile(
      `export function run(): number {
         const s = "Hello World Test String";
         let r = "";
         for (let i = 0; i < 1000; i = i + 1) { r = s.toLowerCase(); r = s.toUpperCase(); }
         return r.length;
       }`,
      { fast: true, optimize: 4 },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const binary = result.binary;
    let offset = 8;
    let codeSectionSize = -1;
    while (offset < binary.length) {
      const id = binary[offset++];
      let size = 0;
      let shift = 0;
      let byte = 0;
      do {
        byte = binary[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      if (id === 10) codeSectionSize = size;
      offset += size;
    }
    expect(codeSectionSize).toBeGreaterThan(0);
    // Measured 2,157 B after #3900 (was 11,303 B). A regression that re-inlines
    // a table into a function body blows straight past this ceiling.
    expect(codeSectionSize).toBeLessThan(5_000);
  }, 120_000);
});
