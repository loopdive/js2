import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// (#40) Standalone String.prototype.to{Upper,Lower}Case full Unicode case mapping.
// Before this slice the native helpers were ASCII-only: à→À, α→Α, я→Я, ß→SS,
// ﬁ→FI, İ all passed through unchanged. The pure-Wasm helpers now use the
// generated simple (1:1) + special (1:N) case tables (case-tables.ts).
//
// Standalone native strings don't marshal across the JS export boundary, so we
// build the converted string into a module-level global and read it back
// code-unit-by-code-unit (the same approach the JSON/string suites use).

async function caseConvert(body: string, target: "standalone" | "wasi" = "standalone"): Promise<string> {
  const src =
    `let G: string = "";\n` +
    `export function len(): number { return G.length; }\n` +
    `export function ch(i: number): number { return G.charCodeAt(i); }\n` +
    `export function run(): void { ${body} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No String_* host import may leak into the standalone/wasi module.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /toUpperCase|toLowerCase|String_/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { run: () => void; len: () => number; ch: (i: number) => number };
  ex.run();
  let out = "";
  const n = ex.len();
  for (let i = 0; i < n; i++) out += String.fromCharCode(ex.ch(i));
  return out;
}

describe("#40 — standalone String.prototype.toUpperCase (Unicode simple mapping)", () => {
  it("ASCII a-z → A-Z (regression)", async () => {
    expect(await caseConvert(`G = "abcXYZ".toUpperCase();`)).toBe("ABCXYZ");
  });
  it("Latin-1 à → À", async () => {
    expect(await caseConvert(`G = "\\u00E0".toUpperCase();`)).toBe("À");
  });
  it("Latin Extended ā → Ā (alternating stride-2 run)", async () => {
    expect(await caseConvert(`G = "\\u0101".toUpperCase();`)).toBe("Ā");
  });
  it("Greek α → Α", async () => {
    expect(await caseConvert(`G = "\\u03B1".toUpperCase();`)).toBe("Α");
  });
  it("Cyrillic я → Я", async () => {
    expect(await caseConvert(`G = "\\u044F".toUpperCase();`)).toBe("Я");
  });
  it("mixed string", async () => {
    expect(await caseConvert(`G = "café \\u03B1\\u03B2".toUpperCase();`)).toBe("CAFÉ ΑΒ");
  });
});

describe("#40 — standalone String.prototype.toLowerCase (Unicode simple mapping)", () => {
  it("ASCII A-Z → a-z (regression)", async () => {
    expect(await caseConvert(`G = "ABCxyz".toLowerCase();`)).toBe("abcxyz");
  });
  it("Latin-1 À → à", async () => {
    expect(await caseConvert(`G = "\\u00C0".toLowerCase();`)).toBe("à");
  });
  it("Greek Α → α", async () => {
    expect(await caseConvert(`G = "\\u0391".toLowerCase();`)).toBe("α");
  });
  it("Cyrillic Я → я", async () => {
    expect(await caseConvert(`G = "\\u042F".toLowerCase();`)).toBe("я");
  });
});

describe("#40 — standalone toUpperCase special casing (1:N)", () => {
  it("ß → SS", async () => {
    expect(await caseConvert(`G = "\\u00DF".toUpperCase();`)).toBe("SS");
  });
  it("ﬁ ligature → FI", async () => {
    expect(await caseConvert(`G = "\\uFB01".toUpperCase();`)).toBe("FI");
  });
  it("special casing mixed with simple + ascii", async () => {
    // "aßà" → "A" + "SS" + "À"
    expect(await caseConvert(`G = "a\\u00DF\\u00E0".toUpperCase();`)).toBe("ASSÀ");
  });
  it("İ (U+0130) → i + combining dot above (lower special, 1:2)", async () => {
    expect(await caseConvert(`G = "\\u0130".toLowerCase();`)).toBe("i̇");
  });
});

describe("#40 — standalone case conversion edge cases", () => {
  it("empty string", async () => {
    expect(await caseConvert(`G = "".toUpperCase();`)).toBe("");
  });
  it("no-op for already-correct case + symbols", async () => {
    expect(await caseConvert(`G = "ABC123!@#".toUpperCase();`)).toBe("ABC123!@#");
  });
  it("toLocaleUpperCase delegates to the same Unicode path", async () => {
    expect(await caseConvert(`G = "\\u00E0".toLocaleUpperCase();`)).toBe("À");
  });
  it("works under --target wasi too (host-import-free)", async () => {
    expect(await caseConvert(`G = "\\u00E0\\u00DF".toUpperCase();`, "wasi")).toBe("ÀSS");
  });
});
